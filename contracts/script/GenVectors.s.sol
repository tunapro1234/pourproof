// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {BatchMessage} from "../src/BatchMessage.sol";

/// @notice Writes contracts/test/vectors.json: 3 signed batches of 12 readings each, for cross-checking the
///  TypeScript device code against the Solidity message format.
///  forge script script/GenVectors.s.sol --root contracts
/// @dev The device key is TEST-ONLY: sha256 of a public seed string. Anyone can rebuild it; never use it for real data.
///  Readings are the first 36 half-hour readings of Box 1 in the Mendeley dataset nmr8pjx8d8 (CC BY 4.0), in milli-degC.
contract GenVectors is Script {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    string internal constant SEED = "POURPROOF TEST-ONLY DEVICE KEY v1";
    string internal constant POUR_LABEL = "P-001";
    uint256 internal constant CHAIN_ID = 31337;
    uint64 internal constant POUR_START = 1_760_000_000;
    uint256 internal constant BATCHES = 3;
    uint256 internal constant PER_BATCH = 12;

    function ledgerAddress() public pure returns (address) {
        return address(uint160(uint256(keccak256("pourproof.test-vectors.ledger"))));
    }

    function devicePk() public pure returns (uint256 pk) {
        pk = uint256(sha256(bytes(SEED)));
        require(pk > 0 && pk < P256_N, "seed gives invalid key");
    }

    function box1MilliC() public pure returns (int32[36] memory) {
        return [
            int32(21440), 21630, 22000, 22500, 23130, 23810, 24500, 25310, 26060, 26940, 27750, 28630,
            29440, 30250, 30940, 31690, 32310, 32940, 33630, 34190, 34690, 35190, 35630, 35940,
            36190, 36380, 36500, 36440, 36380, 36250, 36060, 35880, 35630, 35380, 35130, 34880
        ];
    }

    function run() external {
        vm.writeFile("test/vectors.json", build());
    }

    function build() public pure returns (string memory json) {
        uint256 pk = devicePk();
        (uint256 qx, uint256 qy) = vm.publicKeyP256(pk);
        bytes32 pourId = keccak256(bytes(POUR_LABEL));
        json = string.concat(
            "{\n",
            '  "description": "PourProof device message test vectors. TEST-ONLY KEY: derived from a public seed, never use it for real data.",\n',
            '  "generator": "contracts/script/GenVectors.s.sol",\n',
            '  "test_only_key": {"seed": "', SEED, '", "derivation": "private key = sha256(utf8(seed)) read as a big-endian integer"},\n',
            '  "qx": "', vm.toString(bytes32(qx)), '",\n',
            '  "qy": "', vm.toString(bytes32(qy)), '",\n',
            '  "domain": "', BatchMessage.DOMAIN, '",\n',
            '  "chainId": ', vm.toString(CHAIN_ID), ",\n",
            '  "ledger": "', vm.toString(ledgerAddress()), '",\n',
            '  "pourLabel": "', POUR_LABEL, '",\n',
            '  "pourId": "', vm.toString(pourId), '",\n',
            '  "pourIdDerivation": "keccak256(utf8(pourLabel))",\n',
            '  "pourStart": ', vm.toString(uint256(POUR_START)), ",\n"
        );
        json = string.concat(
            json,
            '  "readingsSource": "Box 1, first 36 half-hour readings, Mendeley Data nmr8pjx8d8 v1 (CC BY 4.0); t_unix = pourStart + t_h * 3600",\n',
            '  "leaf": "keccak256(abi.encode(uint64 t_unix, int32 temp_milliC))",\n',
            '  "root": "pairs hashed sorted (OpenZeppelin Hashes.commutativeKeccak256), leaves in reading order, odd last node carried up",\n',
            '  "digest": "sha256(abi.encode(string domain, uint256 chainId, address ledger, bytes32 pourId, uint64 counter, uint64 fromTs, uint64 toTs, bytes32 root))",\n',
            '  "signature": "P-256 ECDSA over digest (no extra hashing), RFC 6979 nonce, low-s (s <= n/2)",\n',
            '  "batchCount": ', vm.toString(BATCHES), ",\n",
            '  "readingsPerBatch": ', vm.toString(PER_BATCH), ",\n",
            '  "batches": [\n'
        );
        for (uint256 b = 0; b < BATCHES; b++) {
            json = string.concat(json, _batchJson(pk, pourId, uint64(b)), b + 1 < BATCHES ? ",\n" : "\n");
        }
        json = string.concat(json, "  ]\n}\n");
    }

    function _batchJson(uint256 pk, bytes32 pourId, uint64 counter) internal pure returns (string memory out) {
        int32[36] memory temps = box1MilliC();
        bytes32[] memory leaves = new bytes32[](PER_BATCH);
        string memory readings;
        uint64 fromTs;
        uint64 toTs;
        for (uint256 i = 0; i < PER_BATCH; i++) {
            uint256 k = counter * PER_BATCH + i;
            uint64 t = POUR_START + uint64((k + 1) * 1800); // t_h = 0.5 h, 1.0 h, ...
            if (i == 0) fromTs = t;
            toTs = t;
            leaves[i] = BatchMessage.leaf(t, temps[k]);
            readings = string.concat(
                readings,
                '        {"t_unix": ', vm.toString(uint256(t)),
                ', "temp_milliC": ', vm.toString(int256(temps[k])),
                ', "leaf": "', vm.toString(leaves[i]), '"}',
                i + 1 < PER_BATCH ? ",\n" : "\n"
            );
        }
        bytes32 root = BatchMessage.root(leaves);
        bytes32 h = BatchMessage.digest(CHAIN_ID, ledgerAddress(), pourId, counter, fromTs, toTs, root);
        (bytes32 r, bytes32 s) = vm.signP256(pk, h);
        if (uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        out = string.concat(
            '    {"counter": ', vm.toString(uint256(counter)),
            ', "fromTs": ', vm.toString(uint256(fromTs)),
            ', "toTs": ', vm.toString(uint256(toTs)), ",\n",
            '      "readings": [\n', readings, "      ],\n"
        );
        out = string.concat(
            out,
            '      "root": "', vm.toString(root), '",\n',
            '      "digest": "', vm.toString(h), '",\n',
            '      "r": "', vm.toString(r), '",\n',
            '      "s": "', vm.toString(s), '"}'
        );
    }
}
