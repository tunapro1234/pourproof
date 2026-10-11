// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @title DeviceRegistry
/// @notice Binds one P-256 device key to each pour. Only an inspector registers or replaces it.
/// @dev Abstract: PourLedger inherits it, so the device key, the batches and the roles live at one address.
abstract contract DeviceRegistry is AccessControl {
    bytes32 public constant SUPPLIER_ROLE = keccak256("SUPPLIER");
    bytes32 public constant CONTRACTOR_ROLE = keccak256("CONTRACTOR");
    bytes32 public constant INSPECTOR_ROLE = keccak256("INSPECTOR");
    bytes32 public constant OWNER_ROLE = keccak256("OWNER");

    struct Device {
        bytes32 qx;
        bytes32 qy;
        string kind; // "esp32" | "simulated"
    }

    mapping(bytes32 pourId => Device) private _devices;

    event DeviceRegistered(bytes32 indexed pourId, bytes32 qx, bytes32 qy, string deviceKind);
    event DeviceReplaced(bytes32 indexed pourId, bytes32 oldQx, bytes32 oldQy, bytes32 qx, bytes32 qy, string deviceKind);

    error UnknownPour(bytes32 pourId);
    error DeviceAlreadyRegistered(bytes32 pourId);
    error NoDevice(bytes32 pourId);
    error InvalidDeviceKey();
    error InvalidDeviceKind(string deviceKind);

    function registerDevice(bytes32 pourId, bytes32 qx, bytes32 qy, string calldata deviceKind)
        external
        onlyRole(INSPECTOR_ROLE)
    {
        if (!_pourExists(pourId)) revert UnknownPour(pourId);
        if (_devices[pourId].qx != 0 || _devices[pourId].qy != 0) revert DeviceAlreadyRegistered(pourId);
        _checkDevice(qx, qy, deviceKind);
        _devices[pourId] = Device(qx, qy, deviceKind);
        emit DeviceRegistered(pourId, qx, qy, deviceKind);
    }

    /// @notice Swap a failed device. The batch counter continues; later batches must be signed by the new key.
    function replaceDevice(bytes32 pourId, bytes32 qx, bytes32 qy, string calldata deviceKind)
        external
        onlyRole(INSPECTOR_ROLE)
    {
        Device storage d = _devices[pourId];
        if (d.qx == 0 && d.qy == 0) revert NoDevice(pourId);
        _checkDevice(qx, qy, deviceKind);
        emit DeviceReplaced(pourId, d.qx, d.qy, qx, qy, deviceKind);
        _devices[pourId] = Device(qx, qy, deviceKind);
    }

    function deviceOf(bytes32 pourId) public view returns (Device memory) {
        return _devices[pourId];
    }

    function _checkDevice(bytes32 qx, bytes32 qy, string calldata deviceKind) private pure {
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidDeviceKey();
        bytes32 k = keccak256(bytes(deviceKind));
        if (k != keccak256("esp32") && k != keccak256("simulated")) revert InvalidDeviceKind(deviceKind);
    }

    function _pourExists(bytes32 pourId) internal view virtual returns (bool);
}
