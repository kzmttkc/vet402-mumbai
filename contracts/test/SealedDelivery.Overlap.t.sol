// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// Delivered-claim fraud proofs versus queued withdrawals: queuing a withdrawal must not shield a seller
/// from a proof made inside the cooldown, and proofs only consume what is still there afterwards.
contract SealedDeliveryOverlapTest is SealedDeliveryTestBase {
    uint256 internal constant V = 100e6; // value => reservation 2V = 200e6
    bytes internal constant PLAIN = "wrong goods behind the right key";

    /// Dishonest claim answered with the correct key: DELIVERED, reservation released.
    function _delivered(address seller, address buyer_, uint256 value, bytes32 nonce)
        internal
        returns (bytes32 id, bytes memory ct)
    {
        (id, ct) = _sealedClaim(seller, buyer_, value, nonce, KEY, PLAIN, false);
        sd.answer(id, KEY);
    }

    function _assertHolds() internal view {
        assertGe(sd.deposits(sellerA), sd.reserved(sellerA) + sd.pendingWithdrawal(sellerA));
        assertEq(
            usdc.balanceOf(address(sd)),
            sd.deposits(sellerA) + sd.claimable(buyer) + sd.claimable(buyer2) + sd.claimable(sellerA)
        );
    }

    // (1) the attack: right key, wrong plaintext, immediately queue everything, proof inside the cooldown.
    function test_Attack_QueueEverythingAfterAnswer_ProofInsideCooldownStillPaysInFull() public {
        _fund(sellerA, 500e6);
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1);
        assertEq(sd.coverage(sellerA), 500e6, "all collateral released by the answer");

        vm.prank(sellerA);
        sd.requestWithdraw(500e6);
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        assertEq(readyAt, block.timestamp + COOLDOWN);
        assertEq(sd.coverage(sellerA), 0);

        skip(COOLDOWN - 1); // last second of the cooldown
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id, N1, sellerA, buyer, V);
        vm.prank(carol);
        sd.prove(id, ct, KEY);

        // buyer share and burn paid in full from queued funds
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.claimable(buyer), V);
        assertEq(_deadBal(), V);
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.deposits(sellerA), 300e6);
        // pending dropped by the overlap (amount 200 - coverage 0), cooldown untouched
        assertEq(sd.pendingWithdrawal(sellerA), 300e6);
        assertEq(sd.withdrawReadyAt(sellerA), readyAt);
        _assertHolds();

        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.CooldownActive.selector);
        sd.withdrawDeposit();

        skip(1);
        vm.prank(sellerA);
        sd.withdrawDeposit(); // pays only what is still pending
        assertEq(usdc.balanceOf(sellerA), 300e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(usdc.balanceOf(address(sd)), V, "only the buyer's credit is left");

        vm.prank(buyer);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(buyer), V);
        assertEq(usdc.balanceOf(address(sd)), 0);
    }

    /// The seller's net outcome of the attack equals an honest loss: V burned + V to buyer, 300 returned.
    function test_Attack_SellerCannotEscapeLossByQueueing() public {
        _fund(sellerA, 500e6);
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(500e6);
        sd.prove(id, ct, KEY);
        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        vm.prank(buyer);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(sellerA), 500e6 - 2 * V);
        assertEq(usdc.balanceOf(buyer), V);
        assertEq(_deadBal(), V);
    }

    /// The overlap exhausts pending exactly => withdrawReadyAt cleared, nothing left to withdraw.
    function test_Attack_PendingFullyConsumed_ClearsWithdrawReadyAt() public {
        _fund(sellerA, 200e6); // exactly the reservation
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(200e6);
        assertGt(sd.withdrawReadyAt(sellerA), 0);

        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), V);
        assertEq(_deadBal(), V);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(sd.withdrawReadyAt(sellerA), 0, "cleared when pending reaches 0");
        _assertHolds();

        skip(COOLDOWN);
        vm.prank(sellerA);
        vm.expectRevert(SealedDelivery.NothingPending.selector);
        sd.withdrawDeposit();
        assertEq(usdc.balanceOf(address(sd)), V);
    }

    /// Overlap bigger than coverage but only the pending part of it is removed.
    function test_Attack_OverlapIsOnlyThePartBeyondCoverage() public {
        _fund(sellerA, 500e6);
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(400e6); // coverage 100 < amount 200 => overlap 100
        sd.prove(id, ct, KEY);
        assertEq(sd.pendingWithdrawal(sellerA), 300e6);
        assertEq(sd.deposits(sellerA), 300e6);
        assertEq(sd.coverage(sellerA), 0);
    }

    // (2) a proof needing only part of the pending amount leaves the rest pending, same readyAt.
    function test_PartialConsumption_RestStaysPendingWithSameReadyAt() public {
        _fund(sellerA, 500e6);
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(500e6);
        uint256 readyAt = sd.withdrawReadyAt(sellerA);

        skip(1000);
        sd.prove(id, ct, KEY);
        assertEq(sd.pendingWithdrawal(sellerA), 300e6, "500 - 200");
        assertEq(sd.withdrawReadyAt(sellerA), readyAt, "same readyAt, not restarted");
        assertGt(readyAt, block.timestamp);

        vm.warp(readyAt);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(usdc.balanceOf(sellerA), 300e6);
    }

    /// Without any pending withdrawal the proof draws only on free collateral and touches no pending state.
    function test_NoPending_ProofLeavesPendingStateAlone() public {
        _fund(sellerA, 500e6);
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1);
        sd.prove(id, ct, KEY);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(sd.withdrawReadyAt(sellerA), 0);
        assertEq(sd.deposits(sellerA), 300e6);
    }

    // (3) a proof after the seller completed withdrawDeposit is FRAUD, payout capped by what is left.
    function test_ProofAfterCompletedWithdrawal_NothingLeft_FraudWithZeroPayout() public {
        _fund(sellerA, 200e6);
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(200e6);
        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(sd.deposits(sellerA), 0);
        assertEq(usdc.balanceOf(sellerA), 200e6);

        vm.recordLogs();
        vm.prank(carol);
        sd.prove(id, ct, KEY); // does not revert
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "no transfer");
        (, uint256 paid) = abi.decode(logs[0].data, (address, uint256));
        assertEq(paid, 0);

        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.claimable(buyer), 0);
        assertEq(_deadBal(), 0);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(usdc.balanceOf(address(sd)), 0);
    }

    function test_ProofAfterCompletedWithdrawal_LeftoverCapsPayout() public {
        _fund(sellerA, 300e6);
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, V, N1); // reservation was 200
        vm.prank(sellerA);
        sd.requestWithdraw(250e6);
        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit(); // deposits 50 left
        assertEq(sd.deposits(sellerA), 50e6);

        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id, N1, sellerA, buyer, 25e6);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), 25e6);
        assertEq(_deadBal(), 25e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        assertEq(usdc.balanceOf(address(sd)), 25e6);
        _assertHolds();
    }

    // (4) a delivered-claim proof never touches reservations of other OPEN claims.
    function test_OpenClaimReservationsUntouchedByDeliveredProof() public {
        _fund(sellerA, 500e6);
        (bytes32 idD, bytes memory ctD) = _delivered(sellerA, buyer, V, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(300e6); // coverage 200
        bytes32 idO = _cid(sellerA, buyer2, N2);
        _claimOk(_prom(sellerA, buyer2, V, N2)); // OPEN, reserves 200 => coverage 0
        assertEq(sd.reserved(sellerA), 200e6);
        (,, uint256 rBefore,,) = _claimData(idO);

        sd.prove(idD, ctD, KEY); // needs 200 of queued funds
        assertEq(sd.reserved(sellerA), 200e6, "reserved untouched");
        (,, uint256 rAfter,,) = _claimData(idO);
        assertEq(rAfter, rBefore);
        assertEq(uint8(_status(idO)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.pendingWithdrawal(sellerA), 100e6);
        assertEq(sd.deposits(sellerA), 300e6);
        _assertHolds();

        // the OPEN claim still pays its full reservation, whether silent ...
        skip(WINDOW);
        sd.finalize(idO);
        assertEq(sd.claimable(buyer2), V);
        assertEq(sd.deposits(sellerA), 100e6);
        assertEq(sd.pendingWithdrawal(sellerA), 100e6);
        _assertHolds();
        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(sd.deposits(sellerA), 0);
        assertEq(usdc.balanceOf(address(sd)), 2 * V);
    }

    function test_OpenClaimStillFullyProvableAfterDeliveredProof() public {
        _fund(sellerA, 500e6);
        (bytes32 idD, bytes memory ctD) = _delivered(sellerA, buyer, V, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(300e6);
        (bytes32 idO, bytes memory ctO) = _sealedClaim(sellerA, buyer2, V, N2, KEY, PLAIN, false);
        sd.prove(idD, ctD, KEY);
        sd.prove(idO, ctO, KEY); // OPEN: whole reservation 200, unchanged rule
        assertEq(sd.claimable(buyer2), V);
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.deposits(sellerA), 100e6);
        assertEq(sd.pendingWithdrawal(sellerA), 100e6);
        assertEq(_deadBal(), 2 * V);
        _assertHolds();
    }

    /// Property over arbitrary amounts: payout = min(c.reserved, deposits - reserved), pending drops by
    /// max(0, payout - coverage), other reservations unchanged, accounting stays exact.
    function testFuzz_DeliveredProofPayoutAndPendingLaw(uint256 dep, uint256 val, uint256 req, uint256 otherVal)
        public
    {
        dep = bound(dep, 1, 1e12);
        val = bound(val, 1, 1e12);
        otherVal = bound(otherVal, 0, 1e12);
        _fund(sellerA, dep);
        (bytes32 idD, bytes memory ct) = _delivered(sellerA, buyer, val, N1);
        (,, uint256 cReserved,,) = _claimData(idD);
        req = bound(req, 0, dep);
        if (req > 0) {
            vm.prank(sellerA);
            sd.requestWithdraw(req);
        }
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        _claimOk(_prom(sellerA, buyer2, otherVal, N2));
        uint256 resBefore = sd.reserved(sellerA);
        uint256 cov = sd.coverage(sellerA);

        uint256 backing = dep - resBefore;
        uint256 amount = cReserved < backing ? cReserved : backing;
        uint256 overlap = amount > cov ? amount - cov : 0;
        assertLe(overlap, req, "overlap can never exceed pending");

        sd.prove(idD, ct, KEY);

        assertEq(sd.claimable(buyer), _paid(amount));
        assertEq(_deadBal(), _burnt(amount));
        assertEq(sd.deposits(sellerA), dep - amount);
        assertEq(sd.reserved(sellerA), resBefore);
        assertEq(sd.pendingWithdrawal(sellerA), req - overlap);
        if (req - overlap == 0) assertEq(sd.withdrawReadyAt(sellerA), 0);
        else assertEq(sd.withdrawReadyAt(sellerA), readyAt);
        _assertHolds();

        // everything still settles: pending is withdrawable and the OPEN claim finalizes in full
        skip(COOLDOWN);
        uint256 pend = sd.pendingWithdrawal(sellerA);
        if (pend > 0) {
            vm.prank(sellerA);
            sd.withdrawDeposit();
            assertEq(usdc.balanceOf(sellerA), pend);
        }
        sd.finalize(_cid(sellerA, buyer2, N2));
        assertEq(sd.claimable(buyer2), _paid(resBefore));
        _assertHolds();
    }
}
