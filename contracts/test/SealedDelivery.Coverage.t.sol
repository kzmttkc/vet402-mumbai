// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// coverageFor(seller, value): coverage(seller) >= 2 * value, false when 2 * value would overflow.
contract SealedDeliveryCoverageForTest is SealedDeliveryTestBase {
    uint256 internal constant MAX = type(uint256).max;

    function test_CoverageFor_TrueAtExactlyTwiceValue() public {
        _fund(sellerA, 200e6);
        assertEq(sd.coverage(sellerA), 200e6);
        assertTrue(sd.coverageFor(sellerA, 100e6));
        assertFalse(sd.coverageFor(sellerA, 100e6 + 1));
    }

    function test_CoverageFor_FalseAtTwiceValueMinusOne() public {
        _fund(sellerA, 200e6 - 1);
        assertFalse(sd.coverageFor(sellerA, 100e6));
        assertTrue(sd.coverageFor(sellerA, 100e6 - 1));
    }

    function test_CoverageFor_TrueForZeroValue() public {
        assertTrue(sd.coverageFor(sellerA, 0)); // no deposit at all
        assertTrue(sd.coverageFor(address(0xBEEF), 0));
        _fund(sellerA, 5);
        assertTrue(sd.coverageFor(sellerA, 0));
    }

    function test_CoverageFor_FalseForUnfundedSellerAndPositiveValue() public view {
        assertFalse(sd.coverageFor(sellerA, 1));
    }

    function test_CoverageFor_FalseForMaxAndOverflowingValues() public {
        _fund(sellerA, 1e30);
        assertFalse(sd.coverageFor(sellerA, MAX));
        assertFalse(sd.coverageFor(sellerA, MAX / 2 + 1)); // 2 * value would overflow
        assertFalse(sd.coverageFor(sellerA, MAX / 2)); // 2 * value == MAX - 1 > coverage
        assertFalse(sd.coverageFor(sellerA, 1e30)); // 2e30 > 1e30
        assertTrue(sd.coverageFor(sellerA, 5e29));
    }

    function test_CoverageFor_FalseForOverflowEvenWithHugeCoverage() public {
        _fund(sellerA, MAX / 2); // coverage MAX / 2 (but 2 * (MAX/2) = MAX - 1 > coverage)
        assertFalse(sd.coverageFor(sellerA, MAX / 2 + 1));
        assertFalse(sd.coverageFor(sellerA, MAX / 2));
        assertTrue(sd.coverageFor(sellerA, MAX / 4));
    }

    function test_CoverageFor_FalseAfterPendingWithdrawal() public {
        _fund(sellerA, 200e6);
        assertTrue(sd.coverageFor(sellerA, 100e6));
        vm.prank(sellerA);
        sd.requestWithdraw(1);
        assertFalse(sd.coverageFor(sellerA, 100e6));
        assertTrue(sd.coverageFor(sellerA, 100e6 - 1)); // 2 * (100e6 - 1) = 200e6 - 2 <= 200e6 - 1
        assertEq(sd.coverage(sellerA), 200e6 - 1);
    }

    function test_CoverageFor_FalseAfterReservationAndTrueAfterAnswer() public {
        _fund(sellerA, 400e6);
        assertTrue(sd.coverageFor(sellerA, 200e6));
        _claimOk(_prom(sellerA, buyer, 100e6, N1)); // reserves 200 => coverage 200
        assertTrue(sd.coverageFor(sellerA, 100e6));
        assertFalse(sd.coverageFor(sellerA, 100e6 + 1));
        _claimOk(_prom(sellerA, buyer2, 1e6, N2)); // reserves 2 => coverage 198
        assertFalse(sd.coverageFor(sellerA, 100e6));
        assertTrue(sd.coverageFor(sellerA, 99e6));
        sd.answer(id1, KEY); // releases 200
        assertTrue(sd.coverageFor(sellerA, 199e6));
        assertFalse(sd.coverageFor(sellerA, 199e6 + 1));
    }

    function test_CoverageFor_FalseAfterDepositShrinks() public {
        _fund(sellerA, 200e6);
        _claimOk(_prom(sellerA, buyer, 100e6, N1)); // reserves 200
        skip(WINDOW);
        sd.finalize(id1); // deposit 0
        assertFalse(sd.coverageFor(sellerA, 1));
        assertTrue(sd.coverageFor(sellerA, 0));
    }

    function test_CoverageFor_PredictsTheReservationOfAClaim() public {
        _fund(sellerA, 300e6);
        // buyer checks before paying: 150 is exactly coverable => claim reserves the full 300
        assertTrue(sd.coverageFor(sellerA, 150e6));
        _claimOk(_prom(sellerA, buyer, 150e6, N1));
        (,, uint256 r,,) = _claimData(id1);
        assertEq(r, 300e6);
        // 151 was not coverable (302 > 300) => the reservation would have been capped below 2 * value
        _fund(sellerB, 300e6);
        assertFalse(sd.coverageFor(sellerB, 151e6));
        _claimOk(_prom(sellerB, buyer, 151e6, N1));
        (,, uint256 r2,,) = _claimData(_cid(sellerB, buyer, N1));
        assertLt(r2, 2 * 151e6);
    }

    function testFuzz_CoverageFor_ConsistentWithCoverage(
        uint256 dep,
        uint256 claimVal,
        uint256 pend,
        uint256 query
    ) public {
        dep = bound(dep, 0, 1e15);
        claimVal = bound(claimVal, 0, 1e15);
        if (dep > 0) _fund(sellerA, dep);
        _claimOk(_prom(sellerA, buyer, claimVal, N1));
        uint256 cov = sd.coverage(sellerA);
        if (cov > 0) {
            pend = bound(pend, 0, cov);
            if (pend > 0) {
                vm.prank(sellerA);
                sd.requestWithdraw(pend);
            }
        }
        cov = sd.coverage(sellerA);
        bool expected = query <= MAX / 2 && cov >= 2 * query;
        assertEq(sd.coverageFor(sellerA, query), expected);
        // boundary values around the current coverage
        assertTrue(sd.coverageFor(sellerA, cov / 2));
        assertEq(sd.coverageFor(sellerA, cov / 2 + 1), false);
    }
}
