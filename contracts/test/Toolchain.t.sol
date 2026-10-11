// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// Smoke test for the toolchain: remappings resolve and the libraries the ledger relies on are usable.
contract ToolchainTest is Test {
    function test_singleLeafMerkleRoot() public pure {
        bytes32 leaf = keccak256(abi.encode(uint64(1), int32(20_000)));
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(MerkleProof.verify(proof, leaf, leaf));
    }

    function test_p256RejectsZeroSignature() public view {
        assertFalse(P256.verify(bytes32(0), bytes32(0), bytes32(0), bytes32(0), bytes32(0)));
    }
}
