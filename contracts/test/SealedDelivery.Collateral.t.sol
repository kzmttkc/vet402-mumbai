// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";
import {DeadBlockedUSDC} from "./SealedDelivery.Holes.t.sol";

/// The verdict-time collateral design: no reservation, withdrawals held back by open claims, a queued burn.
contract SealedDeliveryCollateralTest is SealedDeliveryTestBase {
    uint256 internal constant V = 10e6;
    bytes internal constant PLAIN = "not what the signature promised";

    function _request(address seller, uint256 amount) internal {
        vm.prank(seller);
        sd.requestWithdraw(amount);
    }

    function _withdraw(address seller) internal {
        vm.prank(seller);
        sd.withdrawDeposit();
    }

    function _assertBalanceIdentity() internal view {
        assertEq(
            usdc.balanceOf(address(sd)),
            sd.deposits(sellerA) + sd.deposits(sellerB) + sd.claimable(buyer) + sd.claimable(buyer2) + sd.pendingBurn(),
            "USDC balance == deposits + claimable + pendingBurn"
        );
    }

    // ---------------------------------------------------------------- queued funds stay at risk

    function test_RequestAll_ProveOnOpenClaimPaysFromCollateral() public {
        _fund(sellerA, 2 * V);
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, V, N1, KEY, PLAIN, false);
        _request(sellerA, 2 * V);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), V);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(sd.withdrawReadyAt(sellerA), 0);
        _assertBalanceIdentity();
    }

    function test_DeliveredClaim_ProvePaysFromCollateral() public {
        _fund(sellerA, 2 * V);
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, V, N1, KEY, PLAIN, false);
        sd.answer(id, KEY);
        assertEq(sd.openLiability(sellerA), 0);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), V);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.openLiability(sellerA), 0, "not released a second time");
        _assertBalanceIdentity();
    }

    // ---------------------------------------------------------------- self-dealing

    /// Pulling the whole deposit out through a second address burns half of it, and the real buyer still
    /// gets whatever is left.
    function test_SelfDealing_HalfIsLostAndTheRestIsStillTakeable() public {
        address sock = _newActor("sock");
        _fund(sellerA, 4 * V);
        _claimOk(_prom(sellerA, sock, V, N2));
        _claimOk(_prom(sellerA, buyer, V, N1));
        vm.warp(T0 + WINDOW);

        sd.finalize(_cid(sellerA, sock, N2));
        assertEq(sd.claimable(sock), V, "the second address gets half");
        assertEq(sd.pendingBurn(), V, "the other half is gone");

        sd.finalize(id1);
        assertEq(sd.claimable(buyer), V);
        assertEq(sd.deposits(sellerA), 0);
    }

    /// A value whose double overflows must not stop the next buyer's claim or verdict.
    function test_HugeSelfSignedClaim_DoesNotBlockTheRealBuyer() public {
        address sock = _newActor("sock");
        _fund(sellerA, 2 * V);
        _claimOk(_prom(sellerA, sock, type(uint256).max, N2));
        _claimOk(_prom(sellerA, sock, type(uint256).max / 2, keccak256("n3")));
        _claimOk(_prom(sellerA, buyer, V, N1));
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), V);
    }

    // ---------------------------------------------------------------- openLiability holds withdrawals back

    function test_Withdraw_OpenClaimPartStaysAndTheVerdictTakesIt() public {
        _fund(sellerA, 5 * V);
        _claimOk(_prom(sellerA, buyer, V, N1)); // liability 2V
        _request(sellerA, 5 * V);
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        skip(COOLDOWN);

        _withdraw(sellerA);
        assertEq(usdc.balanceOf(sellerA), 3 * V, "only deposits - openLiability leaves");
        assertEq(sd.deposits(sellerA), 2 * V);
        assertEq(sd.pendingWithdrawal(sellerA), 2 * V, "the rest stays queued");
        assertEq(sd.withdrawReadyAt(sellerA), readyAt);

        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.LiabilityOpen.selector);
        sd.withdrawDeposit();

        // The answer window is over by now, so silence resolves this claim; the verdict takes what stayed.
        sd.finalize(id1);
        assertEq(sd.openLiability(sellerA), 0);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        _assertBalanceIdentity();
    }

    function test_Withdraw_ReleasedByAnswerWithoutNewCooldown() public {
        _fund(sellerA, 5 * V);
        _request(sellerA, 5 * V);
        skip(COOLDOWN);
        _claimOk(_prom(sellerA, buyer, V, N1)); // claim inside the now-ready window
        _withdraw(sellerA);
        assertEq(usdc.balanceOf(sellerA), 3 * V);

        sd.answer(id1, KEY);
        _withdraw(sellerA); // no second cooldown
        assertEq(usdc.balanceOf(sellerA), 5 * V);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(sd.withdrawReadyAt(sellerA), 0);
        _assertBalanceIdentity();
    }

    function test_Withdraw_ReleasedByProveOnOpenClaim() public {
        _fund(sellerA, 5 * V);
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, V, N1, KEY, PLAIN, false);
        _request(sellerA, 3 * V);
        sd.prove(id, ct, KEY);
        assertEq(sd.openLiability(sellerA), 0, "a proof on an OPEN claim must release it too");
        skip(COOLDOWN);
        _withdraw(sellerA);
        assertEq(usdc.balanceOf(sellerA), 3 * V);
        _assertBalanceIdentity();
    }

    function test_Withdraw_LiabilityAboveDepositLeavesNothingToTake() public {
        _fund(sellerA, V);
        _claimOk(_prom(sellerA, buyer, V, N1)); // liability 2V > deposit V
        _request(sellerA, V);
        skip(COOLDOWN);
        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.LiabilityOpen.selector);
        sd.withdrawDeposit();
        assertEq(sd.deposits(sellerA), V);
    }

    /// Open liability stops only the seller's own withdrawal, never a claim or another buyer's verdict.
    function test_OpenLiability_NeverBlocksClaimsOrVerdicts() public {
        _fund(sellerA, 2 * V);
        _claimOk(_prom(sellerA, buyer, 100 * V, N1)); // owes far more than the deposit
        _claimOk(_prom(sellerA, buyer2, V, N2));
        vm.warp(T0 + WINDOW);
        sd.finalize(_cid(sellerA, buyer2, N2));
        assertEq(sd.claimable(buyer2), V);
        assertEq(sd.openLiability(sellerA), 200 * V);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), 0, "nothing left");
        assertEq(sd.openLiability(sellerA), 0);
    }

    // ---------------------------------------------------------------- pendingBurn and flushBurn

    function test_FlushBurn_AnyoneSendsTheQueueToDead() public {
        _fund(sellerA, 4 * V);
        _claimOk(_prom(sellerA, buyer, V, N1));
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);
        assertEq(sd.pendingBurn(), V);
        assertEq(usdc.balanceOf(DEAD_ADDR), 0);

        vm.expectEmit(false, false, false, true, address(sd));
        emit SealedDelivery.BurnFlushed(V);
        vm.prank(carol);
        sd.flushBurn();
        assertEq(sd.pendingBurn(), 0);
        assertEq(usdc.balanceOf(DEAD_ADDR), V);
        assertEq(usdc.balanceOf(address(sd)), 3 * V);
        _assertBalanceIdentity();
    }

    function test_FlushBurn_RevertsWhenEmpty() public {
        vm.expectRevert(SealedDelivery.NothingToWithdraw.selector);
        sd.flushBurn();
    }

    function test_FlushBurn_BlockedDead_VerdictsPassAndTheQueueWaits() public {
        vm.etch(USDC_ADDR, address(new DeadBlockedUSDC()).code);
        _fund(sellerA, 4 * V);
        _claimOk(_prom(sellerA, buyer, V, N1));
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer2, V, N2, KEY, PLAIN, false);
        sd.prove(id, ct, KEY);
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);
        assertEq(sd.pendingBurn(), 2 * V);

        vm.expectRevert(DeadBlockedUSDC.Blacklisted.selector);
        sd.flushBurn();
        assertEq(sd.pendingBurn(), 2 * V, "the queue survives a failed flush");

        // buyers and the seller are not stuck behind the blocked burn
        vm.prank(buyer);
        sd.withdrawClaimable();
        vm.prank(buyer2);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(buyer), V);
        assertEq(usdc.balanceOf(buyer2), V);
        _assertBalanceIdentity();
    }

    // ---------------------------------------------------------------- claims beyond the collateral

    function test_ClaimsBeyondCollateral_FirstVerdictFirstRestAfter() public {
        _fund(sellerA, 3 * V);
        _claimOk(_prom(sellerA, buyer, V, N1)); // owes 2V
        _claimOk(_prom(sellerA, buyer2, V, N2)); // owes 2V, only V left after the first
        vm.warp(T0 + WINDOW);

        sd.finalize(_cid(sellerA, buyer2, N2));
        assertEq(sd.claimable(buyer2), V, "the first verdict takes in full, whichever claim came first");
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), V / 2, "the second gets half of what is left");
        assertEq(sd.deposits(sellerA), 0);
        _assertBalanceIdentity();
    }

    // ---------------------------------------------------------------- deposit below pending

    function test_DepositBelowPending_PendingFollowsItDown() public {
        _fund(sellerA, 5 * V);
        _claimOk(_prom(sellerA, buyer, V, N1));
        _request(sellerA, 4 * V);
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);

        assertEq(sd.deposits(sellerA), 3 * V);
        assertEq(sd.pendingWithdrawal(sellerA), 3 * V, "capped by the deposit");
        assertEq(sd.withdrawReadyAt(sellerA), readyAt, "the cooldown keeps running while funds remain");
        assertEq(sd.coverage(sellerA), 0);
        _assertBalanceIdentity();

        vm.warp(readyAt);
        _withdraw(sellerA);
        assertEq(usdc.balanceOf(sellerA), 3 * V);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.withdrawReadyAt(sellerA), 0);
        _assertBalanceIdentity();
    }

    function test_DepositAbovePending_PendingUntouched() public {
        _fund(sellerA, 5 * V);
        _claimOk(_prom(sellerA, buyer, V, N1));
        _request(sellerA, 2 * V);
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);
        assertEq(sd.deposits(sellerA), 3 * V);
        assertEq(sd.pendingWithdrawal(sellerA), 2 * V);
        assertEq(sd.coverage(sellerA), V);
    }

    // ---------------------------------------------------------------- what the design does not cover

    /// Documents the limit: answer releases the liability, so once the cooldown is over the seller can leave
    /// right after a dishonest answer and a later proof gets nothing. The buyer's time to prove is the slack
    /// in COOLDOWN beyond MAX_EXPIRY + ANSWER_WINDOW, which is why a deployment should set a generous COOLDOWN.
    function test_Limit_WithdrawRightAfterAnswerOutrunsTheProof() public {
        _fund(sellerA, 2 * V);
        _request(sellerA, 2 * V);
        vm.warp(T0 + COOLDOWN);
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, V, N1, KEY, PLAIN, false);
        sd.answer(id, KEY);
        _withdraw(sellerA);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), 0);
        assertEq(sd.fraudCount(sellerA), 1, "the record stays even with nothing to take");
    }
}
