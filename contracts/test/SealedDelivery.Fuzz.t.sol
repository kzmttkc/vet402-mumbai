// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console2} from "forge-std/Test.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase, SDHelpers, MockUSDC} from "./SealedDelivery.Base.t.sol";

/// Bounded action surface driven by the invariant fuzzer. Tracks the burn independently of the contract.
contract SDHandler is SDHelpers {
    bytes internal constant PT = "the plaintext the seller promised the buyer";

    address[] internal _sellers;
    address[] internal _buyers;
    bytes32[] internal _nonces; // claimIds of every claim created through the handler
    bytes internal _ct; // KEY-encrypted PT

    uint256 public totalBurned;
    uint256 public finalizeCount;
    uint256 public proveCount;
    /// Deviations of prove()'s effects from the handler's independent model (must stay 0).
    uint256 public modelViolations;
    /// prove() calls that reverted although the claim was OPEN/DELIVERED, dishonest, with the right key.
    uint256 public unexpectedProveReverts;
    /// Successful DELIVERED proofs that were paid partly from queued (pending) funds.
    uint256 public deliveredOverlapProofs;

    constructor(SealedDelivery _sd, MockUSDC _usdc) {
        sd = _sd;
        usdc = _usdc;
        _ct = _xorStream(PT, KEY);
        for (uint256 i; i < 2; ++i) {
            address s = _newActor(string.concat("hs", vm.toString(i)));
            address b = _newActor(string.concat("hb", vm.toString(i)));
            _sellers.push(s);
            _buyers.push(b);
            vm.prank(s);
            usdc.approve(address(sd), type(uint256).max);
        }
    }

    function sellerAt(uint256 i) external view returns (address) {
        return _sellers[i];
    }

    function buyerAt(uint256 i) external view returns (address) {
        return _buyers[i];
    }

    function nonceCount() external view returns (uint256) {
        return _nonces.length;
    }

    function nonceAt(uint256 i) external view returns (bytes32) {
        return _nonces[i];
    }

    function deposit(uint256 sSeed, uint256 amt) external {
        address s = _sellers[sSeed % 2];
        amt = bound(amt, 1, 1000e6);
        usdc.mint(s, amt);
        vm.prank(s);
        sd.deposit(amt);
    }

    /// Small nonce pool so the same nonce is reused across sellers/buyers (distinct claims) while
    /// an identical (seller, buyer, nonce) triple is skipped (it would revert AlreadyClaimed).
    /// `honest` decides whether the promise's plaintextHash matches what KEY decrypts _ct to.
    function claim(uint256 sSeed, uint256 bSeed, uint256 nSeed, uint256 value, uint256 expiryOff, bool honest)
        external
    {
        address s = _sellers[sSeed % 2];
        address b = _buyers[bSeed % 2];
        bytes32 n = keccak256(abi.encode("nonce", nSeed % 3));
        bytes32 id = _cid(s, b, n);
        (,,,,, SealedDelivery.Status st,,,) = sd.claims(id);
        if (st != SealedDelivery.Status.NONE) return;
        SealedDelivery.Promise memory p = _prom(s, b, bound(value, 0, 1500e6), n);
        p.expiry = uint64(block.timestamp + bound(expiryOff, 1, 3600));
        p.ciphertextHash = keccak256(_ct);
        p.plaintextHash = honest ? keccak256(PT) : keccak256("a different plaintext");
        _claimOk(p);
        _nonces.push(id);
    }

    function answer(uint256 idx, bool good) external {
        if (_nonces.length == 0) return;
        bytes32 n = _nonces[idx % _nonces.length];
        bytes memory k = KEY;
        if (!good) k = "bad";
        try sd.answer(n, k) {} catch {}
    }

    function finalize(uint256 idx) external {
        if (_nonces.length == 0) return;
        bytes32 id = _nonces[idx % _nonces.length];
        (,, uint256 r,,,,,,) = sd.claims(id);
        try sd.finalize(id) {
            totalBurned += r - (r / 2 + (r % 2));
            finalizeCount++;
        } catch {}
    }

    /// Fraud proof: succeeds only for dishonest promises with the right key; OPEN claims pay their whole
    /// reservation, DELIVERED claims pay min(reservation, deposits - reserved) - queued funds included.
    function prove(uint256 idx, bool good) external {
        _prove(idx, good);
    }

    /// The attack shape: the seller first queues all of its free collateral, then anyone proves fraud.
    function requestThenProve(uint256 idx, bool good) external {
        _requestThenProve(idx, good);
    }

    /// Whole attack in one step: dishonest claim, answered with the right key, all free collateral queued
    /// for withdrawal, then the fraud proof. Makes proofs that consume queued funds frequent.
    function attack(uint256 sSeed, uint256 bSeed, uint256 nSeed, uint256 value, uint256 extraDeposit) external {
        address s = _sellers[sSeed % 2];
        address b = _buyers[bSeed % 2];
        bytes32 n = keccak256(abi.encode("nonce", nSeed % 3));
        bytes32 id = _cid(s, b, n);
        (,,,,, SealedDelivery.Status st,,,) = sd.claims(id);
        if (st != SealedDelivery.Status.NONE) return;
        extraDeposit = bound(extraDeposit, 0, 600e6);
        if (extraDeposit > 0) {
            usdc.mint(s, extraDeposit);
            vm.prank(s);
            sd.deposit(extraDeposit);
        }
        SealedDelivery.Promise memory p = _prom(s, b, bound(value, 1, 400e6), n);
        p.ciphertextHash = keccak256(_ct);
        p.plaintextHash = keccak256("a different plaintext");
        _claimOk(p);
        _nonces.push(id);
        sd.answer(id, KEY);
        _requestThenProve(_nonces.length - 1, true);
    }

    function _requestThenProve(uint256 idx, bool good) internal {
        if (_nonces.length == 0) return;
        (address s,,,,,,,,) = sd.claims(_nonces[idx % _nonces.length]);
        uint256 cov = sd.coverage(s);
        if (cov > 0) {
            vm.prank(s);
            sd.requestWithdraw(cov);
        }
        _prove(idx, good);
    }

    function _prove(uint256 idx, bool good) internal {
        if (_nonces.length == 0) return;
        bytes32 id = _nonces[idx % _nonces.length];
        (address s,, uint256 r,,, SealedDelivery.Status st,,,) = sd.claims(id);
        // Independent model of the expected effects, read before the call.
        uint256 dep = sd.deposits(s);
        uint256 res = sd.reserved(s);
        uint256 cov = sd.coverage(s);
        uint256 pend = sd.pendingWithdrawal(s);
        uint256 readyAt = sd.withdrawReadyAt(s);
        uint256 amount = r;
        uint256 overlap;
        if (st == SealedDelivery.Status.DELIVERED) {
            uint256 backing = dep - res;
            amount = r < backing ? r : backing;
            overlap = amount > cov ? amount - cov : 0;
        }
        bytes memory k = KEY;
        if (!good) k = "bad";
        try sd.prove(id, _ct, k) {
            totalBurned += amount - (amount / 2 + (amount % 2));
            proveCount++;
            uint256 expRes = st == SealedDelivery.Status.OPEN ? res - r : res;
            if (sd.deposits(s) != dep - amount) modelViolations++;
            if (sd.reserved(s) != expRes) modelViolations++; // other claims' reservations untouched
            if (sd.pendingWithdrawal(s) != pend - overlap) modelViolations++;
            uint256 expReady = overlap == 0 ? readyAt : (pend - overlap == 0 ? 0 : readyAt);
            if (sd.withdrawReadyAt(s) != expReady) modelViolations++;
            if (overlap > 0) deliveredOverlapProofs++;
        } catch {
            if (_shouldSucceed(id, good)) unexpectedProveReverts++;
        }
    }

    function _shouldSucceed(bytes32 id, bool good) internal view returns (bool) {
        (,,,,, SealedDelivery.Status st,, bytes32 ph,) = sd.claims(id);
        bool provable = st == SealedDelivery.Status.OPEN || st == SealedDelivery.Status.DELIVERED;
        return good && provable && ph != keccak256(PT);
    }

    function requestWithdraw(uint256 sSeed, uint256 amt) external {
        address s = _sellers[sSeed % 2];
        uint256 cov = sd.coverage(s);
        if (cov == 0) return;
        vm.prank(s);
        sd.requestWithdraw(bound(amt, 1, cov));
    }

    function withdrawDeposit(uint256 sSeed) external {
        address s = _sellers[sSeed % 2];
        vm.prank(s);
        try sd.withdrawDeposit() {} catch {}
    }

    function withdrawClaimable(uint256 bSeed) external {
        address b = _buyers[bSeed % 2];
        vm.prank(b);
        try sd.withdrawClaimable() {} catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2000));
    }
}

