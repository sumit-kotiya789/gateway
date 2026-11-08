// SPDX-License-Identifier: MIT
// MONEY-CRITICAL. Forwarder custody mode (D-097). Audit required before any mainnet use.
pragma solidity 0.8.28;

import {Forwarder} from "./Forwarder.sol";

/// @notice Deploys per-invoice Forwarders with CREATE2 and flushes them. Stateless and permissionless: the address
/// commits to every constructor argument, so calling it with other arguments only reaches another address.
contract ForwarderFactory {
    event Deployed(address indexed forwarder, bytes32 indexed salt);

    error EmptyAssets();

    /// @notice The deposit address for these arguments (whether or not it is deployed yet).
    function predict(bytes32 salt, address merchant, address feeRecipient, address token, uint16 feeBps, uint256 feeCap)
        public
        view
        returns (address)
    {
        bytes32 initHash = keccak256(
            abi.encodePacked(type(Forwarder).creationCode, abi.encode(merchant, feeRecipient, token, feeBps, feeCap))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash)))));
    }

    /// @notice Deploys the forwarder if it is not there yet, then flushes each asset (address(0) = native coin).
    function deployAndFlush(
        bytes32 salt,
        address merchant,
        address feeRecipient,
        address token,
        uint16 feeBps,
        uint256 feeCap,
        address[] calldata assets
    ) external returns (address forwarder) {
        if (assets.length == 0) revert EmptyAssets();
        forwarder = predict(salt, merchant, feeRecipient, token, feeBps, feeCap);
        if (forwarder.code.length == 0) {
            new Forwarder{salt: salt}(merchant, feeRecipient, token, feeBps, feeCap);
            emit Deployed(forwarder, salt);
        }
        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == address(0)) Forwarder(payable(forwarder)).flushNative();
            else Forwarder(payable(forwarder)).flush(assets[i]);
        }
    }
}
