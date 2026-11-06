// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// EIP-3009 settles only while validAfter < now < validBefore. A claim must come after validAfter, because no
/// payment can have settled before it, and the window must hold at least one whole second. A passed validBefore
/// is accepted: the payment settled before it, and the claim normally comes after the settlement.
contract SealedDeliveryPaymentTimesTest is SealedDeliveryTestBase {
    function setUp() public override {
        super.setUp();
        _fund(sellerA, 1_000_000);
    }

    function _claimWith(uint256 validAfter, uint256 validBefore, bytes4 err) internal {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, 1_000, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        a.validAfter = validAfter;
        a.validBefore = validBefore;
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, err);
    }

    function test_PaymentTimes_ClaimAtValidAfterIsRefused() public {
        _claimWith(block.timestamp, type(uint256).max, SealedDelivery.PaymentNotYetValid.selector);
    }

    function test_PaymentTimes_ClaimBeforeValidAfterIsRefused() public {
        _claimWith(block.timestamp + 600, type(uint256).max, SealedDelivery.PaymentNotYetValid.selector);
    }

    function test_PaymentTimes_ClaimOneSecondAfterValidAfterIsTaken() public {
        _claimWith(block.timestamp - 1, type(uint256).max, bytes4(0));
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_PaymentTimes_GatewayShapedWindowIsTaken() public {
        // BatchEvmScheme signs validAfter about 600 s back and validBefore about a week ahead.
        _claimWith(block.timestamp - 600, block.timestamp + 604_800, bytes4(0));
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_PaymentTimes_PassedValidBeforeIsStillTaken() public {
        // Settled inside its window, claimed after the window closed.
        _claimWith(block.timestamp - 700, block.timestamp - 100, bytes4(0));
        assertEq(uint8(_status(id1)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_PaymentTimes_WindowWithNoWholeSecondIsRefused() public {
        uint256 va = block.timestamp - 10;
        _claimWith(va, va + 1, SealedDelivery.PaymentNeverValid.selector);
        _claimWith(va, va, SealedDelivery.PaymentNeverValid.selector);
        _claimWith(va, va - 1, SealedDelivery.PaymentNeverValid.selector);
        _claimWith(va, va + 2, bytes4(0));
    }

    function test_PaymentTimes_ZeroWindowIsRefused() public {
        _claimWith(0, 0, SealedDelivery.PaymentNeverValid.selector);
        _claimWith(0, 1, SealedDelivery.PaymentNeverValid.selector);
    }

    function testFuzz_PaymentTimes_FollowEip3009(uint256 validAfter, uint256 validBefore) public {
        validAfter = bound(validAfter, 0, block.timestamp + 10_000);
        bytes4 err;
        if (block.timestamp <= validAfter) err = SealedDelivery.PaymentNotYetValid.selector;
        else if (validBefore <= validAfter + 1) err = SealedDelivery.PaymentNeverValid.selector;
        _claimWith(validAfter, validBefore, err);
        assertEq(uint8(_status(id1)), uint8(err == bytes4(0) ? SealedDelivery.Status.OPEN : SealedDelivery.Status.NONE));
    }
}