contract SealedDeliveryFuzzTest is SealedDeliveryTestBase {
    function testFuzz_PayoutIsMinOfDepositAndTwiceValue(uint256 dep, uint256 val) public {
        dep = bound(dep, 0, 1e15);
        val = bound(val, 0, 1e15);
        if (dep > 0) _fund(sellerA, dep);

        _claimOk(_prom(sellerA, buyer, val, N1));
        uint256 expected = 2 * val < dep ? 2 * val : dep;
        (,, uint256 r, uint64 dl,) = _claimData(id1);
        assertEq(r, expected);
        assertEq(sd.reserved(sellerA), expected);
        assertEq(sd.coverage(sellerA), dep - expected);

        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(id1, N1, sellerA, buyer, _paid(expected));
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), _paid(expected));
        assertEq(_deadBal(), _burnt(expected));
        assertEq(_paid(expected) + _burnt(expected), expected);
        assertEq(sd.deposits(sellerA), dep - expected);
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.coverage(sellerA), dep - expected);
        assertEq(usdc.balanceOf(address(sd)), dep - _burnt(expected));
    }

    /// Any uint256 value (incl. those whose double overflows) reserves min(2*value, coverage) without reverting.
    function testFuzz_ClaimReservationNeverOverflows(uint256 dep, uint256 val) public {
        dep = bound(dep, 0, 1e30);
        if (dep > 0) _fund(sellerA, dep);
        _claimOk(_prom(sellerA, buyer, val, N1));
        (,, uint256 r,,) = _claimData(id1);
        uint256 wanted = val > type(uint256).max / 2 ? type(uint256).max : 2 * val;
        assertEq(r, wanted < dep ? wanted : dep);
    }

    function testFuzz_AnswerRestoresFullCoverage(uint256 dep, uint256 val) public {
        dep = bound(dep, 1, 1e15);
        val = bound(val, 0, 1e15);
        _fund(sellerA, dep);
        _claimOk(_prom(sellerA, buyer, val, N1));
        sd.answer(id1, KEY);
        assertEq(sd.coverage(sellerA), dep);
        assertEq(sd.reserved(sellerA), 0);
    }

    function testFuzz_RequestWithdrawRespectsCoverage(uint256 dep, uint256 val, uint256 req) public {
        dep = bound(dep, 1, 1e15);
        val = bound(val, 0, 1e15);
        req = bound(req, 1, 2e15);
        _fund(sellerA, dep);
        _claimOk(_prom(sellerA, buyer, val, N1));
        uint256 cov = sd.coverage(sellerA);
        vm.prank(sellerA);
        if (req > cov) {
            vm.expectRevert(SealedDelivery.ExceedsCoverage.selector);
            sd.requestWithdraw(req);
        } else {
            sd.requestWithdraw(req);
            assertEq(sd.coverage(sellerA), cov - req);
            assertEq(sd.pendingWithdrawal(sellerA), req);
        }
    }
}

