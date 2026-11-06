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
    uint256 public totalFlushed;
    /// Successful withdrawals that left less than the open liability behind (must stay 0).
    uint256 public withdrawViolations;
    uint256 public finalizeCount;
    uint256 public proveCount;
    /// Deviations of prove()'s effects from the handler's independent model (must stay 0).
    uint256 public modelViolations;
    /// prove() calls that reverted although the claim was OPEN/DELIVERED, dishonest, with the right key.
    uint256 public unexpectedProveReverts;
    /// Successful proofs that took queued funds, pushing the deposit below pending.
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
        // One claim in seven carries a value whose double overflows: it must not stop any later claim.
        uint256 v = value % 7 == 0 ? type(uint256).max : bound(value, 0, 1500e6);
        SealedDelivery.Promise memory p = _prom(s, b, v, n);
        p.expiry = uint64(block.timestamp + bound(expiryOff, 1, 3600));
        p.ciphertextHash = keccak256(_ct);
        p.plaintextHash = honest ? keccak256(PT) : keccak256("a different plaintext");
        // Any gas price up to twice the cap. It changes nothing on a deployment that repays no gas.
        vm.txGasPrice(uint256(keccak256(abi.encode(value, nSeed))) % 2000 gwei);
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
        (address s,, uint256 r,,,,,,) = sd.claims(id);
        uint256 dep = sd.deposits(s);
        uint256 amount = r < dep ? r : dep;
        try sd.finalize(id) {
            totalBurned += amount - (amount / 2 + (amount % 2));
            finalizeCount++;
        } catch {}
    }

    /// Fraud proof: succeeds only for dishonest promises with the right key; OPEN and DELIVERED claims
    /// both pay min(liability, deposits), queued funds included.
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
        uint256 res = sd.openLiability(s);
        uint256 pend = sd.pendingWithdrawal(s);
        uint256 readyAt = sd.withdrawReadyAt(s);
        uint256 amount = r < dep ? r : dep;
        uint256 depAfter = dep - amount;
        bytes memory k = KEY;
        if (!good) k = "bad";
        try sd.prove(id, _ct, k) {
            totalBurned += amount - (amount / 2 + (amount % 2));
            proveCount++;
            uint256 expRes = st == SealedDelivery.Status.OPEN ? res - r : res;
            uint256 expPend = pend < depAfter ? pend : depAfter;
            if (sd.deposits(s) != depAfter) modelViolations++;
            if (sd.openLiability(s) != expRes) modelViolations++; // other claims' liabilities untouched
            if (sd.pendingWithdrawal(s) != expPend) modelViolations++;
            uint256 expReady = pend > 0 && expPend == 0 ? 0 : readyAt;
            if (sd.withdrawReadyAt(s) != expReady) modelViolations++;
            if (pend > depAfter) deliveredOverlapProofs++;
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
        try sd.withdrawDeposit() {
            if (sd.deposits(s) < sd.openLiability(s)) withdrawViolations++;
        } catch {}
    }

    function flushBurn() external {
        uint256 amt = sd.pendingBurn();
        try sd.flushBurn() {
            totalFlushed += amt;
        } catch {}
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
        assertEq(r, 2 * val);
        assertEq(sd.openLiability(sellerA), 2 * val);
        assertEq(sd.coverage(sellerA), dep, "a claim moves no funds");

        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(id1, N1, sellerA, buyer, _paid(expected));
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), _paid(expected));
        assertEq(sd.pendingBurn(), _burnt(expected));
        assertEq(_paid(expected) + _burnt(expected), expected);
        assertEq(sd.deposits(sellerA), dep - expected);
        assertEq(sd.openLiability(sellerA), 0);
        assertEq(sd.coverage(sellerA), dep - expected);
        assertEq(usdc.balanceOf(address(sd)), dep, "a verdict moves no USDC");
    }

    /// Any uint256 value (incl. those whose double overflows) records a capped liability without reverting.
    function testFuzz_ClaimLiabilityNeverOverflows(uint256 dep, uint256 val) public {
        dep = bound(dep, 0, 1e30);
        if (dep > 0) _fund(sellerA, dep);
        _claimOk(_prom(sellerA, buyer, val, N1));
        (,, uint256 r,,) = _claimData(id1);
        uint256 cap = type(uint128).max;
        assertEq(r, val > cap / 2 ? cap : 2 * val);
        assertEq(sd.openLiability(sellerA), r);
        skip(WINDOW);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), _paid(r < dep ? r : dep));
    }

    function testFuzz_AnswerRestoresFullCoverage(uint256 dep, uint256 val) public {
        dep = bound(dep, 1, 1e15);
        val = bound(val, 0, 1e15);
        _fund(sellerA, dep);
        _claimOk(_prom(sellerA, buyer, val, N1));
        sd.answer(id1, KEY);
        assertEq(sd.coverage(sellerA), dep);
        assertEq(sd.openLiability(sellerA), 0);
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

    function setUp() public virtual override {
        super.setUp();
        handler = new SDHandler(sd, usdc);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](12);
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
        sels[11] = SDHandler.flushBurn.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// pending <= deposits for every seller (also after verdicts that eat queued funds), so coverage cannot
    /// underflow; a successful withdrawal never leaves the deposit below the open liability.
    function invariant_PendingNeverExceedsDeposit() public view {
        for (uint256 i; i < 2; ++i) {
            address s = handler.sellerAt(i);
            assertLe(sd.pendingWithdrawal(s), sd.deposits(s));
            assertEq(sd.coverage(s), sd.deposits(s) - sd.pendingWithdrawal(s));
        }
        assertEq(handler.withdrawViolations(), 0);
    }

    /// Conservation: every unit is a deposit, a buyer credit, or waiting to burn - nothing else leaks.
    function invariant_BalanceEqualsDepositsPlusClaimablePlusPendingBurn() public view {
        uint256 sum = sd.pendingBurn();
        for (uint256 i; i < 2; ++i) {
            sum += sd.deposits(handler.sellerAt(i)) + sd.claimable(handler.sellerAt(i));
            sum += sd.claimable(handler.buyerAt(i));
        }
        assertEq(usdc.balanceOf(address(sd)), sum);
    }

    /// Burned halves computed independently by the handler are either queued or already at DEAD.
    function invariant_BurnedEqualsQueuedPlusFlushed() public view {
        assertEq(usdc.balanceOf(DEAD_ADDR), handler.totalFlushed());
        assertEq(sd.pendingBurn() + handler.totalFlushed(), handler.totalBurned());
    }

    /// Coverage telemetry (visible with -vv): proofs paid partly from queued funds must actually occur.
    function afterInvariant() public view {
        console2.log("proofs", handler.proveCount());
        console2.log("proofs eating queued funds", handler.deliveredOverlapProofs());
    }

    /// prove() matches the handler's independent model on every success (payout, liabilities of other
    /// claims, pending capped by the deposit, readyAt cleared at 0) and never reverts for a valid proof.
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

    /// openLiability[seller] equals the sum of liabilities of that seller's OPEN claims
    /// (SILENT, DELIVERED and FRAUD claims hold none).
    function invariant_OpenLiabilityMatchesOpenClaims() public view {
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
        assertEq(sd.openLiability(handler.sellerAt(0)), r0);
        assertEq(sd.openLiability(handler.sellerAt(1)), r1);
    }
}

/// The same invariants on a deployment that repays gas: answers move USDC out to the buyer, claims at any gas price.
contract SealedDeliveryInvariantGasRepaidTest is SealedDeliveryInvariantTest {
    function setUp() public override {
        followUpGas = 230_000;
        maxGasPrice = 1000 gwei;
        super.setUp();
    }
}
