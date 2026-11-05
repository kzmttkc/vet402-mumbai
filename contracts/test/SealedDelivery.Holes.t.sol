// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SealedDelivery} from "../SealedDelivery.sol";
import {MockUSDC, SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// A FiatToken-like USDC whose blacklist has caught the burn address.
contract DeadBlockedUSDC is MockUSDC {
    error Blacklisted();

    function _update(address from, address to, uint256 value) internal override {
        if (to == 0x000000000000000000000000000000000000dEaD) revert Blacklisted();
        super._update(from, to, value);
    }
}

/// Each test reproduces one collateral hole using only the external surface shared by the old and
/// new designs, so the same file fails on the reservation design and passes on the current one.
contract SealedDeliveryHolesTest is SealedDeliveryTestBase {
    uint256 internal constant V = 10e6;

    function setUp() public override {
        super.setUp();
    }

    /// Promise handed out, then the seller queues everything before the buyer can claim.
    function test_Hole1_RequestWithdrawAfterPromise_SilencePaysFromCollateral() public {
        _fund(sellerA, 2 * V);
        SealedDelivery.Promise memory p = _prom(sellerA, buyer, V, N1);

        vm.prank(sellerA);
        sd.requestWithdraw(2 * V);
        _claimOk(p);
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);

        assertEq(sd.claimable(buyer), V, "buyer half");
        assertEq(sd.deposits(sellerA), 0, "seller paid in full");
    }

    /// The seller's own second address claims first and takes all of the coverage.
    function test_Hole2_SecondAddressClaimsFirst_RealBuyerStillPaid() public {
        address sock = _newActor("sock");
        _fund(sellerA, 2 * V);
        _claimOk(_prom(sellerA, sock, V, N2));
        _claimOk(_prom(sellerA, buyer, V, N1));

        // The seller frees its own claim for free; the real buyer is left to silence.
        sd.answer(_cid(sellerA, sock, N2), KEY);
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);

        assertEq(sd.claimable(buyer), V, "real buyer half");
        assertEq(sd.deposits(sellerA), 0, "seller paid in full");
    }

    /// The burn address is blacklisted: the buyer's credit must not depend on the burn.
    function test_Hole3_BurnTransferBlocked_FinalizeStillCredits() public {
        vm.etch(USDC_ADDR, address(new DeadBlockedUSDC()).code);
        _fund(sellerA, 2 * V);
        _claimOk(_prom(sellerA, buyer, V, N1));
        vm.warp(T0 + WINDOW);
        sd.finalize(id1);
        assertEq(sd.claimable(buyer), V, "buyer half");
    }

    function test_Hole3_BurnTransferBlocked_ProveStillCredits() public {
        vm.etch(USDC_ADDR, address(new DeadBlockedUSDC()).code);
        _fund(sellerA, 2 * V);
        (bytes32 id, bytes memory ct) = _sealedClaim(sellerA, buyer, V, N1, KEY, "plain", false);
        sd.prove(id, ct, KEY);
        assertEq(sd.claimable(buyer), V, "buyer half");
    }
}
