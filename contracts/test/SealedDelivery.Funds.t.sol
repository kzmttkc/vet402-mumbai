// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// deposit / requestWithdraw / withdrawDeposit / withdrawClaimable.
contract SealedDeliveryFundsTest is SealedDeliveryTestBase {
    // ---------------------------------------------------------------- deposit

    function test_Deposit_RevertsZeroAmount() public {
        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.ZeroAmount.selector);
        sd.deposit(0);
    }

    function test_Deposit_MovesUsdcAndCredits() public {
        usdc.mint(sellerA, 300e6);
        vm.startPrank(sellerA);
        usdc.approve(address(sd), 300e6);
        vm.expectEmit(true, false, false, true, address(sd));
        emit SealedDelivery.Deposited(sellerA, 300e6);
        sd.deposit(300e6);
        vm.stopPrank();
        assertEq(sd.deposits(sellerA), 300e6);
        assertEq(sd.coverage(sellerA), 300e6);
        assertEq(usdc.balanceOf(sellerA), 0);
        assertEq(usdc.balanceOf(address(sd)), 300e6);
    }

    function test_Deposit_AccumulatesAcrossCalls() public {
        _fund(sellerA, 10e6);
        _fund(sellerA, 5e6);
        assertEq(sd.deposits(sellerA), 15e6);
    }

    function test_Deposit_RevertsWithoutAllowance() public {
        usdc.mint(sellerA, 10e6);
        vm.prank(sellerA);
        vm.expectRevert();
        sd.deposit(10e6);
    }

    // ---------------------------------------------------------------- requestWithdraw

    function test_RequestWithdraw_RevertsZeroAmount() public {
        _fund(sellerA, 100e6);
        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.ZeroAmount.selector);
        sd.requestWithdraw(0);
    }

    function test_RequestWithdraw_RevertsWithNoDeposit() public {
        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.ExceedsCoverage.selector);
        sd.requestWithdraw(1);
    }

    function test_RequestWithdraw_ReducesCoverageAndEmits() public {
        _fund(sellerA, 100e6);
        vm.expectEmit(true, false, false, true, address(sd));
        emit SealedDelivery.WithdrawalRequested(sellerA, 40e6, block.timestamp + COOLDOWN);
        vm.prank(sellerA);
        sd.requestWithdraw(40e6);
        assertEq(sd.pendingWithdrawal(sellerA), 40e6);
        assertEq(sd.withdrawReadyAt(sellerA), block.timestamp + COOLDOWN);
        assertEq(sd.coverage(sellerA), 60e6);
        assertEq(sd.deposits(sellerA), 100e6); // not yet withdrawn
    }

    function test_RequestWithdraw_RevertsWhenDippingIntoReservation() public {
        _fund(sellerA, 100e6);
        _claimOk(_prom(sellerA, buyer, 30e6, N1)); // reserves 2 * 30 = 60
        vm.startPrank(sellerA);
        vm.expectRevert(SealedDelivery.ExceedsCoverage.selector);
        sd.requestWithdraw(40e6 + 1);
        sd.requestWithdraw(40e6); // exactly the free coverage
        vm.stopPrank();
        assertEq(sd.coverage(sellerA), 0);
    }

    function test_RequestWithdraw_RevertsWhenDippingIntoEarlierRequest() public {
        _fund(sellerA, 100e6);
        vm.startPrank(sellerA);
        sd.requestWithdraw(70e6);
        vm.expectRevert(SealedDelivery.ExceedsCoverage.selector);
        sd.requestWithdraw(30e6 + 1);
        sd.requestWithdraw(30e6);
        vm.stopPrank();
        assertEq(sd.pendingWithdrawal(sellerA), 100e6);
    }

    // ---------------------------------------------------------------- withdrawDeposit

    function test_WithdrawDeposit_RevertsNothingPending() public {
        _fund(sellerA, 100e6);
        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.NothingPending.selector);
        sd.withdrawDeposit();
    }

    function test_WithdrawDeposit_RevertsCooldownActive() public {
        _fund(sellerA, 100e6);
        vm.startPrank(sellerA);
        sd.requestWithdraw(100e6);
        vm.expectRevert(SealedDelivery.CooldownActive.selector);
        sd.withdrawDeposit();
        skip(COOLDOWN - 1);
        vm.expectRevert(SealedDelivery.CooldownActive.selector);
        sd.withdrawDeposit();
        vm.stopPrank();
    }

    function test_WithdrawDeposit_SucceedsExactlyAtReadyAt() public {
        _fund(sellerA, 100e6);
        vm.startPrank(sellerA);
        sd.requestWithdraw(60e6);
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        vm.warp(readyAt);
        vm.expectEmit(true, false, false, true, address(sd));
        emit SealedDelivery.DepositWithdrawn(sellerA, 60e6);
        sd.withdrawDeposit();
        vm.stopPrank();
        assertEq(usdc.balanceOf(sellerA), 60e6);
        assertEq(usdc.balanceOf(address(sd)), 40e6);
        assertEq(sd.deposits(sellerA), 40e6);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(sd.withdrawReadyAt(sellerA), 0);
        assertEq(sd.coverage(sellerA), 40e6);
    }

    function test_WithdrawDeposit_SecondCallReverts() public {
        _fund(sellerA, 100e6);
        vm.startPrank(sellerA);
        sd.requestWithdraw(60e6);
        skip(COOLDOWN);
        sd.withdrawDeposit();
        vm.expectRevert(SealedDelivery.NothingPending.selector);
        sd.withdrawDeposit();
        vm.stopPrank();
    }

    function test_WithdrawDeposit_SecondRequestRestartsCooldown() public {
        _fund(sellerA, 100e6);
        vm.startPrank(sellerA);
        sd.requestWithdraw(10e6);
        uint256 first = sd.withdrawReadyAt(sellerA);
        skip(1000);
        sd.requestWithdraw(10e6);
        uint256 second = sd.withdrawReadyAt(sellerA);
        assertEq(second, first + 1000);

        // the first request's original ready time no longer suffices
        vm.warp(first);
        vm.expectRevert(SealedDelivery.CooldownActive.selector);
        sd.withdrawDeposit();
        vm.warp(second - 1);
        vm.expectRevert(SealedDelivery.CooldownActive.selector);
        sd.withdrawDeposit();
        vm.warp(second);
        sd.withdrawDeposit();
        vm.stopPrank();
        assertEq(usdc.balanceOf(sellerA), 20e6);
        assertEq(sd.deposits(sellerA), 80e6);
    }

    /// A pending withdrawal cannot be dodged by a claim: reservation takes only free coverage.
    function test_WithdrawDeposit_PendingExcludedFromLaterClaims() public {
        _fund(sellerA, 100e6);
        vm.prank(sellerA);
        sd.requestWithdraw(80e6);
        _claimOk(_prom(sellerA, buyer, 100e6, N1));
        (,, uint256 r,,) = _claimData(id1);
        assertEq(r, 20e6);
        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(sd.deposits(sellerA), 20e6);
        assertEq(sd.reserved(sellerA), 20e6);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), 10e6); // half of the capped 20e6 reservation
        assertEq(_deadBal(), 10e6);
        assertEq(sd.deposits(sellerA), 0);
    }

    /// The pending withdrawal stays withdrawable after a claim finalizes: tokens are all there.
    function test_WithdrawDeposit_PendingSurvivesFinalizeOfOtherClaim() public {
        _fund(sellerA, 100e6);
        vm.prank(sellerA);
        sd.requestWithdraw(40e6);
        _claimOk(_prom(sellerA, buyer, 30e6, N1)); // reserves 60e6, coverage 0
        skip(COOLDOWN);
        sd.finalize(id1); // buyer 30, burned 30, deposits 40
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(usdc.balanceOf(sellerA), 40e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(usdc.balanceOf(address(sd)), 30e6); // exactly the buyer's credit remains
        vm.prank(buyer);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(buyer), 30e6);
        assertEq(usdc.balanceOf(address(sd)), 0);
    }

    // ---------------------------------------------------------------- withdrawClaimable

    function test_WithdrawClaimable_RevertsNothingToWithdraw() public {
        vm.prank(buyer);
        vm.expectRevert(SealedDelivery.NothingToWithdraw.selector);
        sd.withdrawClaimable();
    }

    function test_WithdrawClaimable_PaysBuyerAfterSilent() public {
        _fund(sellerA, 100e6);
        _claimOk(_prom(sellerA, buyer, 30e6, N1)); // reserves 60: buyer 30, burned 30
        skip(WINDOW);
        sd.finalize(id1);
        assertEq(usdc.balanceOf(address(sd)), 70e6); // burn already left the contract

        vm.expectEmit(true, false, false, true, address(sd));
        emit SealedDelivery.ClaimableWithdrawn(buyer, 30e6);
        vm.prank(buyer);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(buyer), 30e6);
        assertEq(usdc.balanceOf(address(sd)), 40e6);
        assertEq(sd.deposits(sellerA), 40e6);
        assertEq(sd.claimable(buyer), 0);

        vm.prank(buyer);
        vm.expectRevert(SealedDelivery.NothingToWithdraw.selector);
        sd.withdrawClaimable();
    }

    function test_WithdrawClaimable_NotPayableToOthers() public {
        _fund(sellerA, 100e6);
        _claimOk(_prom(sellerA, buyer, 30e6, N1));
        skip(WINDOW);
        sd.finalize(id1);
        vm.prank(carol);
        vm.expectRevert(SealedDelivery.NothingToWithdraw.selector);
        sd.withdrawClaimable();
        assertEq(sd.claimable(buyer), 30e6);
    }
}
