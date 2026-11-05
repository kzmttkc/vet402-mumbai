// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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

    function test_Answer_DeliversAndReleasesReservation() public {
        assertEq(sd.reserved(sellerA), 2 * VAL);
        sd.answer(id1, KEY);
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(sd.reserved(sellerA), 0);
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
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(sd.silentCount(sellerA), 1);
        assertEq(sd.coverage(sellerA), DEP - 2 * VAL);
        // the burned half leaves the contract; the buyer's half stays as claimable
        assertEq(usdc.balanceOf(address(sd)), DEP - VAL);
        assertEq(_deadBal(), VAL);
    }

    function test_Finalize_EmitsUsdcTransferToDead() public {
        vm.warp(deadline);
        vm.expectEmit(true, true, false, true, USDC_ADDR);
        emit IERC20.Transfer(address(sd), DEAD_ADDR, VAL);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(id1, N1, sellerA, buyer, VAL);
        sd.finalize(id1);
    }

    function test_Finalize_ZeroReservationMovesNoTokensAndSkipsBurn() public {
        // zero-deposit seller: reservation 0, no transfer to DEAD, still SILENT
        _claimOk(_prom(sellerB, buyer2, 5e6, N2));
        bytes32 idB = _cid(sellerB, buyer2, N2);
        vm.warp(deadline);
        vm.recordLogs();
        sd.finalize(idB);
        assertEq(vm.getRecordedLogs().length, 1, "only the Silent event");
        assertEq(_deadBal(), 0);
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
        assertEq(r, 30e6); // min(2 * 100, 30)
        assertEq(sd.reserved(sellerB), 30e6);
        assertEq(sd.coverage(sellerB), 0);

        (,,, uint64 dl,) = _claimData(_cid(sellerB, buyer2, N2));
        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(_cid(sellerB, buyer2, N2), N2, sellerB, buyer2, 15e6);
        sd.finalize(_cid(sellerB, buyer2, N2));
        assertEq(sd.claimable(buyer2), 15e6);
        assertEq(_deadBal(), 15e6);
        assertEq(sd.deposits(sellerB), 0);
        assertEq(sd.silentCount(sellerB), 1);
    }

    function test_Payout_OddCapRoundsBuyerShareUp() public {
        _fund(sellerB, 31); // 31 base units, value large => r = 31
        _claimOk(_prom(sellerB, buyer2, 1e6, N2));
        bytes32 idB = _cid(sellerB, buyer2, N2);
        (,, uint256 r,,) = _claimData(idB);
        assertEq(r, 31);
        vm.warp(deadline);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(idB, N2, sellerB, buyer2, 16);
        sd.finalize(idB);
        assertEq(sd.claimable(buyer2), 16);
        assertEq(_deadBal(), 15);
        assertEq(sd.deposits(sellerB), 0);
    }

    function test_Payout_TinyReservationOfOneAllGoesToBuyer() public {
        _fund(sellerB, 1);
        _claimOk(_prom(sellerB, buyer2, 1e6, N2));
        bytes32 idB = _cid(sellerB, buyer2, N2);
        vm.warp(deadline);
        sd.finalize(idB);
        assertEq(sd.claimable(buyer2), 1);
        assertEq(_deadBal(), 0);
    }

    function test_Payout_ZeroDepositSeller() public {
        _claimOk(_prom(sellerB, buyer2, 100e6, N2));
        (,, uint256 r, uint64 dl,) = _claimData(_cid(sellerB, buyer2, N2));
        assertEq(r, 0);
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

    function test_Payout_SecondClaimSeesReducedCoverage() public {
        // deposit is DEP (500); first claim reserved 200. Second claim (2 * 450 = 900) only gets 300.
        bytes32 n3 = keccak256("n3");
        _claimOk(_prom(sellerA, buyer2, 450e6, N2));
        (,, uint256 r2,,) = _claimData(_cid(sellerA, buyer2, N2));
        assertEq(r2, 300e6);
        assertEq(sd.coverage(sellerA), 0);
        // third claim sees nothing left
        _claimOk(_prom(sellerA, buyer2, 10e6, n3));
        (,, uint256 r3,,) = _claimData(_cid(sellerA, buyer2, n3));
        assertEq(r3, 0);
        assertEq(sd.reserved(sellerA), DEP);

        vm.warp(block.timestamp + 1000);
        sd.finalize(id1);
        sd.finalize(_cid(sellerA, buyer2, N2));
        sd.finalize(_cid(sellerA, buyer2, n3));
        assertEq(sd.claimable(buyer), 100e6);
        assertEq(sd.claimable(buyer2), 150e6);
        assertEq(_deadBal(), 250e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.silentCount(sellerA), 3);
    }

    function test_Payout_AnswerFreesCoverageForNextClaim() public {
        _claimOk(_prom(sellerA, buyer2, 450e6, N2));
        (,, uint256 r2,,) = _claimData(_cid(sellerA, buyer2, N2));
        assertEq(r2, 300e6);
        sd.answer(id1, KEY);
        assertEq(sd.coverage(sellerA), 200e6);
    }

    // ---------------------------------------------------------------- coverage identity

    function _assertCoverageIdentity() internal view {
        assertEq(sd.coverage(sellerA), sd.deposits(sellerA) - sd.reserved(sellerA) - sd.pendingWithdrawal(sellerA));
    }

    function test_Coverage_AcrossClaimAnswerFinalizeRequest() public {
        // after claim (setUp): reserved 2 * VAL
        assertEq(sd.coverage(sellerA), DEP - 2 * VAL);
        _assertCoverageIdentity();

        // requestWithdraw lowers coverage
        vm.prank(sellerA);
        sd.requestWithdraw(50e6);
        assertEq(sd.coverage(sellerA), DEP - 2 * VAL - 50e6);
        _assertCoverageIdentity();

        // second claim reserves 2 * 70
        _claimOk(_prom(sellerA, buyer2, 70e6, N2));
        assertEq(sd.coverage(sellerA), DEP - 2 * VAL - 50e6 - 140e6);
        _assertCoverageIdentity();

        // answer N1 releases 200
        sd.answer(id1, KEY);
        assertEq(sd.coverage(sellerA), DEP - 50e6 - 140e6);
        _assertCoverageIdentity();

        // finalize N2 removes the whole 140 reservation from the deposit (70 buyer, 70 burned)
        (,,, uint64 dl,) = _claimData(_cid(sellerA, buyer2, N2));
        vm.warp(dl);
        sd.finalize(_cid(sellerA, buyer2, N2));
        assertEq(sd.deposits(sellerA), DEP - 140e6);
        assertEq(sd.coverage(sellerA), DEP - 140e6 - 50e6);
        _assertCoverageIdentity();
    }

    function test_Coverage_UnknownSellerIsZero() public view {
        assertEq(sd.coverage(carol), 0);
    }
}
