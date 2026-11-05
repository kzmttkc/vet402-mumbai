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
/// Gateway's batched domain at version "2" is salted with the token. Version "1" is not.
function _gatewaySalt(string memory version, address usdc) pure returns (bytes32) {
    return keccak256(bytes(version)) == keccak256("2") ? bytes32(uint256(uint160(usdc))) : bytes32(0);
}

/// The same contract set up for a token's own EIP-3009 domain, as plain x402 signs it: no salt at any version.
contract SealedDeliveryPlainDomainHarness is SealedDelivery {
    constructor(address usdc, string memory name, string memory version, address verifyingContract)
        SealedDelivery(3600, 60, 3660, usdc, name, version, verifyingContract, 0, bytes32(0))
    {}

    function paymentDigest(PaymentAuth memory a) external view returns (bytes32) {
        return _paymentDigest(a);
    }
}

contract SealedDeliveryHarness is SealedDelivery {
    constructor(address usdc, string memory name, string memory version, address verifyingContract)
        SealedDelivery(3600, 60, 3660, usdc, name, version, verifyingContract, 0, _gatewaySalt(version, usdc))
    {}

    function paymentDigest(PaymentAuth memory a) external view returns (bytes32) {
        return _paymentDigest(a);
    }

    function isValidSignature(bytes32 digest, bytes memory sig, address signer) external pure returns (bool) {
        return _isValidSignature(digest, sig, signer);
    }

    function claimIdOf(address seller, address buyer, bytes32 paymentNonce) external pure returns (bytes32) {
        return _claimId(seller, buyer, paymentNonce);
    }
}

/// Signing + claim helpers shared by the tests and the invariant handler.
abstract contract SDHelpers is Test {
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;
    address internal constant GATEWAY_WALLET = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9;
    string internal constant PAY_NAME = "GatewayWalletBatched";
    string internal constant PAY_VERSION = "1";
    bytes32 internal constant PROMISE_TYPEHASH = keccak256(
        "Promise(address seller,uint256 value,bytes32 paymentNonce,bytes32 keyHash,bytes32 plaintextHash,bytes32 ciphertextHash,uint64 expiry,address buyer)"
    );
    bytes32 internal constant PAY_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    address internal constant DEAD_ADDR = 0x000000000000000000000000000000000000dEaD;
    bytes internal constant KEY = "sealed-key";

    SealedDelivery internal sd;
    MockUSDC internal usdc;
    mapping(address => uint256) internal pkOf;

    /// Independent re-computation of the contract's claim key.
    function _cid(address seller, address buyer_, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(seller, buyer_, nonce));
    }

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

    uint256 internal disputeCost;

    function _deploy(uint256 maxExpiry, uint256 window, uint256 cooldown) internal returns (SealedDelivery) {
        return new SealedDelivery(maxExpiry, window, cooldown, USDC_ADDR, PAY_NAME, PAY_VERSION, GATEWAY_WALLET, disputeCost, bytes32(0));
    }

    function _sdDomain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("SealedDelivery"), keccak256("1"), block.chainid, address(sd))
        );
    }

    function _gwDomain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes(PAY_NAME)), keccak256(bytes(PAY_VERSION)), block.chainid, GATEWAY_WALLET
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

    function _authDigest(SealedDelivery.PaymentAuth memory a) internal view returns (bytes32) {
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

    /// Independent keystream: block i = keccak256(abi.encodePacked(key, uint256(i))), XOR per 32-byte chunk,
    /// last chunk truncated. XOR is its own inverse, so this both encrypts and decrypts.
    function _xorStream(bytes memory data, bytes memory key) internal pure returns (bytes memory out) {
        out = new bytes(data.length);
        for (uint256 i; i < data.length; i += 32) {
            bytes32 ks = keccak256(abi.encodePacked(key, i / 32));
            for (uint256 j; j < 32 && i + j < data.length; ++j) {
                out[i + j] = data[i + j] ^ ks[j];
            }
        }
    }

    /// Deterministic pseudo-random bytes of a given length.
    function _bytesOf(uint256 len, bytes32 seed) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i += 32) {
            bytes32 w = keccak256(abi.encode(seed, i));
            for (uint256 j; j < 32 && i + j < len; ++j) {
                b[i + j] = w[j];
            }
        }
    }

    /// Promise for a sealed delivery: honest => plaintextHash matches the decrypted ciphertext,
    /// otherwise the seller signed a different plaintextHash than what the key/ciphertext decrypt to.
    function _sealedProm(
        address seller,
        address buyer_,
        uint256 value,
        bytes32 nonce,
        bytes memory key,
        bytes memory plain,
        bool honest
    ) internal view returns (SealedDelivery.Promise memory p, bytes memory ct) {
        ct = _xorStream(plain, key);
        p = _prom(seller, buyer_, value, nonce);
        p.keyHash = keccak256(key);
        p.ciphertextHash = keccak256(ct);
        p.plaintextHash = honest ? keccak256(plain) : keccak256(abi.encodePacked("promised-other", plain));
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
    /// claimId of (sellerA, buyer, N1) - the default claim used across suites.
    bytes32 internal id1;

    function setUp() public virtual {
        vm.warp(T0);
        _etchUsdc();
        sd = _deploy(MAX_EXPIRY, WINDOW, COOLDOWN);
        sellerA = _newActor("sellerA");
        sellerB = _newActor("sellerB");
        buyer = _newActor("buyer");
        buyer2 = _newActor("buyer2");
        carol = makeAddr("carol");
        id1 = _cid(sellerA, buyer, N1);
    }

    function _status(bytes32 id) internal view returns (SealedDelivery.Status st) {
        (,,,,, st,,,) = sd.claims(id);
    }

    function _claimData(bytes32 id) internal view returns (address s, address b, uint256 r, uint64 dl, bytes32 kh) {
        (s, b, r, dl, kh,,,,) = sd.claims(id);
    }

    function _claimNonce(bytes32 id) internal view returns (bytes32 n) {
        (,,,,,, n,,) = sd.claims(id);
    }

    function _claimHashes(bytes32 id) internal view returns (bytes32 ph, bytes32 ch) {
        (,,,,,,, ph, ch) = sd.claims(id);
    }

    /// Buyer's rounded-up half and the burned remainder of a payout amount.
    function _paid(uint256 r) internal pure returns (uint256) {
        return r / 2 + (r % 2);
    }

    function _burnt(uint256 r) internal pure returns (uint256) {
        return r - _paid(r);
    }

    /// Everything burned so far: queued in pendingBurn plus already flushed to DEAD.
    function _burnTotal() internal view returns (uint256) {
        return sd.pendingBurn() + usdc.balanceOf(DEAD_ADDR);
    }

    /// Creates a sealed claim (submitted by `buyer_`) and returns its id and ciphertext.
    function _sealedClaim(
        address seller,
        address buyer_,
        uint256 value,
        bytes32 nonce,
        bytes memory key,
        bytes memory plain,
        bool honest
    ) internal returns (bytes32 id, bytes memory ct) {
        SealedDelivery.Promise memory p;
        (p, ct) = _sealedProm(seller, buyer_, value, nonce, key, plain, honest);
        _claimOk(p);
        id = _cid(seller, buyer_, nonce);
    }
}
