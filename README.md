# vet402 on Arc

When an AI agent pays for an API, nothing guarantees the answer arrives. On 2026-09-28, one Arc mainnet transaction settled 50 purchases by vet402, an AI agent I already own. 31 delivered. 19 were charged and returned nothing it could use. vet402's own requests may explain some of those 19, and 41 of the 50 went to one seller.

A retry with a new signature pays again. I measured it at the event with Seller B, which declares nothing: Circle's record shows 2 transfers, `e9cbd6d5-d3a3-4693-9e6d-f9d33a197b31` and `b9d962ef-6276-4f29-a94d-87618539a6fd`, 2026-11-05 16:04 UTC. [circlefin/arc-nanopayments#43](https://github.com/circlefin/arc-nanopayments/issues/43) describes the same problem (open, 0 comments, read 2026-11-05 UTC).

With vet402, the answer arrives locked, and the key comes on a separate request. When the key does not come, vet402 sends one claim to SealedDelivery on Arc. The seller then has 60 seconds to put the key on chain. If it answers, the same transaction repays the buyer the gas of its claim from the seller's deposit. If it stays silent or swaps the answer, its deposit pays twice the price plus the buyer's gas for the whole dispute, counted at the gas price the claim paid: half to the buyer, the rest burned.

Proof on Arc testnet, 2026-11-06 01:59 to 02:04 UTC, on the final contract, each at a price of 0.001 USDC. Sellers A, D, E and F each deposited 0.5 USDC at 01:37 UTC. The "line stayed up" row is from the run of 01:42 UTC on the same contract. I run these sellers, so every payout comes from a seller I stopped or told to cheat. All rows, the run of 01:42 to 01:46 UTC, and the runs on earlier versions are in [DEMO.md](DEMO.md).

