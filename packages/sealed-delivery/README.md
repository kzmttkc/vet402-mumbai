# @vet402/sealed-delivery

A paid x402 answer either arrives with its key, or the seller's deposit pays the buyer.
The seller adds one middleware. The buyer adds one call. Nothing changes in the payment itself.
The buyer stops paying for answers that never come, and the seller pays a dispute only when it stays silent or lies.

The package is not on npm yet, so use it from this repository: `import { sealedDelivery, openSealed } from './packages/sealed-delivery/src/index'` from the repository root, as `scripts/sdk-example-local.ts` does, in place of `'@vet402/sealed-delivery'` in the examples below.

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
4. If the key goes missing, `openSealed` sends `claim` from the payer's address. The middleware's lookout sees the claim and calls `answer` with the key. `openSealed` reads the key from the `KeyRevealed` event and opens the box. The answer also sends the buyer the claim's gas from the seller's deposit.
5. If nobody answers by the deadline, `openSealed` calls `finalize`, and the deposit credits the buyer the price plus its gas for the whole dispute, counted at the gas price the claim paid. If the key opens something other than what was signed, it calls `prove`, with the same credit.

## Seller

```ts
import express from 'express'
import { sealedDelivery } from '@vet402/sealed-delivery'

const app = express()
const sealed = sealedDelivery({
  contract: '0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B',
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
await createSealedChain({ contract, rpcUrl }).deposit(sellerKey, 500_000n) // 0.5 USDC
```

Size the deposit as `2 * (price + MAX_DISPUTE_COST)` times the open claims you want to back, which is what `coverageFor` asks for: 0.112 USDC per claim at a 0.001 USDC price with `maxGasPrice` at 100 gwei. Each claim you answer on chain also repays the buyer's claim gas from the deposit, about 0.007 USDC at 25 gwei. The seller address also needs gas to answer a claim: 98,019 to 132,231 gas per answer on anvil on 2026-11-06. A route that answers with a status of 400 or more is passed through and nothing is settled. `sealed.close()` stops the lookout.

The full example is `examples/seller.ts`.

### Guard against a buyer that claims with the key in hand

A claim needs no proof that the key never came. A buyer that already has it can still claim, at no cost to itself, and an honest seller pays its answer and the claim's gas, about 0.010 USDC at 25 gwei. `claimGuard` reads the buyer's record from the chain after verify, before anything is settled:

```ts
import { buyerClaimRecord, createSealedChain, sealedDelivery } from '@vet402/sealed-delivery'

const chain = createSealedChain({ contract, rpcUrl })
const sealed = sealedDelivery({
  contract, sellerKey, facilitator, accepts, rpcUrl, chain,
  claimGuard: {
    fromBlock: async () => (await chain.latestBlock()) - 100_000n, // the latest 100,000 blocks
    last: 5,               // look at the buyer's 5 latest claims
    answeredAtLeast: 3,    // 3 of them ended with the seller handing over the key
    action: 'refuse',      // or { surcharge: 10_000n } to ask 0.01 USDC more
  },
})

// The same record, read by hand:
const record = await buyerClaimRecord(buyer, { contract, rpcUrl, fromBlock: 0n, last: 5 })
// record.claims, record.answered, record.recent[i].answered
```

- `'refuse'`: the buyer gets a 403 that says why, and nothing is settled, so it is not charged.
- `{ surcharge }`: a payment of the plain price gets a 402 asking for the price plus `surcharge`. A payment of that amount gets a sealed box as usual. Anyone may pay it.
- If the record read fails, the guard logs it and the sale goes on. One buyer's verdict is reused for `cacheMs` (60 s by default).
- `buyerClaimRecord` reads `Claimed`, filters the buyer here because it is not an indexed field, then reads `KeyRevealed` for the latest claims only. Both reads go 10,000 blocks per call. `seller` (or `thisSellerOnly: true` in the guard) counts only claims against one seller.

`test/guard.test.ts` runs both actions and the record against a node that serves real event logs.

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

Before paying, `await isRuledAgainst(accept.payTo, { writer: '0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5', verifyOnArc: true })` is true when vet402 recorded a Silent or Fraud ruling against that address in the last 7 days and Arc holds the contract's event for it.
`verifyOnArc` reads Arc testnet by default (`arcRpcUrl` for another node, `contracts` for other deployments), counts only rulings whose event it found, and throws when a node cannot be read, so you decide what a failed read means.
`await isRuledAgainst(accept.payTo, { writers: 'any', verifyOnArc: true })` counts a ruling from any writer, vet402 among them, once Arc holds the contract's event for it. Anyone who copies an Arc ruling to Arkiv adds to the same record.
`writers: 'any'` requires `verifyOnArc: true` and throws without it, so a ruling from an unknown writer always rests on Arc's own event.

## Also exported

`buyerClaimRecord`, `isGuarded`, `sealResponse`, `openResponse`, `sealAndPromise`, `signPromise`, `promiseSigner`, `checkBox`, `openBox`, `claimIdOf`, `paymentAuthOf`, `PROMISE_TYPES`, `promiseDomain`, `SEALED_DELIVERY_ABI` and `createSealedChain`, for a seller or buyer that is not on Express.

## The contract

