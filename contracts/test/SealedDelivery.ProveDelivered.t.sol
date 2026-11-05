// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// prove() on DELIVERED claims: payout = min(c.reserved, deposits - reserved) at that moment, i.e. the
/// unreserved deposit INCLUDING funds queued by requestWithdraw. The part of the payout that was queued
/// (amount - coverage) is taken out of pendingWithdrawal.
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
        assertGe(sd.deposits(sellerA), sd.reserved(sellerA) + sd.pendingWithdrawal(sellerA));
    }

    function test_ProveDelivered_FullCoverage_PaysWholeReservation() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        // a different OPEN claim must keep its reservation untouched
        _claimOk(_prom(sellerA, buyer2, 50e6, N2));
        assertEq(sd.reserved(sellerA), 100e6);

        vm.expectEmit(true, true, false, true, USDC_ADDR);
        emit IERC20.Transfer(address(sd), DEAD_ADDR, VAL);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id, N1, sellerA, buyer, VAL);
        vm.prank(carol);
        sd.prove(id, ct, KEY);

        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.reserved(sellerA), 100e6, "delivered claim holds no reservation to release");
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
        assertEq(sd.claimable(buyer), VAL);
        assertEq(_deadBal(), VAL);
        assertEq(usdc.balanceOf(address(sd)), DEP - VAL);
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        _solvent();

        vm.expectRevert(SealedDelivery.AlreadyFraud.selector);
        sd.prove(id, ct, KEY);
        vm.warp(block.timestamp + 5000);
        vm.expectRevert(SealedDelivery.NotOpen.selector);
        sd.finalize(id);
    }

    /// Another claim and a pending withdrawal consumed coverage: the payout is still the full reservation
    /// (deposit 500, other claim reserves 200 => 300 backing >= 200); the overlap comes out of pending.
    function test_ProveDelivered_PaidFromQueuedFundsWhenOtherClaimConsumedCoverage() public {
        (bytes32 id1_, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1); // reserved back to 0
        vm.prank(sellerA);
        sd.requestWithdraw(250e6); // coverage 250
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        (bytes32 id2,) = _sealedClaim(sellerA, buyer2, VAL, N2, KEY, PLAIN, false); // reserves 200 -> coverage 50
        assertEq(sd.coverage(sellerA), 50e6);

        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id1_, N1, sellerA, buyer, VAL);
        sd.prove(id1_, ct, KEY);

        assertEq(sd.claimable(buyer), VAL);
        assertEq(_deadBal(), VAL);
        assertEq(sd.deposits(sellerA), DEP - 2 * VAL);
        assertEq(sd.reserved(sellerA), 200e6, "other claim's reservation untouched");
        assertEq(sd.pendingWithdrawal(sellerA), 100e6, "pending dropped by the overlap 200 - 50 = 150");
        assertEq(sd.withdrawReadyAt(sellerA), readyAt, "cooldown unchanged while pending remains");
        assertEq(sd.coverage(sellerA), 0);
        assertEq(sd.fraudCount(sellerA), 1);
        _solvent();

        // the seller can still withdraw what is pending and the other claim still settles in full
        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(usdc.balanceOf(sellerA), 100e6);
        sd.finalize(id2);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(sd.claimable(buyer2), 100e6);
        assertEq(usdc.balanceOf(address(sd)), sd.claimable(buyer) + sd.claimable(buyer2), "fully backed");
        vm.prank(buyer);
        sd.withdrawClaimable();
        vm.prank(buyer2);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(address(sd)), 0);
    }

    /// The cap is now deposits - reserved: another OPEN claim reserving most of the deposit caps the payout,
    /// and an odd cap rounds the buyer's half up.
    function test_ProveDelivered_CappedOddBackingRoundsBuyerUp() public {
        _fund(sellerA, 1); // deposit 500e6 + 1
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        _sealedClaim(sellerA, buyer2, 175e6, N2, KEY, PLAIN, false); // reserves 350e6 => backing 150e6 + 1
        assertEq(sd.reserved(sellerA), 350e6);

        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Fraud(id, N1, sellerA, buyer, 75e6 + 1);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), 75e6 + 1);
        assertEq(_deadBal(), 75e6);
        assertEq(sd.deposits(sellerA), 350e6, "exactly the other claim's reservation is left");
        assertEq(sd.reserved(sellerA), 350e6);
        assertEq(sd.coverage(sellerA), 0);
        assertEq(sd.pendingWithdrawal(sellerA), 0);
        _solvent();
    }

    function test_ProveDelivered_QueuedFundsPayAndPendingDropsByOverlap() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        vm.prank(sellerA);
        sd.requestWithdraw(480e6); // coverage 20
        uint256 readyAt = sd.withdrawReadyAt(sellerA);
        sd.prove(id, ct, KEY); // full 200 paid; overlap 180
        assertEq(sd.claimable(buyer), VAL);
        assertEq(_deadBal(), VAL);
        assertEq(sd.deposits(sellerA), 300e6);
        assertEq(sd.pendingWithdrawal(sellerA), 300e6);
        assertEq(sd.withdrawReadyAt(sellerA), readyAt);
        _solvent();

        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit(); // only the still-pending amount is paid
        assertEq(usdc.balanceOf(sellerA), 300e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(usdc.balanceOf(address(sd)), VAL);
    }

    /// Everything is reserved by another claim: nothing backs the delivered claim, fraud is recorded, payout 0.
    function test_ProveDelivered_NothingUnreservedLeft_FraudWithoutPayout() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerA, buyer, VAL, N1);
        _sealedClaim(sellerA, buyer2, 250e6, N2, KEY, PLAIN, false); // reserves the whole 500
        assertEq(sd.reserved(sellerA), DEP);

        vm.recordLogs();
        sd.prove(id, ct, KEY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "no token transfer when nothing is paid");
        assertEq(logs[0].topics[0], SealedDelivery.Fraud.selector);
        assertEq(logs[0].topics[1], id);
        (address b, uint256 paid) = abi.decode(logs[0].data, (address, uint256));
        assertEq(b, buyer);
        assertEq(paid, 0);

        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        assertEq(sd.fraudCount(sellerA), 1);
        assertEq(sd.claimable(buyer), 0);
        assertEq(_deadBal(), 0);
        assertEq(sd.deposits(sellerA), DEP);
        assertEq(sd.reserved(sellerA), DEP);
        assertEq(usdc.balanceOf(address(sd)), DEP);
        vm.expectRevert(SealedDelivery.AlreadyFraud.selector);
        sd.prove(id, ct, KEY);
    }

    function test_ProveDelivered_ClaimWithZeroReservation_FraudWithoutPayout() public {
        (bytes32 id, bytes memory ct) = _delivered(sellerB, buyer, VAL, N1); // sellerB had no deposit => r = 0
        (,, uint256 r,,) = _claimData(id);
        assertEq(r, 0);
        _fund(sellerB, 100e6); // coverage appears later, but the claim only reserved 0
        sd.prove(id, ct, KEY);
        assertEq(sd.fraudCount(sellerB), 1);
        assertEq(sd.claimable(buyer), 0);
        assertEq(sd.deposits(sellerB), 100e6);
        assertEq(_deadBal(), 0);
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
        assertEq(_deadBal(), 200e6);
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
        assertEq(_deadBal(), VAL);
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
        assertEq(logs[1].topics[0], SealedDelivery.Fraud.selector);
        assertEq(logs[1].topics[1], id);
        assertEq(logs[1].topics[2], N1);
    }
}
