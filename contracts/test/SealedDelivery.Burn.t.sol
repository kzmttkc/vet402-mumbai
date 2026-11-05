// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// Economics of the 2x payout: half to the buyer (rounded up), half queued for the burn to 0xdEaD.
contract SealedDeliveryBurnTest is SealedDeliveryTestBase {
    uint256 internal constant V = 100e6;
    bytes internal constant PLAIN = "self-dealt goods";

    /// Everything an actor owns across wallet, contract deposit and unclaimed credit.
    function _holdings(address a) internal view returns (uint256) {
        return usdc.balanceOf(a) + sd.deposits(a) + sd.claimable(a);
    }

    /// seller S pays itself through B: S signs a Promise to B, B claims, nobody answers, finalize, B withdraws.
    function _selfDeal(address s, address b, uint256 value) internal {
        _claimOk(_prom(s, b, value, N1));
        skip(WINDOW);
        sd.finalize(_cid(s, b, N1));
        vm.prank(b);
        sd.withdrawClaimable();
    }

    function test_SelfDealing_LosesHalfOfWhatItPulls() public {
        address s = sellerA; // self-dealer
        address b = buyer; // its second address
        _fund(s, 500e6);
        _fund(sellerB, 500e6); // control seller who simply withdraws
        usdc.mint(s, 50e6);
        usdc.mint(b, 10e6);
        usdc.mint(sellerB, 50e6);

        uint256 startTotal = _holdings(s) + _holdings(b);
        assertEq(startTotal, 560e6); // 50 wallet + 500 deposit + 10
        uint256 ctrlStart = _holdings(sellerB);
        assertEq(ctrlStart, 550e6);

        // S pulls V = 100 to B: payout 2V = 200, B receives 100, 100 is burned
        _selfDeal(s, b, V);

        assertEq(sd.deposits(s), 300e6);
        assertEq(usdc.balanceOf(s), 50e6);
        assertEq(usdc.balanceOf(b), 110e6);
        assertEq(sd.claimable(b), 0);
        assertEq(_burnTotal(), V);
        uint256 endTotal = _holdings(s) + _holdings(b);
        assertEq(endTotal, 460e6);
        assertEq(startTotal - endTotal, V, "S+B together are exactly V poorer");

        // the rest of S's deposit is recoverable, the loss is permanent
        vm.prank(s);
        sd.requestWithdraw(300e6);
        skip(COOLDOWN);
        vm.prank(s);
        sd.withdrawDeposit();
        assertEq(usdc.balanceOf(s) + usdc.balanceOf(b), 350e6 + 110e6);
        assertEq(startTotal - (usdc.balanceOf(s) + usdc.balanceOf(b)), V);

        // control: requestWithdraw + COOLDOWN + withdrawDeposit returns the whole deposit with zero loss
        vm.prank(sellerB);
        sd.requestWithdraw(500e6);
        skip(COOLDOWN);
        vm.prank(sellerB);
        sd.withdrawDeposit();
        assertEq(sd.deposits(sellerB), 0);
        assertEq(usdc.balanceOf(sellerB), 550e6);
        assertEq(_holdings(sellerB), ctrlStart, "zero loss");

        // nothing left in the contract once the burn is flushed; burned amount sits at DEAD
        sd.flushBurn();
        assertEq(usdc.balanceOf(address(sd)), 0);
        assertEq(_burnTotal(), V);
    }

    /// Dishonest seller proving itself through B instead of staying silent loses the same half.
    function test_SelfDealing_ViaFraudProofLosesTheSameHalf() public {
        _fund(sellerA, 500e6);
        usdc.mint(buyer, 10e6);
        uint256 start = _holdings(sellerA) + _holdings(buyer);
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, V, N1, KEY, PLAIN, false);
        sd.prove(id, ct, KEY);
        vm.prank(buyer);
        sd.withdrawClaimable();
        assertEq(start - (_holdings(sellerA) + _holdings(buyer)), V);
        assertEq(_burnTotal(), V);
    }

    /// Control: a seller that simply answers pays nothing.
    function test_NoLoss_WhenSellerAnswers() public {
        _fund(sellerA, 500e6);
        _claimOk(_prom(sellerA, buyer, V, N1));
        sd.answer(id1, KEY);
        assertEq(sd.deposits(sellerA), 500e6);
        assertEq(_burnTotal(), 0);
        assertEq(sd.claimable(buyer), 0);
    }

    function test_SelfDealing_OddPayout_BuyerRoundedUp_OneFewerBurned() public {
        usdc.mint(buyer, 10);
        _fund(sellerA, 101); // 101 base units, value 1000 => payout min(2000, 101) = 101
        uint256 start = _holdings(sellerA) + _holdings(buyer);
        _claimOk(_prom(sellerA, buyer, 1000, N1));
        (,,, uint64 dl,) = _claimData(id1);
        vm.warp(dl);

        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(id1, N1, sellerA, buyer, 51);
        sd.finalize(id1);
        vm.prank(buyer);
        sd.withdrawClaimable();

        assertEq(usdc.balanceOf(buyer), 10 + 51);
        assertEq(_burnTotal(), 50, "one unit fewer burned than the buyer receives");
        assertEq(sd.deposits(sellerA), 0);
        assertEq(start - (_holdings(sellerA) + _holdings(buyer)), 50);
    }

    function test_SelfDealing_Capped_DepositBelowTwiceValue() public {
        _fund(sellerA, 150e6); // deposit 150 < 2V = 200
        usdc.mint(buyer, 10e6);
        uint256 start = _holdings(sellerA) + _holdings(buyer);
        _selfDeal(sellerA, buyer, V);
        assertEq(usdc.balanceOf(buyer), 85e6); // 10 + 75
        assertEq(_burnTotal(), 75e6);
        assertEq(sd.deposits(sellerA), 0);
        assertEq(start - (_holdings(sellerA) + _holdings(buyer)), 75e6, "loss is 75 < V because the cap bit");
    }

    /// Queuing no longer shrinks what a verdict can take: only the deposit caps it.
    function test_SelfDealing_QueuedFundsDoNotCapThePayout() public {
        _fund(sellerA, 500e6);
        vm.prank(sellerA);
        sd.requestWithdraw(350e6); // coverage 150, but the whole 500 is still there
        _selfDeal(sellerA, buyer, V);
        assertEq(usdc.balanceOf(buyer), V);
        assertEq(_burnTotal(), V);
        assertEq(sd.deposits(sellerA), 300e6);
        assertEq(sd.pendingWithdrawal(sellerA), 300e6, "pending comes down with the deposit");
        skip(COOLDOWN);
        vm.prank(sellerA);
        sd.withdrawDeposit();
        assertEq(usdc.balanceOf(sellerA), 300e6);
        sd.flushBurn();
        assertEq(usdc.balanceOf(address(sd)), 0);
    }

    function test_Burn_FinalizeWithSingleUnitPayoutBurnsNothing() public {
        _fund(sellerA, 1);
        _claimOk(_prom(sellerA, buyer, V, N1));
        skip(WINDOW);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), 1);
        assertEq(_burnTotal(), 0);
        assertEq(usdc.balanceOf(address(sd)), 1);
        vm.expectRevert(SealedDelivery.NothingToWithdraw.selector);
        sd.flushBurn();
    }

    function test_Burn_QueuesFromBothFinalizeAndProve() public {
        _fund(sellerA, 500e6);
        _claimOk(_prom(sellerA, buyer, V, N1)); // will go silent
        (bytes32 idF, bytes memory ct) = _sealedClaim(sellerA, buyer2, 50e6, N2, KEY, PLAIN, false);
        sd.prove(idF, ct, KEY); // buyer2 50, burn 50
        skip(WINDOW);
        sd.finalize(id1); // buyer 100, burn 100
        assertEq(sd.pendingBurn(), 150e6);
        assertEq(usdc.balanceOf(DEAD_ADDR), 0, "verdicts move no USDC");
        assertEq(sd.claimable(buyer), 100e6);
        assertEq(sd.claimable(buyer2), 50e6);
        assertEq(usdc.balanceOf(address(sd)), 500e6);
        sd.flushBurn();
        assertEq(usdc.balanceOf(DEAD_ADDR), 150e6);
        assertEq(usdc.balanceOf(address(sd)), 500e6 - 150e6);
    }

    function testFuzz_SelfDealing_LossIsFloorHalfOfPayout(uint256 dep, uint256 value) public {
        dep = bound(dep, 1, 1e15);
        value = bound(value, 1, 1e15);
        _fund(sellerA, dep);
        usdc.mint(buyer, 7e6);
        uint256 start = _holdings(sellerA) + _holdings(buyer);
        _selfDeal(sellerA, buyer, value);
        uint256 r = 2 * value < dep ? 2 * value : dep;
        assertEq(usdc.balanceOf(buyer), 7e6 + (r + 1) / 2, "buyer gets half rounded up");
        assertEq(_burnTotal(), r / 2, "burned is half rounded down");
        assertEq(start - (_holdings(sellerA) + _holdings(buyer)), r / 2);
        assertEq(sd.deposits(sellerA), dep - r);
    }
}
