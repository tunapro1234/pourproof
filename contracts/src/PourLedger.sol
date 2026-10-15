// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {BatchMessage} from "./BatchMessage.sol";
import {DeviceRegistry} from "./DeviceRegistry.sol";

/// @title PourLedger
/// @notice One record per concrete pour, read the same way by supplier, contractor, inspector and owner.
///  The pour's device signs batches of curing readings (P-256); each batch signature is checked here.
///  The carbon saving of a pour against the contractor's pre-pour baseline can be claimed once, by one party.
/// @dev Units: GWP in kg CO2e per m3, volume in dm3 (1 m3 = 1000 dm3), saving in kg CO2e (rounded down).
contract PourLedger is DeviceRegistry {
    struct Pour {
        address supplier;
        uint64 pourStart;
        uint32 volumeDm3;
        uint32 gwpLow;
        uint32 gwpHigh;
        address contractor; // set by acceptPour
        uint64 nextCounter;
        bool strengthApproved;
        address claimant;
        bytes32 ticketHash;
        bytes32 epdHash;
        bytes32 evidenceHash;
    }

    struct Baseline {
        address contractor;
        uint32 gwpLow;
        uint32 gwpHigh;
        bytes32 mixHash;
    }

    mapping(bytes32 pourId => Pour) private _pours;
    mapping(bytes32 pourId => Baseline) private _baselines;
    mapping(bytes32 pourId => mapping(uint64 counter => bytes32 root)) public batchRoot;
    /// @notice The pour a delivery ticket was first recorded for: one ticket, one pour record.
    mapping(bytes32 ticketHash => bytes32 pourId) public pourOfTicket;

    event PourCreated(
        bytes32 indexed pourId,
        address indexed supplier,
        bytes32 ticketHash,
        bytes32 epdHash,
        uint32 volumeDm3,
        uint32 gwpLow,
        uint32 gwpHigh,
        uint64 pourStart
    );
    event BaselineDeclared(
        bytes32 indexed pourId, address indexed contractor, bytes32 baselineMixHash, uint32 baselineGwpLow, uint32 baselineGwpHigh
    );
    event PourAccepted(bytes32 indexed pourId, address indexed contractor);
    event BatchAppended(bytes32 indexed pourId, uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root);
    event StrengthApproved(bytes32 indexed pourId, bytes32 evidenceHash);
    event SavingClaimed(
        bytes32 indexed pourId, address indexed claimant, bytes32 role, uint256 savingLow_kg, uint256 savingHigh_kg
    );

    error BadSignature();
    error CounterGap(bytes32 pourId, uint64 expected, uint64 got);
    error AlreadyClaimed(bytes32 pourId, address firstClaimant);
    error NotBeforePour(bytes32 pourId, uint64 pourStart);
    error StrengthNotApproved(bytes32 pourId);
    error PourExists(bytes32 pourId);
    error InvalidRange();
    error BaselineAlreadyDeclared(bytes32 pourId);
    error NoBaseline(bytes32 pourId);
    error AlreadyAccepted(bytes32 pourId);
    error NotPourContractor(bytes32 pourId, address account);
    error BadBatchWindow(uint64 fromTs, uint64 toTs);
    error FutureBatch(uint64 toTs, uint256 blockTime);
    error NoBatches(bytes32 pourId);
    error AlreadyApproved(bytes32 pourId);
    error NotAClaimant(bytes32 pourId, address account);
    error TicketReused(bytes32 ticketHash, bytes32 firstPourId);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------- pour lifecycle

    /// @notice Contractor fixes the mix it would have used. Allowed only before the pour starts and before any batch.
    function declareBaseline(bytes32 pourId, bytes32 baselineMixHash, uint32 baselineGwpLow, uint32 baselineGwpHigh)
        external
        onlyRole(CONTRACTOR_ROLE)
    {
        if (_baselines[pourId].contractor != address(0)) revert BaselineAlreadyDeclared(pourId);
        Pour storage p = _pours[pourId];
        if (p.supplier != address(0) && (block.timestamp >= p.pourStart || p.nextCounter > 0)) {
            revert NotBeforePour(pourId, p.pourStart);
        }
        if (baselineGwpHigh == 0 || baselineGwpLow > baselineGwpHigh) revert InvalidRange();
        _baselines[pourId] = Baseline(msg.sender, baselineGwpLow, baselineGwpHigh, baselineMixHash);
        emit BaselineDeclared(pourId, msg.sender, baselineMixHash, baselineGwpLow, baselineGwpHigh);
    }

    function createPour(
        bytes32 pourId,
        bytes32 ticketHash,
        bytes32 epdHash,
        uint32 volumeDm3,
        uint32 gwpLow,
        uint32 gwpHigh,
        uint64 pourStart
    ) external onlyRole(SUPPLIER_ROLE) {
        if (_pours[pourId].supplier != address(0)) revert PourExists(pourId);
        if (volumeDm3 == 0 || gwpHigh == 0 || gwpLow > gwpHigh) revert InvalidRange();
        // A non-zero ticket hash can open one pour record only, so one delivery cannot be claimed under two pours.
        if (ticketHash != bytes32(0)) {
            bytes32 first = pourOfTicket[ticketHash];
            if (first != bytes32(0)) revert TicketReused(ticketHash, first);
            pourOfTicket[ticketHash] = pourId;
        }
        Pour storage p = _pours[pourId];
        p.supplier = msg.sender;
        p.ticketHash = ticketHash;
        p.epdHash = epdHash;
        p.volumeDm3 = volumeDm3;
        p.gwpLow = gwpLow;
        p.gwpHigh = gwpHigh;
        p.pourStart = pourStart;
        emit PourCreated(pourId, msg.sender, ticketHash, epdHash, volumeDm3, gwpLow, gwpHigh, pourStart);
    }

    /// @notice Contractor accepts the delivery. If a baseline was declared, only its contractor can accept.
    function acceptPour(bytes32 pourId) external onlyRole(CONTRACTOR_ROLE) {
        Pour storage p = _existing(pourId);
        if (p.contractor != address(0)) revert AlreadyAccepted(pourId);
        address declared = _baselines[pourId].contractor;
        if (declared != address(0) && declared != msg.sender) revert NotPourContractor(pourId, msg.sender);
        p.contractor = msg.sender;
        emit PourAccepted(pourId, msg.sender);
    }

    /// @notice Anyone may relay a batch; the device signature is the authorization. A batch can only be appended
    ///  once its last reading lies in the past (toTs <= block.timestamp).
    function appendBatch(bytes32 pourId, uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root, bytes32 r, bytes32 s)
        external
    {
        Pour storage p = _existing(pourId);
        Device memory d = deviceOf(pourId);
        if (d.qx == 0 && d.qy == 0) revert NoDevice(pourId);
        if (counter != p.nextCounter) revert CounterGap(pourId, p.nextCounter, counter);
        if (fromTs > toTs || fromTs < p.pourStart) revert BadBatchWindow(fromTs, toTs);
        if (toTs > block.timestamp) revert FutureBatch(toTs, block.timestamp);
        bytes32 h = BatchMessage.digest(block.chainid, address(this), pourId, counter, fromTs, toTs, root);
        if (!P256.verify(h, r, s, d.qx, d.qy)) revert BadSignature();
        p.nextCounter = counter + 1;
        batchRoot[pourId][counter] = root;
        emit BatchAppended(pourId, counter, fromTs, toTs, root);
    }

    /// @notice Inspector records the evidence (maturity calculation, break tests if any) behind the strength decision.
    function approveStrength(bytes32 pourId, bytes32 evidenceHash) external onlyRole(INSPECTOR_ROLE) {
        Pour storage p = _existing(pourId);
        if (p.nextCounter == 0) revert NoBatches(pourId);
        if (p.strengthApproved) revert AlreadyApproved(pourId);
        p.strengthApproved = true;
        p.evidenceHash = evidenceHash;
        emit StrengthApproved(pourId, evidenceHash);
    }

    /// @notice Claim the pour's saving against its baseline. Once per pour, by the pour's supplier, its contractor
    ///  or an owner. Every later call reverts with the first claimant.
    function claimSaving(bytes32 pourId) external {
        Pour storage p = _existing(pourId);
        if (p.claimant != address(0)) revert AlreadyClaimed(pourId, p.claimant);
        if (!p.strengthApproved) revert StrengthNotApproved(pourId);
        if (_baselines[pourId].contractor == address(0)) revert NoBaseline(pourId);
        bytes32 role;
        if (msg.sender == p.supplier && hasRole(SUPPLIER_ROLE, msg.sender)) role = SUPPLIER_ROLE;
        else if (msg.sender == p.contractor && hasRole(CONTRACTOR_ROLE, msg.sender)) role = CONTRACTOR_ROLE;
        else if (hasRole(OWNER_ROLE, msg.sender)) role = OWNER_ROLE;
        else revert NotAClaimant(pourId, msg.sender);
        p.claimant = msg.sender;
        (uint256 lo, uint256 hi) = savingRange(pourId);
        emit SavingClaimed(pourId, msg.sender, role, lo, hi);
    }

    // ---------------------------------------------------------------- views

    /// @notice low = (baselineLow - gwpHigh) * m3, high = (baselineHigh - gwpLow) * m3, in kg CO2e; negative ends become 0.
    function savingRange(bytes32 pourId) public view returns (uint256 low_kg, uint256 high_kg) {
        Pour storage p = _pours[pourId];
        Baseline storage b = _baselines[pourId];
        low_kg = _savingKg(b.gwpLow, p.gwpHigh, p.volumeDm3);
        high_kg = _savingKg(b.gwpHigh, p.gwpLow, p.volumeDm3);
    }

    function pour(bytes32 pourId) external view returns (Pour memory) {
        return _pours[pourId];
    }

    function baseline(bytes32 pourId) external view returns (Baseline memory) {
        return _baselines[pourId];
    }

    function nextCounter(bytes32 pourId) external view returns (uint64) {
        return _pours[pourId].nextCounter;
    }

    // ---------------------------------------------------------------- internals

    function _savingKg(uint32 baseGwp, uint32 actualGwp, uint32 volumeDm3) private pure returns (uint256) {
        if (actualGwp >= baseGwp) return 0;
        return (uint256(baseGwp - actualGwp) * volumeDm3) / 1000;
    }

    function _existing(bytes32 pourId) private view returns (Pour storage p) {
        p = _pours[pourId];
        if (p.supplier == address(0)) revert UnknownPour(pourId);
    }

    function _pourExists(bytes32 pourId) internal view override returns (bool) {
        return _pours[pourId].supplier != address(0);
    }
}
