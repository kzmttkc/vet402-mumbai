// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase, SDHelpers, MockUSDC} from "./SealedDelivery.Base.t.sol";

/// Bounded action surface driven by the invariant fuzzer.
contract SDHandler is SDHelpers {
    address[] internal _sellers;
    address[] internal _buyers;
    bytes32[] internal _nonces;
    uint256 internal _counter;

    constructor(SealedDelivery _sd, MockUSDC _usdc) {
        sd = _sd;
        usdc = _usdc;
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

    function claim(uint256 sSeed, uint256 bSeed, uint256 value, uint256 expiryOff) external {
        address s = _sellers[sSeed % 2];
        address b = _buyers[bSeed % 2];
        bytes32 n = keccak256(abi.encode("nonce", _counter++));
        SealedDelivery.Promise memory p = _prom(s, b, bound(value, 0, 1500e6), n);
        p.expiry = uint64(block.timestamp + bound(expiryOff, 1, 3600));
        _claimOk(p);
        _nonces.push(n);
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
        try sd.finalize(_nonces[idx % _nonces.length]) {} catch {}
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
    function testFuzz_PayoutIsMinOfDepositAndValue(uint256 dep, uint256 val) public {
        dep = bound(dep, 0, 1e15);
        val = bound(val, 0, 1e15);
        if (dep > 0) _fund(sellerA, dep);

        _claimOk(_prom(sellerA, buyer, val, N1));
        uint256 expected = val < dep ? val : dep;
        (,, uint256 r, uint64 dl,) = _claimData(N1);
        assertEq(r, expected);
        assertEq(sd.reserved(sellerA), expected);
        assertEq(sd.coverage(sellerA), dep - expected);

        vm.warp(dl);
        vm.expectEmit(true, true, true, true, address(sd));
        emit SealedDelivery.Silent(N1, sellerA, buyer, expected);
        sd.finalize(N1);
        assertEq(sd.claimable(buyer), expected);
        assertEq(sd.deposits(sellerA), dep - expected);
        assertEq(sd.reserved(sellerA), 0);
        assertEq(sd.coverage(sellerA), dep - expected);
        assertEq(usdc.balanceOf(address(sd)), dep);
    }

    function testFuzz_AnswerRestoresFullCoverage(uint256 dep, uint256 val) public {
        dep = bound(dep, 1, 1e15);
        val = bound(val, 0, 1e15);
        _fund(sellerA, dep);
        _claimOk(_prom(sellerA, buyer, val, N1));
        sd.answer(N1, KEY);
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
        bytes4[] memory sels = new bytes4[](8);
        sels[0] = SDHandler.deposit.selector;
        sels[1] = SDHandler.claim.selector;
        sels[2] = SDHandler.answer.selector;
        sels[3] = SDHandler.finalize.selector;
        sels[4] = SDHandler.requestWithdraw.selector;
        sels[5] = SDHandler.withdrawDeposit.selector;
        sels[6] = SDHandler.withdrawClaimable.selector;
        sels[7] = SDHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// deposits >= reserved + pending for every seller; USDC balance >= deposits + claimables.
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

    /// reserved[seller] equals the sum of reservations of that seller's OPEN claims.
    function invariant_ReservedMatchesOpenClaims() public view {
        uint256 n = handler.nonceCount();
        uint256 r0;
        uint256 r1;
        for (uint256 i; i < n; ++i) {
            (address s,, uint256 r,,, SealedDelivery.Status st) = sd.claims(handler.nonceAt(i));
            if (st != SealedDelivery.Status.OPEN) continue;
            if (s == handler.sellerAt(0)) r0 += r;
            else r1 += r;
        }
        assertEq(sd.reserved(handler.sellerAt(0)), r0);
        assertEq(sd.reserved(handler.sellerAt(1)), r1);
    }
}
