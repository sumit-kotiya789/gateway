// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Forwarder} from "../src/Forwarder.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {MockERC20} from "../src/Mocks.sol";

/// Minimal Foundry cheatcodes (no forge-std dependency).
interface Vm {
    function deal(address who, uint256 amount) external;
    function assume(bool condition) external pure;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
}

/// USDT-on-Ethereum style: transfer returns nothing.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address to, uint256 v) external {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
    }
}

/// Returns false instead of reverting.
contract FalseERC20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }
}

contract ForwarderTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant MERCHANT = address(0xBEEF);
    address private constant PLATFORM = address(0xFEE);
    bytes32 private constant SALT = keccak256("invoice-1");

    ForwarderFactory private factory;
    MockERC20 private usdt;

    function setUp() public {
        factory = new ForwarderFactory();
        usdt = new MockERC20("sastaUSDT", "sastaUSDT", 18);
    }

    function _eq(uint256 a, uint256 b, string memory what) private pure {
        require(a == b, what);
    }

    function _flushOne(bytes32 salt, address token, uint16 bps, uint256 cap, address asset) private returns (address) {
        address[] memory assets = new address[](1);
        assets[0] = asset;
        return factory.deployAndFlush(salt, MERCHANT, PLATFORM, token, bps, cap, assets);
    }

    /// Callers pass at most uint128 amounts, so the plain formula cannot overflow.
    function _feeOn(uint256 amount, uint16 bps) private pure returns (uint256) {
        return (amount * bps) / 10_000;
    }

    function test_predictedAddressIsWhereItDeploys() public {
        address predicted = factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18);
        usdt.mint(predicted, 100e18);
        address deployed = _flushOne(SALT, address(usdt), 100, 1e18, address(usdt));
        require(deployed == predicted, "deployed at predicted address");
        require(predicted.code.length > 0, "code deployed");
        Forwarder f = Forwarder(payable(predicted));
        require(f.merchant() == MERCHANT && f.feeRecipient() == PLATFORM && f.token() == address(usdt), "params");
    }

    function test_anyChangedArgumentIsAnotherAddress() public view {
        address a = factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18);
        require(a != factory.predict(keccak256("other"), MERCHANT, PLATFORM, address(usdt), 100, 1e18), "salt");
        require(a != factory.predict(SALT, address(0xBAD), PLATFORM, address(usdt), 100, 1e18), "merchant");
        require(a != factory.predict(SALT, MERCHANT, address(0xBAD), address(usdt), 100, 1e18), "fee recipient");
        require(a != factory.predict(SALT, MERCHANT, PLATFORM, address(0xBAD), 100, 1e18), "token");
        require(a != factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 101, 1e18), "fee bps");
        require(a != factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18 + 1), "fee cap");
    }

    function test_onePercentOfExactPayment() public {
        address dep = factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18);
        usdt.mint(dep, 100e18);
        _flushOne(SALT, address(usdt), 100, 1e18, address(usdt));
        _eq(usdt.balanceOf(MERCHANT), 99e18, "merchant gets 99");
        _eq(usdt.balanceOf(PLATFORM), 1e18, "platform gets 1");
        _eq(usdt.balanceOf(dep), 0, "forwarder empty");
    }

    /// Fee = floor(received * bps / 10000), never above the fee on the invoice amount; nothing is lost.
    function testFuzz_splitAndCap(uint128 received, uint128 invoiceAmount, uint16 bps) public {
        vm.assume(bps <= 10_000);
        uint256 cap = _feeOn(invoiceAmount, bps);
        bytes32 salt = keccak256(abi.encode(received, invoiceAmount, bps));
        address dep = factory.predict(salt, MERCHANT, PLATFORM, address(usdt), bps, cap);
        usdt.mint(dep, received);
        uint256 m0 = usdt.balanceOf(MERCHANT);
        uint256 p0 = usdt.balanceOf(PLATFORM);
        _flushOne(salt, address(usdt), bps, cap, address(usdt));
        uint256 fee = usdt.balanceOf(PLATFORM) - p0;
        // Independent oracle: plain multiply-then-divide cannot overflow for uint128 inputs.
        uint256 expected = (uint256(received) * bps) / 10_000;
        _eq(Forwarder(payable(dep)).feeOn(received), expected, "feeOn is exact");
        _eq(cap, (uint256(invoiceAmount) * bps) / 10_000, "cap is exact");
        if (expected > cap) expected = cap;
        _eq(fee, expected, "fee");
        _eq(usdt.balanceOf(MERCHANT) - m0 + fee, received, "conserved");
        _eq(usdt.balanceOf(dep), 0, "empty");
    }

    function test_latePaymentsShareOneCap() public {
        // Invoice of 100 at 1%: cap 1. Two payments of 60 each.
        address dep = factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18);
        usdt.mint(dep, 60e18);
        _flushOne(SALT, address(usdt), 100, 1e18, address(usdt));
        _eq(usdt.balanceOf(PLATFORM), 0.6e18, "first fee 0.6");
        usdt.mint(dep, 60e18);
        _flushOne(SALT, address(usdt), 100, 1e18, address(usdt)); // already deployed: flush only
        _eq(usdt.balanceOf(PLATFORM), 1e18, "total fee capped at 1");
        _eq(usdt.balanceOf(MERCHANT), 119e18, "merchant gets the rest");
        _eq(Forwarder(payable(dep)).feeTaken(), 1e18, "feeTaken");
        usdt.mint(dep, 50e18);
        Forwarder(payable(dep)).flush(address(usdt)); // anyone can flush directly
        _eq(usdt.balanceOf(PLATFORM), 1e18, "no fee after the cap");
        _eq(usdt.balanceOf(MERCHANT), 169e18, "all to merchant");
    }

    function test_otherTokenGoesToMerchantWithoutFee() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        address dep = factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18);
        other.mint(dep, 500e6);
        _flushOne(SALT, address(usdt), 100, 1e18, address(other));
        _eq(other.balanceOf(MERCHANT), 500e6, "all to merchant");
        _eq(other.balanceOf(PLATFORM), 0, "no fee");
    }

    function test_nativeCoinGoesToMerchant() public {
        address dep = factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18);
        vm.deal(dep, 2 ether);
        uint256 before = MERCHANT.balance;
        _flushOne(SALT, address(usdt), 100, 1e18, address(0));
        _eq(MERCHANT.balance - before, 2 ether, "native to merchant");
        _eq(dep.balance, 0, "empty");
    }

    function test_tokenWithoutReturnValue() public {
        NoReturnERC20 t = new NoReturnERC20();
        address dep = factory.predict(SALT, MERCHANT, PLATFORM, address(t), 100, 1e18);
        t.mint(dep, 100e18);
        _flushOne(SALT, address(t), 100, 1e18, address(t));
        _eq(t.balanceOf(MERCHANT), 99e18, "merchant");
        _eq(t.balanceOf(PLATFORM), 1e18, "platform");
    }

    function test_tokenReturningFalseReverts() public {
        FalseERC20 t = new FalseERC20();
        address dep = factory.predict(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18);
        t.mint(dep, 1e18);
        address[] memory assets = new address[](1);
        assets[0] = address(t);
        vm.expectRevert(abi.encodeWithSelector(Forwarder.TransferFailed.selector, address(t)));
        factory.deployAndFlush(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18, assets);
    }

    function test_emptyBalanceIsANoOp() public {
        address dep = _flushOne(SALT, address(usdt), 100, 1e18, address(usdt));
        require(dep.code.length > 0, "deployed");
        _eq(usdt.balanceOf(MERCHANT), 0, "nothing moved");
    }

    function test_badParamsRefused() public {
        address[] memory assets = new address[](1);
        assets[0] = address(usdt);
        vm.expectRevert(Forwarder.BadParams.selector);
        factory.deployAndFlush(SALT, address(0), PLATFORM, address(usdt), 100, 1e18, assets);
        vm.expectRevert(Forwarder.BadParams.selector);
        factory.deployAndFlush(SALT, MERCHANT, PLATFORM, address(usdt), 10_001, 1e18, assets);
        vm.expectRevert(Forwarder.BadParams.selector);
        factory.deployAndFlush(SALT, MERCHANT, PLATFORM, address(0x1234), 100, 1e18, assets); // token without code
        vm.expectRevert(ForwarderFactory.EmptyAssets.selector);
        factory.deployAndFlush(SALT, MERCHANT, PLATFORM, address(usdt), 100, 1e18, new address[](0));
    }

    function test_feeOnNeverOverflows() public {
        address dep = _flushOne(SALT, address(usdt), 10_000, type(uint256).max, address(usdt));
        Forwarder f = Forwarder(payable(dep));
        _eq(f.feeOn(type(uint256).max), type(uint256).max, "100% of max");
    }
}
