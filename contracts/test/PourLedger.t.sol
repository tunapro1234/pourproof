// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PourLedger} from "../src/PourLedger.sol";
import {DeviceRegistry} from "../src/DeviceRegistry.sol";
import {LedgerBase} from "./LedgerBase.sol";

contract PourLedgerTest is LedgerBase {
    function setUp() public {
        _deploy();
    }

    function test_happyPath() public {
        _setupPour(P1);
        vm.warp(pourStart + 1 days);
        for (uint64 c = 0; c < 3; c++) _append(P1, c);
        assertEq(ledger.nextCounter(P1), 3);

        vm.prank(inspector);
        vm.expectEmit(address(ledger));
        emit PourLedger.StrengthApproved(P1, keccak256("evidence"));
        ledger.approveStrength(P1, keccak256("evidence"));

        (uint256 lo, uint256 hi) = ledger.savingRange(P1);
        assertEq(lo, 400); // (300 - 250) * 8 m3
        assertEq(hi, 960); // (340 - 220) * 8 m3

        bytes32 role = ledger.CONTRACTOR_ROLE();
        vm.prank(contractor);
        vm.expectEmit(address(ledger));
        emit PourLedger.SavingClaimed(P1, contractor, role, 400, 960);
        ledger.claimSaving(P1);
        assertEq(ledger.pour(P1).claimant, contractor);
    }

    function test_appendEmitsAndStoresRoot() public {
        _setupPour(P1);
        (uint64 fromTs, uint64 toTs) = _window(0);
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(devicePk, P1, 0, fromTs, toTs, root);
        vm.expectEmit(address(ledger));
        emit PourLedger.BatchAppended(P1, 0, fromTs, toTs, root);
        ledger.appendBatch(P1, 0, fromTs, toTs, root, r, s);
        assertEq(ledger.batchRoot(P1, 0), root);
    }

    function test_RevertWhen_wrongKey() public {
        _setupPour(P1);
        (uint64 fromTs, uint64 toTs) = _window(0);
        bytes32 root = _root(fromTs, 12, 21_000);
        uint256 otherPk = uint256(keccak256("pourproof test-only device key B")) % P256_N;
        (bytes32 r, bytes32 s) = _sign(otherPk, P1, 0, fromTs, toTs, root);
        vm.expectRevert(PourLedger.BadSignature.selector);
        ledger.appendBatch(P1, 0, fromTs, toTs, root, r, s);
    }

    function test_RevertWhen_rootTampered() public {
        _setupPour(P1);
        (uint64 fromTs, uint64 toTs) = _window(0);
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(devicePk, P1, 0, fromTs, toTs, root);
        bytes32 tampered = _root(fromTs, 12, 21_001);
        vm.expectRevert(PourLedger.BadSignature.selector);
        ledger.appendBatch(P1, 0, fromTs, toTs, tampered, r, s);
    }

    /// The same physical key on two pours: a signature made for P-002 must not be accepted for P-001.
    function test_RevertWhen_signatureReusedFromOtherPour() public {
        _setupPour(P1);
        _setupPour(P2);
        (uint64 fromTs, uint64 toTs) = _window(0);
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(devicePk, P2, 0, fromTs, toTs, root);
        ledger.appendBatch(P2, 0, fromTs, toTs, root, r, s);
        vm.expectRevert(PourLedger.BadSignature.selector);
        ledger.appendBatch(P1, 0, fromTs, toTs, root, r, s);
    }

    function test_RevertWhen_signatureFromOtherChain() public {
        _setupPour(P1);
        (uint64 fromTs, uint64 toTs) = _window(0);
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(devicePk, P1, 0, fromTs, toTs, root);
        vm.chainId(84532);
        vm.expectRevert(PourLedger.BadSignature.selector);
        ledger.appendBatch(P1, 0, fromTs, toTs, root, r, s);
    }

    function test_RevertWhen_highS() public {
        _setupPour(P1);
        (uint64 fromTs, uint64 toTs) = _window(0);
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(devicePk, P1, 0, fromTs, toTs, root);
        vm.expectRevert(PourLedger.BadSignature.selector);
        ledger.appendBatch(P1, 0, fromTs, toTs, root, r, bytes32(P256_N - uint256(s)));
    }

    function test_RevertWhen_counterGap() public {
        _setupPour(P1);
        Batch memory b0 = _batch(devicePk, P1, 0);
        Batch memory b1 = _batch(devicePk, P1, 1);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.CounterGap.selector, P1, uint64(0), uint64(1)));
        _submit(b1);
        _submit(b0);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.CounterGap.selector, P1, uint64(1), uint64(0)));
        _submit(b0); // replay
    }

    function test_RevertWhen_batchBeforePourStart() public {
        _setupPour(P1);
        uint64 fromTs = pourStart - 1;
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(devicePk, P1, 0, fromTs, fromTs + 1, root);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.BadBatchWindow.selector, fromTs, fromTs + 1));
        ledger.appendBatch(P1, 0, fromTs, fromTs + 1, root, r, s);
    }

    function test_RevertWhen_secondClaim_fromEveryRole() public {
        _setupPour(P1);
        _append(P1, 0);
        vm.prank(inspector);
        ledger.approveStrength(P1, keccak256("evidence"));
        vm.prank(supplier);
        ledger.claimSaving(P1);

        address[6] memory callers = [supplier, contractor, owner, inspector, outsider, admin];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(PourLedger.AlreadyClaimed.selector, P1, supplier));
            ledger.claimSaving(P1);
        }
    }

    function test_ownerCanClaim() public {
        _setupPour(P1);
        _append(P1, 0);
        vm.prank(inspector);
        ledger.approveStrength(P1, bytes32(0));
        vm.prank(owner);
        ledger.claimSaving(P1);
        assertEq(ledger.pour(P1).claimant, owner);
    }

    function test_RevertWhen_claimBeforeApproval() public {
        _setupPour(P1);
        _append(P1, 0);
        vm.prank(contractor);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.StrengthNotApproved.selector, P1));
        ledger.claimSaving(P1);
    }

    function test_RevertWhen_claimByNonParty() public {
        _setupPour(P1);
        _append(P1, 0);
        vm.prank(inspector);
        ledger.approveStrength(P1, bytes32(0));
        address[3] memory callers = [inspector, outsider, admin];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(PourLedger.NotAClaimant.selector, P1, callers[i]));
            ledger.claimSaving(P1);
        }
    }

    function test_RevertWhen_claimByAnotherSupplier() public {
        address supplier2 = makeAddr("supplier2");
        bytes32 role = ledger.SUPPLIER_ROLE();
        vm.prank(admin);
        ledger.grantRole(role, supplier2);
        _setupPour(P1);
        _append(P1, 0);
        vm.prank(inspector);
        ledger.approveStrength(P1, bytes32(0));
        vm.prank(supplier2);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.NotAClaimant.selector, P1, supplier2));
        ledger.claimSaving(P1);
    }

    function test_RevertWhen_approveWithoutBatches() public {
        _setupPour(P1);
        vm.prank(inspector);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.NoBatches.selector, P1));
        ledger.approveStrength(P1, bytes32(0));
    }

    function test_RevertWhen_nonInspectorRegistersDevice() public {
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 1000, 200, 250, pourStart);
        bytes32 role = ledger.INSPECTOR_ROLE();
        address[5] memory callers = [supplier, contractor, owner, outsider, admin];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, callers[i], role)
            );
            ledger.registerDevice(P1, qx, qy, "simulated");
        }
    }

    function test_registerDeviceEmitsKind() public {
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 1000, 200, 250, pourStart);
        vm.prank(inspector);
        vm.expectEmit(address(ledger));
        emit DeviceRegistry.DeviceRegistered(P1, qx, qy, "esp32");
        ledger.registerDevice(P1, qx, qy, "esp32");
        assertEq(ledger.deviceOf(P1).kind, "esp32");
    }

    function test_RevertWhen_deviceKindUnknown() public {
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 1000, 200, 250, pourStart);
        vm.prank(inspector);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.InvalidDeviceKind.selector, "lab"));
        ledger.registerDevice(P1, qx, qy, "lab");
    }

    function test_RevertWhen_deviceKeyNotOnCurve() public {
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 1000, 200, 250, pourStart);
        vm.prank(inspector);
        vm.expectRevert(DeviceRegistry.InvalidDeviceKey.selector);
        ledger.registerDevice(P1, qx, bytes32(uint256(qy) ^ 1), "simulated");
    }

    function test_RevertWhen_secondDeviceForPour() public {
        _setupPour(P1);
        vm.prank(inspector);
        vm.expectRevert(abi.encodeWithSelector(DeviceRegistry.DeviceAlreadyRegistered.selector, P1));
        ledger.registerDevice(P1, qx, qy, "simulated");
    }

    function test_replaceDevice_oldKeyStops_counterContinues() public {
        _setupPour(P1);
        _append(P1, 0);
        uint256 newPk = uint256(keccak256("pourproof test-only device key C")) % P256_N;
        (uint256 x, uint256 y) = vm.publicKeyP256(newPk);
        vm.prank(inspector);
        vm.expectEmit(address(ledger));
        emit DeviceRegistry.DeviceReplaced(P1, qx, qy, bytes32(x), bytes32(y), "esp32");
        ledger.replaceDevice(P1, bytes32(x), bytes32(y), "esp32");

        Batch memory stale = _batch(devicePk, P1, 1);
        vm.expectRevert(PourLedger.BadSignature.selector);
        _submit(stale);

        (uint64 fromTs, uint64 toTs) = _window(1);
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(newPk, P1, 1, fromTs, toTs, root);
        ledger.appendBatch(P1, 1, fromTs, toTs, root, r, s);
        assertEq(ledger.nextCounter(P1), 2);
    }

    function test_RevertWhen_baselineAfterPourStart() public {
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 8000, 220, 250, pourStart);
        vm.warp(pourStart);
        vm.prank(contractor);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.NotBeforePour.selector, P1, pourStart));
        ledger.declareBaseline(P1, keccak256("baseline"), 300, 340);
    }

    function test_RevertWhen_baselineAfterFirstBatch() public {
        // pourStart set in the future, but readings already exist: the pour has started.
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 8000, 220, 250, pourStart);
        vm.prank(inspector);
        ledger.registerDevice(P1, qx, qy, "simulated");
        _append(P1, 0);
        vm.prank(contractor);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.NotBeforePour.selector, P1, pourStart));
        ledger.declareBaseline(P1, keccak256("baseline"), 300, 340);
    }

    function test_RevertWhen_baselineDeclaredTwice() public {
        vm.startPrank(contractor);
        ledger.declareBaseline(P1, keccak256("baseline"), 300, 340);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.BaselineAlreadyDeclared.selector, P1));
        ledger.declareBaseline(P1, keccak256("baseline 2"), 400, 440);
        vm.stopPrank();
    }

    function test_RevertWhen_otherContractorAccepts() public {
        address contractor2 = makeAddr("contractor2");
        bytes32 role = ledger.CONTRACTOR_ROLE();
        vm.prank(admin);
        ledger.grantRole(role, contractor2);
        vm.prank(contractor);
        ledger.declareBaseline(P1, keccak256("baseline"), 300, 340);
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 8000, 220, 250, pourStart);
        vm.prank(contractor2);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.NotPourContractor.selector, P1, contractor2));
        ledger.acceptPour(P1);
    }

    function test_RevertWhen_noBaseline() public {
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 8000, 220, 250, pourStart);
        vm.prank(inspector);
        ledger.registerDevice(P1, qx, qy, "simulated");
        _append(P1, 0);
        vm.prank(inspector);
        ledger.approveStrength(P1, bytes32(0));
        vm.prank(supplier);
        vm.expectRevert(abi.encodeWithSelector(PourLedger.NoBaseline.selector, P1));
        ledger.claimSaving(P1);
    }

    function test_savingRangeClampsToZero() public {
        vm.prank(contractor);
        ledger.declareBaseline(P1, 0, 240, 260);
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, 2500, 230, 280, pourStart);
        (uint256 lo, uint256 hi) = ledger.savingRange(P1);
        assertEq(lo, 0); // 240 - 280 < 0
        assertEq(hi, 75); // (260 - 230) * 2.5 m3
    }

    function testFuzz_RevertWhen_wrongKeyAppends(uint256 pk) public {
        pk = bound(pk, 1, P256_N - 1);
        vm.assume(pk != devicePk);
        _setupPour(P1);
        (uint64 fromTs, uint64 toTs) = _window(0);
        bytes32 root = _root(fromTs, 12, 21_000);
        (bytes32 r, bytes32 s) = _sign(pk, P1, 0, fromTs, toTs, root);
        vm.expectRevert(PourLedger.BadSignature.selector);
        ledger.appendBatch(P1, 0, fromTs, toTs, root, r, s);
    }

    function testFuzz_savingRangeOrderedAndExact(uint32 bLow, uint32 bSpan, uint32 aLow, uint32 aSpan, uint32 vol)
        public
    {
        bLow = uint32(bound(bLow, 0, 2000));
        uint32 bHigh = bLow + uint32(bound(bSpan, 1, 500));
        aLow = uint32(bound(aLow, 0, 2000));
        uint32 aHigh = aLow + uint32(bound(aSpan, 1, 500));
        vol = uint32(bound(vol, 1, 1_000_000));
        vm.prank(contractor);
        ledger.declareBaseline(P1, 0, bLow, bHigh);
        vm.prank(supplier);
        ledger.createPour(P1, 0, 0, vol, aLow, aHigh, pourStart);
        (uint256 lo, uint256 hi) = ledger.savingRange(P1);
        assertLe(lo, hi);
        assertEq(lo, bLow > aHigh ? uint256(bLow - aHigh) * vol / 1000 : 0);
        assertEq(hi, bHigh > aLow ? uint256(bHigh - aLow) * vol / 1000 : 0);
    }
}
