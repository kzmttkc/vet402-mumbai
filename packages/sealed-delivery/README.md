# @vet402/sealed-delivery

A paid x402 answer either arrives with its key, or the seller's deposit pays the buyer.
The seller adds one middleware. The buyer adds one call. Nothing changes in the payment itself.
The buyer stops paying for answers that never come, and the seller pays a dispute only when it stays silent or lies.

<!-- readme-example -->
```ts
import { sealedDelivery, openSealed } from '@vet402/sealed-delivery'
app.use('/answer', sealedDelivery({ contract, sellerKey, facilitator, accepts, rpcUrl }))
app.get('/answer', (req, res) => res.json({ answer: 42 }))
const { text } = await openSealed({ url, paymentHeader, contract, rpcUrl, buyerKey })
```

Lines 2 and 3 go on the seller. Line 4 goes on the buyer. `test/readme.test.ts` runs this block as written.

## What it does

1. The buyer reads `coverageFor(seller, price)` and pays as usual with its x402 client.
2. The middleware verifies the payment with your facilitator, lets your route answer, encrypts that answer with a fresh key, signs a `Promise` for this buyer and payment, and settles. The buyer gets a box: ciphertext, promise and signature. If settlement fails, the box is thrown away and the buyer gets the 402.
3. The buyer asks `GET <route>/key` with the same payment header. The key opens the box, and the buyer checks the plaintext against the signed hash. In the normal case the chain is never touched.
4. If the key does not come, `openSealed` sends `claim` from the payer's address. The middleware's lookout sees the claim and calls `answer` with the key. `openSealed` reads the key from the `KeyRevealed` event and opens the box.
5. If nobody answers by the deadline, `openSealed` calls `finalize`, and the deposit credits the buyer `price + DISPUTE_COST`. If the key opens something other than what was signed, it calls `prove`, with the same credit.

## Seller

```ts
import express from 'express'
import { sealedDelivery } from '@vet402/sealed-delivery'

const app = express()
const sealed = sealedDelivery({
  contract: '0x20ce7bbfaf66b28cb917f9331a8960eb563f2094',
  sellerKey,              // signs promises, receives the payment, answers claims
  facilitator,            // the one you already use, for example Circle's BatchFacilitatorClient
  accepts,                // your x402 payment requirement, with payTo set to sellerKey's address
  rpcUrl: 'https://rpc.testnet.arc.network',
  storeFile: 'data/sealed-keys.json', // keeps keys across a restart
})
app.use('/forecast', sealed)
app.get('/forecast', (req, res) => res.json({ forecast: 'Sunny' }))
```

Before the first sale, deposit once from the same address:

```ts
import { createSealedChain } from '@vet402/sealed-delivery'
await createSealedChain({ contract, rpcUrl }).deposit(sellerKey, 100_000n) // 0.1 USDC
```

Size the deposit as `2 * (price + DISPUTE_COST)` times the open claims you want to back. The seller address also needs gas to answer a claim: 87,400 gas per answer on Arc testnet on 2026-11-05. A route that answers with a status of 400 or more is passed through and nothing is settled. `sealed.close()` stops the lookout.

The full example is `examples/seller.ts`.

## Buyer

```ts
import { coverageFor, openSealed } from '@vet402/sealed-delivery'

if (await coverageFor({ contract, rpcUrl }, accept.payTo, BigInt(accept.amount))) {
  const paymentHeader = await pay(accept) // your x402 client
  const result = await openSealed({ url, paymentHeader, contract, rpcUrl, buyerKey })
  // result.status is 'opened', 'silent' or 'fraud'. result.credited is what the deposit paid.
}
```

`buyerKey` must be the key that signed the payment, because only the payer can claim. Without it, `openSealed` still opens a box whose key arrives over HTTP. The full example is `examples/buyer.ts`. `npx bun run scripts/sdk-example-local.ts` runs both against the real contract on a local anvil: the key over HTTP, the key on chain, silence, a seller without cover, and a wrong amount.

## Also exported