contract SealedDeliveryInvariantTest is SealedDeliveryTestBase {
    SDHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new SDHandler(sd, usdc);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](11);
        sels[0] = SDHandler.deposit.selector;
        sels[1] = SDHandler.claim.selector;
        sels[2] = SDHandler.answer.selector;
        sels[3] = SDHandler.finalize.selector;
        sels[4] = SDHandler.requestWithdraw.selector;
        sels[5] = SDHandler.withdrawDeposit.selector;
        sels[6] = SDHandler.withdrawClaimable.selector;
        sels[7] = SDHandler.warp.selector;
        sels[8] = SDHandler.prove.selector;
        sels[9] = SDHandler.requestThenProve.selector;
        sels[10] = SDHandler.attack.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// deposits >= reserved + pending for every seller (also after proofs that eat queued funds);
    /// USDC balance >= deposits + claimables.
    function invariant_SolvencyAndCollateral() public view {
        uint256 sumDeposits;
        uint256 sumClaimable;
        for (uint256 i; i < 2; ++i) {
            address s = handler.sellerAt(i);
            assertGe(sd.deposits(s), sd.reserved(s) + sd.pendingWithdrawal(s));
            sumDeposits += sd.deposits(s);
            sumClaimable += sd.claimable(s);
            sumClaimable += sd.claimable(handler.buyerAt(i));
        }
        assertGe(usdc.balanceOf(address(sd)), sumDeposits + sumClaimable);
    }

    /// Conservation: every unit is either a deposit, a buyer credit, or burned - nothing else leaks.
    function invariant_BalanceEqualsDepositsPlusClaimable() public view {
        uint256 sum;
        for (uint256 i; i < 2; ++i) {
            sum += sd.deposits(handler.sellerAt(i)) + sd.claimable(handler.sellerAt(i));
            sum += sd.claimable(handler.buyerAt(i));
        }
        assertEq(usdc.balanceOf(address(sd)), sum);
    }

    /// The DEAD address holds exactly the burned halves the handler computed independently.
    function invariant_DeadBalanceEqualsTotalBurned() public view {
        assertEq(usdc.balanceOf(DEAD_ADDR), handler.totalBurned());
    }

    /// Coverage telemetry (visible with -vv): proofs paid partly from queued funds must actually occur.
    function afterInvariant() public view {
        console2.log("proofs", handler.proveCount());
        console2.log("delivered proofs eating queued funds", handler.deliveredOverlapProofs());
    }

    /// prove() matches the handler's independent model on every success (payout, reservations of other
    /// claims, pending reduction by the overlap, readyAt cleared at 0) and never reverts for a valid proof.
    function invariant_ProveMatchesModel() public view {
        assertEq(handler.modelViolations(), 0);
        assertEq(handler.unexpectedProveReverts(), 0);
    }

    /// Every successful finalize / prove bumps exactly one counter.
    function invariant_CountersMatchSuccessfulCalls() public view {
        uint256 silent;
        uint256 fraud;
        for (uint256 i; i < 2; ++i) {
            silent += sd.silentCount(handler.sellerAt(i));
            fraud += sd.fraudCount(handler.sellerAt(i));
        }
        assertEq(silent, handler.finalizeCount());
        assertEq(fraud, handler.proveCount());
    }

    /// reserved[seller] equals the sum of reservations of that seller's OPEN claims
    /// (SILENT, DELIVERED and FRAUD claims hold no reservation).
    function invariant_ReservedMatchesOpenClaims() public view {
        uint256 n = handler.nonceCount();
        uint256 r0;
        uint256 r1;
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.nonceAt(i);
            (address s, address b, uint256 r,,, SealedDelivery.Status st, bytes32 pn,,) = sd.claims(id);
            assertEq(id, _cid(s, b, pn)); // stored claim is consistent with its key
            if (st != SealedDelivery.Status.OPEN) continue;
            if (s == handler.sellerAt(0)) r0 += r;
            else r1 += r;
        }
        assertEq(sd.reserved(handler.sellerAt(0)), r0);
        assertEq(sd.reserved(handler.sellerAt(1)), r1);
    }
}
