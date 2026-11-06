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
4. If the key does not come, `openSealed` sends `claim` from the payer's address. The middleware's lookout sees the claim and calls `answer` with the key. `openSealed` reads the key from the `KeyRevealed` event and opens the box. The answer also sends the buyer the claim's gas from the seller's deposit.
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

The source in `contracts/` repays the buyer's gas, and it is deployed on Arc testnet at `0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B` (2026-11-06 01:35 UTC, source verified on the explorer) and on Arc mainnet at `0xf3e2a77e1a93eeb791ae1016f411e5bb8a05e6d9` (2026-11-06 02:02 UTC, Sourcify `exact_match`). This package reads `MAX_DISPUTE_COST`, so it does not work with the earlier testnet version `0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5`, which charged a fixed `DISPUTE_COST`. Each seller has its own deposit pool. The contract has no owner, administrator or upgrade path. The full state table is in `contracts/README.md`.

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

## Limits

- **One deployment serves one payment domain.** The live one takes Circle Gateway batched payments at version `1`. The x402 `exact` scheme signs the token's own EIP-3009 domain with no salt, so plain USDC payments need their own deployment with that name, version and token address and a zero `paymentDomainSalt`. `test_PlainTokenDomainVersion2HasNoSalt` checks that digest. I have not run a plain x402 claim on chain.
- **The deposit is shared per seller, first come, first served.** Nothing is reserved at claim time. `coverageFor` is true when read and can change after that. A later verdict gets what is left, which can be nothing.
- **The contract cannot judge what the answer means.** It checks that the key opens exactly the plaintext the seller signed. A seller that signs the hash of junk and delivers that junk has kept its promise.
- **The payment is never seen on chain.** `claim` checks the buyer's signed intent. The middleware signs a promise only after verify and before settle, and returns the box only after settle.
- **A claim needs no proof of non-delivery.** A buyer that already has the key can still claim, at no cost to itself, and the seller must answer within the window and repay the claim's gas. Keep the lookout running and set a longer `answerWindow` for real use.
- **Disputes publish the answer.** `answer` puts the key on chain, so anyone with that box can read it. Keys are per request, so other answers stay sealed.
- **`prove` gas grows with the answer.** It suits small answers.
- **Signatures must come from EOAs.** Contract wallets are refused.
- **Gas above `maxGasPrice` is not repaid**, and a verdict counts the buyer's later calls at the claim's gas price.
- **Arc testnet and one small Arc mainnet run, with no outside audit.** The package has run only against the testnet contract.
- **The package lives in this repository** and imports the app's sealing, ABI and lookout from `src/` and `server/`. It is not on npm.
