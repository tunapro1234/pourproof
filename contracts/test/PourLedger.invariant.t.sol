// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PourLedger} from "../src/PourLedger.sol";
import {LedgerBase} from "./LedgerBase.sol";

/// Drives the ledger with random sequences of appends (valid, wrong counter, wrong key), approvals and claims
/// from every party, and records what actually happened on chain.
contract LedgerHandler is LedgerBase {
    bytes32[3] internal ids = [keccak256("P-001"), keccak256("P-002"), keccak256("P-003")];
    address[6] internal actors;

    mapping(bytes32 => uint256) public savingClaimedEvents;
    mapping(bytes32 => uint64) public appended;
    uint256 public counterDecreases;
    uint256 public wrongKeyAppends;

    constructor() {
        _deploy();
        for (uint256 i = 0; i < ids.length; i++) _setupPour(ids[i]);
        actors = [supplier, contractor, inspector, owner, outsider, admin];
    }

    function ledgerAddress() external view returns (address) {
        return address(ledger);
    }

    function pourIds() external view returns (bytes32[3] memory) {
        return ids;
    }

    function appendValid(uint256 pourSeed) external {
        bytes32 id = ids[pourSeed % ids.length];
        uint64 before = ledger.nextCounter(id);
        _append(id, before);
        appended[id]++;
        _checkCounter(id, before);
    }

    function appendAnyCounter(uint256 pourSeed, uint64 counter) external {
        bytes32 id = ids[pourSeed % ids.length];
        uint64 before = ledger.nextCounter(id);
        counter = uint64(bound(counter, 0, uint256(before) + 3));
        (uint64 fromTs, uint64 toTs) = _window(counter);
        bytes32 root = _root(fromTs, 12, 20_000);
        (bytes32 r, bytes32 s) = _sign(devicePk, id, counter, fromTs, toTs, root);
        _reach(toTs);
        try ledger.appendBatch(id, counter, fromTs, toTs, root, r, s) {
            appended[id]++;
        } catch {}
        _checkCounter(id, before);
    }

    function appendWrongKey(uint256 pourSeed, uint256 pk) external {
        bytes32 id = ids[pourSeed % ids.length];
        pk = bound(pk, 1, P256_N - 1);
        if (pk == devicePk) pk = pk == 1 ? 2 : pk - 1;
        uint64 before = ledger.nextCounter(id);
        (uint64 fromTs, uint64 toTs) = _window(before);
        bytes32 root = _root(fromTs, 12, 20_000);
        (bytes32 r, bytes32 s) = _sign(pk, id, before, fromTs, toTs, root);
        _reach(toTs);
        try ledger.appendBatch(id, before, fromTs, toTs, root, r, s) {
            wrongKeyAppends++;
        } catch {}
        _checkCounter(id, before);
    }

    function approve(uint256 pourSeed) external {
        bytes32 id = ids[pourSeed % ids.length];
        vm.prank(inspector);
        try ledger.approveStrength(id, keccak256(abi.encode(id))) {} catch {}
    }

    function claim(uint256 pourSeed, uint256 actorSeed) external {
        bytes32 id = ids[pourSeed % ids.length];
        address who = actors[actorSeed % actors.length];
        vm.recordLogs();
        vm.prank(who);
        try ledger.claimSaving(id) {} catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(ledger) && logs[i].topics[0] == PourLedger.SavingClaimed.selector) {
                savingClaimedEvents[logs[i].topics[1]]++;
            }
        }
    }

    function _checkCounter(bytes32 id, uint64 before) internal {
        if (ledger.nextCounter(id) < before) counterDecreases++;
    }
}

contract PourLedgerInvariantTest is StdInvariant, LedgerBase {
    LedgerHandler internal handler;

    function setUp() public {
        handler = new LedgerHandler();
        ledger = PourLedger(handler.ledgerAddress());
        targetContract(address(handler));
    }

    function invariant_atMostOneSavingClaimedPerPour() public view {
        bytes32[3] memory ids = handler.pourIds();
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 n = handler.savingClaimedEvents(ids[i]);
            assertLe(n, 1);
            assertEq(n == 1, ledger.pour(ids[i]).claimant != address(0));
        }
    }

    function invariant_counterMonotone() public view {
        assertEq(handler.counterDecreases(), 0);
        bytes32[3] memory ids = handler.pourIds();
        for (uint256 i = 0; i < ids.length; i++) {
            assertEq(ledger.nextCounter(ids[i]), handler.appended(ids[i]));
        }
    }

    function invariant_wrongKeyNeverAppends() public view {
        assertEq(handler.wrongKeyAppends(), 0);
    }
}