| Seller | What it did | Result | Onchain proof |
|---|---|---|---|
| A | Line stayed up | "Charged once. Delivered." 2.1 s from the start, 01:42 UTC | Transfer `8df8ff6d-df86-4aa1-b9fb-840347074510`, 0 transactions to the contract |
| A | Dropped the key request, answered the claim | "Charged once. Key read from Arc." "Claim gas repaid by the seller: 0.006949 USDC." "Circle record: 1 transfer for this payment." Key on chain 7.2 s from the start | Claim [`0x6fbe43cb…`](https://explorer.testnet.arc.io/tx/0x6fbe43cb52a151c51b4b01736bcc99f94bc9f98b249c42de09acf54c1af0d5da), answer [`0x7e816df8…`](https://explorer.testnet.arc.io/tx/0x7e816df8f4631d9b0172c9a3da16f820f56dc4360f0657816d9914bc29f3fc11) |
| E | Said nothing | "The seller stayed silent. Its deposit paid 0.011413 USDC back: the 0.001 USDC price and 0.010413 USDC for the gas of the dispute." | Claim [`0xf1ba70bd…`](https://explorer.testnet.arc.io/tx/0xf1ba70bd45d40f05cccaae9fbf8e3d39b6f027375f3cf28ed5b9b2fa89aa681f), finalize [`0x924ad0c9…`](https://explorer.testnet.arc.io/tx/0x924ad0c91688abcb24c83d9c99efd72e365102f2b626fc0045f39166c716a9ed) |
| D | Tried a wrong key, then said nothing | "Wrong key rejected by the contract." "The seller stayed silent. Its deposit paid 0.012142 USDC back: the 0.001 USDC price and 0.011142 USDC for the gas of the dispute." | Claim [`0x67698fff…`](https://explorer.testnet.arc.io/tx/0x67698fff825e33a5246cbd352e0e22287a39c4f01138e14112dee3842efc066d), reverted answer [`0x95b35393…`](https://explorer.testnet.arc.io/tx/0x95b353935b893116dd398828157e1ef7676a368e4428284acd1abc9361d72aa1), finalize [`0x9baef1dd…`](https://explorer.testnet.arc.io/tx/0x9baef1dd448e64221aa186f77a46e3d8ed720e245aabcf42f60e2502d02baa98) |
| F | Swapped the answer, then gave its key | "Claim gas repaid by the seller: 0.006949 USDC." "The answer did not match the seller's promise. Its deposit paid 0.013699 USDC back: the 0.001 USDC price and 0.012699 USDC for the gas of the dispute." | Claim [`0x0bd9b723…`](https://explorer.testnet.arc.io/tx/0x0bd9b7234d1c29973260969109a2827ef35b0d45be73fd9efb570f285361f48f), answer [`0x5a5e0606…`](https://explorer.testnet.arc.io/tx/0x5a5e06064433ab10ea339b76f5a8c3da64b6fdd37c97175182a67b173a1a74d0), prove [`0xccfb2bd7…`](https://explorer.testnet.arc.io/tx/0xccfb2bd733da6f8a0980a8a6a2a80f04706a792ba78b973a1cc8d6c7d819df12) |

The same contract runs on Arc mainnet at [`0xf3e2a77e…`](https://explorer.arc.io/address/0xf3e2a77e1a93eeb791ae1016f411e5bb8a05e6d9). On 2026-11-06 between 02:02 and 02:04 UTC, a seller of mine there answered one claim and stayed silent on a second. The buyer ended 0.000139 USDC and 0.001355 USDC ahead, after its own gas. [Contract](#contract) has the transactions.

## Why this matters

x402 is turning into the common way software pays for software. The Linux Foundation launched the x402 Foundation on 2026-07-14 with 40 members, and Visa, Mastercard, Google, AWS, Stripe, Cloudflare, Circle and Coinbase are among its premier members ([announcement](https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications)). Chainalysis counted more than 100 million x402 payments on Base through the first quarter of 2026 ([Chainalysis, 2026-06-03](https://www.chainalysis.com/blog/x402-agentic-payments-adoption/)). Cloudflare's Monetization Gateway post lists "zero chargebacks" ([Cloudflare, 2026-07-01](https://blog.cloudflare.com/monetization-gateway/)). A buyer whose answer never came has nowhere to go. A CoinDesk column of 2026-10-28 puts it in one line: "Payment finality is not commercial finality" ([CoinDesk](https://www.coindesk.com/coindesk-indices/2026/10/28/crypto-long-and-short-what-happens-when-an-ai-agent-pays-for-the-wrong-thing)).

Other fixes put every payment through an escrow or a job contract. vet402 leaves a normal payment as it is and touches the chain only in a dispute.

| | [x402r](https://docs.x402r.org) | [authCapture](https://github.com/x402-foundation/x402/pull/1425) | [x402B](https://github.com/bosonprotocol/x402b) | [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) | vet402 |
|---|---|---|---|---|---|
| Escrow or job contract calls on a payment with no dispute | 1 or more. The buyer pays into escrow and the merchant captures | 1 or more. Authorize then capture on `AuthCaptureEscrow`, or one call when it captures at once | 1 or more. The money goes into Boson's escrow at commit | 4: `createJob`, `fund`, `submit`, `complete` | 0 to SealedDelivery, measured with Seller A on 2026-11-06 at 01:42 UTC ([Architecture](#architecture)) |
| Buyer signatures per payment | Not stated in the docs | 1, an ERC-3009 or Permit2 signature | 2 or more, a meta transaction and a token authorization | 2 or more transactions, `createJob` and `fund` | 1, the EIP-3009 signature x402 already asks for |
| Works with Circle Gateway batched payments | Not stated. The docs list Base and Base Sepolia | Not stated | Not stated | Not stated | Yes. The contract checks the buyer's `GatewayWalletBatched` signature, and every payment of the [run of 01:42 UTC on the live contract](DEMO.md#the-run-of-0142-to-0146-utc) settled in a Gateway batch |
| What a seller adds | Not measured | Not measured | Not measured | Not measured | One middleware and its route, 2 lines in the [package README](packages/sealed-delivery/README.md) that `test/readme.test.ts` runs. The package source is 692 lines |

ERC-8183 also says it has "No dispute resolution or arbitration". In a dispute vet402 sends one claim, and a seller that stays silent or lies pays the buyer from its deposit.

## Architecture

![vet402 architecture: a normal payment sends 0 transactions to SealedDelivery, and a claim appears only in a dispute](docs/architecture.png)

Vector version: [docs/architecture.svg](docs/architecture.svg).

A payment that goes normally sends no transaction to SealedDelivery. Measured on Arc testnet, 2026-11-06 01:42 UTC: Seller A with the line up, delivered 2.1 s from the start, and no claim for that payment among the contract's 12 `Claimed` events, read at 02:10 UTC. Circle still settles the payment in a Gateway batch that Circle sends, and one batch carries many payments. A seller's deposit takes one transaction up front.

Before paying, vet402 reads `coverageFor(seller, price)`. If the deposit does not cover the verdict, the seller gets the same treatment as Seller B: no claim and no second charge. A box lost on the way comes back on a second fetch with the same payment, for a seller that declares it.

## The agent picks the seller

Ask the agent at the top of https://vet402-mumbai-live.vercel.app, from a phone. vet402 reads Circle's Discovery catalog for Arc testnet, 134 listings on 2026-11-06 (132 Quicknode JSON-RPC nodes and 2 BotPay listings), and scores every listing against the words of the job with BM25. No language model runs, and no seller or path is written into the code.

- A job about a payment goes to a JSON-RPC node on the network vet402 pays on. vet402 knows a node by the request its listing asks for, and finds Arc Testnet by name in the listing. It then asks for the receipt of its own latest batch, once.
- Any other job goes to the listing whose own words fit best, if vet402 can fill in the request that listing needs.
- A listing over the 0.01 USDC limit, a seller Arkiv shows with no recent delivery, or a sealing seller whose deposit does not cover the price is passed over for the next one.

Before it pays, the card shows the pick, one line on why, and the top 3 it compared, then asks "May I spend up to 0.0001 USDC on this job?" Nothing moves until Approve. The receipt reads "Paid 0.0001 USDC. Settled on Arc." with a link to the batch on the Arc explorer.

| Job | Pick | Price |
|---|---|---|
| Did my last payment go through? | Quicknode, the Arc Testnet node | 0.0001 USDC |
| Get me a paid access receipt | BotPay, `/pay` | 0.01 USDC |
| What's the weather in Mumbai? | Nobody. "None of the 134 Arc listings matched. Nothing was paid." | 0 |

The public agent pays from its own Arc testnet wallet, `TRY_JOB_HOLD_KEY`, never the dispute wallet. The browser sends only the words of the job and, to approve, the signed id of the plan. The server plans again from the same words and pays only the same seller at the same price. One paid job every 2 minutes per address, and 40 a day across every instance (`TRY_JOB_DAILY_LIMIT`). Without the key the card says the agent is resting. The tests run on a saved copy of the catalog: `server/__tests__/agentPick.test.ts` and `server/__tests__/tryJob.test.ts`.

## Contract

| | |
|---|---|
| Contract | `SealedDelivery`, source in [contracts/SealedDelivery.sol](contracts/SealedDelivery.sol), mechanism and limits in [contracts/README.md](contracts/README.md) |
| Address | [`0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B`](https://explorer.testnet.arc.io/address/0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B) |
| Network | Arc testnet, chain id 5042002 |
| Deploy transaction | [`0x38095fb7894b86e2c57be1d1bb6e367ddbc6fd9fc9276ecacc43ac37701b3733`](https://explorer.testnet.arc.io/tx/0x38095fb7894b86e2c57be1d1bb6e367ddbc6fd9fc9276ecacc43ac37701b3733), 2026-11-06 01:35:22 UTC. Sent with `forge create` from the terminal of the Arc Studio sandbox, by `0xBdccB9ef5aBf024A513566dB8d45DE0315e0735f`, a key used only on testnet |
| Arguments | `maxExpiry` 3600 s, `answerWindow` 60 s, `cooldown` 7200 s, USDC `0x3600000000000000000000000000000000000000`, payment domain `GatewayWalletBatched` version `1` at `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` with a zero `paymentDomainSalt`, `followUpGas` 230000, `maxGasPrice` 100 gwei. `MAX_DISPUTE_COST` reads 55000 (0.055 USDC) |
| Source | Verified on the Arc testnet explorer (Blockscout) at 2026-11-06 01:50 UTC, solc 0.8.28, optimizer on, EVM `cancun`. The verified file has the same sha256 as `contracts/SealedDelivery.sol` on `main` (`93a08889…`) |
| Arc mainnet | [`0xf3e2a77e1a93eeb791ae1016f411e5bb8a05e6d9`](https://explorer.arc.io/address/0xf3e2a77e1a93eeb791ae1016f411e5bb8a05e6d9), chain id 5042, the same source and arguments with Arc mainnet's Gateway Wallet `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE`. Deployed by script at 2026-11-06 02:02:56 UTC, [`0x6a276f7a…`](https://explorer.arc.io/tx/0x6a276f7a2ca79260ccdfc28a809b889a2febd95d684e9a5db818ecb2581eabd8). Sourcify `exact_match` |
| Earlier versions | On testnet, five deployments by Arc Studio's agent, all from earlier source. The last of them, `0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5` (2026-11-05 22:20 UTC), charged a fixed `disputeCost` of 0.0105 USDC in place of the gas each claim paid. On mainnet, the earlier version `0xafdb8931eebdce7f714ac3905c65a50293eb6db6` (2026-11-05 21:59 UTC) charged a fixed 0.009 USDC. Their runs are under [Earlier runs](DEMO.md#earlier-runs). The demo no longer uses them |
| Arc Studio | App id `f6f547d3-78ad-4550-9805-8fc08ac65425`, [workspace](https://studio.arc.io/app/f6f547d3-78ad-4550-9805-8fc08ac65425) |
| Share link | {{SHARE_URL}} |
| Live screen | https://vet402-mumbai-live.vercel.app, whose Try a dispute claims on `0xE9C35ad2…` since 2026-11-06 01:38 UTC |

The two mainnet rounds, all status 1, at 20.001 to 20.00115 gwei:

| UTC | Step | Gas used | Fee in USDC | Transaction |
|---|---|---:|---:|---|
| 02:03:08 | Round 1 `claim` | 271,037 | 0.005421 | [`0x183be3f0…`](https://explorer.arc.io/tx/0x183be3f0fb87c826b6f26f2a4103e5419772843d842c3718f96e284c85e37fa8) |
| 02:03:10 | Round 1 `answer`, `ClaimGasRepaid` 0.00556 USDC to the buyer | 131,604 | 0.002632 | [`0x7541a28b…`](https://explorer.arc.io/tx/0x7541a28bc973fec1969705db7a5e407e48b8ec27c8ff9419732ceb03fd235124) |
| 02:03:13 | Round 2 `claim` | 271,049 | 0.005421 | [`0x9c7229b0…`](https://explorer.arc.io/tx/0x9c7229b0d124973484991ff5cd59858a612ed20d6c1ec4e11cff8d0d9e4c61d0) |
| 02:04:20 | Round 2 `finalize`, `Silent` with 0.01116 USDC for the buyer | 115,874 | 0.002318 | [`0x52162804…`](https://explorer.arc.io/tx/0x521628040a75d008ab4fed04c01f7351ea2035d4c6ed93e5b3fe581b99865555) |
| 02:04:22 | Round 2 `withdrawClaimable` | 53,316 | 0.001066 | [`0x229c82ee…`](https://explorer.arc.io/tx/0x229c82ee7e4c5b14f7c52cea0bc8f3e8bfd31713868ab2236768b38a91fef960) |
| 02:04:24 | `flushBurn`, 0.01116 USDC burned | 57,256 | 0.001145 | [`0x25935b41…`](https://explorer.arc.io/tx/0x25935b4186918c293b415e295b75b6f6d3db4bd27b14f5ab8676265176af8d7c) |

The buyer ended round 1 0.000139 USDC ahead (0.00556 repaid against 0.005421 of claim gas) and round 2 0.001355 USDC ahead (0.01116 credited, less the 0.001 price and its three transactions). Circle's record shows 1 transfer for each payment. The whole mainnet run cost 0.084055 USDC: 0.072895 in gas for twelve transactions, from the deploy to a `requestWithdraw`, and the 0.01116 burned. The seller's remaining 0.11612 USDC can be withdrawn from 2026-11-06 04:04:27 UTC.

## Measured costs

The run of 2026-11-06 01:59 to 02:04 UTC on the testnet contract, and the deposit before it. Every transaction below read status 1 except the one marked reverted, which the contract refused on purpose. The fee is gas used times the gas price each transaction paid, 20.25 to 25 gwei in this run. Arc counts gas in USDC with 18 decimals.

| Call | Gas used | Gas price in gwei | Fee in USDC | Transaction |
|---|---:|---:|---:|---|
| `deposit` | 76,873 | 25 | 0.001922 | [`0x5b33f435…`](https://explorer.testnet.arc.io/tx/0x5b33f435b8c014a645ab9d19513758eea9792995fd053fbbc2493836c26cf3ec) |
| `claim` | 271,013 | 25 | 0.006775 | [`0x6fbe43cb…`](https://explorer.testnet.arc.io/tx/0x6fbe43cb52a151c51b4b01736bcc99f94bc9f98b249c42de09acf54c1af0d5da) |
| `answer` by Seller A, with the refund of the claim gas | 97,015 | 25 | 0.002425 | [`0x7e816df8…`](https://explorer.testnet.arc.io/tx/0x7e816df8f4631d9b0172c9a3da16f820f56dc4360f0657816d9914bc29f3fc11) |
| `answer` with a wrong key, reverted | 29,279 | 21.935 | 0.000642 | [`0x95b35393…`](https://explorer.testnet.arc.io/tx/0x95b353935b893116dd398828157e1ef7676a368e4428284acd1abc9361d72aa1) |
| `finalize` | 98,774 | 20.5 | 0.002025 | [`0x924ad0c9…`](https://explorer.testnet.arc.io/tx/0x924ad0c91688abcb24c83d9c99efd72e365102f2b626fc0045f39166c716a9ed) |
| `prove` on a 70 byte answer | 106,352 | 20.5 | 0.002180 | [`0xccfb2bd7…`](https://explorer.testnet.arc.io/tx/0xccfb2bd733da6f8a0980a8a6a2a80f04706a792ba78b973a1cc8d6c7d819df12) |
| `flushBurn` | 57,256 | 20.5 | 0.001174 | [`0x16884749…`](https://explorer.testnet.arc.io/tx/0x16884749ae92cdc46d60a4c143e140be5ac3ef2874fb35f7047de56c27ee1071) |
| `withdrawClaimable` | 53,316 | 20.5 | 0.001093 | [`0xc7be5f1e…`](https://explorer.testnet.arc.io/tx/0xc7be5f1eb6d04ddb1bf4fe0ce56ddee642bdbe4b618c0ab2d0b3f9a03a5ce76f) |

On this contract, each seller's first `answer` used 131,604 gas and every later one 97,015. The first `finalize` against a seller used 115,862 gas and the next 98,774. The first `prove` used 123,452. [DEMO.md](DEMO.md#contract-transactions) lists all 46 transactions of this contract up to 2026-11-06 02:05 UTC.

The answer pays the buyer back. Claim `0x6fbe43cb…` cost the buyer 0.006775 USDC, and Seller A's answer sent it 0.006949 in the same transaction, so the buyer ended 0.000174 USDC ahead and had its answer.

Deposits read from the contract on 2026-11-06 at 02:17 UTC: Seller A 0.487353 USDC, Seller D 0.448318, Seller E 0.450638, Seller F 0.437452. Each started at 0.5 at 01:37 UTC. Seller A repaid two claims' gas. Sellers D and E each had two SILENT verdicts and Seller F two FRAUD verdicts, one in each run, and Seller F also repaid two claims' gas. The buyer withdrew every credit, and its `claimable` read 0 at 02:17 UTC. A `flushBurn` after each verdict burned the other half.

A claim at the price of 0.001 USDC costs more than the price, so the contract runs only when a delivery fails, and the seller's deposit repays the dispute. [contracts/README.md](contracts/README.md#the-economics) has the numbers.

## How to check this, in order

With nothing installed:

1. Open the [contract](https://explorer.testnet.arc.io/address/0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B) on the explorer. Its source is verified there.
2. Open claim [`0x6fbe43cb…`](https://explorer.testnet.arc.io/tx/0x6fbe43cb52a151c51b4b01736bcc99f94bc9f98b249c42de09acf54c1af0d5da) and answer [`0x7e816df8…`](https://explorer.testnet.arc.io/tx/0x7e816df8f4631d9b0172c9a3da16f820f56dc4360f0657816d9914bc29f3fc11). The `KeyRevealed` event holds the key, and `ClaimGasRepaid` sends the buyer 0.006949 USDC.
3. Open reverted answer [`0x95b35393…`](https://explorer.testnet.arc.io/tx/0x95b353935b893116dd398828157e1ef7676a368e4428284acd1abc9361d72aa1). The chain refused a wrong key.
4. Open finalize [`0x924ad0c9…`](https://explorer.testnet.arc.io/tx/0x924ad0c91688abcb24c83d9c99efd72e365102f2b626fc0045f39166c716a9ed). The `Silent` event names Seller E and the 0.011413 USDC credit.
5. Run the Arkiv query further down. It returns the payment entity and the settlement entity for transfer `4c985dc0-a59d-4674-9e8a-3d5d25def02b`, Seller A at 01:42 UTC.
6. Open the box of that payment's claim on Swarm: https://api.gateway.ethswarm.org/bytes/678485f34be28e46bc7791341ea987e149b38b592ff52ad9aecfa6e292696ec8. Its `claimId` is the one in claim [`0x1269e948…`](https://explorer.testnet.arc.io/tx/0x1269e9487f9fbe1207f1791cfdc9963bf9fb20d93854722c9f794f79c597f94b). [arkiv/swarm.md](arkiv/swarm.md#one-entity-and-the-box-it-points-to) shows the Arkiv entity that points to it.
7. Open the [mainnet contract](https://explorer.arc.io/address/0xf3e2a77e1a93eeb791ae1016f411e5bb8a05e6d9) and its answer [`0x7541a28b…`](https://explorer.arc.io/tx/0x7541a28bc973fec1969705db7a5e407e48b8ec27c8ff9419732ceb03fd235124) and finalize [`0x52162804…`](https://explorer.arc.io/tx/0x521628040a75d008ab4fed04c01f7351ea2035d4c6ed93e5b3fe581b99865555).
8. Open the live screen, listed in the contract table. It shows receipts and checks them, and nothing on it can pay.

With a clone (commands below, results from a fresh clone of commit `4ad89eb` on 2026-11-06 between 02:10 and 02:20 UTC, forge 1.8.3):

9. `forge test`: 236 tests passed in 19 suites. In the Arc Studio sandbox, which also holds `contracts/test-integration`, forge 1.7.1 passed 246 and failed 0 before the deploy.
10. `bash scripts/test.sh`: 440 tests passed, 0 failed.
11. `npx bun run scripts/sealed-local-e2e.ts`: every scene ran against the real contract on a local anvil chain, with real signatures and with Gateway replaced by a stand-in. It printed `RESULT: all scenes as expected`.

## Run it

You need Node.js and Foundry.

```bash
git clone https://github.com/kzmttkc/vet402-mumbai.git
cd vet402-mumbai
npx bun@1.3.14 install --frozen-lockfile
forge install foundry-rs/forge-std --no-git
```

Start the backend in one terminal and the screen in another:

```bash
SEALED_DELIVERY_ADDRESS=0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B npx bun run server/index.ts
```

```bash
npx vite
```

Open http://localhost:5173. The first backend start writes fresh keys for the buyer, the hold and the sellers to `.env`, which git ignores.

To pay for real on Arc testnet:

1. Print the buyer address with `cast wallet address --private-key <BUYER_PRIVATE_KEY from .env>` and send it testnet USDC from https://faucet.circle.com.
2. Run `SEALED_DELIVERY_ADDRESS=0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B npx bun run scripts/sealed-setup.ts --dry-run` to see the plan, then run it again without `--dry-run`. It sends each of Seller A, D, E and F 0.03 USDC for gas and tops each deposit up to 0.5 USDC, so 2.12 USDC in total for fresh sellers. The dry run prints the exact amounts.
3. Open http://localhost:5173/?demo, which shows the scene buttons. Set a hold, then press "Seller A, line stays up", "Try Seller A", "Try Seller B", "Try Seller D", "Try Seller E" or "Try Seller F".

The sellers close the connection on purpose, apart from the "line stays up" button.

| Optional setting | What it turns on |
|---|---|
| `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNER_KEY` | The World ID approval before a hold. Set all three or none |
| `WORLD_ENVIRONMENT` | `staging` (default, the World ID Simulator) or `production` (the real World App, shown as a QR code) |
| `ARKIV_WRITER_KEY`, `ARKIV_ACCESS_KEY` | The Arkiv receipts, and the check of Arc's rulings before each payment, including the demo buttons. Without them the app runs on local receipts alone |
| `SWARM_API_URL`, `SWARM_POSTAGE_BATCH_ID` | Upload each dispute box through your own Bee API, stamped with your own postage batch. Without them the box goes through the public Swarm gateway. `SWARM_UPLOAD=off` keeps boxes off Swarm |
| `PORT`, `DATA_DIR` | The backend port, 3001 by default, and its data folder |

`npx vite build` makes the published screen. Its only paying routes are the two Vercel functions, `api/try-dispute.ts` and `api/try-job.ts`, each on a fixed Arc testnet wallet. With `ARKIV_WRITER_ADDRESS` (or `ARKIV_WRITER_KEY`) on the deploy, `api/try-job` reads Arkiv before it picks, with no key. With `ARKIV_WRITER_KEY`, `api/try-dispute` also writes its receipt and evidence entities to Arkiv and puts the claimed box on Swarm through the public gateway. Without it, the try writes nothing.

## Boundary

Pre-event work ends at tag `mumbai-pre-event-2026` in the older repository. This repository starts after it, and the last two lines of this section name what is here that I did not write at the event.

Pre-event, before 2026-11-05 15:30 UTC:

- Product: vet402. ERC-8004 agentId 9907. Registry `eip155:42220:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.
- Repo: https://github.com/kzmttkc/vet402
- Tag: `mumbai-pre-event-2026`, an annotated tag. Tag object `cc14616dac3b7256ecfdda731ce1225e71756174`.
- Commit the tag points at: `343cd0c348bdbb12db61a09e1ca04b621d7fd68e`, committed 2026-11-03 17:27 UTC.
- Public receipt page: https://kzmttkc.github.io/arc-delivery-receipts/
- The 2026-09-28 batch in the first paragraph: `0x3a78bad401267d8f0914878db7b15e81a27b44637330f619eefef863209d6616` on Arc mainnet (`eip155:5042`). The 50 transfers and their sellers come from Circle's Gateway API, read on 2026-11-05. The 31 and the 19 come from [round 2 of the receipt page](https://kzmttkc.github.io/arc-delivery-receipts/rounds/2/records.json), matched to those transfers by nonce.

Built at ETHGlobal Mumbai:

- This repo: https://github.com/kzmttkc/vet402-mumbai
- First event commit: `4c452189d8a3943a46c5257d8bd1da448585f066` at 2026-11-05 15:30 UTC.
- Arc Studio app id: `f6f547d3-78ad-4550-9805-8fc08ac65425`.
- Arkiv: no file at the tag mentions Arkiv. The SDK came in at `cc37eb7` (2026-11-05 16:17 UTC), the first Arkiv writer at `7df3fb3` (16:21 UTC), and all Arkiv code and `arkiv/` were written here.
- Brought in from before the event: `src/existing/arc-gateway.ts`, copied from the tag. Its first line says so.
- Generated by Arc Studio at commit `a6e3fa2`: the starter app. Commit `341edd6` removed the parts this project does not use.

## Receipts on Arkiv

vet402 keeps each receipt on Arkiv's Rabdi testnet, so a receipt stays readable when this app is down. The receipts page reads Arkiv directly from the browser, every page of it.

Arkiv is also where a seller's standing lives. Each Silent or Fraud ruling from the contract becomes a readonly `vet402_verdict` entity, and before paying, vet402 refuses any seller with a ruling in the last 7 days, a seller whose record has expired, and any seller it cannot read on Arkiv. Rulings are read by the address that would be paid: for a catalog listing the payTo it names, for my own Sellers A to F the address they are paid at. So after Arc's Fraud ruling on Seller F, **Try Seller F** answers "Seller F: Arc ruled against this seller in the last 7 days. Not paid." and pays nothing. The public agent (`api/try-job`) runs the same check, read only. Only an answer that kept the seller's promise extends the seller's record. Another x402 buyer can ask the same question with `isRuledAgainst(payTo, { writer })` from `packages/sealed-delivery`.

Writer address: `0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5`

Print it with `npx bun run scripts/arkiv-address.ts`. The script derives the address from `ARKIV_WRITER_KEY` and never prints the key.

One query you can run. It returns the payment entity and the settlement entity for transfer `4c985dc0-a59d-4674-9e8a-3d5d25def02b`, Seller A at 01:42 UTC on 2026-11-06, the one in step 5 of "How to check this". Receipts live 30 days, so this one expires around 2026-12-06 unless somebody extends it. After that, put a transfer id from the receipts page in place of the id.

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_receipt'"'"') AND gateway_transfer_id = str('"'"'4c985dc0-a59d-4674-9e8a-3d5d25def02b'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"expiresAt":true,"attributes":true}}]}'
```

Arc's rulings, the entities the check reads before paying. At 03:15 UTC on 2026-11-06 it returned 6: 2 Fraud against Seller F and 2 Silent each against Seller D and Seller E, all from the live contract on chain 5042002. Add `AND seller = str('<payTo, lowercase>')` for one seller.

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_verdict'"'"') AND kind = str('"'"'verdict'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"createdAt":true,"attributes":true}}]}'
```

Explorer: https://rabdi.explorer.arkiv.network

More in [arkiv/](arkiv/schema.md).

## World ID

The moment that needs a person is money reaching the agent. vet402 pays with my money and its keys sit on my server. With World ID on, an approval in World App is the only way money reaches the hold wallet.

There are two approvals. Both are World ID 4.0 session proofs of Proof of Human.

1. **Budget.** Setting a budget creates a session. Its proof carries the signal `budget:<amount>:<budget id>`, so the amount saved is the amount I approved on my phone. The backend saves the session id and the proof's session nullifier.
2. **Hold.** Each hold needs a proof of that same session with the signal `<hold id>:<amount>`. The backend accepts it only if the session matches the saved one in full, the signal matches this hold, the session nullifier has never been used, and the hold fits in what the budget has left.

Every hold approved under a budget counts toward it, spent or not. A 1 USDC budget allows a 0.6 USDC hold once and refuses a second one with "Not approved: this is more than the budget has left." A larger hold asks for a new budget, with its own approval. A new budget is a proof of the same session, so only the person who set the first budget can raise it. The backend signs every request and sends every result to World's verify endpoint before anything is saved or held. It also requires the environment, protocol 4.0, `proof_of_human` and this request's nonce. A hold is the agent's spending limit, so the screen reads "Held 1 USDC for your agent." The jobs the agent plans afterwards are paid from it.

In production (`WORLD_ENVIRONMENT=production`) nothing else adds to the hold. The plain hold route answers 403. The compare scene and the Seller C scene spend from the approved hold, and stop with "The hold doesn’t cover this. Hold more first." when it is too small. Gas sent to the hold wallet for contract calls is taken from the approved budget, and nothing is sent once the budget has no room. Staging keeps the filmed flow, where those two scenes add their own small extra hold.

While a hold waits in production, the screen offers **Replay test**. It sends the previous hold's approval for the new hold, and the screen reads "Not approved: this approval is for another hold." Nothing is held. Every route that starts, approves or cancels a request needs a token the backend makes at start. It hands the token only to a request the browser marks as coming from the app's own page (`Sec-Fetch-Site: same-origin`). Any other POST a browser marks as sent from another site is refused, so no other page can start a demo or approve a job.

**Why Proof of Human is enough.** The question at a hold is whether the owner is there and released the money. It is not who the owner is, and it is not whether the owner is unique. The budget belongs to one owner, and the session ties every hold to the person who set it, so another person cannot approve a hold. Uniqueness and Selfie Check answer a Sybil question, and a single owner's budget has no Sybil to stop. Selfie Check also returned `credential_unavailable` on staging when I tried it on 2026-10-28.

It runs in production with the real World App. On 2026-11-05 at 22:16 UTC I set a budget and approved a hold of 1 USDC with my World App on iOS, verified at an Orb, and the verified result reads environment production, protocol 4.0, proof_of_human. Those runs came before the budget had its own signal. The budget signal, the running total, the production limits on the demo scenes, the session token and the cross site check were added on 2026-11-06, and I ran that version in production the same day: "Budget set." for a 1.2 USDC budget at 02:10 UTC, "Held 1 USDC for your agent." at 02:10 UTC, Replay test refused with "Not approved: this approval is for another hold." at 02:11 UTC, Cancel request at 02:11 UTC, and a 0.1 USDC hold approved in World App at 02:18 UTC while the iPhone screen was recorded. The budget then had 0.1 USDC left, so the running total held. The demo video shows the iPhone approval next to the app. The integration debrief is in [DEMO.md](DEMO.md#integration-debrief).

Feedback for the sponsors, each with the step, what came back and the date: [Arc Studio](docs/arc-studio-feedback.md), [World ID](docs/world-feedback.md), [Arkiv](arkiv/friction.md).

## After judging

The buyer side of this goes into vet402's production buyer, which paid through Gateway on Arc mainnet on 2026-09-28. The receipt writer keeps writing one Arkiv entity per payment on Rabdi until Arkiv announces a mainnet.

## How I used AI

Two AI tools wrote the code. Arc Studio (session `mumbai`) started the app, and its agent wrote, tested and deployed the first five versions of the contract on testnet. The final testnet contract was not an agent turn: its source was pasted into the code editor of the same Studio sandbox, tested in the sandbox terminal with forge 1.7.1 (246 passed, 0 failed), and deployed from that terminal with `forge create` on 2026-11-06 at 01:35 UTC. The app's full source, copied into the sandbox, passed `tsc` and 432 tests there. On 2026-11-06 at 02:06 UTC, Studio's Preview ran the published screen from the sandbox, and its Tracing listed the screen's calls to `/api/receipts`, Circle's `/v1/x402/transfers` and Arkiv's `arkiv_query`. Claude Code wrote the instructions sent to Arc Studio, pulled its files with `arc-studio pull`, and wrote the rest of the code and these documents. Every instruction sent to Arc Studio is in [prompts/](prompts/README.md), with what each turn built. The table says who wrote each part first, who changed it, and what I decided. Times are 2026-11-05 UTC unless a date is given. "None recorded" means no decision of mine about that part is written down anywhere.

| Part | First written by | Changed by | What I decided |
|---|---|---|---|
| `contracts/SealedDelivery.sol` | Arc Studio, turn sd1 at 16:17. Turns sd2 and sd3 keyed claims by claim id and added the double verdict with a burned half, `coverageFor` and `prove` | Claude Code from 17:24: collateral taken at the verdict, token and payment domain as constructor arguments, `DISPUTE_COST`, the payment domain salt, and on 2026-11-06 the claim's own gas repaid in every outcome (`81d1f32`). Arc Studio's agent built, tested and made the first 5 testnet deployments, in turns sd2 and sd4 to sd7. The sixth and final testnet deployment was a `forge create` from the Studio sandbox terminal on 2026-11-06 at 01:35 UTC, after 246 tests passed there. I deployed both mainnet contracts by script | A deposit per seller, in place of money held for each payment. At about 16:25 I asked why the plan gave up limits first while time was left. The plan written under that question kept `prove` and made silence and fraud cost twice, with half burned, so a seller paying itself through a second address loses money |
| `contracts/test` | Arc Studio, 14 of the 16 files, in turns sd1 and sd3 | Claude Code added `SealedDelivery.Holes.t.sol` and `SealedDelivery.Collateral.t.sol`, edited the others with each contract change, and turned the gas slope test into a bound (`b7edde7`) | None recorded |
| `server/sealedDelivery.ts` | Claude Code at 17:15 (`2a88276`) | Claude Code (`aa7720b`, `3a602f1`, `131230d`) | None recorded beyond the deposit rule in the first row |
| `server/world.ts` | Claude Code at 16:20 (`6262f7b`), from the instruction [prompt-p6w.txt](prompts/studio/prompt-p6w.txt). Arc Studio never ran it | Claude Code: production mode (`a8219d0`), and on 2026-11-06 the budget signal and the rule that only an approval moves money to the hold (`bd05f86`) | Proof of Human as the credential, not Selfie Check (2026-11-04). I made the production approvals at 22:16 and 23:25 with my own World App, verified at an Orb |
| `server/arkiv.ts` | Claude Code at 16:21 (`7df3fb3`), from the instruction [prompt-p6a.txt](prompts/studio/prompt-p6a.txt). Arc Studio never ran it | Claude Code: the evidence entity that points to the Swarm box (`4ce7a5b`), and on 2026-11-06 the verdict entity and the seller's standing (`c4b0dfe`) | None recorded |
| `server/planner.ts` | Arc Studio, turn p3 at 15:43 | Claude Code: the Arkiv delivery check (`7df3fb3`), then on 2026-11-06 BM25 over all 134 listings with no seller or path written into the code (`9dd11ac`) | None recorded |
| `server/tryDispute.ts`, `server/tryJob.ts` | Claude Code (`04bd19d` at 21:34, `9dd11ac` on 2026-11-06 at 01:06) | Claude Code | None recorded |
| `src/lib/swarmBox.ts`, `server/swarm.ts` | Claude Code at 20:55 (`f4d37f7`, `e20cd85`) | Claude Code: uploads with my own postage batch (`2d6d920`) | I funded the wallet of my Bee node with xDAI and xBZZ, and that node bought batch `b6455d93…`, which the second run used |
| `src/` (the screen) | Arc Studio, turns p1 to p5: `App.tsx`, the hold, job, demo and receipt cards and their hooks | Claude Code: the World ID steps, the sealed scenes, the receipts page, the public page with Ask the agent and Try a dispute. `341edd6` removed the template files Arc Studio started with | I kept the Seller B comparison on the screen, labelled "Comparison only. vet402 does not do this.", when a review suggested cutting it (2026-11-05, before the event) |
| `packages/sealed-delivery` | Claude Code at 21:33 (`7f6a1f5`), from the app's own sealing, ABI and lookout | Claude Code (tests and README) | None recorded |
| `docs/`, `arkiv/*.md`, README.md, DEMO.md | Claude Code (`352154c`, `50eb76c`, `6aa4ba9`, `620340b`) | Claude Code | I set the order the story follows: the problem, how vet402 fixes it, the case for each sponsor, the promise to ship it after judging, and a closing line (2026-11-05, before the event) |

## License

[MIT](LICENSE).

One payment. One receipt. Anyone can check it.
