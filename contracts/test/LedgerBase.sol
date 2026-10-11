// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PourLedger} from "../src/PourLedger.sol";
import {BatchMessage} from "../src/BatchMessage.sol";

/// Shared fixture: four parties, one device key, helpers to build and sign batches.
abstract contract LedgerBase is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    PourLedger internal ledger;
    address internal admin = makeAddr("admin");
    address internal supplier = makeAddr("supplier");
    address internal contractor = makeAddr("contractor");
    address internal inspector = makeAddr("inspector");
    address internal owner = makeAddr("owner");
    address internal outsider = makeAddr("outsider");

    // Test-only device key, derived from a public label. Never used outside tests.
    uint256 internal devicePk = uint256(keccak256("pourproof test-only device key A")) % P256_N;
    bytes32 internal qx;
    bytes32 internal qy;

    bytes32 internal constant P1 = keccak256("P-001");
    bytes32 internal constant P2 = keccak256("P-002");
    uint64 internal pourStart;

    function _deploy() internal {
        vm.warp(1_760_000_000);
        ledger = new PourLedger(admin);
        vm.startPrank(admin);
        ledger.grantRole(ledger.SUPPLIER_ROLE(), supplier);
        ledger.grantRole(ledger.CONTRACTOR_ROLE(), contractor);
        ledger.grantRole(ledger.INSPECTOR_ROLE(), inspector);
        ledger.grantRole(ledger.OWNER_ROLE(), owner);
        vm.stopPrank();
        (uint256 x, uint256 y) = vm.publicKeyP256(devicePk);
        (qx, qy) = (bytes32(x), bytes32(y));
        pourStart = uint64(block.timestamp + 1 hours);
    }

    /// Baseline 300-340 kg/m3, actual mix 220-250 kg/m3, 8 m3: saving 400-960 kg.
    function _setupPour(bytes32 id) internal {
        vm.prank(contractor);
        ledger.declareBaseline(id, keccak256("baseline CEM I mix"), 300, 340);
        vm.prank(supplier);
        ledger.createPour(id, keccak256("ticket"), keccak256("epd"), 8000, 220, 250, pourStart);
        vm.prank(contractor);
        ledger.acceptPour(id);
        vm.prank(inspector);
        ledger.registerDevice(id, qx, qy, "simulated");
    }

    function _root(uint64 fromTs, uint256 n, int32 base) internal pure returns (bytes32) {
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            leaves[i] = BatchMessage.leaf(fromTs + uint64(i) * 1800, base + int32(int256(i)) * 100);
        }
        return BatchMessage.root(leaves);
    }

    function _sign(uint256 pk, bytes32 id, uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root)
        internal
        view
        returns (bytes32 r, bytes32 s)
    {
        bytes32 h = BatchMessage.digest(block.chainid, address(ledger), id, counter, fromTs, toTs, root);
        (r, s) = vm.signP256(pk, h);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
    }

    function _window(uint64 counter) internal view returns (uint64 fromTs, uint64 toTs) {
        fromTs = pourStart + counter * 6 hours + 30 minutes;
        toTs = fromTs + 5 hours + 30 minutes;
    }

    struct Batch {
        bytes32 id;
        uint64 counter;
        uint64 fromTs;
        uint64 toTs;
        bytes32 root;
        bytes32 r;
        bytes32 s;
    }

    /// Builds and signs a batch. Sign before vm.expectRevert: the digest calls the sha256 precompile.
    function _batch(uint256 pk, bytes32 id, uint64 counter) internal view returns (Batch memory b) {
        (b.fromTs, b.toTs) = _window(counter);
        b.id = id;
        b.counter = counter;
        b.root = _root(b.fromTs, 12, 21_000);
        (b.r, b.s) = _sign(pk, id, counter, b.fromTs, b.toTs, b.root);
    }

    function _submit(Batch memory b) internal {
        ledger.appendBatch(b.id, b.counter, b.fromTs, b.toTs, b.root, b.r, b.s);
    }

    function _append(bytes32 id, uint64 counter) internal {
        _submit(_batch(devicePk, id, counter));
    }
}
