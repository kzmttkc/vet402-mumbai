// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryHarness} from "./SealedDelivery.Base.t.sol";

/// EIP-3009 TransferWithAuthorization vector from the real Circle x402 batching scheme.
contract SealedDeliveryVectorTest is Test {
    struct Vec {
        string name;
        string version;
        uint256 chainId;
        address verifyingContract;
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes signature;
        address signer;
    }

    SealedDeliveryHarness internal h;
    Vec internal v;

    function setUp() public {
        h = new SealedDeliveryHarness();
        string memory j = vm.readFile("contracts/test/fixtures/eip3009-vector.json");
        v.name = vm.parseJsonString(j, ".domain.name");
        v.version = vm.parseJsonString(j, ".domain.version");
        v.chainId = vm.parseJsonUint(j, ".domain.chainId");
        v.verifyingContract = vm.parseJsonAddress(j, ".domain.verifyingContract");
        v.from = vm.parseJsonAddress(j, ".authorization.from");
        v.to = vm.parseJsonAddress(j, ".authorization.to");
        v.value = vm.parseJsonUint(j, ".authorization.value");
        v.validAfter = vm.parseJsonUint(j, ".authorization.validAfter");
        v.validBefore = vm.parseJsonUint(j, ".authorization.validBefore");
        v.nonce = vm.parseJsonBytes32(j, ".authorization.nonce");
        v.signature = vm.parseJsonBytes(j, ".signature");
        v.signer = vm.parseJsonAddress(j, ".signer");
    }

    function _auth() internal view returns (SealedDelivery.PaymentAuth memory) {
        return SealedDelivery.PaymentAuth(v.from, v.to, v.value, v.validAfter, v.validBefore, v.nonce);
    }

    function _independentDigest(SealedDelivery.PaymentAuth memory a) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(v.name)),
                keccak256(bytes(v.version)),
                v.chainId,
                v.verifyingContract
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
                ),
                a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
    }

    function _ecrecover(bytes32 digest, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 vv;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            vv := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(digest, vv, r, s);
    }

    function test_Vector_ParsesAsExpected() public view {
        assertEq(v.chainId, 5042002);
        assertEq(v.verifyingContract, 0x0077777d7EBA4688BDeF3E311b846F25870A19B9);
        assertEq(v.signature.length, 65);
    }

    function test_Vector_HarnessDigestRecoversSigner() public view {
        bytes32 digest = h.paymentDigest(_auth());
        assertEq(_ecrecover(digest, v.signature), v.signer, "ecrecover");
        assertTrue(h.isValidSignature(digest, v.signature, v.signer), "contract check");
        assertFalse(h.isValidSignature(digest, v.signature, address(0xBEEF)), "wrong expected signer");
    }

    function test_Vector_SignerEqualsFromAndSignerField() public view {
        bytes32 digest = h.paymentDigest(_auth());
        address rec = _ecrecover(digest, v.signature);
        assertEq(rec, v.signer);
        assertEq(rec, v.from);
        assertEq(v.signer, v.from);
    }

    function test_Vector_DigestMatchesIndependentComputation() public view {
        assertEq(h.paymentDigest(_auth()), _independentDigest(_auth()));
    }

    function test_Vector_TamperedValueDoesNotRecoverSigner() public view {
        SealedDelivery.PaymentAuth memory a = _auth();
        a.value += 1;
        bytes32 digest = h.paymentDigest(a);
        assertNotEq(_ecrecover(digest, v.signature), v.signer);
        assertFalse(h.isValidSignature(digest, v.signature, v.signer));
    }

    function test_Vector_TamperedOtherFieldsDoNotRecoverSigner() public view {
        SealedDelivery.PaymentAuth memory a = _auth();
        a.to = address(0xCAFE);
        assertFalse(h.isValidSignature(h.paymentDigest(a), v.signature, v.signer));
        a = _auth();
        a.nonce = bytes32(uint256(v.nonce) ^ 1);
        assertFalse(h.isValidSignature(h.paymentDigest(a), v.signature, v.signer));
        a = _auth();
        a.validBefore += 1;
        assertFalse(h.isValidSignature(h.paymentDigest(a), v.signature, v.signer));
    }
}
