// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// prove(): reverts, PromiseKept, fraud on OPEN claims, payload shapes. DELIVERED cases live in ProveDelivered.
contract SealedDeliveryProveTest is SealedDeliveryTestBase {
    uint256 internal constant DEP = 500e6;
    uint256 internal constant VAL = 100e6;
    bytes internal constant PLAIN = "Delivered goods: 42 widgets, colour blue. (Not what the signed hash promised.)";

    function setUp() public override {
        super.setUp();
        _fund(sellerA, DEP);
    }

    struct Snap {
        uint8 st;
        uint256 res;
        uint256 dep;
        uint256 claimableBuyer;
        uint256 frauds;
        uint256 dead;
        uint256 bal;
    }

    function _snap(bytes32 id) internal view returns (Snap memory s) {
        s.st = uint8(_status(id));
        s.res = sd.reserved(sellerA);
        s.dep = sd.deposits(sellerA);
        s.claimableBuyer = sd.claimable(buyer);
        s.frauds = sd.fraudCount(sellerA);
        s.dead = _deadBal();
        s.bal = usdc.balanceOf(address(sd));
    }

    // ---------------------------------------------------------------- PromiseKept

    function test_Prove_PromiseKept_StateUnchanged() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, true);
        Snap memory a = _snap(id);
        vm.prank(carol);
        vm.expectRevert(SealedDelivery.PromiseKept.selector);
        sd.prove(id, ct, KEY);
        Snap memory b = _snap(id);
        assertEq(b.st, a.st);
        assertEq(b.st, uint8(SealedDelivery.Status.OPEN));
        assertEq(b.res, a.res);
        assertEq(b.dep, a.dep);
        assertEq(b.claimableBuyer, a.claimableBuyer);
        assertEq(b.frauds, a.frauds);
        assertEq(b.dead, a.dead);
        assertEq(b.bal, a.bal);
        assertEq(b.claimableBuyer, 0, "no payout");
        // the claim is still live: it can still be answered
        sd.answer(id, KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function test_Prove_PromiseKept_OnDeliveredClaim() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, true);
        sd.answer(id, KEY);
        vm.expectRevert(SealedDelivery.PromiseKept.selector);
        sd.prove(id, ct, KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(sd.fraudCount(sellerA), 0);
        assertEq(sd.deposits(sellerA), DEP);
    }

    // ---------------------------------------------------------------- fraud on an OPEN claim

    function test_Prove_FraudOnOpen_SplitsPayoutAndReleasesReservation() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        assertEq(sd.reserved(sellerA), 2 * VAL);
        assertEq(sd.coverage(sellerA), DEP - 2 * VAL);

        vm.prank(carol);
        sd.prove(id, ct, KEY);

        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(uint8(SealedDelivery.Status.FRAUD), 4);
        assertEq(sd.reserved(sellerA), 0, "reservation released");
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL, "deposit down by the whole reservation");
        assertEq(sd.claimable(buyer), VAL, "buyer share up");
        assertEq(_deadBal(), VAL, "burn to DEAD");
        assertEq(usdc.balanceOf(address(sd)), DEP - VAL, "contract balance drops by the burn only");
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.silentCount(sellerA), 0);
        assertEq(sd.coverage(sellerA), DEP - 2 * VAL);

        vm.prank(buyer);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(buyer), VAL);
    }

    function test_Prove_FraudOnOpen_EmitsFraudAndTransferToDead() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        vm.expectEmit(true, true, false, true, USDC_ADDR);
        emit IERC20.Transfer(address(sd), DEAD_ADDR, VAL);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id, N1, sellerA, buyer, VAL);
        sd.prove(id, ct, KEY);
    }

    function test_Prove_FraudEventCarriesClaimIdAndNonceTopics() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        vm.recordLogs();
        sd.prove(id, ct, KEY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2); // USDC Transfer + Fraud
        assertEq(logs[0].emitter, USDC_ADDR);
        assertEq(logs[1].emitter, address(sd));
        assertEq(logs[1].topics[0], SealedDelivery.Fraud.selector);
        assertEq(logs[1].topics[1], id);
        assertEq(logs[1].topics[2], N1);
        assertEq(logs[1].topics[3], bytes32(uint256(uint160(sellerA))));
        (address b, uint256 paid) = abi.decode(logs[1].data, (address, uint256));
        assertEq(b, buyer);
        assertEq(paid, VAL);
    }

    function test_Prove_AfterFraud_FinalizeAnswerProveAllRevert() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        sd.prove(id, ct, KEY);

        vm.warp(block.timestamp + 10_000);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(id);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(id, KEY);
        vm.expectRevert(SealedDelivery.AlreadyFraud.selector);
        sd.prove(id, ct, KEY);
        // AlreadyFraud takes precedence over key / ciphertext validation
        vm.expectRevert(SealedDelivery.AlreadyFraud.selector);
        sd.prove(id, hex"00", "bad");

        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.silentCount(sellerA), 0);
        assertEq(_deadBal(), VAL);
    }

    function test_Prove_FraudAfterClaimIdReplayStillAlreadyClaimed() public {
        SealedDelivery.Promise memory p;
        bytes memory ct;
        (p, ct) = _sealedProm(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        _claimOk(p);
        sd.prove(id1, ct, KEY);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.AlreadyClaimed.selector);
    }

    function test_Prove_FraudCountAccumulatesPerSeller() public {
        (bytes32 idA, bytes memory ctA) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        (bytes32 idB, bytes memory ctB) = _sealedClaim(sellerA, buyer2, 10e6, N2, KEY, PLAIN, false);
        sd.prove(idA, ctA, KEY);
        sd.prove(idB, ctB, KEY);
        assertEq(sd.fraudCount(sellerA), 2);
        assertEq(sd.fraudCount(sellerB), 0);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.claimable(buyer2), 10e6);
        assertEq(_deadBal(), VAL + 10e6);
    }

    function test_Prove_OnOpenClaim_AfterDeadlineButBeforeFinalize() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        (,,, uint64 dl,) = _claimData(id);
        vm.warp(uint256(dl) + 1000);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.OPEN));
        vm.prank(carol);
        sd.prove(id, ct, KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.silentCount(sellerA), 0);
    }

    function test_Prove_OnOpenClaim_ExactlyAtDeadlineAndBefore() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        (bytes32 id2, bytes memory ct2) = _sealedClaim(sellerA, buyer2, VAL, N2, KEY, PLAIN, false);
        (,,, uint64 dl,) = _claimData(id);
        vm.warp(dl - 1);
        sd.prove(id, ct, KEY);
        vm.warp(dl);
        sd.prove(id2, ct2, KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(uint8(_status(id2)), uint8(SealedDelivery.Status.FRAUD));
    }

    function test_Prove_CallableByAnyone() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, 50e6, N1, KEY, PLAIN, false);
        (bytes32 id2, bytes memory ct2) = _sealedClaim(sellerA, buyer2, 50e6, N2, KEY, PLAIN, false);
        address buyer3 = _newActor("buyer3");
        (bytes32 id3, bytes memory ct3) = _sealedClaim(sellerA, buyer3, 50e6, N1, KEY, PLAIN, false);
        // the claim's own seller, its buyer, and a stranger
        vm.prank(sellerA);
        sd.prove(id, ct, KEY);
        vm.prank(buyer2);
        sd.prove(id2, ct2, KEY);
        vm.prank(address(0xBEEF));
        sd.prove(id3, ct3, KEY);
        assertEq(sd.fraudCount(sellerA), 3);
        assertEq(sd.claimable(buyer), 50e6);
        assertEq(sd.claimable(buyer2), 50e6);
        assertEq(sd.claimable(buyer3), 50e6);
    }

    function test_Prove_FraudOnOpen_ZeroReservationStillMarksFraud() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerB, buyer, VAL, N1, KEY, PLAIN, false); // no deposit
        (,, uint256 r,,) = _claimData(id);
        assertEq(r, 0);
        vm.recordLogs();
        sd.prove(id, ct, KEY);
        assertEq(vm.getRecordedLogs().length, 1, "Fraud only, no transfer");
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.fraudCount(sellerB), 1);
        assertEq(sd.claimable(buyer), 0);
        assertEq(_deadBal(), 0);
    }

    function test_Prove_FraudOnOpen_CappedByCoverageAtClaimTime() public {
        _fund(sellerB, 150e6);
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerB, buyer, VAL, N1, KEY, PLAIN, false);
        (,, uint256 r,,) = _claimData(id);
        assertEq(r, 150e6); // min(200, 150)
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), 75e6);
        assertEq(_deadBal(), 75e6);
        assertEq(sd.deposits(sellerB), 0);
        assertEq(sd.reserved(sellerB), 0);
    }

    // ---------------------------------------------------------------- not provable / wrong inputs

    function test_Prove_RevertsNotProvable_None() public {
        vm.expectRevert(SealedDelivery.NotProvable.selector);
        sd.prove(id1, hex"", KEY);
        vm.expectRevert(SealedDelivery.NotProvable.selector);
        sd.prove(bytes32(0), PLAIN, "");
    }

    function test_Prove_RevertsNotProvable_Silent() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        (,,, uint64 dl,) = _claimData(id);
        vm.warp(dl);
        sd.finalize(id);
        vm.expectRevert(SealedDelivery.NotProvable.selector);
        sd.prove(id, ct, KEY);
        assertEq(sd.fraudCount(sellerA), 0);
        assertEq(sd.claimable(buyer), VAL, "silent payout is not doubled");
        assertEq(_deadBal(), VAL);
    }

    function test_Prove_RevertsWrongKey() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.prove(id, ct, "not-the-key");
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.prove(id, ct, "");
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.prove(id, ct, abi.encodePacked(KEY, hex"00")); // longer by one byte
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.reserved(sellerA), 2 * VAL);
    }

    function test_Prove_RevertsWrongKey_OnDelivered() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        sd.answer(id, KEY);
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.prove(id, ct, "nope");
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function test_Prove_RevertsWrongCiphertext() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        bytes memory flipped = abi.encodePacked(ct);
        flipped[0] = bytes1(uint8(flipped[0]) ^ 1);
        vm.expectRevert(SealedDelivery.WrongCiphertext.selector);
        sd.prove(id, flipped, KEY);
        vm.expectRevert(SealedDelivery.WrongCiphertext.selector);
        sd.prove(id, "", KEY);
        vm.expectRevert(SealedDelivery.WrongCiphertext.selector);
        sd.prove(id, abi.encodePacked(ct, hex"00"), KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_Prove_WrongKeyCheckedBeforeWrongCiphertext() public {
        (bytes32 id,) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.prove(id, hex"1234", "bad-key");
    }

    function test_Prove_WrongCiphertextCheckedBeforePromiseKept() public {
        (bytes32 id,) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, true);
        vm.expectRevert(SealedDelivery.WrongCiphertext.selector);
        sd.prove(id, PLAIN, KEY); // plaintext handed in place of the ciphertext
    }

    /// A key that decrypts the ciphertext differently cannot be used: the key is pinned by keyHash.
    function test_Prove_CannotFrameSellerWithAnotherKey() public {
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, true);
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.prove(id, ct, "attacker-key");
        assertEq(sd.fraudCount(sellerA), 0);
    }

    // ---------------------------------------------------------------- ciphertext / key shapes

    function _roundTrip(uint256 len, bytes memory key, bytes32 salt) internal {
        bytes memory plain = _bytesOf(len, salt);
        bytes32 nHonest = keccak256(abi.encode("h", len, key.length, salt));
        bytes32 nFraud = keccak256(abi.encode("f", len, key.length, salt));
        (bytes32 idH, bytes memory ctH) = _sealedClaim(sellerA, buyer, 1, nHonest, key, plain, true);
        (bytes32 idF, bytes memory ctF) = _sealedClaim(sellerA, buyer, 1, nFraud, key, plain, false);
        // honest: our independent decryption equals the contract's => PromiseKept
        vm.expectRevert(SealedDelivery.PromiseKept.selector);
        sd.prove(idH, ctH, key);
        assertEq(uint8(_status(idH)), uint8(SealedDelivery.Status.OPEN));
        // dishonest: fraud is proven
        sd.prove(idF, ctF, key);
        assertEq(uint8(_status(idF)), uint8(SealedDelivery.Status.FRAUD));
    }

    function test_Prove_CiphertextLengths() public {
        uint256[10] memory lens = [uint256(0), 1, 31, 32, 33, 63, 64, 65, 100, 5000];
        for (uint256 i; i < lens.length; ++i) {
            _roundTrip(lens[i], KEY, bytes32(i));
        }
    }

    function test_Prove_MultiKbCiphertext() public {
        _roundTrip(32 * 1024 + 17, KEY, bytes32(uint256(7)));
    }

    function test_Prove_KeyLengths() public {
        uint256[9] memory klens = [uint256(0), 1, 16, 31, 32, 33, 64, 100, 200];
        for (uint256 i; i < klens.length; ++i) {
            _roundTrip(100, _bytesOf(klens[i], bytes32(uint256(1000 + i))), bytes32(uint256(i)));
        }
    }

    /// Only the very last byte of the promise differs: the final truncated chunk is decrypted exactly.
    function test_Prove_LastByteMismatchIsFraud() public {
        uint256[5] memory lens = [uint256(1), 31, 32, 33, 100];
        for (uint256 i; i < lens.length; ++i) {
            bytes memory plain = _bytesOf(lens[i], bytes32(i));
            bytes memory other = _bytesOf(lens[i], bytes32(i));
            other[other.length - 1] = bytes1(uint8(other[other.length - 1]) ^ 0x80);
            bytes32 n = keccak256(abi.encode("lb", i));
            SealedDelivery.Promise memory p;
            bytes memory ct;
            (p, ct) = _sealedProm(sellerA, buyer, 1, n, KEY, plain, true);
            p.plaintextHash = keccak256(other);
            _claimOk(p);
            sd.prove(_cid(sellerA, buyer, n), ct, KEY);
            assertEq(uint8(_status(_cid(sellerA, buyer, n))), uint8(SealedDelivery.Status.FRAUD));
        }
    }

    function testFuzz_Prove_AnyLengthAndKeyLength(uint256 len, uint256 klen, bytes32 salt) public {
        len = bound(len, 0, 6000);
        klen = bound(klen, 0, 200);
        _roundTrip(len, _bytesOf(klen, keccak256(abi.encode(salt, "k"))), salt);
    }
}
