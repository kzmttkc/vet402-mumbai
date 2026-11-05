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
        (,,, deadline,) = _claimData(id1);
    }

    // ---------------------------------------------------------------- answer

    function test_Answer_DeliversAndReleasesLiability() public {
        assertEq(sd.openLiability(sellerA), 2 * VAL);
        sd.answer(id1, KEY);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(sd.openLiability(sellerA), 0);
        assertEq(sd.deposits(sellerA), DEP);
        assertEq(sd.coverage(sellerA), DEP);
        assertEq(sd.claimable(buyer), 0);
    }

    function test_Answer_EmitsKeyRevealed() public {
        vm.expectEmit(true, true, false, true, address(sd));
        emit SealedDelivery.KeyRevealed(id1, N1, KEY);
        sd.answer(id1, KEY);
    }

    function test_Answer_CallableByThirdPartyHoldingKey() public {
        vm.prank(carol);
        sd.answer(id1, KEY);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function test_Answer_OneSecondBeforeDeadline() public {
        vm.warp(deadline - 1);
        sd.answer(id1, KEY);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.DELIVERED));
    }

    function test_Answer_RevertsWrongKey() public {
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.answer(id1, "not-the-key");
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
        vm.expectRevert(SealedDelivery.WrongKey.selector);
        sd.answer(id1, "");
    }

    function test_Answer_RevertsAnswerWindowClosed_AtDeadline() public {
        vm.warp(deadline);
        vm.expectRevert(SealedDelivery.AnswerWindowClosed.selector);
        sd.answer(id1, KEY);
    }

    function test_Answer_RevertsAnswerWindowClosed_AfterDeadline() public {
        vm.warp(uint256(deadline) + 1000);
        vm.expectRevert(SealedDelivery.AnswerWindowClosed.selector);
        sd.answer(id1, KEY);
    }

    function test_Answer_RevertsNotOpen_UnknownNonce() public {
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(_cid(sellerA, buyer, N2), KEY);
    }

    function test_Answer_RevertsNotOpen_Repeat() public {
        sd.answer(id1, KEY);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(id1, KEY);
    }

    function test_Answer_RevertsNotOpen_AfterFinalize() public {
        vm.warp(deadline);
        sd.finalize(id1);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.answer(id1, KEY);
    }

    // ---------------------------------------------------------------- finalize

    function test_Finalize_RevertsDeadlineNotReached() public {
        vm.expectRevert(SealedDelivery.DeadlineNotReached.selector);
        sd.finalize(id1);
        vm.warp(deadline - 1);
        vm.expectRevert(SealedDelivery.DeadlineNotReached.selector);
        sd.finalize(id1);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_Finalize_AtDeadlineMarksSilentAndPays() public {
        vm.warp(deadline);
        vm.prank(carol); // anyone may finalize
        sd.finalize(id1);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.SILENT));
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
        assertEq(sd.openLiability(sellerA), 0);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.silentCount(sellerA), 1);
        assertEq(sd.coverage(sellerA), DEP - 2 * VAL);
        // no USDC moves: the burned half waits in pendingBurn, the buyer's half stays as claimable
        assertEq(usdc.balanceOf(address(sd)), DEP);
        assertEq(sd.pendingBurn(), VAL);
    }

    function test_Finalize_MovesNoUsdc_SilentIsTheOnlyLog() public {
        vm.warp(deadline);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(id1, N1, sellerA, buyer, VAL);
        vm.recordLogs();
        sd.finalize(id1);
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(usdc.balanceOf(DEAD_ADDR), 0);
    }

    function test_Finalize_NoDepositMovesNoTokensAndSkipsBurn() public {
        // zero-deposit seller: payout 0, nothing queued to burn, still SILENT
        _claimOk(_prom(sellerB, buyer2, 5e6, N2));
        bytes32 idB = _cid(sellerB, buyer2, N2);
        vm.warp(deadline);
        vm.recordLogs();
        sd.finalize(idB);
        assertEq(vm.getRecordedLogs().length, 1, "only the Silent event");
        assertEq(_burnTotal(), 0);
    }

    function test_Finalize_EmitsSilent() public {
        vm.warp(deadline);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(id1, N1, sellerA, buyer, VAL);
        sd.finalize(id1);
    }

    function test_Finalize_LongAfterDeadline() public {
        vm.warp(uint256(deadline) + 1 days);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), VAL);
    }

    function test_Finalize_RevertsNotOpen_AfterAnswer() public {
        sd.answer(id1, KEY);
        vm.warp(deadline);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(id1);
        assertEq(sd.silentCount(sellerA), 0);
    }

    function test_Finalize_RevertsNotOpen_Twice() public {
        vm.warp(deadline);
        sd.finalize(id1);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(id1);
        assertEq(sd.silentCount(sellerA), 1);
        assertEq(sd.claimable(buyer), VAL);
    }

    function test_Finalize_RevertsNotOpen_UnknownNonce() public {
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(_cid(sellerA, buyer, N2));
    }

    function test_Finalize_SilentCountAccumulates() public {
        _claimOk(_prom(sellerA, buyer2, VAL, N2));
        vm.warp(block.timestamp + 1000);
        sd.finalize(id1);
        sd.finalize(_cid(sellerA, buyer2, N2));
        assertEq(sd.silentCount(sellerA), 2);
        assertEq(sd.silentCount(sellerB), 0);
    }

    // ---------------------------------------------------------------- coverage-capped payouts

    function test_Payout_CappedByDeposit() public {
        _fund(sellerB, 30e6);
        _claimOk(_prom(sellerB, buyer2, 100e6, N2));
        (,, uint256 r,,) = _claimData(_cid(sellerB, buyer2, N2));
        assertEq(r, 200e6); // the liability is not capped; the payout below is
        assertEq(sd.openLiability(sellerB), 200e6);
        assertEq(sd.coverage(sellerB), 30e6);

        (,,, uint64 dl,) = _claimData(_cid(sellerB, buyer2, N2));
        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(_cid(sellerB, buyer2, N2), N2, sellerB, buyer2, 15e6);
        sd.finalize(_cid(sellerB, buyer2, N2));
        assertEq(sd.claimable(buyer2), 15e6);
        assertEq(_burnTotal(), 15e6);
        assertEq(sd.deposits(sellerB), 0);
        assertEq(sd.silentCount(sellerB), 1);
    }

    function test_Payout_OddCapRoundsBuyerShareUp() public {
        _fund(sellerB, 31); // 31 base units, value large => payout 31
        _claimOk(_prom(sellerB, buyer2, 1e6, N2));
        bytes32 idB = _cid(sellerB, buyer2, N2);
        vm.warp(deadline);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(idB, N2, sellerB, buyer2, 16);
        sd.finalize(idB);
        assertEq(sd.claimable(buyer2), 16);
        assertEq(_burnTotal(), 15);
        assertEq(sd.deposits(sellerB), 0);
    }

    function test_Payout_TinyPayoutOfOneAllGoesToBuyer() public {
        _fund(sellerB, 1);
        _claimOk(_prom(sellerB, buyer2, 1e6, N2));
        bytes32 idB = _cid(sellerB, buyer2, N2);
        vm.warp(deadline);
        sd.finalize(idB);
        assertEq(sd.claimable(buyer2), 1);
        assertEq(_burnTotal(), 0);
    }

    function test_Payout_ZeroDepositSeller() public {
        _claimOk(_prom(sellerB, buyer2, 100e6, N2));
        (,, uint256 r, uint64 dl,) = _claimData(_cid(sellerB, buyer2, N2));
        assertEq(r, 200e6);
        assertEq(uint8(_status(_cid(sellerB, buyer2, N2))), uint8(SealedDelivery.Status.OPEN));
        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(_cid(sellerB, buyer2, N2), N2, sellerB, buyer2, 0);
        sd.finalize(_cid(sellerB, buyer2, N2));
        assertEq(sd.claimable(buyer2), 0);
        assertEq(sd.silentCount(sellerB), 1);
        vm.prank(buyer2);
        vm.expectRevert(SealedDelivery.NothingToWithdraw.selector);
        sd.withdrawClaimable();
    }

    function test_Payout_EarlierVerdictTakesFirstLaterGetsTheRest() public {
        // deposit is DEP (500); the first claim owes 200, the second 900, the third 20.
        bytes32 n3 = keccak256("n3");
        _claimOk(_prom(sellerA, buyer2, 450e6, N2));
        _claimOk(_prom(sellerA, buyer2, 10e6, n3));
        assertEq(sd.openLiability(sellerA), 200e6 + 900e6 + 20e6);
        assertEq(sd.coverage(sellerA), DEP);

        vm.warp(block.timestamp + 1000);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), 100e6);
        sd.finalize(_cid(sellerA, buyer2, N2)); // only 300 left of the 900 owed
        assertEq(sd.claimable(buyer2), 150e6);
        sd.finalize(_cid(sellerA, buyer2, n3)); // nothing left
        assertEq(sd.claimable(buyer2), 150e6);
        assertEq(_burnTotal(), 250e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.openLiability(sellerA), 0);
        assertEq(sd.silentCount(sellerA), 3);
    }

    function test_Payout_AnswerReleasesOnlyItsOwnLiability() public {
        _claimOk(_prom(sellerA, buyer2, 450e6, N2));
        (,, uint256 r2,,) = _claimData(_cid(sellerA, buyer2, N2));
        assertEq(r2, 900e6);
        assertEq(sd.openLiability(sellerA), 2 * VAL + 900e6);
        sd.answer(id1, KEY);
        assertEq(sd.openLiability(sellerA), 900e6);
        assertEq(sd.coverage(sellerA), DEP);
    }

    // ---------------------------------------------------------------- coverage identity

    function _assertCoverageIdentity() internal view {
        assertEq(sd.coverage(sellerA), sd.deposits(sellerA) - sd.pendingWithdrawal(sellerA));
    }

    function test_Coverage_AcrossClaimAnswerFinalizeRequest() public {
        // after claim (setUp): nothing moved
        assertEq(sd.coverage(sellerA), DEP);
        _assertCoverageIdentity();

        // requestWithdraw lowers coverage
        vm.prank(sellerA);
        sd.requestWithdraw(50e6);
        assertEq(sd.coverage(sellerA), DEP - 50e6);
        _assertCoverageIdentity();

        // a second claim and an answer only change the liability
        _claimOk(_prom(sellerA, buyer2, 70e6, N2));
        assertEq(sd.coverage(sellerA), DEP - 50e6);
        assertEq(sd.openLiability(sellerA), 2 * VAL + 140e6);
        sd.answer(id1, KEY);
        assertEq(sd.coverage(sellerA), DEP - 50e6);
        assertEq(sd.openLiability(sellerA), 140e6);
        _assertCoverageIdentity();

        // finalize N2 takes the whole 140 from the deposit (70 buyer, 70 burned)
        (,,, uint64 dl,) = _claimData(_cid(sellerA, buyer2, N2));
        vm.warp(dl);
        sd.finalize(_cid(sellerA, buyer2, N2));
        assertEq(sd.deposits(sellerA), DEP - 140e6);
        assertEq(sd.coverage(sellerA), DEP - 140e6 - 50e6);
        assertEq(sd.openLiability(sellerA), 0);
        _assertCoverageIdentity();
    }

    function test_Coverage_UnknownSellerIsZero() public view {
        assertEq(sd.coverage(carol), 0);
    }
}
