// SPDX-License-Identifier: MIT
// MONEY-CRITICAL. Forwarder custody mode (D-097). Audit required before any mainnet use.
pragma solidity 0.8.28;

/// @notice One per invoice. ForwarderFactory deploys it with CREATE2 at an address that commits to every constructor
/// argument, so the deposit address shown to the payer can only ever pay `merchant` (and the capped platform fee).
/// No owner, no upgrade, no admin function, no other destination. Anyone may call `flush`: a merchant can always move
/// late payments out themselves.
contract Forwarder {
    uint256 private constant BPS = 10_000;

    /// @notice Where everything goes (minus the fee on the invoice token).
    address public immutable merchant;
    /// @notice Platform fee wallet.
    address public immutable feeRecipient;
    /// @notice The invoice token: the only token a fee is taken on.
    address public immutable token;
    /// @notice Fee rate in basis points (100 = 1%).
    uint16 public immutable feeBps;
    /// @notice Total fee ever taken on `token`: the fee on the invoice amount, so an overpayment is never charged.
    uint256 public immutable feeCap;
    /// @notice Fee taken so far on `token` (never above `feeCap`).
    uint256 public feeTaken;

    event Flushed(address indexed asset, uint256 toMerchant, uint256 fee);

    error BadParams();
    error TransferFailed(address asset);

    constructor(address merchant_, address feeRecipient_, address token_, uint16 feeBps_, uint256 feeCap_) {
        if (merchant_ == address(0) || feeRecipient_ == address(0) || token_.code.length == 0 || feeBps_ > BPS) revert BadParams();
        merchant = merchant_;
        feeRecipient = feeRecipient_;
        token = token_;
        feeBps = feeBps_;
        feeCap = feeCap_;
    }

    /// @notice Accepts the native coin (sent by mistake); `flushNative` passes it on.
    receive() external payable {}

    /// @notice Sends this contract's whole balance of `asset` on: fee (invoice token only, capped) to the platform,
    /// the rest to the merchant.
    function flush(address asset) external returns (uint256 toMerchant, uint256 fee) {
        uint256 bal = _balanceOf(asset);
        if (bal == 0) return (0, 0);
        if (asset == token) {
            fee = feeOn(bal);
            uint256 room = feeCap - feeTaken;
            if (fee > room) fee = room;
            feeTaken += fee;
        }
        toMerchant = bal - fee;
        if (fee > 0) _transfer(asset, feeRecipient, fee);
        _transfer(asset, merchant, toMerchant);
        emit Flushed(asset, toMerchant, fee);
    }

    /// @notice Sends the whole native-coin balance to the merchant (no fee).
    function flushNative() external returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) return 0;
        (bool ok, ) = merchant.call{value: amount}("");
        if (!ok) revert TransferFailed(address(0));
        emit Flushed(address(0), amount, 0);
    }

    /// @notice floor(amount * feeBps / 10000) without overflow for any uint256 amount. Exact, not an approximation:
    /// amount = q*10000 + r, so amount*bps/10000 = q*bps + r*bps/10000 and only the last term is floored.
    function feeOn(uint256 amount) public view returns (uint256) {
        // forge-lint: disable-next-line(divide-before-multiply)
        return (amount / BPS) * feeBps + ((amount % BPS) * feeBps) / BPS;
    }

    function _balanceOf(address asset) private view returns (uint256) {
        if (asset.code.length == 0) revert TransferFailed(asset);
        (bool ok, bytes memory ret) = asset.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert TransferFailed(asset);
        return abi.decode(ret, (uint256));
    }

    /// @dev ERC-20 transfer that accepts tokens returning a bool and tokens returning nothing.
    function _transfer(address asset, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert TransferFailed(asset);
    }
}
