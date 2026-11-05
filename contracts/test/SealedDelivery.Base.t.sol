// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SealedDelivery} from "../SealedDelivery.sol";

/// 6-decimals mock etched at the canonical USDC address.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Exposes the internal signature helpers for the EIP-3009 vector test.
contract SealedDeliveryHarness is SealedDelivery {
    constructor() SealedDelivery(3600, 60, 3660) {}

    function paymentDigest(PaymentAuth memory a) external view returns (bytes32) {
        return _paymentDigest(a);
    }

    function isValidSignature(bytes32 digest, bytes memory sig, address signer) external pure returns (bool) {
        return _isValidSignature(digest, sig, signer);
    }
}

/// Signing + claim helpers shared by the tests and the invariant handler.
abstract contract SDHelpers is Test {
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    bytes32 internal constant PROMISE_TYPEHASH = keccak256(
        "Promise(address seller,uint256 value,bytes32 paymentNonce,bytes32 keyHash,bytes32 plaintextHash,bytes32 ciphertextHash,uint64 expiry,address buyer)"
    );
    bytes32 internal constant PAY_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes internal constant KEY = "sealed-key";

    SealedDelivery internal sd;
    MockUSDC internal usdc;
    mapping(address => uint256) internal pkOf;

    function _newActor(string memory label) internal returns (address a) {
        uint256 pk;
        (a, pk) = makeAddrAndKey(label);
        pkOf[a] = pk;
    }

    function _etchUsdc() internal {
        MockUSDC m = new MockUSDC();
        vm.etch(USDC_ADDR, address(m).code);
        usdc = MockUSDC(USDC_ADDR);
    }

    function _sdDomain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("SealedDelivery"), keccak256("1"), block.chainid, address(sd))
        );
    }

    function _gwDomain() internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("GatewayWalletBatched"),
                keccak256("1"),
                uint256(5042002),
                address(0x0077777d7EBA4688BDeF3E311b846F25870A19B9)
            )
        );
    }

    function _promiseDigest(SealedDelivery.Promise memory p) internal view returns (bytes32) {
        bytes32 sh = keccak256(
            abi.encode(
                PROMISE_TYPEHASH, p.seller, p.value, p.paymentNonce, p.keyHash,
                p.plaintextHash, p.ciphertextHash, p.expiry, p.buyer
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _sdDomain(), sh));
    }

    function _authDigest(SealedDelivery.PaymentAuth memory a) internal pure returns (bytes32) {
        bytes32 sh = keccak256(abi.encode(PAY_TYPEHASH, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce));
        return keccak256(abi.encodePacked("\x19\x01", _gwDomain(), sh));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _prom(address seller, address buyer_, uint256 value, bytes32 nonce)
        internal
        view
        returns (SealedDelivery.Promise memory p)
    {
        p = SealedDelivery.Promise({
            seller: seller,
            value: value,
            paymentNonce: nonce,
            keyHash: keccak256(KEY),
            plaintextHash: keccak256("plain"),
            ciphertextHash: keccak256("cipher"),
            expiry: uint64(block.timestamp + 1000),
            buyer: buyer_
        });
    }

    function _authFor(SealedDelivery.Promise memory p) internal pure returns (SealedDelivery.PaymentAuth memory) {
        return SealedDelivery.PaymentAuth({
            from: p.buyer,
            to: p.seller,
            value: p.value,
            validAfter: 0,
            validBefore: type(uint256).max,
            nonce: p.paymentNonce
        });
    }

    function _sellerSig(SealedDelivery.Promise memory p) internal view returns (bytes memory) {
        return _sign(pkOf[p.seller], _promiseDigest(p));
    }

    function _buyerSig(SealedDelivery.PaymentAuth memory a) internal view returns (bytes memory) {
        return _sign(pkOf[a.from], _authDigest(a));
    }

    /// Fully valid claim submitted by p.buyer.
    function _claimOk(SealedDelivery.Promise memory p) internal {
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory ss = _sellerSig(p);
        bytes memory bs = _buyerSig(a);
        vm.prank(p.buyer);
        sd.claim(p, ss, a, bs);
    }

    /// Raw claim; pass err == bytes4(0) to expect success.
    function _claimRaw(
        SealedDelivery.Promise memory p,
        bytes memory ss,
        SealedDelivery.PaymentAuth memory a,
        bytes memory bs,
        address caller,
        bytes4 err
    ) internal {
        vm.prank(caller);
        if (err != bytes4(0)) vm.expectRevert(err);
        sd.claim(p, ss, a, bs);
    }

    function _fund(address seller, uint256 amt) internal {
        usdc.mint(seller, amt);
        vm.startPrank(seller);
        usdc.approve(address(sd), amt);
        sd.deposit(amt);
        vm.stopPrank();
    }
}

abstract contract SealedDeliveryTestBase is SDHelpers {
    uint256 internal constant MAX_EXPIRY = 3600;
    uint256 internal constant WINDOW = 60;
    uint256 internal constant COOLDOWN = 3660;
    uint256 internal constant T0 = 1_000_000;

    bytes32 internal constant N1 = keccak256("n1");
    bytes32 internal constant N2 = keccak256("n2");

    address internal sellerA;
    address internal sellerB;
    address internal buyer;
    address internal buyer2;
    address internal carol;

    function setUp() public virtual {
        vm.warp(T0);
        _etchUsdc();
        sd = new SealedDelivery(MAX_EXPIRY, WINDOW, COOLDOWN);
        sellerA = _newActor("sellerA");
        sellerB = _newActor("sellerB");
        buyer = _newActor("buyer");
        buyer2 = _newActor("buyer2");
        carol = makeAddr("carol");
    }

    function _status(bytes32 nonce) internal view returns (SealedDelivery.Status st) {
        (,,,,, st) = sd.claims(nonce);
    }

    function _claimData(bytes32 nonce) internal view returns (address s, address b, uint256 r, uint64 dl, bytes32 kh) {
        (s, b, r, dl, kh,) = sd.claims(nonce);
    }
}