The source in `contracts/` repays the buyer's gas, and it is deployed on Arc testnet at `0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B` (2026-11-06 01:35 UTC, source verified on the explorer) and on Arc mainnet at `0xf3e2a77e1a93eeb791ae1016f411e5bb8a05e6d9` (2026-11-06 02:02 UTC, Sourcify `exact_match`). This package reads `MAX_DISPUTE_COST` and works with the final contract on both networks. Each seller has its own deposit pool. The contract has no owner, administrator or upgrade path. The full state table is in `contracts/README.md`.

| # | Argument | Recommended on Arc testnet | Meaning |
|---:|---|---|---|
| 1 | `maxExpiry` | 3600 | The furthest ahead, in seconds, a promise may expire at claim time |
| 2 | `answerWindow` | 60 | Seconds the seller has to answer a claim |
| 3 | `cooldown` | 7200 | Seconds a deposit withdrawal waits. At least `maxExpiry + answerWindow` |
| 4 | `usdc` | `0x3600000000000000000000000000000000000000` | The deposit token, a 6 decimal ERC-20 |
| 5 | `paymentDomainName` | `GatewayWalletBatched` | EIP-712 name of the buyer's payment signature |
| 6 | `paymentDomainVersion` | `1` | Its version |
| 7 | `paymentVerifyingContract` | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | The contract the buyer's payment is signed for: the Gateway Wallet |
| 8 | `followUpGas` | 230000 | Gas the buyer spends after a claim: a verdict on an answer up to 1 KiB and the withdrawal |
| 9 | `maxGasPrice` | 100000000000 | The highest gas price, in wei, a claim's costs are counted at. 0 repays no gas |
| 10 | `paymentDomainSalt` | `0x0000000000000000000000000000000000000000000000000000000000000000` | Zero for an unsalted payment domain. Gateway's batched domain at version `2` takes the USDC address here |

### Another chain or another USDC

Deploy a copy on the chain the buyer pays on, because the payment domain takes this deployment's chain id. Three groups of arguments change:

- `usdc`: the 6 decimal USDC of that chain. The SDK reads it from the contract, so deposits follow.
- The payment domain (5, 6, 7, 10): copy the `extra.name`, `extra.version` and `extra.verifyingContract` your x402 requirement already advertises. For Circle Gateway batching that is `GatewayWalletBatched`, version `1` or `2`, and the Gateway Wallet of that chain. At version `2` Gateway salts the domain with the USDC address, so pass that address padded to 32 bytes as `paymentDomainSalt`. At version `1` pass zero.
- `followUpGas` and `maxGasPrice`: the contract converts gas to USDC at 1e12 wei per USDC unit, which holds where gas is paid in USDC, as on Arc. On a chain whose gas is another token, pass `maxGasPrice` 0. `contracts/README.md` explains both.

```bash
forge create contracts/SealedDelivery.sol:SealedDelivery --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast \
  --constructor-args 3600 60 7200 "$USDC" GatewayWalletBatched 1 "$GATEWAY_WALLET" 230000 100000000000 "$PAYMENT_DOMAIN_SALT"
```

## Design notes

- **One deployment serves one payment domain.** The live one takes Circle Gateway batched payments at version `1`. The x402 `exact` scheme signs the token's own EIP-3009 domain with no salt, so plain USDC payments take their own deployment with that name, version and token address and a zero `paymentDomainSalt`. `test_PlainTokenDomainVersion2HasNoSalt` checks that digest.
- **The deposit is one pool per seller, first come, first served.** Nothing is locked per payment. `coverageFor` counts the open claims when read, so read it right before each payment, as `openSealed`'s caller does above.
- **The contract checks the promise, and vet402 checks the content.** The key has to open exactly the plaintext the seller signed. Whether that plaintext is a useful answer is a judgment about meaning, which vet402's delivery check makes.
- **Settlement stays with your facilitator.** `claim` checks the buyer's signed intent. The middleware signs a promise only after verify and before settle, and returns the box only after settle.
- **Claims are open to every payer, and `claimGuard` protects the seller.** A claim asks for no proof of non delivery, so a buyer never has to prove a negative, and an answer repays its gas. Keep the lookout running, and give `answerWindow` more room in production. `claimGuard` refuses a sealed box, or asks a surcharge, when a buyer's latest claims were answered, and the seller sets the bar.
- **A dispute opens that one answer to everyone.** `answer` puts the key on chain, so anyone with that box can read it. Keys are per request, so every other answer stays sealed.
- **`prove` decrypts on chain**, and its gas grows with the answer. It is sized for answers up to 1 KiB.
- **Promises and payments are signed by EOAs**, checked with `ecrecover`.
- **Gas is repaid up to `maxGasPrice`**, and a verdict counts the buyer's later calls at the claim's gas price, so claim at 100 gwei or less and send the follow up calls at the claim's price.
- **Tested against the real contract.** `scripts/sdk-example-local.ts` runs the package against the real contract on a local anvil, `test/readme.test.ts` runs the README block as written, and `test/guard.test.ts` runs the guard. The same contract is live on Arc testnet and Arc mainnet.
- **The package lives in this repository** and imports the app's sealing, ABI and lookout from `src/` and `server/`.
