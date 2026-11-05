// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// Cross-check against a keystream vector produced outside Solidity (contracts/test/fixtures/sealed-vector.json).
contract SealedDeliverySealedTest is SealedDeliveryTestBase {
    uint256 internal constant DEP = 500e6;
    uint256 internal constant VAL = 100e6;

    bytes internal fKey;
    bytes internal fPlain;
    bytes internal fCipher;
    bytes32 internal fKeyHash;
    bytes32 internal fPlainHash;
    bytes32 internal fCipherHash;
    string internal fPlainUtf8;

    function setUp() public override {
        super.setUp();
        string memory j = vm.readFile("contracts/test/fixtures/sealed-vector.json");
        fKey = vm.parseJsonBytes(j, ".key");
        fPlain = vm.parseJsonBytes(j, ".plaintext");
        fCipher = vm.parseJsonBytes(j, ".ciphertext");
        fKeyHash = vm.parseJsonBytes32(j, ".keyHash");
        fPlainHash = vm.parseJsonBytes32(j, ".plaintextHash");
        fCipherHash = vm.parseJsonBytes32(j, ".ciphertextHash");
        fPlainUtf8 = vm.parseJsonString(j, ".plaintextUtf8");
        _fund(sellerA, DEP);
    }

    /// A second, deliberately differently-structured keystream: bytes.concat + bytes32(index), per-chunk bounds.
    function _decryptIndependent(bytes memory ct, bytes memory key) internal pure returns (bytes memory out) {
        out = new bytes(ct.length);
        uint256 nBlocks = (ct.length + 31) / 32;
        for (uint256 b; b < nBlocks; ++b) {
            bytes32 ks = keccak256(bytes.concat(key, bytes32(b)));
            uint256 start = b * 32;
            uint256 end = start + 32 > ct.length ? ct.length : start + 32;
            for (uint256 k = start; k < end; ++k) {
                out[k] = bytes1(uint8(ct[k]) ^ uint8(ks[k - start]));
            }
        }
    }

    function _claimWith(bytes32 plaintextHash) internal returns (bytes32 id) {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        p.keyHash = fKeyHash;
        p.plaintextHash = plaintextHash;
        p.ciphertextHash = fCipherHash;
        _claimOk(p);
        id = _cid(sellerA, buyer, N1);
    }

    function test_Fixture_HashesMatchItsFields() public view {
        assertEq(keccak256(fKey), fKeyHash);
        assertEq(keccak256(fCipher), fCipherHash);
        assertEq(keccak256(fPlain), fPlainHash);
        assertEq(fCipher.length, fPlain.length);
        assertEq(bytes(fPlainUtf8), fPlain);
        assertGt(fPlain.length, 64, "spans several chunks");
        assertTrue(fPlain.length % 32 != 0, "has a truncated last chunk");
        assertTrue(fKey.length != 32, "key is not word sized");
    }

    function test_Fixture_IndependentKeystreamDecryptsToPlaintext() public view {
        assertEq(_decryptIndependent(fCipher, fKey), fPlain);
        // and the helper shared by the other suites agrees
        assertEq(_xorStream(fCipher, fKey), fPlain);
        assertEq(_xorStream(fPlain, fKey), fCipher);
    }

    function test_Fixture_PromiseKept_ProveRevertsOnOpen() public {
        bytes32 id = _claimWith(fPlainHash);
        vm.prank(carol);
        vm.expectRevert(SealedDelivery.PromiseKept.selector);
        sd.prove(id, fCipher, fKey);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.fraudCount(sellerA), 0);
        assertEq(sd.reserved(sellerA), 2 * VAL);
        assertEq(sd.deposits(sellerA), DEP);
    }

    function test_Fixture_PromiseKept_ProveRevertsOnDelivered() public {
        bytes32 id = _claimWith(fPlainHash);
        sd.answer(id, fKey);
        vm.expectRevert(SealedDelivery.PromiseKept.selector);
        sd.prove(id, fCipher, fKey);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function test_Fixture_DifferentPlaintextHash_ProveSucceedsAsFraud() public {
        bytes32 id = _claimWith(keccak256("a different promised plaintext"));
        vm.prank(carol);
        sd.prove(id, fCipher, fKey);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(_deadBal(), VAL);
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
        assertEq(sd.reserved(sellerA), 0);
    }

    function test_Fixture_DifferentPlaintextHash_FraudOnDelivered() public {
        bytes32 id = _claimWith(bytes32(uint256(fPlainHash) ^ 1)); // one bit off the true hash
        sd.answer(id, fKey);
        sd.prove(id, fCipher, fKey);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.claimable(buyer), VAL);
    }

    function test_Fixture_TamperedInputsAreRejected() public {
        bytes32 id = _claimWith(fPlainHash);
        bytes memory badCt = abi.encodePacked(fCipher);
        badCt[badCt.length - 1] = bytes1(uint8(badCt[badCt.length - 1]) ^ 1);
        vm.expectRevert(SealedDelivery.WrongCiphertext.selector);
        sd.prove(id, badCt, fKey);
        bytes memory badKey = abi.encodePacked(fKey);
        badKey[0] = bytes1(uint8(badKey[0]) ^ 1);
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.prove(id, fCipher, badKey);
    }

    function test_Fixture_AnswerAcceptsFixtureKey() public {
        bytes32 id = _claimWith(fPlainHash);
        sd.answer(id, fKey);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
    }
}
