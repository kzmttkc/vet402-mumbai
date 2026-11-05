// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// answer() / finalize() / coverage-capped payouts.
contract SealedDeliveryLifecycleTest is SealedDeliveryTestBase {
    uint256 internal constant DEP = 500e6;
    uint256 internal constant VAL = 100e6;
    uint64 internal deadline;

    function setUp() public override {
        super.setUp();
        _fund(sellerA, DEP);
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        (,,, deadline,) = _claimData(N1);
    }

    // ---------------------------------------------------------------- answer

    function test_Answer_DeliversAndReleasesReservation() public {
        assertEq(sd.reserved(sellerA), VAL);
        sd.answer(N1, KEY);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.deposits(sellerA), DEP);
        assertEq(sd.coverage(sellerA), DEP);
        assertEq(sd.claimable(buyer), 0);
    }

    function test_Answer_EmitsKeyRevealed() public {
        vm.expectEmit(true, false, false, true, address(sd));
        emit SealedDelivery.KeyRevealed(N1, KEY);
        sd.answer(N1, KEY);
    }

    function test_Answer_CallableByThirdPartyHoldingKey() public {
        vm.prank(carol);
        sd.answer(N1, KEY);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function test_Answer_OneSecondBeforeDeadline() public {
        vm.warp(deadline - 1);
        sd.answer(N1, KEY);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function test_Answer_RevertsWrongKey() public {
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.answer(N1, "not-the-key");
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.OPEN));
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.answer(N1, "");
    }

    function test_Answer_RevertsAnswerWindowClosed_AtDeadline() public {
        vm.warp(deadline);
        vm.expectRevert(SealedDelivery.AnswerWindowClosed.selector);
        sd.answer(N1, KEY);
    }

    function test_Answer_RevertsAnswerWindowClosed_AfterDeadline() public {
        vm.warp(uint256(deadline) + 1000);
        vm.expectRevert(SealedDelivery.AnswerWindowClosed.selector);
        sd.answer(N1, KEY);
    }

    function test_Answer_RevertsNotOpen_UnknownNonce() public {
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(N2, KEY);
    }

    function test_Answer_RevertsNotOpen_Repeat() public {
        sd.answer(N1, KEY);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(N1, KEY);
    }

    function test_Answer_RevertsNotOpen_AfterFinalize() public {
        vm.warp(deadline);
        sd.finalize(N1);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(N1, KEY);
    }

    // ---------------------------------------------------------------- finalize

    function test_Finalize_RevertsDeadlineNotReached() public {
        vm.expectRevert(SealedDelivery.DeadlineNotReached.selector);
        sd.finalize(N1);
        vm.warp(deadline - 1);
        vm.expectRevert(SealedDelivery.DeadlineNotReached.selector);
        sd.finalize(N1);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_Finalize_AtDeadlineMarksSilentAndPays() public {
        vm.warp(deadline);
        vm.prank(carol); // anyone may finalize
        sd.finalize(N1);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.SILENT));
        assertEq(sd.deposits(sellerA), DEP - VAL);
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.silentCount(sellerA), 1);
        assertEq(sd.coverage(sellerA), DEP - VAL);
        // finalize moves no tokens
        assertEq(usdc.balanceOf(address(sd)), DEP);
    }

    function test_Finalize_EmitsSilent() public {
        vm.warp(deadline);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(N1, sellerA, buyer, VAL);
        sd.finalize(N1);
    }

    function test_Finalize_LongAfterDeadline() public {
        vm.warp(uint256(deadline) + 1 days);
        sd.finalize(N1);
        assertEq(sd.claimable(buyer), VAL);
    }

    function test_Finalize_RevertsNotOpen_AfterAnswer() public {
        sd.answer(N1, KEY);
        vm.warp(deadline);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(N1);
        assertEq(sd.silentCount(sellerA), 0);
    }

    function test_Finalize_RevertsNotOpen_Twice() public {
        vm.warp(deadline);
        sd.finalize(N1);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(N1);
        assertEq(sd.silentCount(sellerA), 1);
        assertEq(sd.claimable(buyer), VAL);
    }

    function test_Finalize_RevertsNotOpen_UnknownNonce() public {
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(N2);
    }

    function test_Finalize_SilentCountAccumulates() public {
        _claimOk(_prom(sellerA, buyer2, VAL, N2));
        vm.warp(block.timestamp + 1000);
        sd.finalize(N1);
        sd.finalize(N2);
        assertEq(sd.silentCount(sellerA), 2);
        assertEq(sd.silentCount(sellerB), 0);
    }

    // ---------------------------------------------------------------- coverage-capped payouts

    function test_Payout_CappedByDeposit() public {
        _fund(sellerB, 30e6);
        _claimOk(_prom(sellerB, buyer2, 100e6, N2));
        (,, uint256 r,,) = _claimData(N2);
        assertEq(r, 30e6);
        assertEq(sd.reserved(sellerB), 30e6);
        assertEq(sd.coverage(sellerB), 0);

        (,,, uint64 dl,) = _claimData(N2);
        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(N2, sellerB, buyer2, 30e6);
        sd.finalize(N2);
        assertEq(sd.claimable(buyer2), 30e6);
        assertEq(sd.deposits(sellerB), 0);
        assertEq(sd.silentCount(sellerB), 1);
    }

    function test_Payout_ZeroDepositSeller() public {
        _claimOk(_prom(sellerB, buyer2, 100e6, N2));
        (,, uint256 r, uint64 dl,) = _claimData(N2);
        assertEq(r, 0);
        assertEq(uint8(_status(N2)), uint8(SealedDelivery.Status.OPEN));
        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(N2, sellerB, buyer2, 0);
        sd.finalize(N2);
        assertEq(sd.claimable(buyer2), 0);
        assertEq(sd.silentCount(sellerB), 1);
        vm.prank(buyer2);
        vm.expectRevert(SealedDelivery.NothingToWithdraw.selector);
        sd.withdrawClaimable();
    }

    function test_Payout_SecondClaimSeesReducedCoverage() public {
        // deposit is DEP (500); first claim reserved 100. Second claim for 450 only gets 400.
        bytes32 n3 = keccak256("n3");
        _claimOk(_prom(sellerA, buyer2, 450e6, N2));
        (,, uint256 r2,,) = _claimData(N2);
        assertEq(r2, 400e6);
        assertEq(sd.coverage(sellerA), 0);
        // third claim sees nothing left
        _claimOk(_prom(sellerA, buyer2, 10e6, n3));
        (,, uint256 r3,,) = _claimData(n3);
        assertEq(r3, 0);
        assertEq(sd.reserved(sellerA), DEP);

        vm.warp(block.timestamp + 1000);
        sd.finalize(N1);
        sd.finalize(N2);
        sd.finalize(n3);
        assertEq(sd.claimable(buyer), 100e6);
        assertEq(sd.claimable(buyer2), 400e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.silentCount(sellerA), 3);
    }

    function test_Payout_AnswerFreesCoverageForNextClaim() public {
        _claimOk(_prom(sellerA, buyer2, 450e6, N2));
        (,, uint256 r2,,) = _claimData(N2);
        assertEq(r2, 400e6);
        sd.answer(N1, KEY);
        assertEq(sd.coverage(sellerA), 100e6);
    }

    // ---------------------------------------------------------------- coverage identity

    function _assertCoverageIdentity() internal view {
        assertEq(sd.coverage(sellerA), sd.deposits(sellerA) - sd.reserved(sellerA) - sd.pendingWithdrawal(sellerA));
    }

    function test_Coverage_AcrossClaimAnswerFinalizeRequest() public {
        // after claim (setUp)
        assertEq(sd.coverage(sellerA), DEP - VAL);
        _assertCoverageIdentity();

        // requestWithdraw lowers coverage
        vm.prank(sellerA);
        sd.requestWithdraw(50e6);
        assertEq(sd.coverage(sellerA), DEP - VAL - 50e6);
        _assertCoverageIdentity();

        // second claim
        _claimOk(_prom(sellerA, buyer2, 70e6, N2));
        assertEq(sd.coverage(sellerA), DEP - VAL - 50e6 - 70e6);
        _assertCoverageIdentity();

        // answer N1 releases 100
        sd.answer(N1, KEY);
        assertEq(sd.coverage(sellerA), DEP - 50e6 - 70e6);
        _assertCoverageIdentity();

        // finalize N2 burns 70 from the deposit, reservation cleared
        (,,, uint64 dl,) = _claimData(N2);
        vm.warp(dl);
        sd.finalize(N2);
        assertEq(sd.deposits(sellerA), DEP - 70e6);
        assertEq(sd.coverage(sellerA), DEP - 70e6 - 50e6);
        _assertCoverageIdentity();
    }

    function test_Coverage_UnknownSellerIsZero() public view {
        assertEq(sd.coverage(carol), 0);
    }
}
