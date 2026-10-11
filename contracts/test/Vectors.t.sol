// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {PourLedger} from "../src/PourLedger.sol";
import {BatchMessage} from "../src/BatchMessage.sol";
import {GenVectors} from "../script/GenVectors.s.sol";

/// Checks contracts/test/vectors.json against the Solidity message format and the ledger itself, and
/// contracts/test/proofs.json (Merkle proofs built by packages/core) against OpenZeppelin MerkleProof.
contract VectorsTest is Test {
    string internal json;
    GenVectors internal gen;

    function setUp() public {
        json = vm.readFile("test/vectors.json");
        gen = new GenVectors();
    }

    function _b(uint256 i, string memory key) internal pure returns (string memory) {
        return string.concat(".batches[", vm.toString(i), "].", key);
    }

    function test_fileIsCurrent() public view {
        assertEq(keccak256(bytes(json)), keccak256(bytes(gen.build())), "regenerate: forge script script/GenVectors.s.sol");
    }

    function test_keyMatchesSeed() public view {
        uint256 pk = uint256(sha256(bytes(vm.parseJsonString(json, ".test_only_key.seed"))));
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        assertEq(bytes32(x), vm.parseJsonBytes32(json, ".qx"));
        assertEq(bytes32(y), vm.parseJsonBytes32(json, ".qy"));
    }

    struct Ctx {
        bytes32 qx;
        bytes32 qy;
        bytes32 pourId;
        uint256 chainId;
        address ledger;
        uint256 perBatch;
    }

    function test_leavesRootsDigestsSignatures() public view {
        Ctx memory c = Ctx({
            qx: vm.parseJsonBytes32(json, ".qx"),
            qy: vm.parseJsonBytes32(json, ".qy"),
            pourId: vm.parseJsonBytes32(json, ".pourId"),
            chainId: vm.parseJsonUint(json, ".chainId"),
            ledger: vm.parseJsonAddress(json, ".ledger"),
            perBatch: vm.parseJsonUint(json, ".readingsPerBatch")
        });
        assertEq(c.pourId, keccak256(bytes(vm.parseJsonString(json, ".pourLabel"))));
        assertEq(vm.parseJsonString(json, ".domain"), "POURPROOF_BATCH_V1");
        uint256 nb = vm.parseJsonUint(json, ".batchCount");
        assertEq(nb, 3);
        for (uint256 b = 0; b < nb; b++) {
            _checkBatch(c, b);
        }
    }

    function _checkBatch(Ctx memory c, uint256 b) internal view {
        bytes32[] memory leaves = new bytes32[](c.perBatch);
        for (uint256 i = 0; i < c.perBatch; i++) {
            string memory p = string.concat(_b(b, "readings["), vm.toString(i), "]");
            leaves[i] = BatchMessage.leaf(
                uint64(vm.parseJsonUint(json, string.concat(p, ".t_unix"))),
                int32(vm.parseJsonInt(json, string.concat(p, ".temp_milliC")))
            );
            assertEq(leaves[i], vm.parseJsonBytes32(json, string.concat(p, ".leaf")));
        }
        bytes32 root = BatchMessage.root(leaves);
        assertEq(root, vm.parseJsonBytes32(json, _b(b, "root")));
        bytes32 h = BatchMessage.digest(
            c.chainId,
            c.ledger,
            c.pourId,
            uint64(vm.parseJsonUint(json, _b(b, "counter"))),
            uint64(vm.parseJsonUint(json, _b(b, "fromTs"))),
            uint64(vm.parseJsonUint(json, _b(b, "toTs"))),
            root
        );
        assertEq(h, vm.parseJsonBytes32(json, _b(b, "digest")));
        bytes32 s = vm.parseJsonBytes32(json, _b(b, "s"));
        assertLe(uint256(s), 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8, "low-s");
        assertTrue(P256.verify(h, vm.parseJsonBytes32(json, _b(b, "r")), s, c.qx, c.qy));
    }

    /// Batch 0 has 12 leaves: the tree is 12 -> 6 -> 3 -> 2 -> 1, so the odd-node rule is exercised.
    function test_rootByHand() public view {
        bytes32[] memory l = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) {
            l[i] = vm.parseJsonBytes32(json, string.concat(_b(0, "readings["), vm.toString(i), "].leaf"));
        }
        bytes32 ab = l[0] < l[1] ? keccak256(abi.encode(l[0], l[1])) : keccak256(abi.encode(l[1], l[0]));
        bytes32 want = ab < l[2] ? keccak256(abi.encode(ab, l[2])) : keccak256(abi.encode(l[2], ab));
        assertEq(BatchMessage.root(l), want);
    }

    function test_ledgerAcceptsVectorBatches() public {
        address admin = makeAddr("admin");
        address ledgerAddr = vm.parseJsonAddress(json, ".ledger");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        deployCodeTo("PourLedger.sol:PourLedger", abi.encode(admin), ledgerAddr);
        PourLedger ledger = PourLedger(ledgerAddr);
        address supplier = makeAddr("supplier");
        address inspector = makeAddr("inspector");
        vm.startPrank(admin);
        ledger.grantRole(ledger.SUPPLIER_ROLE(), supplier);
        ledger.grantRole(ledger.INSPECTOR_ROLE(), inspector);
        vm.stopPrank();

        bytes32 pourId = vm.parseJsonBytes32(json, ".pourId");
        uint64 pourStart = uint64(vm.parseJsonUint(json, ".pourStart"));
        vm.warp(pourStart - 1 hours);
        vm.prank(supplier);
        ledger.createPour(pourId, 0, 0, 8000, 220, 250, pourStart);
        vm.prank(inspector);
        ledger.registerDevice(pourId, vm.parseJsonBytes32(json, ".qx"), vm.parseJsonBytes32(json, ".qy"), "simulated");
        for (uint256 b = 0; b < 3; b++) {
            ledger.appendBatch(
                pourId,
                uint64(vm.parseJsonUint(json, _b(b, "counter"))),
                uint64(vm.parseJsonUint(json, _b(b, "fromTs"))),
                uint64(vm.parseJsonUint(json, _b(b, "toTs"))),
                vm.parseJsonBytes32(json, _b(b, "root")),
                vm.parseJsonBytes32(json, _b(b, "r")),
                vm.parseJsonBytes32(json, _b(b, "s"))
            );
        }
        assertEq(ledger.nextCounter(pourId), 3);
    }

    /// Proofs come from the TypeScript side (packages/core/scripts/gen-proofs.ts); roots must match BatchMessage.root.
    function test_typescriptProofsVerifyWithOpenZeppelin() public view {
        string memory pj = vm.readFile("test/proofs.json");
        for (uint256 t = 0; t < 4; t++) {
            string memory p = string.concat(".trees[", vm.toString(t), "]");
            bytes32[] memory leaves = vm.parseJsonBytes32Array(pj, string.concat(p, ".leaves"));
            bytes32 root = vm.parseJsonBytes32(pj, string.concat(p, ".root"));
            assertEq(BatchMessage.root(leaves), root);
            if (t < 3) assertEq(root, vm.parseJsonBytes32(json, _b(t, "root")));
            for (uint256 i = 0; i < leaves.length; i++) {
                bytes32[] memory proof =
                    vm.parseJsonBytes32Array(pj, string.concat(p, ".proofs[", vm.toString(i), "]"));
                assertTrue(MerkleProof.verify(proof, root, leaves[i]));
                assertFalse(MerkleProof.verify(proof, root, keccak256(abi.encode(leaves[i]))));
            }
        }
    }
}
