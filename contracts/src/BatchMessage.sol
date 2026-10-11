// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title BatchMessage
/// @notice The device message format, shared with packages/core (TypeScript) and checked against contracts/test/vectors.json.
///  - reading leaf: keccak256(bytes.concat(0x00, abi.encode(uint64 t_unix, int32 temp_milliC)))
///  - internal node: keccak256(bytes.concat(0x01, min(a, b), max(a, b)))
///  - batch root: leaves stay in reading order; on an odd level the last node is carried up unchanged.
///    Proofs verify with OpenZeppelin MerkleProof.verify(proof, root, leaf, BatchMessage.node).
///  The 0x00 / 0x01 prefixes (as in RFC 6962) keep leaf and node preimages apart: without them a leaf is the
///  keccak of 64 bytes, exactly like a node, so an internal node could be passed off as a reading.
///  - signed digest: sha256(abi.encode("POURPROOF_BATCH_V1", chainId, ledger, pourId, counter, fromTs, toTs, root))
library BatchMessage {
    string internal constant DOMAIN = "POURPROOF_BATCH_V1";

    function leaf(uint64 tUnix, int32 tempMilliC) internal pure returns (bytes32) {
        return keccak256(bytes.concat(bytes1(0x00), abi.encode(tUnix, tempMilliC)));
    }

    function node(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(bytes.concat(bytes1(0x01), a, b)) : keccak256(bytes.concat(bytes1(0x01), b, a));
    }

    function verify(bytes32[] memory proof, bytes32 batchRoot, bytes32 readingLeaf) internal view returns (bool) {
        return MerkleProof.verify(proof, batchRoot, readingLeaf, node);
    }

    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        require(n > 0, "empty batch");
        bytes32[] memory level = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            level[i] = leaves[i];
        }
        while (n > 1) {
            uint256 m = (n + 1) / 2;
            for (uint256 i = 0; i < n / 2; i++) {
                level[i] = node(level[2 * i], level[2 * i + 1]);
            }
            if (n % 2 == 1) level[m - 1] = level[n - 1];
            n = m;
        }
        return level[0];
    }

    function digest(
        uint256 chainId,
        address ledger,
        bytes32 pourId,
        uint64 counter,
        uint64 fromTs,
        uint64 toTs,
        bytes32 batchRoot
    ) internal pure returns (bytes32) {
        return sha256(abi.encode(DOMAIN, chainId, ledger, pourId, counter, fromTs, toTs, batchRoot));
    }
}
