// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console} from "forge-std/console.sol";
import {SealedDelivery} from "../SealedDelivery.sol";
import {SealedDeliveryTestBase} from "./SealedDelivery.Base.t.sol";

/// How large can the ciphertext of a *fraud* prove() be under a 30,000,000 gas cap?
/// Worst case path: decrypt every block, compare (mismatch), then payout + USDC burn transfer.
///
/// The ciphertext is the keystream itself (plaintext = zero bytes), built once into a single memory buffer
/// that doubles as the raw call input, so the huge input is never re-copied per attempt. Call layout is a
/// valid (non-canonical) ABI encoding: head [id, offCt=0xa0, offKey=0x60], then key, then ciphertext last.
/// Every attempt uses a FRESH seller + buyer + claim, zeroes the DEAD balance and makes the touched
/// accounts/slots cold, so the first-time SSTOREs (fraudCount, claimable, DEAD balance) are all paid.
contract SealedDeliveryGasTest is SealedDeliveryTestBase {
    uint256 internal constant CAP = 30_000_000;
    bytes32 internal constant GKEY = keccak256("gas-test-key-32-bytes");
    bytes32 internal constant FRAUD_HASH = keccak256("a promised plaintext that is never the zero string");

    uint256 internal _dp; // memory pointer of the raw call input (selector)
    uint256 internal _cs; // memory pointer of the first ciphertext byte inside that buffer
    uint256 internal _pp; // memory pointer of the prefix table: zero bytes in the first i ciphertext words
    uint256 internal _seq;

    // ------------------------------------------------------------------ buffer construction

    function _build(uint256 maxLen, bool zeroTable) internal {
        uint256 words = (maxLen + 31) / 32;
        uint256 total = 4 + 0xc0 + words * 32 + 32;
        bytes32 key = GKEY;
        uint256 dp;
        uint256 cs;
        uint256 pp;
        assembly {
            dp := mload(0x40)
            cs := add(dp, 0xc4)
            pp := add(dp, and(add(total, 0x1f), not(0x1f)))
            mstore(0x40, add(pp, mul(add(words, 1), 0x20)))
            mstore(pp, 0)
            let zeros := 0
            for { let i := 0 } lt(i, words) { i := add(i, 1) } {
                mstore(0x00, key)
                mstore(0x20, i)
                let w := keccak256(0x00, 0x40) // keccak256(abi.encodePacked(key32, uint256(i)))
                mstore(add(cs, mul(i, 0x20)), w)
                if zeroTable {
                    for { let j := 0 } lt(j, 32) { j := add(j, 1) } {
                        if iszero(byte(j, w)) { zeros := add(zeros, 1) }
                    }
                    mstore(add(pp, mul(add(i, 1), 0x20)), zeros)
                }
            }
        }
        _dp = dp;
        _cs = cs;
        _pp = pp;
    }

    /// Fresh seller+buyer+claim whose promise carries this ciphertext prefix. Returns the claimId.
    function _prepare(uint256 len, bytes32 ptHash) internal returns (bytes32 id) {
        uint256 n = _seq++;
        address s = _newActor(string.concat("gs", vm.toString(n)));
        address b = _newActor(string.concat("gb", vm.toString(n)));
        _fund(s, 10e6);
        bytes32 ch;
        uint256 cs = _cs;
        assembly {
            ch := keccak256(cs, len)
        }
        SealedDelivery.Promise memory p = _prom(s, b, 1e6, bytes32(n + 1));
        p.keyHash = keccak256(abi.encodePacked(GKEY));
        p.plaintextHash = ptHash;
        p.ciphertextHash = ch;
        _claimOk(p);
        id = _cid(s, b, p.paymentNonce);
    }

    function _writeHeader(bytes32 id, uint256 len) internal view {
        uint256 dp = _dp;
        bytes32 key = GKEY;
        bytes4 sel = SealedDelivery.prove.selector;
        assembly {
            mstore(dp, sel)
            let a := add(dp, 4)
            mstore(a, id)
            mstore(add(a, 0x20), 0xa0) // offset of ciphertext
            mstore(add(a, 0x40), 0x60) // offset of key
            mstore(add(a, 0x60), 32) // key length
            mstore(add(a, 0x80), key)
            mstore(add(a, 0xa0), len) // ciphertext length
        }
    }

    /// 21000 + calldata gas (16 per non-zero byte, 4 per zero byte) of the equivalent transaction.
    /// The claimId word is counted as all non-zero so the figure does not depend on the attempt.
    function _intrinsic(uint256 len) internal view returns (uint256 g) {
        uint256 dp = _dp;
        uint256 cs = _cs;
        uint256 pp = _pp;
        uint256 padded = (len + 31) / 32 * 32;
        uint256 zeros;
        assembly {
            for { let i := 0 } lt(i, 0xc4) { i := add(i, 1) } {
                if and(or(lt(i, 4), iszero(lt(i, 36))), iszero(byte(0, mload(add(dp, i))))) {
                    zeros := add(zeros, 1)
                }
            }
            let full := div(len, 32)
            zeros := add(zeros, mload(add(pp, mul(full, 32))))
            let w := mload(add(cs, mul(full, 32)))
            for { let j := 0 } lt(j, mod(len, 32)) { j := add(j, 1) } {
                if iszero(byte(j, w)) { zeros := add(zeros, 1) }
            }
            zeros := add(zeros, sub(padded, len)) // zero padding of the last word
        }
        uint256 total = 0xc4 + padded;
        g = 21000 + 16 * (total - zeros) + 4 * zeros;
    }

    function _rawCall(uint256 cap, uint256 len) internal returns (bool ok, uint256 used) {
        uint256 dp = _dp;
        address t = address(sd);
        assembly {
            let inLen := add(0xc4, and(add(len, 0x1f), not(0x1f)))
            let g0 := gas()
            ok := call(cap, t, 0, dp, inLen, 0, 0)
            used := sub(g0, gas())
        }
    }

    /// One fresh-claim prove() call. If txLevel, the cap is 30M minus the transaction's intrinsic gas.
    function _attempt(uint256 len, uint256 cap, bytes32 ptHash, bool txLevel)
        internal
        returns (bool ok, uint256 used, uint256 intrinsic, bytes32 id)
    {
        id = _prepare(len, ptHash);
        _writeHeader(id, len);
        intrinsic = _intrinsic(len);
        if (txLevel) {
            if (intrinsic >= cap) return (false, 0, intrinsic, id);
            cap = cap - intrinsic;
        }
        // make everything cold; prove() itself never touches USDC
        vm.cool(address(sd));
        (ok, used) = _rawCall(cap, len);
    }

    /// Binary search over byte lengths. Returns the largest passing length and the gas it used.
    /// Invariant: lo passes (or is 0), hi fails. Termination hi == lo + 1 means lo + 1 was itself observed failing.
    function _search(uint256 maxLen, bool txLevel) internal returns (uint256 lo, uint256 usedAtLo) {
        (bool okHi,,,) = _attempt(maxLen, CAP, FRAUD_HASH, txLevel);
        require(!okHi, "raise maxLen: upper bound still succeeds");
        uint256 hi = maxLen;
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool ok, uint256 used,,) = _attempt(mid, CAP, FRAUD_HASH, txLevel);
            if (ok) {
                lo = mid;
                usedAtLo = used;
            } else {
                hi = mid;
            }
        }
    }

    // ------------------------------------------------------------------ harness sanity

    /// The assembly-built keystream equals an independent Solidity keystream, and the contract agrees with it:
    /// a promise for the zero string is KEPT, any other promise is proven as fraud.
    function test_Gas_HarnessKeystreamIsTheContractsKeystream() public {
        _build(1000, false);
        bytes memory key = abi.encodePacked(GKEY);
        bytes memory expected = _xorStream(new bytes(100), key);
        bytes memory got = new bytes(160);
        uint256 cs = _cs;
        assembly {
            for { let i := 0 } lt(i, 5) { i := add(i, 1) } {
                mstore(add(add(got, 32), mul(i, 32)), mload(add(cs, mul(i, 32))))
            }
            mstore(got, 100)
        }
        assertEq(got, expected);

        uint256[4] memory lens = [uint256(0), 100, 777, 1000];
        for (uint256 i; i < lens.length; ++i) {
            // honest: the promised hash is of the zero string of that length => PromiseKept => call fails
            (bool okKept,,,) = _attempt(lens[i], CAP, keccak256(new bytes(lens[i])), false);
            assertFalse(okKept, "honest promise must revert PromiseKept");
            (bool okFraud,,, bytes32 id) = _attempt(lens[i], CAP, FRAUD_HASH, false);
            assertTrue(okFraud, "fraud proof succeeds");
            assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
            assertEq(sd.claimable(_buyerOf(id)), 1e6);
        }
    }

    function _buyerOf(bytes32 id) internal view returns (address b) {
        (, b,,,) = _claimData(id);
    }

    // ------------------------------------------------------------------ per-KB slope

    function test_Gas_PerKbSlope() public {
        _build(100 * 1024, false);
        uint256[4] memory lens = [uint256(100), 1024, 10 * 1024, 100 * 1024];
        uint256[4] memory gasUsed;
        for (uint256 i; i < lens.length; ++i) {
            (bool ok, uint256 used,, bytes32 id) = _attempt(lens[i], CAP, FRAUD_HASH, false);
            assertTrue(ok, "fraud prove fits in 30M");
            assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
            gasUsed[i] = used;
            console.log("fraud prove: ciphertext bytes", lens[i]);
            console.log("  gasUsed (call, cold, fresh claim)", used);
        }
        uint256 s1 = (gasUsed[2] - gasUsed[1]) * 1024 / (lens[2] - lens[1]);
        uint256 s2 = (gasUsed[3] - gasUsed[2]) * 1024 / (lens[3] - lens[2]);
        console.log("slope gas/KB between 1KB and 10KB", s1);
        console.log("slope gas/KB between 10KB and 100KB", s2);
        console.log("fixed overhead (gasUsed at 100 B)", gasUsed[0]);
        assertLt(gasUsed[0], gasUsed[1]);
        assertLt(gasUsed[1], gasUsed[2]);
        assertLt(gasUsed[2], gasUsed[3]);
        // near-linear: quadratic memory expansion is a small correction at these sizes
        assertApproxEqRel(s1, s2, 0.05e18);
    }

    // ------------------------------------------------------------------ largest ciphertext

    /// Cap 30M applied to the call itself (what the task asked for). Calldata intrinsic gas is NOT charged
    /// for an internal call, so this is an upper bound on what a real transaction can carry.
    function test_Gas_LargestCiphertextUnder30MGasCap_CallLevel() public {
        uint256 maxLen = 4 * 1024 * 1024; // memory expansion alone exceeds 30M at 4 MiB (3w + w^2/512)
        _build(maxLen, false);
        (uint256 best, uint256 used) = _search(maxLen, false);
        assertGt(best, 0);
        // best + 1 was observed failing by the search (hi == best + 1). The failure is the gas cap, not a
        // logic revert: the identical input passes with a bigger cap.
        (bool okBig, uint256 usedBig,, bytes32 idBig) = _attempt(best + 1, 100_000_000, FRAUD_HASH, false);
        assertTrue(okBig, "best+1 succeeds with more gas => the cap was the only obstacle");
        assertEq(uint8(_status(idBig)), uint8(SealedDelivery.Status.FRAUD));

        console.log("CALL-LEVEL largest ciphertext bytes (cap 30,000,000):", best);
        console.log("  words (32 B)", (best + 31) / 32);
        uint256 w = (best + 31) / 32 + 6; // ciphertext-sized buffer plus scratch/key/index words
        console.log("  ~memory-expansion gas inside the call (3w + w^2/512)", 3 * w + w * w / 512);
        console.log("  gasUsed at that length", used);
        console.log("  gasUsed at length+1 under a 100M cap", usedBig);
        // lengths inside one 32-byte word cost the same gas, so the boundary sits on a word edge
        assertEq(best % 32, 0, "boundary is word aligned");
    }

    /// Same search, but the cap is 30M minus the transaction's intrinsic gas (21000 + calldata), i.e.
    /// what a single real 30M-gas transaction can carry. Still excludes any mempool / RPC size limit.
    function test_Gas_LargestCiphertextUnder30MGasCap_TxLevel() public {
        uint256 maxLen = 2 * 1024 * 1024;
        _build(maxLen, true);
        (uint256 best,) = _search(maxLen, true);

        (bool ok, uint256 used, uint256 intrinsic, bytes32 id) = _attempt(best, CAP, FRAUD_HASH, true);
        assertTrue(ok);
        assertEq(uint8(_status(id)), uint8(SealedDelivery.Status.FRAUD));
        (bool okBig,,, bytes32 idBig) = _attempt(best + 1, 100_000_000, FRAUD_HASH, false);
        assertTrue(okBig, "best+1 succeeds with more gas => the cap was the only obstacle");
        assertEq(uint8(_status(idBig)), uint8(SealedDelivery.Status.FRAUD));

        console.log("TX-LEVEL largest ciphertext bytes (30M incl. calldata gas):", best);
        console.log("  execution gasUsed", used);
        console.log("  intrinsic gas (21000 + calldata)", intrinsic);
        console.log("  total gas of the tx", used + intrinsic);
        console.log("  calldata bytes", 0xc4 + (best + 31) / 32 * 32);
    }
}
