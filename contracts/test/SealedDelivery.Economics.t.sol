// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console} from "forge-std/console.sol";
import {Vm} from "forge-std/Vm.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {MockUSDC, SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// A USDC whose blacklist can catch any address, as FiatToken's can.
contract BlockingUSDC is MockUSDC {
    mapping(address => bool) public blocked;

    function block_(address who, bool on) external {
        blocked[who] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to] && !blocked[from], "blocked");
        super._update(from, to, value);
    }
}

/// The buyer never loses on a dispute, gas included, and never gains when the seller answers.
///
/// Every call the buyer sends is priced as a whole transaction: 21,000, its calldata (16 gas a nonzero byte,
/// 4 a zero byte, or the EIP-7623 floor if higher), the callee's execution with all storage cold, less the
/// refund the EVM gives back (at most a fifth). The buyer starts with no USDC, so its withdrawal pays the most.
/// scripts/sealed-local-e2e.ts checks the same thing against real receipts on anvil.
contract SealedDeliveryEconomicsTest is SealedDeliveryTestBase {
    /// The deployment value README recommends: prove on an answer up to 1 KiB, and withdrawClaimable.
    uint256 internal constant FOLLOW_UP = 230_000;
    uint256 internal constant CAP = 1000 gwei;
    uint256 internal constant PRICE = 1_000; // 0.001 USDC
    uint256 internal constant DEPOSIT = 10_000_000;
    /// When the seller answers, the buyer may end at most this share of its claim's gas cost ahead.
    uint256 internal constant SHARE_PERCENT = 5;

    enum Outcome { SILENT, FRAUD_OPEN, FRAUD_AFTER_ANSWER, ANSWERED }

    struct Run {
        uint256 claimGas;
        uint256 verdictGas;
        uint256 withdrawGas;
        uint256 received; // USDC units that reached the buyer
        int256 netWei; // received - price paid (not counted when the key came) - gas, in gas wei
    }

    bytes internal plain;
    uint256 internal seq;

    function setUp() public override {
        followUpGas = FOLLOW_UP;
        maxGasPrice = CAP;
        super.setUp();
        _fund(sellerA, DEPOSIT);
        // The demo's swapped answer is 70 bytes. 100 leaves room.
        plain = _bytesOf(100, keccak256("plain"));
    }

    // ------------------------------------------------------------------ transaction gas

    function _calldataGas(bytes memory data) internal pure returns (uint256 standard, uint256 floorTokens) {
        for (uint256 i; i < data.length; ++i) {
            if (data[i] == 0) {
                standard += 4;
                floorTokens += 1;
            } else {
                standard += 16;
                floorTokens += 4;
            }
        }
    }

    /// True when this forge reports a top-level call's gas as a whole transaction (21,000, calldata and the refund
    /// already applied), as forge 1.8.3 does. A view call that executes a few hundred gas tells the two apart.
    function _forgeCountsTheTransaction() internal returns (bool) {
        (bool ok,) = address(sd).call(abi.encodeWithSignature("MAX_GAS_PRICE()"));
        require(ok);
        return vm.lastCallGas().gasTotalUsed >= 21_000;
    }

    /// Sends data to the contract as `from`, with every slot cold, and returns the gas of the whole transaction.
    /// On forge 1.8.3 this matched anvil receipts exactly for withdrawClaimable (58,443) and within 320 gas for
    /// claim (271,324 here against 271,013 to 271,037 there, which differ in their calldata zero bytes).
    function _tx(address from, bytes memory data) internal returns (uint256 gasUsed) {
        bool whole = _forgeCountsTheTransaction();
        vm.cool(address(sd));
        vm.cool(address(usdc));
        vm.prank(from);
        (bool ok, bytes memory ret) = address(sd).call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        Vm.Gas memory g = vm.lastCallGas();
        (uint256 cd, uint256 tokens) = _calldataGas(data);
        if (whole) {
            gasUsed = g.gasTotalUsed;
        } else {
            uint256 used = 21_000 + cd + g.gasTotalUsed;
            uint256 refund = g.gasRefunded > 0 ? uint256(int256(g.gasRefunded)) : 0;
            if (refund > used / 5) refund = used / 5;
            gasUsed = used - refund;
        }
        uint256 floorGas = 21_000 + 10 * tokens;
        if (floorGas > gasUsed) gasUsed = floorGas;
    }

    // ------------------------------------------------------------------ one dispute

    function _dispute(Outcome outcome, uint256 gasPrice) internal returns (Run memory r) {
        address b = _newActor(string.concat("eb", vm.toString(seq++)));
        bytes memory key = abi.encodePacked(keccak256(abi.encode("key", seq)));
        bool honest = outcome == Outcome.SILENT || outcome == Outcome.ANSWERED;
        (SealedDelivery.Promise memory p, bytes memory ct) =
            _sealedProm(sellerA, b, PRICE, keccak256(abi.encode("n", seq)), key, plain, honest);
        SealedDelivery.PaymentAuth memory a = _authFor(p);
        bytes32 id = _cid(sellerA, b, p.paymentNonce);

        vm.txGasPrice(gasPrice);
        r.claimGas = _tx(b, abi.encodeCall(SealedDelivery.claim, (p, _sellerSig(p), a, _buyerSig(a))));

        if (outcome == Outcome.ANSWERED || outcome == Outcome.FRAUD_AFTER_ANSWER) {
            vm.prank(sellerA);
            sd.answer(id, key);
        }
        if (outcome == Outcome.SILENT) {
            skip(WINDOW);
            r.verdictGas = _tx(b, abi.encodeCall(SealedDelivery.finalize, (id)));
        } else if (outcome != Outcome.ANSWERED) {
            r.verdictGas = _tx(b, abi.encodeCall(SealedDelivery.prove, (id, ct, key)));
        }
        if (outcome != Outcome.ANSWERED) {
            r.withdrawGas = _tx(b, abi.encodeCall(SealedDelivery.withdrawClaimable, ()));
        }
        r.received = usdc.balanceOf(b);
        assertEq(sd.claimable(b), 0, "nothing left behind");
        uint256 spent = (r.claimGas + r.verdictGas + r.withdrawGas) * gasPrice;
        // When the seller answers, the buyer has the key it paid for, so the price is not a loss.
        uint256 paid = outcome == Outcome.ANSWERED ? 0 : PRICE * 1e12;
        r.netWei = int256(r.received * 1e12) - int256(paid) - int256(spent);
    }

    function _name(Outcome o) internal pure returns (string memory) {
        if (o == Outcome.SILENT) return "SILENT";
        if (o == Outcome.FRAUD_OPEN) return "FRAUD (claim, prove)";
        if (o == Outcome.FRAUD_AFTER_ANSWER) return "FRAUD (claim, answer, prove)";
        return "ANSWERED";
    }

    function _log(Outcome o, uint256 gasPrice, Run memory r) internal pure {
        console.log(_name(o));
        console.log("  gas price (gwei)", gasPrice / 1 gwei);
        console.log("  gas claim / verdict / withdraw", r.claimGas, r.verdictGas, r.withdrawGas);
        console.log("  received (USDC units)", r.received);
        console.log("  buyer net (gas wei, signed)");
        console.logInt(r.netWei);
    }

    // ------------------------------------------------------------------ the table

    /// Criteria 2 and 3: at 1, 25, 100 and 1000 gwei the buyer ends at or above zero in every outcome, and the
    /// answered outcome leaves it at most SHARE_PERCENT of its claim gas ahead.
    function test_Economics_BuyerNeverLosesAndNeverGainsFromAnAnswer() public {
        uint256[4] memory prices = [uint256(1 gwei), 25 gwei, 100 gwei, 1000 gwei];
        for (uint256 i; i < prices.length; ++i) {
            for (uint256 o; o < 4; ++o) {
                Run memory r = _dispute(Outcome(o), prices[i]);
                _log(Outcome(o), prices[i], r);
                assertGe(r.netWei, 0, "the buyer does not lose");
                if (Outcome(o) == Outcome.ANSWERED) {
                    assertLe(uint256(r.netWei), r.claimGas * prices[i] * SHARE_PERCENT / 100, "an answer is no profit");
                }
            }
        }
    }

    /// A seller that already has an open claim makes the next claim cheaper: openLiability is no longer written
    /// from zero. The refund follows the measured gas, so the bound still holds.
    function test_Economics_AnsweredBoundHoldsWhenTheSellerAlreadyHasAnOpenClaim() public {
        _dispute(Outcome.SILENT, 25 gwei); // leaves nothing open
        address other = _newActor("other");
        _claimOk(_prom(sellerA, other, PRICE, keccak256("open")));
        assertGt(sd.openLiability(sellerA), 0);
        Run memory r = _dispute(Outcome.ANSWERED, 25 gwei);
        _log(Outcome.ANSWERED, 25 gwei, r);
        assertGe(r.netWei, 0);
        assertLe(uint256(r.netWei), r.claimGas * 25 gwei * SHARE_PERCENT / 100);
    }

    /// FOLLOW_UP covers prove on an answer up to 1 KiB, the size README states.
    function test_Economics_FraudOnAOneKibAnswerIsCovered() public {
        plain = _bytesOf(1024, keccak256("kib"));
        uint256[2] memory prices = [uint256(25 gwei), 1000 gwei];
        for (uint256 i; i < prices.length; ++i) {
            Run memory r = _dispute(Outcome.FRAUD_OPEN, prices[i]);
            _log(Outcome.FRAUD_OPEN, prices[i], r);
            assertGe(r.netWei, 0);
        }
    }

    /// Above MAX_GAS_PRICE the costs are counted at the cap, so nothing above it is repaid.
    function test_Economics_GasAboveTheCapIsNotRepaid() public {
        Run memory atCap = _dispute(Outcome.ANSWERED, CAP);
        Run memory above = _dispute(Outcome.ANSWERED, 2 * CAP);
        assertApproxEqAbs(above.received, atCap.received, atCap.received / 50, "the refund stops growing at the cap");
        assertLt(above.netWei, 0, "the buyer carries what it paid above the cap");
    }

    /// The claim's own refund tracks its measured gas within the overhead slack, at the cap where 1 gas = 1 unit.
    function test_Economics_ClaimRefundTracksTheTransaction() public {
        Run memory r = _dispute(Outcome.ANSWERED, CAP);
        console.log("claim tx gas", r.claimGas);
        console.log("refunded gas", r.received);
        assertGe(r.received, r.claimGas);
        assertLe(r.received - r.claimGas, r.claimGas * SHARE_PERCENT / 100);
    }

    /// The verdicts and the withdrawal the buyer sends fit inside FOLLOW_UP in the worst case measured here.
    function test_Economics_FollowUpGasCoversTheBuyersLaterCalls() public {
        Run memory s = _dispute(Outcome.SILENT, 25 gwei);
        Run memory f = _dispute(Outcome.FRAUD_OPEN, 25 gwei);
        console.log("finalize + withdraw", s.verdictGas + s.withdrawGas);
        console.log("prove(100 B) + withdraw", f.verdictGas + f.withdrawGas);
        assertLe(s.verdictGas + s.withdrawGas, FOLLOW_UP);
        assertLe(f.verdictGas + f.withdrawGas, FOLLOW_UP);
    }

    /// A buyer the token refuses still gets the refund, as a credit. The answer itself never fails on it.
    function test_Economics_RefundToABlockedBuyerBecomesACredit() public {
        vm.etch(address(usdc), address(new BlockingUSDC()).code);
        address b = _newActor("blocked");
        BlockingUSDC(address(usdc)).block_(b, true);
        SealedDelivery.Promise memory p = _prom(sellerA, b, PRICE, keccak256("blocked"));
        vm.txGasPrice(25 gwei);
        _claimOk(p);
        bytes32 id = _cid(sellerA, b, p.paymentNonce);
        uint256 refund = sd.gasRefundOf(id);
        uint256 held = usdc.balanceOf(address(sd));
        vm.expectEmit(address(sd));
        emit SealedDelivery.ClaimGasRepaid(id, b, refund, false);
        sd.answer(id, KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(sd.claimable(b), refund, "credited instead");
        assertEq(usdc.balanceOf(address(sd)), held, "nothing left the contract");
        assertEq(sd.deposits(sellerA), DEPOSIT - refund);
        BlockingUSDC(address(usdc)).block_(b, false);
        vm.prank(b);
        sd.withdrawClaimable();
        assertEq(usdc.balanceOf(b), refund);
    }

    /// A seller with nothing left pays nothing, and its answer still goes through.
    function test_Economics_EmptyDepositRepaysNothing() public {
        address s = _newActor("emptySeller");
        address b = _newActor("buyerOfEmpty");
        SealedDelivery.Promise memory p = _prom(s, b, PRICE, keccak256("empty"));
        vm.txGasPrice(25 gwei);
        _claimOk(p);
        bytes32 id = _cid(s, b, p.paymentNonce);
        assertGt(sd.gasRefundOf(id), 0);
        sd.answer(id, KEY);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.DELIVERED));
        assertEq(usdc.balanceOf(b), 0);
        assertEq(sd.claimable(b), 0);
    }
}
