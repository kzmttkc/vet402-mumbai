// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// Constructor + claim() tests.
contract SealedDeliveryTest is SealedDeliveryTestBase {
    uint256 internal constant DEP = 500e6;
    uint256 internal constant VAL = 100e6;

    function setUp() public override {
        super.setUp();
        _fund(sellerA, DEP);
    }

    // ---------------------------------------------------------------- constructor

    function test_Constructor_RevertsZeroMaxExpiry() public {
        vm.expectRevert(SealedDelivery.InvalidMaxExpiry.selector);
        new SealedDelivery(0, 60, 120);
    }

    function test_Constructor_RevertsZeroAnswerWindow() public {
        vm.expectRevert(SealedDelivery.InvalidAnswerWindow.selector);
        new SealedDelivery(60, 0, 120);
    }

    function test_Constructor_RevertsCooldownBelowSum() public {
        vm.expectRevert(SealedDelivery.InvalidCooldown.selector);
        new SealedDelivery(60, 60, 119);
    }

    function test_Constructor_RevertsCooldownBelowMaxExpiry() public {
        vm.expectRevert(SealedDelivery.InvalidCooldown.selector);
        new SealedDelivery(100, 1, 99);
    }

    function test_Constructor_RevertsOverflowSizedArgs() public {
        vm.expectRevert(SealedDelivery.InvalidCooldown.selector);
        new SealedDelivery(type(uint256).max, 1, type(uint256).max);
        vm.expectRevert(SealedDelivery.InvalidCooldown.selector);
        new SealedDelivery(1, type(uint256).max, type(uint256).max);
        vm.expectRevert(SealedDelivery.InvalidCooldown.selector);
        new SealedDelivery(type(uint256).max, type(uint256).max, type(uint256).max);
    }

    function test_Constructor_AcceptsEquality() public {
        SealedDelivery s = new SealedDelivery(60, 60, 120);
        assertEq(s.MAX_EXPIRY(), 60);
        assertEq(s.ANSWER_WINDOW(), 60);
        assertEq(s.COOLDOWN(), 120);
    }

    function test_Constructor_StoresParams() public view {
        assertEq(sd.MAX_EXPIRY(), MAX_EXPIRY);
        assertEq(sd.ANSWER_WINDOW(), WINDOW);
        assertEq(sd.COOLDOWN(), COOLDOWN);
        assertEq(address(sd.USDC()), USDC_ADDR);
    }

    /// Full lifecycle on a 60/60/120 deployment.
    function test_ShortConfig_ClaimFinalizeWithdraw() public {
        sd = new SealedDelivery(60, 60, 120);
        _fund(sellerA, 100e6);
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, 40e6, N1);
        p.expiry = uint64(block.timestamp + 60); // exactly MAX_EXPIRY: accepted
        _claimOk(p);
        (,,, uint64 dl,) = _claimData(N1);
        assertEq(dl, block.timestamp + 60);
        skip(60);
        sd.finalize(N1);
        assertEq(sd.claimable(buyer), 40e6);

        vm.startPrank(sellerA);
        sd.requestWithdraw(60e6);
        skip(119);
        vm.expectRevert(SealedDelivery.CooldownActive.selector);
        sd.withdrawDeposit();
        skip(1);
        sd.withdrawDeposit();
        vm.stopPrank();
        assertEq(usdc.balanceOf(sellerA), 60e6);

        // expiry one second beyond the shorter MAX_EXPIRY is rejected
        SealedDelivery.Promise memory q = _prom(sellerA, buyer, 1e6, N2);
        q.expiry = uint64(block.timestamp + 61);
        SealedDelivery.PaymentAuth memory a = _authFor(q);
        _claimRaw(q, _sellerSig(q), a, _buyerSig(a), buyer, SealedDelivery.ExpiryTooFar.selector);
    }

    // ---------------------------------------------------------------- claim happy path

    function test_Claim_StoresClaimAndReserves() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        _claimOk(p);
        (address s, address b, uint256 r, uint64 dl, bytes32 kh) = _claimData(N1);
        assertEq(s, sellerA);
        assertEq(b, buyer);
        assertEq(r, VAL);
        assertEq(dl, uint64(block.timestamp + WINDOW));
        assertEq(kh, keccak256(KEY));
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.OPEN));
        assertEq(sd.reserved(sellerA), VAL);
        assertEq(sd.coverage(sellerA), DEP - VAL);
        assertEq(sd.deposits(sellerA), DEP);
    }

    function test_Claim_EmitsClaimed() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory ss = _sellerSig(p);
        bytes memory bs = _buyerSig(a);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Claimed(N1, sellerA, buyer, VAL, uint64(block.timestamp + WINDOW));
        vm.prank(buyer);
        sd.claim(p, ss, a, bs);
    }

    function test_Claim_ReservesMinOfValueAndCoverage() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, DEP + 1, N1);
        _claimOk(p);
        (,, uint256 r,,) = _claimData(N1);
        assertEq(r, DEP);
        assertEq(sd.coverage(sellerA), 0);
    }

    // ---------------------------------------------------------------- claim reverts

    function test_Claim_RevertsInvalidSellerSignature_Garbage() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        _claimRaw(p, hex"deadbeef", a, _buyerSig(a), buyer, SealedDelivery.InvalidSellerSignature.selector);
        _claimRaw(p, new bytes(65), a, _buyerSig(a), buyer, SealedDelivery.InvalidSellerSignature.selector);
        _claimRaw(p, "", a, _buyerSig(a), buyer, SealedDelivery.InvalidSellerSignature.selector);
    }

    /// seller B signs a promise that names seller A.
    function test_Claim_RevertsInvalidSellerSignature_SignedByOtherSeller() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory forged = _sign(pkOf[sellerB], _promiseDigest(p));
        _claimRaw(p, forged, a, _buyerSig(a), buyer, SealedDelivery.InvalidSellerSignature.selector);
    }

    function test_Claim_RevertsInvalidSellerSignature_PromiseTampered() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory ss = _sellerSig(p);
        p.keyHash = keccak256("other key");
        _claimRaw(p, ss, a, _buyerSig(a), buyer, SealedDelivery.InvalidSellerSignature.selector);
    }

    function test_Claim_RevertsInvalidBuyerSignature_OtherSigner() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory wrong = _sign(pkOf[buyer2], _authDigest(a));
        _claimRaw(p, _sellerSig(p), a, wrong, buyer, SealedDelivery.InvalidBuyerSignature.selector);
    }

    function test_Claim_RevertsInvalidBuyerSignature_Garbage() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        _claimRaw(p, _sellerSig(p), a, hex"01", buyer, SealedDelivery.InvalidBuyerSignature.selector);
    }

    function test_Claim_RevertsNotBuyer() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer2, SealedDelivery.NotBuyer.selector);
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), carol, SealedDelivery.NotBuyer.selector);
    }

    function test_Claim_RevertsWrongBuyer() public {
        // promise names buyer2, but buyer signs and submits the payment auth
        SealedDelivery.Promise memory p = _prom(sellerA, buyer2, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        a.from = buyer;
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.WrongBuyer.selector);
    }

    function test_Claim_RevertsWrongPayee() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        a.to = sellerB;
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.WrongPayee.selector);
    }

    function test_Claim_RevertsWrongValue() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        a.value = VAL + 1;
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.WrongValue.selector);
    }

    function test_Claim_RevertsWrongNonce() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        a.nonce = N2;
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.WrongNonce.selector);
    }

    function test_Claim_RevertsPromiseExpired_AfterExpiry() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory ss = _sellerSig(p);
        bytes memory bs = _buyerSig(a);
        vm.warp(uint256(p.expiry) + 1);
        _claimRaw(p, ss, a, bs, buyer, SealedDelivery.PromiseExpired.selector);
    }

    function test_Claim_RevertsPromiseExpired_ExactlyAtExpiry() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes memory ss = _sellerSig(p);
        bytes memory bs = _buyerSig(a);
        vm.warp(p.expiry);
        _claimRaw(p, ss, a, bs, buyer, SealedDelivery.PromiseExpired.selector);
    }

    function test_Claim_OneSecondBeforeExpiryAccepted() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        vm.warp(p.expiry - 1);
        _claimOk(p);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_Claim_RevertsExpiryTooFar() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        p.expiry = uint64(block.timestamp + MAX_EXPIRY + 1);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.ExpiryTooFar.selector);
    }

    function test_Claim_AcceptsExpiryExactlyMax() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        p.expiry = uint64(block.timestamp + MAX_EXPIRY);
        _claimOk(p);
        assertEq(uint8(_status(N1)), uint8(SealedDelivery.Status.OPEN));
    }

    function test_Claim_RevertsAlreadyClaimed_Replay() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        _claimOk(p);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.AlreadyClaimed.selector);
    }

    function test_Claim_RevertsAlreadyClaimed_DifferentBuyer() public {
        _claimOk(_prom(sellerA, buyer, VAL, N1));
        SealedDelivery.Promise memory p2 = _prom(sellerA, buyer2, VAL, N1);
        SealedDelivery.PaymentAuth memory a2 = _authFor(p2);
        _claimRaw(p2, _sellerSig(p2), a2, _buyerSig(a2), buyer2, SealedDelivery.AlreadyClaimed.selector);
    }

    function test_Claim_AlreadyClaimedAfterTerminalStates() public {
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, VAL, N1);
        _claimOk(p);
        sd.answer(N1, KEY);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        _claimRaw(p, _sellerSig(p), a, _buyerSig(a), buyer, SealedDelivery.AlreadyClaimed.selector);
    }

    // ---------------------------------------------------------------- no native-token entry / no owner

    function test_RejectsEth() public {
        vm.deal(address(this), 2 ether);
        (bool ok,) = address(sd).call{value: 1 ether}("");
        assertFalse(ok);
        (ok,) = address(sd).call{value: 1 ether}(abi.encodeWithSignature("deposit(uint256)", 1));
        assertFalse(ok);
        (ok,) = address(sd).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        assertEq(address(sd).balance, 0);
    }

    function test_HasNoOwner() public view {
        (bool ok,) = address(sd).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
    }
}