`sealResponse`, `openResponse`, `sealAndPromise`, `signPromise`, `promiseSigner`, `checkBox`, `openBox`, `claimIdOf`, `paymentAuthOf`, `PROMISE_TYPES`, `promiseDomain`, `SEALED_DELIVERY_ABI` and `createSealedChain`, for a seller or buyer that is not on Express.

## The contract

Live on Arc testnet at `0x20ce7bbfaf66b28cb917f9331a8960eb563f2094`. Each seller has its own deposit pool, so any seller can deposit into this one. The contract has no owner, administrator or upgrade path. The full state table is in `contracts/README.md`.

| # | Argument | On the live deployment | Meaning |
|---:|---|---|---|
| 1 | `maxExpiry` | 3600 | The furthest ahead, in seconds, a promise may expire at claim time |
| 2 | `answerWindow` | 60 | Seconds the seller has to answer a claim |
| 3 | `cooldown` | 7200 | Seconds a deposit withdrawal waits. At least `maxExpiry + answerWindow` |
| 4 | `usdc` | `0x3600000000000000000000000000000000000000` | The deposit token, a 6 decimal ERC-20 |
| 5 | `paymentDomainName` | `GatewayWalletBatched` | EIP-712 name of the buyer's payment signature |
| 6 | `paymentDomainVersion` | `1` | Its version. `2` means Gateway's salted form |
| 7 | `paymentVerifyingContract` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | The contract the buyer's payment is signed for: the Gateway Wallet |
| 8 | `disputeCost` | 10500 | The buyer's gas for a dispute, in USDC units |

### Another chain or another USDC

Deploy a copy on the chain the buyer pays on, because the payment domain takes this deployment's chain id. Three groups of arguments change:

- `usdc`: the 6 decimal USDC of that chain. The SDK reads it from the contract, so deposits follow.
- The payment domain (5, 6, 7): copy the `extra.name`, `extra.version` and `extra.verifyingContract` your x402 requirement already advertises. For Circle Gateway batching that is `GatewayWalletBatched`, version `1` or `2`, and the Gateway Wallet of that chain.
- `disputeCost`: the gas of `claim`, `finalize` and `withdrawClaimable` together on that chain, in USDC units. On Arc testnet that was 420,269 gas, 0.0105 USDC at 25 gwei.

```bash
forge create contracts/SealedDelivery.sol:SealedDelivery --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast \
  --constructor-args 3600 60 7200 "$USDC" GatewayWalletBatched 1 "$GATEWAY_WALLET" "$DISPUTE_COST"
```

## Limits

- **Plain USDC payments cannot be claimed.** Version `2` always takes Gateway's salted domain. The x402 `exact` scheme signs USDC's own domain, version `2` with no salt, so `claim` refuses that signature (checked on anvil on 2026-11-06). Today the contract serves Gateway batched payments and any payment domain with another version. Plain USDC needs a contract change.
- **The deposit is shared per seller, first come, first served.** Nothing is reserved at claim time. `coverageFor` is true when read and can change after that. A later verdict gets what is left, which can be nothing.
- **The contract cannot judge what the answer means.** It checks that the key opens exactly the plaintext the seller signed. A seller that signs the hash of junk and delivers that junk has kept its promise.
- **The payment is never seen on chain.** `claim` checks the buyer's signed intent. The middleware signs a promise only after verify and before settle, and returns the box only after settle.
- **A claim needs no proof of non-delivery.** A buyer that already has the key can still claim, and the seller must answer within the window. Keep the lookout running and set a longer `answerWindow` for real use.
- **Disputes publish the answer.** `answer` puts the key on chain, so anyone with that box can read it. Keys are per request, so other answers stay sealed.
- **`prove` gas grows with the answer.** It suits small answers.
- **Signatures must come from EOAs.** Contract wallets are refused.
- **Arc testnet only, with no outside audit.**
- **The package lives in this repository** and imports the app's sealing, ABI and lookout from `src/` and `server/`. It is not on npm.
