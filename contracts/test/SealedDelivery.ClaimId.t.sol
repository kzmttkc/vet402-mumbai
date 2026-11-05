// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase, SealedDeliveryHarness} from "./SealedDelivery.Base.t.sol";

/// claimId = keccak256(abi.encode(seller, buyer, paymentNonce)) semantics.
contract SealedDeliveryClaimIdTest is SealedDeliveryTestBase {
    uint256 internal constant DEP = 500e6;
    uint256 internal constant VAL = 100e6;

    address internal stranger;

    function setUp() public override {
        super.setUp();
        stranger = _newActor("stranger");
        _fund(sellerA, DEP);
        _fund(sellerB, DEP);
    }

    // ---------------------------------------------------------------- (a) stranger squats the nonce

    function test_Stranger_SelfClaimDoesNotBlockRealBuyer() public {
        // stranger signs as BOTH seller and buyer with the real payment nonce; zero deposit, small value
        SealedDelivery.Promise memory sp = _prom(stranger, stranger, 5e6, N1);
        _claimOk(sp);
        bytes32 strangerId = _cid(stranger, stranger, N1);
        assertEq(uint8(_status(strangerId)), uint8(SealedDelivery.Status.OPEN));
        (,, uint256 sr, uint64 sdl,) = _claimData(strangerId);
        assertEq(sr, 10e6, "the liability is 2x the value even with no deposit");

        skip(10);

        // the real claim with the same nonce still succeeds, under a different claimId
        SealedDelivery.Promise memory rp = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory ra = _authFor(rp);
        bytes memory ss = _sellerSig(rp);
        bytes memory bs = _buyerSig(ra);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Claimed(id1, N1, sellerA, buyer, 2 * VAL, uint64(block.timestamp + WINDOW));
        vm.prank(buyer);
        sd.claim(rp, ss, ra, bs);

        assertTrue(id1 != strangerId);
        (address s, address b, uint256 rr, uint64 rdl,) = _claimData(id1);
        assertEq(s, sellerA);
        assertEq(b, buyer);
        assertEq(rr, 2 * VAL, "own liability");
        assertEq(rdl, uint64(block.timestamp + WINDOW), "own deadline");
        assertEq(uint256(rdl), uint256(sdl) + 10, "deadlines are independent");
        assertEq(sd.openLiability(sellerA), 2 * VAL);
        assertEq(sd.openLiability(stranger), 10e6);
        assertEq(_claimNonce(id1), N1);
        assertEq(_claimNonce(strangerId), N1);
    }

    function test_Stranger_AnswerOneClaimLeavesOtherUntouched() public {
        _claimOk(_prom(stranger, stranger, 5e6, N1));
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        bytes32 strangerId = _cid(stranger, stranger, N1);

        sd.answer(strangerId, KEY);
        assertEq(uint8(_status(strangerId)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.openLiability(sellerA), 2 * VAL);

        sd.answer(id1, KEY);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(sd.openLiability(sellerA), 0);
    }

    function test_Stranger_FinalizeOneClaimLeavesOtherUntouched() public {
        _claimOk(_prom(stranger, stranger, 5e6, N1));
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        bytes32 strangerId = _cid(stranger, stranger, N1);
        (,,, uint64 dl,) = _claimData(strangerId);
        vm.warp(dl);

        sd.finalize(strangerId);
        assertEq(uint8(_status(strangerId)), uint8(SealedDelivery.Status.SILENT));
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.openLiability(sellerA), 2 * VAL);
        assertEq(sd.deposits(sellerA), DEP);
        assertEq(sd.silentCount(stranger), 1);
        assertEq(sd.silentCount(sellerA), 0);
        assertEq(sd.claimable(buyer), 0);
        assertEq(sd.claimable(stranger), 0);
        assertEq(_burnTotal(), 0);

        sd.finalize(id1);
        assertEq(sd.claimable(buyer), VAL); // half of the 2 * VAL payout
        assertEq(_burnTotal(), VAL); // the other half
        assertEq(sd.silentCount(sellerA), 1);
    }

    function test_Stranger_SelfClaimFirstThenRealAnsweredIndependently() public {
        // stranger claims first with the same nonce and the real flow still pays out on silence
        _claimOk(_prom(stranger, stranger, 0, N1));
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        sd.answer(_cid(stranger, stranger, N1), KEY);
        skip(WINDOW);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
    }

    // ---------------------------------------------------------------- (b) same nonce, other seller / buyer

    function test_SameNonce_OtherSellerSameBuyerIsSeparateClaim() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        _claimOk(_prom(sellerB, buyer, 40e6, N1));
        bytes32 idB = _cid(sellerB, buyer, N1);
        assertTrue(idB != id1);
        (address s,, uint256 r,,) = _claimData(idB);
        assertEq(s, sellerB);
        assertEq(r, 80e6);
        assertEq(sd.openLiability(sellerA), 2 * VAL);
        assertEq(sd.openLiability(sellerB), 80e6);

        sd.answer(id1, KEY);
        assertEq(uint8(_status(idB)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.openLiability(sellerB), 80e6);
        skip(WINDOW);
        sd.finalize(idB);
        assertEq(sd.claimable(buyer), 40e6);
        assertEq(sd.deposits(sellerA), DEP);
        assertEq(sd.deposits(sellerB), DEP - 80e6);
    }

    function test_SameNonce_OtherBuyerSameSellerIsSeparateClaim() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        _claimOk(_prom(sellerA, buyer2, 70e6, N1));
        bytes32 id2 = _cid(sellerA, buyer2, N1);
        assertTrue(id2 != id1);
        (, address b, uint256 r,,) = _claimData(id2);
        assertEq(b, buyer2);
        assertEq(r, 140e6);
        assertEq(sd.openLiability(sellerA), 2 * VAL + 140e6);

        skip(WINDOW);
        sd.finalize(id2);
        assertEq(sd.claimable(buyer2), 70e6);
        assertEq(sd.claimable(buyer), 0);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
        vm.expectRevert(SealedDelivery.AnswerWindowClosed.selector); // deadline == now
        sd.answer(id1, KEY);
    }

    // ---------------------------------------------------------------- (c) exact replay

    function test_Replay_SameSellerBuyerNonceRevertsAlreadyClaimed() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        _claimOk(p);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory ss = _sellerSig(p);
        bytes memory bs = _buyerSig(a);
        _claimRaw(p, ss, a, bs, buyer, SealedDelivery.AlreadyClaimed.selector);
        sd.answer(id1, KEY);
        _claimRaw(p, ss, a, bs, buyer, SealedDelivery.AlreadyClaimed.selector);
        assertEq(sd.openLiability(sellerA), 0);
    }

    function test_Replay_AfterFinalizeRevertsAlreadyClaimed() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        _claimOk(p);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory ss = _sellerSig(p);
        bytes memory bs = _buyerSig(a);
        skip(WINDOW);
        sd.finalize(id1);
        _claimRaw(p, ss, a, bs, buyer, SealedDelivery.AlreadyClaimed.selector);
        assertEq(sd.claimable(buyer), VAL);
    }

    function test_Replay_StrangerSelfClaimAlsoSingleUse() public {
        SealedDelivery.Promise memory sp = _prom(stranger, stranger, 0, N1);
        _claimOk(sp);
        SealedDelivery.PaymentAuth memory a = _authFor(sp);
        _claimRaw(sp, _sellerSig(sp), a, _buyerSig(a), stranger, SealedDelivery.AlreadyClaimed.selector);
    }

    // ---------------------------------------------------------------- (d) claimId derivation and events

    function test_ClaimId_MatchesKeccakAbiEncode() public {
        SealedDeliveryHarness h = new SealedDeliveryHarness(USDC_ADDR, PAY_NAME, PAY_VERSION, GATEWAY_WALLET);
        assertEq(h.claimIdOf(sellerA, buyer, N1), keccak256(abi.encode(sellerA, buyer, N1)));
        assertEq(h.claimIdOf(sellerA, buyer, N1), id1);
        // every component matters
        assertTrue(h.claimIdOf(sellerB, buyer, N1) != id1);
        assertTrue(h.claimIdOf(sellerA, buyer2, N1) != id1);
        assertTrue(h.claimIdOf(sellerA, buyer, N2) != id1);
        assertTrue(h.claimIdOf(buyer, sellerA, N1) != id1, "argument order matters");
    }

    function test_ClaimId_ClaimStoredUnderDerivedKey() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
        assertEq(_claimNonce(id1), N1);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.NONE), "old nonce key unused");
    }

    function test_Events_ClaimedCarriesClaimIdAndNonceTopics() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        vm.recordLogs();
        _claimOk(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].emitter, address(sd));
        assertEq(logs[0].topics[0], SealedDelivery.Claimed.selector);
        assertEq(logs[0].topics[1], id1);
        assertEq(logs[0].topics[2], N1);
        assertEq(logs[0].topics[3], bytes32(uint256(uint160(sellerA))));
        (address b, uint256 r, uint64 dl) = abi.decode(logs[0].data, (address, uint256, uint64));
        assertEq(b, buyer);
        assertEq(r, 2 * VAL);
        assertEq(dl, uint64(block.timestamp + WINDOW));
    }

    function test_Events_KeyRevealedCarriesClaimIdAndNonce() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        vm.expectEmit(true, true, false, true, address(sd));
        emit SealedDelivery.KeyRevealed(id1, N1, KEY);
        sd.answer(id1, KEY);

        _claimOk(_prom(sellerA, buyer2, VAL, N2));
        vm.recordLogs();
        sd.answer(_cid(sellerA, buyer2, N2), KEY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        assertEq(logs[0].topics[0], SealedDelivery.KeyRevealed.selector);
        assertEq(logs[0].topics[1], _cid(sellerA, buyer2, N2));
        assertEq(logs[0].topics[2], N2);
        assertEq(abi.decode(logs[0].data, (bytes)), KEY);
    }

    function test_Events_SilentCarriesClaimIdAndNonce() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        skip(WINDOW);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(id1, N1, sellerA, buyer, VAL);
        sd.finalize(id1);

        _claimOk(_prom(sellerB, buyer2, 30e6, N2));
        bytes32 idB = _cid(sellerB, buyer2, N2);
        skip(WINDOW);
        vm.recordLogs();
        sd.finalize(idB);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1); // Silent only: the burn is queued, no USDC moves
        assertEq(logs[0].emitter, address(sd));
        assertEq(logs[0].topics[0], SealedDelivery.Silent.selector);
        assertEq(logs[0].topics[1], idB);
        assertEq(logs[0].topics[2], N2);
        assertEq(logs[0].topics[3], bytes32(uint256(uint160(sellerB))));
        (address b, uint256 paid) = abi.decode(logs[0].data, (address, uint256));
        assertEq(b, buyer2);
        assertEq(paid, 30e6);
    }

    // ---------------------------------------------------------------- (e) old nonce-only key is dead

    function test_OldKey_AnswerWithNonceAloneRevertsNotOpen() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(N1, KEY);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(keccak256(abi.encode(N1)), KEY);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.openLiability(sellerA), 2 * VAL);
    }

    function test_OldKey_FinalizeWithNonceAloneRevertsNotOpen() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        skip(WINDOW);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(N1);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(keccak256(abi.encode(N1)));
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.claimable(buyer), 0);
        sd.finalize(id1); // the real claimId works
        assertEq(sd.claimable(buyer), VAL);
    }
}
