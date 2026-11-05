// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// prove() on DELIVERED claims: payout = min(c.liability, deposits) at that moment, INCLUDING funds queued
/// by requestWithdraw. pendingWithdrawal comes down only when the deposit falls below it.
contract SealedDeliveryProveDeliveredTest is SealedDeliveryTestBase {
    uint256 internal constant DEP = 500e6;
    uint256 internal constant VAL = 100e6;
    bytes internal constant PLAIN = "Delivered goods that do not match the signed plaintext hash.";

    function setUp() public override {
        super.setUp();
        _fund(sellerA, DEP);
    }

    /// Dishonest claim that is answered with the right key (so DELIVERED) - returns its id + ciphertext.
    function _delivered(address seller, address buyer_, uint256 value, bytes32 nonce)
        internal
        returns (bytes32 id, bytes memory ct)
    {
        (id, ct) = _sealedClaim(seller, buyer_, value, nonce, KEY, PLAIN, false);
        sd.answer(id, KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function _solvent() internal view {
        assertLe(sd.pendingWithdrawal(sellerA), sd.deposits(sellerA));
    }

    function test_ProveDelivered_FullCoverage_PaysTwiceTheValue() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        // a different OPEN claim must keep its liability untouched
        _claimOk(_prom(sellerA, buyer2, 50e6, N2));
        assertEq(sd.openLiability(sellerA), 100e6);

        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id, N1, sellerA, buyer, VAL);
        vm.prank(carol);
        sd.prove(id, ct, KEY);

        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.openLiability(sellerA), 100e6, "delivered claim holds no liability to release");
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.pendingBurn(), VAL);
        assertEq(usdc.balanceOf(address(sd)), DEP, "a verdict moves no USDC");
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        _solvent();

        vm.expectRevert(SealedDelivery.AlreadyFraud.selector);
        sd.prove(id, ct, KEY);
        vm.warp(block.timestamp + 5000);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(id);
    }

    /// A proof takes from queued funds too; open liability then holds part of the queue back until it resolves.
    function test_ProveDelivered_QueuePartlyHeldBackByOtherOpenClaim() public {
        (bytes32 id1_, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(250e6);
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        (bytes32 id2,) = _sealedClaim(sellerA, buyer2, VAL, N2, KEY, PLAIN, false); // liability 200
        assertEq(sd.coverage(sellerA), 250e6);

        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id1_, N1, sellerA, buyer, VAL);
        sd.prove(id1_, ct, KEY);

        assertEq(sd.claimable(buyer), VAL);
        assertEq(_burnTotal(), VAL);
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
        assertEq(sd.openLiability(sellerA), 200e6, "other claim's liability untouched");
        assertEq(sd.pendingWithdrawal(sellerA), 250e6, "the deposit still holds the whole queue");
        assertEq(sd.withdrawReadyAt(sellerA), readyAt, "cooldown unchanged while pending remains");
        assertEq(sd.coverage(sellerA), 50e6);
        assertEq(sd.fraudCount(sellerA), 1);
        _solvent();

        // only deposits - openLiability = 100 can leave; the other claim still settles in full
        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(usdc.balanceOf(sellerA), 100e6);
        assertEq(sd.pendingWithdrawal(sellerA), 150e6, "the rest stays queued");
        sd.finalize(id2);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(sd.withdrawReadyAt(sellerA), 0);
        assertEq(sd.claimable(buyer2), 100e6);
        assertEq(
            usdc.balanceOf(address(sd)), sd.claimable(buyer) + sd.claimable(buyer2) + sd.pendingBurn(), "fully backed"
        );
        vm.prank(buyer);
        sd.withdrawClaimable();
        vm.prank(buyer2);
        sd.withdrawClaimable();
        sd.flushBurn();
        assertEq(usdc.balanceOf(address(sd)), 0);
    }

    /// The deposit caps the payout, and an odd cap rounds the buyer's half up.
    function test_ProveDelivered_CappedOddDepositRoundsBuyerUp() public {
        _fund(sellerB, 150e6 + 1);
        (bytes32 id, bytes memory ct) = _delivered(sellerB, buyer, VAL, N1);

        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id, N1, sellerB, buyer, 75e6 + 1);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), 75e6 + 1);
        assertEq(_burnTotal(), 75e6);
        assertEq(sd.deposits(sellerB), 0);
        assertEq(sd.coverage(sellerB), 0);
        assertEq(sd.pendingWithdrawal(sellerB), 0);
    }

    function test_ProveDelivered_QueuedFundsPayAndPendingDropsByOverlap() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(480e6); // coverage 20
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        sd.prove(id, ct, KEY); // full 200 paid; overlap 180
        assertEq(sd.claimable(buyer), VAL);
        assertEq(_burnTotal(), VAL);
        assertEq(sd.deposits(sellerA), 300e6);
        assertEq(sd.pendingWithdrawal(sellerA), 300e6);
        assertEq(sd.withdrawReadyAt(sellerA), readyAt);
        _solvent();

        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit(); // only the still-pending amount is paid
        assertEq(usdc.balanceOf(sellerA), 300e6);
        assertEq(sd.deposits(sellerA), 0);
        sd.flushBurn();
        assertEq(usdc.balanceOf(address(sd)), VAL);
    }

    /// Another open claim owing the whole deposit does not shield it: first verdict first, the rest after.
    function test_ProveDelivered_OtherOpenClaimDoesNotShieldTheDeposit() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        (bytes32 idO,) = _sealedClaim(sellerA, buyer2, 250e6, N2, KEY, PLAIN, false); // owes the whole 500
        assertEq(sd.openLiability(sellerA), DEP);

        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
        assertEq(sd.openLiability(sellerA), DEP, "the open claim still counts");

        vm.warp(block.timestamp + WINDOW);
        sd.finalize(idO);
        assertEq(sd.claimable(buyer2), 150e6, "half of the 300 that was left");
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.openLiability(sellerA), 0);
        vm.expectRevert(SealedDelivery.AlreadyFraud.selector);
        sd.prove(id, ct, KEY);
    }

    /// Nothing is fixed at claim time: a deposit that arrives later is what the proof takes from.
    function test_ProveDelivered_DepositArrivingLaterPaysTheProof() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerB, buyer, VAL, N1); // sellerB had no deposit
        (,, uint256 r,,) = _claimData(id);
        assertEq(r, 200e6);
        _fund(sellerB, 100e6);
        sd.prove(id, ct, KEY);
        assertEq(sd.fraudCount(sellerB), 1);
        assertEq(sd.claimable(buyer), 50e6);
        assertEq(sd.deposits(sellerB), 0);
        assertEq(_burnTotal(), 50e6);
    }

    /// Two delivered claims from one seller draw from the same deposit, one after the other, with queued
    /// funds shrinking as they are consumed.
    function test_ProveDelivered_SequentialClaimsConsumeQueuedFundsInTurn() public {
        (bytes32 idA, bytes memory ctA) = _delivered(sellerA, buyer, VAL, N1);
        (bytes32 idB, bytes memory ctB) = _delivered(sellerA, buyer2, VAL, N2);
        vm.prank(sellerA);
        sd.requestWithdraw(350e6); // coverage 150

        sd.prove(idA, ctA, KEY); // 200 paid, overlap 50 => pending 300
        assertEq(sd.claimable(buyer), 100e6);
        assertEq(sd.pendingWithdrawal(sellerA), 300e6);
        assertEq(sd.coverage(sellerA), 0);
        sd.prove(idB, ctB, KEY); // 200 paid, overlap 200 => pending 100
        assertEq(sd.claimable(buyer2), 100e6);
        assertEq(sd.pendingWithdrawal(sellerA), 100e6);
        assertEq(sd.fraudCount(sellerA), 2);
        assertEq(_burnTotal(), 200e6);
        assertEq(sd.deposits(sellerA), 100e6);
        _solvent();
    }

    function test_ProveDelivered_AfterDeadline() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        (,,, uint64 dl,) = _claimData(id);
        vm.warp(uint256(dl) + 365 days);
        vm.prank(carol);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(_burnTotal(), VAL);
    }

    function test_ProveDelivered_NotProvableAfterSilentEvenIfNeverAnswered() public {
        // SILENT claims were never delivered: no key was ever published for them to be proven
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, VAL, N1, KEY, PLAIN, false);
        (,,, uint64 dl,) = _claimData(id);
        vm.warp(dl);
        sd.finalize(id);
        vm.expectRevert(SealedDelivery.NotProvable.selector);
        sd.prove(id, ct, KEY);
    }

    function test_ProveDelivered_FraudEventHasClaimIdAndNonceTopics() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        vm.recordLogs();
        sd.prove(id, ct, KEY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[0], SealedDelivery.Fraud.selector);
        assertEq(logs[0].topics[1], id);
        assertEq(logs[0].topics[2], N1);
    }
}
