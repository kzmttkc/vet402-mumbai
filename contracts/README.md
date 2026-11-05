# SealedDelivery

SealedDelivery lets a seller stand behind a paid answer without holding the buyer's money. The payment settles through Circle Gateway and goes to the seller. The contract decides only what happens when the key to a sealed answer does not arrive, or opens something other than what the seller signed.

Live on Arc testnet at [`0x20ce7bbfaf66b28cb917f9331a8960eb563f2094`](https://explorer.testnet.arc.io/address/0x20ce7bbfaf66b28cb917f9331a8960eb563f2094). `contract-metadata/SealedDelivery.json` lists earlier deployments of earlier source, and the demo does not use them.

## Where the idea comes from

FairSwap, by Dziembowski, Eckey and Faust (CCS 2018): https://eprint.iacr.org/2018/740. A seller sends an encrypted file, reveals the key on chain, and the chain looks closer only when somebody complains.

SealedDelivery adapts that to nanopayments settled in Gateway batches. FairSwap holds the payment in the contract, and SealedDelivery holds a seller deposit instead, because the payment has already gone through Gateway. FairSwap proves one wrong step with a Merkle proof, and SealedDelivery decrypts the whole ciphertext on chain, which suits small cached answers.

## How it works

1. Before paying, the buyer reads `coverageFor(seller, value)`. Then it signs a Gateway payment (`TransferWithAuthorization`).
2. The seller verifies the payment, seals the answer with a fresh key for this request, signs a `Promise`, and settles through Gateway. Then it returns the box: ciphertext, promise and seller signature.
3. The buyer asks for the key on a separate request with the same payment, and asks once more if that fails. If the key opens the box and the plaintext matches the signed hash, the job is done and the contract never hears about it.
4. If the key does not come, the buyer sends `claim` with the promise and its own payment signature.
5. The seller, or anyone else holding the key, sends `answer(claimId, key)` before the deadline. The buyer reads the key from the `KeyRevealed` event.
6. If the deadline passes, anyone can send `finalize(claimId)`. If the key opens something other than the signed plaintext, anyone holding the key and ciphertext can send `prove(claimId, ciphertext, key)`.

The sealing is keccak in counter mode: for block `i`, the keystream is `keccak256(abi.encodePacked(key, uint256(i)))`, XORed with each 32 byte chunk. `src/lib/sealed.ts` is the off chain side and `_plaintextHash` is the on chain side.

A claim id is `keccak256(abi.encode(seller, buyer, paymentNonce))`.

## State transitions

```mermaid
stateDiagram-v2
    [*] --> OPEN: claim
    OPEN --> DELIVERED: answer
    OPEN --> SILENT: finalize
    OPEN --> FRAUD: prove
    DELIVERED --> FRAUD: prove
```

`Status` is `NONE`, `OPEN`, `DELIVERED`, `SILENT` or `FRAUD`. SILENT and FRAUD are final. Below, `liability` is `2 * (value + DISPUTE_COST)`, capped at `type(uint128).max`.

| From | Call | Who | Required, or it reverts with | To | Effect |
|---|---|---|---|---|---|
| NONE | `claim(p, sellerSignature, auth, buyerSignature)` | The buyer: `msg.sender == auth.from` (`NotBuyer`) | Seller signature recovers to `p.seller` (`InvalidSellerSignature`). Buyer signature recovers to `auth.from` (`InvalidBuyerSignature`). `p.buyer == auth.from` (`WrongBuyer`). `auth.to == p.seller` (`WrongPayee`). `auth.value == p.value` (`WrongValue`). `auth.nonce == p.paymentNonce` (`WrongNonce`). `now < p.expiry` (`PromiseExpired`). `p.expiry - now <= MAX_EXPIRY` (`ExpiryTooFar`). Claim id unused (`AlreadyClaimed`) | OPEN | No money moves. `openLiability[seller] += liability`. `deadline = now + ANSWER_WINDOW`. Emits `Claimed` |
| OPEN | `answer(claimId, key)` | Anyone | Status is OPEN (`NotOpen`). `now < deadline` (`AnswerWindowClosed`). `keccak256(key) == keyHash` (`WrongKey`) | DELIVERED | `openLiability[seller] -= liability`. `proofHold[seller]` grows by `liability`, after resetting to 0 if the last hold had ended. `proofHoldUntil[seller] = now + COOLDOWN - MAX_EXPIRY`. Emits `KeyRevealed` |
| OPEN | `finalize(claimId)` | Anyone | Status is OPEN (`NotOpen`). `now >= deadline` (`DeadlineNotReached`) | SILENT | `openLiability[seller] -= liability`. `silentCount[seller] += 1`. The deposit pays (below). Emits `Silent` |
| OPEN or DELIVERED | `prove(claimId, ciphertext, key)` | Anyone with the key and ciphertext | Not already FRAUD (`AlreadyFraud`). Status is OPEN or DELIVERED (`NotProvable`). `keccak256(key) == keyHash` (`WrongKey`). `keccak256(ciphertext) == ciphertextHash` (`WrongCiphertext`). Decrypted hash differs from `plaintextHash` (`PromiseKept`). No deadline | FRAUD | From OPEN, `openLiability[seller] -= liability`. `fraudCount[seller] += 1`. The deposit pays (below). `proofHold` stays as it was. Emits `Fraud` |

**When the deposit pays.** `payout = min(liability, deposits[seller])`. The deposit falls by `payout`, and `pendingWithdrawal[seller]` comes down with it if it would exceed the new deposit. The buyer's `claimable` grows by half of `payout`, rounded up. The rest joins `pendingBurn`.

Calls outside a claim:

| Call | Who | Required, or it reverts with | Effect |
|---|---|---|---|
| `deposit(amount)` | The seller | `amount > 0` (`ZeroAmount`), and a USDC approval | `deposits[seller] += amount` |
| `requestWithdraw(amount)` | The seller | `amount > 0` (`ZeroAmount`). `amount <= coverage(seller)` (`ExceedsCoverage`) | `pendingWithdrawal[seller] += amount`. The whole cooldown restarts at `now + COOLDOWN` |
| `withdrawDeposit()` | The seller | Something pending (`NothingPending`). Cooldown over (`CooldownActive`). Something free after open liability and any running proof hold (`LiabilityOpen`) | Sends `min(pending, deposit - held)`. The rest stays queued |
| `withdrawClaimable()` | The buyer | A credit exists (`NothingToWithdraw`) | Sends the buyer's whole credit |
| `flushBurn()` | Anyone | `pendingBurn > 0` (`NothingToWithdraw`) | Sends `pendingBurn` to `0x000000000000000000000000000000000000dEaD` |

Reads: `coverage(seller)` is `deposits - pendingWithdrawal`. `coverageFor(seller, value)` is true when `coverage - openLiability >= 2 * (value + DISPUTE_COST)`.

## The economics

**A verdict repays the dispute.** A claim used about 268,000 gas, which costs more than a sub-cent price. A transaction per payment would not fit these prices, so the contract runs only when a delivery fails. `DISPUTE_COST` is the buyer's gas for going to the chain, fixed at deployment. It came from `claim`, `finalize` and `withdrawClaimable` at 25 gwei on the earlier deployment on 2026-11-05: 420,269 gas, 0.0105 USDC, so it is 10500 here.

On a 0.001 USDC payment, a verdict takes 0.023 USDC from the deposit: 0.0115 to the buyer and 0.0115 burned. In the run of 2026-11-05 at 20 gwei, the same three calls cost the buyer 420,390 gas, 0.0084 USDC. The buyer got back the 0.001 price and all of that gas, and ended 0.0021 USDC ahead. The deposits went from 0.1 to 0.077 USDC.

**Answering is cheaper than silence.** `answer` used 87,400 gas: 0.0017 USDC at 20 gwei in that run, against 0.023 USDC for silence. Silence costs at least 0.021 USDC at any price, so answering stays cheaper up to about 240 gwei.

**The deposit is one pool per seller, and verdicts draw on it first come, first served.** Nothing is reserved at claim time. Each verdict takes its amount when it lands, and later verdicts get what is left. This keeps capital light: no funds are locked per payment. At a 0.001 USDC price, a 0.1 USDC deposit covers 4 open claims.

**Half burns.** Without the burn, a seller could pay itself the deposit through a second address and lose nothing. With it, a seller that drains itself loses half of what it pulls, rounded down, plus gas. It can still empty the pool ahead of honest buyers, at that price. A blocked burn address cannot stop a verdict, because the burn waits in `pendingBurn` until anyone calls `flushBurn`.

**Withdrawals wait.** `requestWithdraw` removes funds from coverage at once and starts `COOLDOWN`. Queued funds stay in `deposits`, and verdicts can take them until they leave. The constructor requires `cooldown >= maxExpiry + answerWindow`, so a seller that signs a promise and then asks to withdraw stays exposed past that claim's deadline. The proof hold keeps a fraud proof payable after an answer: each answer holds that claim's liability until `COOLDOWN - MAX_EXPIRY` after the seller's latest answer, 3600 s on this deployment.

Measured on Arc testnet in the run of 2026-11-05 18:24 to 18:28 UTC, at the 20 gwei each transaction paid:

| Call | Gas | Fee in USDC |
|---|---:|---:|
| `claim` | 268,460 | 0.0054 |
| `answer` | 87,400 | 0.0017 |
| `finalize` | 98,681 | 0.0020 |
| `prove` on a 70 byte answer | 123,426 | 0.0025 |
| `flushBurn` | 57,278 | 0.0011 |
| `withdrawClaimable` | 53,249 | 0.0011 |

## Limits

- **The deposit is shared, first come, first served.** Nothing is reserved at claim. `coverageFor` counts open claims when read, and it can change after that. A later verdict gets what is left, which can be nothing.
- **A seller with no deposit gets no cover.** A seller that plans to drop answers will not deposit. A claim against an empty deposit still records, and `finalize` still marks SILENT, with nothing paid. vet402 reads coverage first and does not claim when it is short.
- **`DISPUTE_COST` is fixed at deployment.** Above about 25 gwei, the 420,390 gas of the last run costs more than 0.0105 USDC, and the verdict no longer covers the whole dispute. Arc mainnet gas is not measured.
- **`DISPUTE_COST` is paid on a verdict only.** A seller that answers on chain owes nothing, so the buyer keeps the claim's gas: 0.0054 USDC at 20 gwei, for a key it paid 0.001 USDC to receive.
- **A claim needs no proof of non-delivery.** A buyer that already has the key can still claim. The seller then has to answer, or pay. A seller whose watcher is down for the 60 s window pays that buyer's verdict too. Set a longer `answerWindow` for real use.
- **It never sees the payment.** `claim` checks signed intent, and settlement stays in Gateway. A seller must sign a promise only in a flow that settles before the box leaves, as `server/sellers.ts` does.
- **A seller can commit to garbage from the start.** If `plaintextHash` is the hash of junk and the key opens that junk, the promise was kept and `prove` reverts. Judging the content belongs to a delivery check outside this contract.
- **A box lost before it arrives leaves nothing to claim.** Without a signed promise there is no claim. vet402 covers that case with a second fetch on the same payment, for sellers that declare it.
- **A late fraud proof pays from what is left.** `prove` has no deadline, and the proof hold ends. After a completed withdrawal, the proof still marks FRAUD and pays what remains.
- **Disputes publish the answer.** `answer` puts the key on chain, so anyone holding that ciphertext can read the answer. `prove` puts key and ciphertext on chain, so anyone can read it. Keys are per request, so other answers stay sealed.
- **`prove` gas grows with the answer**, because it decrypts in a loop. It suits small answers.
- **Signatures must come from EOAs.** Contract wallets are refused.
- **Arc testnet only, with no outside audit.** Deposits are testnet money. The tests in `contracts/test` passed on 2026-11-05 (218 tests on commit `78fa3a9`).

## Use it with your own x402 seller

You can deploy your own copy or deposit into the one above, since each seller has its own pool. The steps below hold for any seller. The code after them uses this repository's helpers on an Express route.

1. **Deposit.** Approve the contract for USDC, then call `deposit(amount)`. USDC here is the 6 decimal ERC-20, and the contract has no native token entry. Size the deposit as `2 * (price + DISPUTE_COST)` times the open claims you want to back. The address that deposits must be the address that signs promises and receives the payment.

2. **Seal in your paid handler.** After you verify the payment and before you settle: make a fresh 32 byte key for this request, encrypt the answer with `sealResponse` from `src/lib/sealed.ts`, and sign a `Promise` bound to this buyer and payment nonce. Set `expiry` at most `MAX_EXPIRY` ahead. This repository uses 3000 s. If settlement fails, return the 402 and throw the box away.

   The EIP-712 domain is `{ name: 'SealedDelivery', version: '1', chainId, verifyingContract }`, and the type string is in `PROMISE_TYPEHASH`.

3. **Serve the key separately.** Add a key route, and hand over the key only to the exact payment header that settled. Store the key and answer on disk, so a restart can still answer a claim.

4. **Run a watcher.** Read `Claimed` events for your seller and call `answer(claimId, key)` before the deadline. Keep gas for it, 87,400 gas per answer on 2026-11-05.

5. **Tell the buyer's side.** Before paying, read `coverageFor`. After paying, check the seller's signature, the buyer, nonce, value, ciphertext hash and expiry. Ask for the key, open the box, and compare the hash. If the key does not come, send `claim` from the address that signed the payment, then read `KeyRevealed` until the deadline. `checkBox` and `createSealedPorts` in `server/sealedDelivery.ts` do this.

In TypeScript, with this repository's helpers:

```ts
import { createSealedDelivery, createSealer, createSellerWatcher } from './server/sealedDelivery'
import { createSeller } from './server/sellers'

const client = createSealedDelivery({ address: CONTRACT })

const seller = createSeller({
  name: 'My API',
  payTo: myAddress,
  declaresRecovery: false,
  facilitator,
  confirmCharged: () => Promise.resolve(false),
  dropAfterSettle: () => false,
  storeFile: 'data/my-seller.json',
  sealing: { seal: createSealer(client, sellerKey), handsOverKey: () => true },
})

app.get('/paid', seller)
app.get('/paid/key', seller.key)

createSellerWatcher({ client, sellerKey, keyFor: seller.keyFor, mode: 'answer' }).start()
```

The price (`DEMO_PRICE`) and the answer (`answer`) are set inside `server/sellers.ts`. Copy that file to set your own. In `server/index.ts`, a small wrapper turns a thrown error into a 502. `ARC_NET` points the client at Arc testnet, and the `net` option takes another chain.

## Constructor

| # | Argument | Type | Value on the live deployment | Meaning |
|---:|---|---|---|---|
| 1 | `maxExpiry` | `uint256` | 3600 | The furthest ahead, in seconds, that a promise can expire at claim time. Must be above 0 |
| 2 | `answerWindow` | `uint256` | 60 | Seconds the seller has to answer after a claim. Must be above 0 |
| 3 | `cooldown` | `uint256` | 7200 | Seconds a withdrawal waits. Must be at least `maxExpiry + answerWindow` |
| 4 | `usdc` | `address` | `0x3600000000000000000000000000000000000000` | The deposit token |
| 5 | `paymentDomainName` | `string` | `GatewayWalletBatched` | EIP-712 name of the buyer's payment signature |
| 6 | `paymentDomainVersion` | `string` | `1` | Its version. `2` uses Gateway's salted form |
| 7 | `paymentVerifyingContract` | `address` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | The Gateway Wallet |
| 8 | `disputeCost` | `uint256` | 10500 | The buyer's cost of going to the chain, in USDC units. Set it from the gas of your chain |

The chain id in the payment domain is the deployment's own, so deploy on the chain the buyer pays on. The contract has no owner, administrator or upgrade path, and these values are immutable.

```bash
forge create contracts/SealedDelivery.sol:SealedDelivery \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key "$DEPLOYER_KEY" \
  --broadcast \
  --constructor-args 3600 60 7200 0x3600000000000000000000000000000000000000 GatewayWalletBatched 1 0x0077777d7EBA4688BDeF3E311b846F25870A19B9 10500
```

This repository's deployment went through Arc Studio. I checked the command above on a local anvil chain on 2026-11-05.

## Tests

```bash
forge install foundry-rs/forge-std --no-git
forge test
```

`lib/` is git-ignored, so the first line is needed on a fresh clone.
