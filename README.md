# vet402 on Arc

When an AI agent pays for an API, nothing guarantees the answer arrives. On 2026-09-28, one Arc mainnet transaction settled 50 purchases by vet402, an AI agent I already own. 31 delivered. 19 were charged and returned nothing it could use. vet402's own requests may explain some of those 19, and 41 of the 50 went to one seller.

A retry with a new signature pays again. I measured it at the event with Seller B, which declares nothing: Circle's record shows 2 transfers, `e9cbd6d5-d3a3-4693-9e6d-f9d33a197b31` and `b9d962ef-6276-4f29-a94d-87618539a6fd`, 2026-11-05 16:04 UTC. [circlefin/arc-nanopayments#43](https://github.com/circlefin/arc-nanopayments/issues/43) describes the same problem (open, 0 comments, read 2026-11-05 UTC).

With vet402, the answer arrives locked, and the key comes on a separate request. When the key does not come, vet402 sends one claim to SealedDelivery on Arc. The seller then has 60 seconds to put the key on chain. If it stays silent or swaps the answer, its deposit pays 2 x (price + 0.0105 USDC): half to the buyer, the rest burned.

Proof on Arc testnet, 2026-11-05 22:40 to 22:46 UTC, on the final contract, each at a price of 0.001 USDC. Each seller deposited 0.1 USDC between 22:21 and 22:22 UTC. I run these sellers, so every payout comes from a seller I stopped or told to cheat. All rows, and a second run from 23:11 to 23:16 UTC, are in [DEMO.md](DEMO.md).

| Seller | What it did | Result | Onchain proof |
|---|---|---|---|
| A | Line stayed up | "Charged once. Delivered." 1.3 s from the start | Transfer `271b8452-365d-4fda-8d49-0019cbdcb4e2`, 0 transactions to the contract |
| A | Dropped the key request, answered the claim | "Charged once. Key read from Arc." "Circle record: 1 transfer for this payment." 9.0 s from the start | Claim [`0xe5bc6bdb…`](https://explorer.testnet.arc.io/tx/0xe5bc6bdb0cecef65b542e66917fe290429952774973af6b92d0605b76138d3cb), answer [`0xd437bafb…`](https://explorer.testnet.arc.io/tx/0xd437bafb360742a03be9f4900f2efaa96a3d2fd8387179e5f2c4c83f50dc792d) |
| E | Said nothing | "The seller stayed silent. Its deposit paid 0.0115 USDC back." Deposit 0.077 USDC | Claim [`0x24182416…`](https://explorer.testnet.arc.io/tx/0x24182416082b271fe9a2a94897e4151e3a2b80bb0aeda1c991d2a3189c3e3fd6), finalize [`0xc60c0312…`](https://explorer.testnet.arc.io/tx/0xc60c0312308f03d84561f7f81671947c3095b255f6cc7a60531c178cabe8d127) |
| D | Tried a wrong key, then said nothing | "Wrong key rejected by the contract." "The seller stayed silent. Its deposit paid 0.0115 USDC back." Deposit 0.077 USDC | Claim [`0xf011ece9…`](https://explorer.testnet.arc.io/tx/0xf011ece93a231868a637ac2a881411d1150af78230a920f4f4b07bdb7a12ac26), reverted answer [`0x66112b6d…`](https://explorer.testnet.arc.io/tx/0x66112b6d4e17ffc01e84a3fde32eb6d3a6fc65a3e20140df14238355f3d1f100), finalize [`0xcf628ca2…`](https://explorer.testnet.arc.io/tx/0xcf628ca23d50eb6e9197c0bfc1882d2d5fda81c73f3018fb1ca9f161d7a053a5) |
| F | Swapped the answer, then gave its key | "The answer did not match the seller's promise. Its deposit paid 0.0115 USDC back." Deposit 0.077 USDC | Claim [`0xb9214a10…`](https://explorer.testnet.arc.io/tx/0xb9214a1089666e9b82106c425095b94e2da39f968ea71056d6fbdc7afd1d8db1), answer [`0x211a089a…`](https://explorer.testnet.arc.io/tx/0x211a089a2bd47d5a549accd135fa84ae36d6e49d20a9dbbb34a9d06cb590ec49), prove [`0xe72c3f4c…`](https://explorer.testnet.arc.io/tx/0xe72c3f4cb07caf1c19757c1b1029749fc89f8c19e31004aa338547b30af3d46b) |

## Architecture

![vet402 architecture: a normal payment sends 0 transactions to SealedDelivery, and a claim appears only in a dispute](docs/architecture.png)

Vector version: [docs/architecture.svg](docs/architecture.svg).

A payment that goes normally sends no transaction to SealedDelivery. Measured on Arc testnet, 2026-11-05 22:42 UTC: Seller A with the line up, delivered 1.3 s from the start, and no claim for that payment among the contract's 15 `Claimed` events, read at 23:31 UTC. Circle still settles the payment in a Gateway batch that Circle sends, and one batch carries many payments. A seller's deposit takes one transaction up front.

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
| Address | [`0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5`](https://explorer.testnet.arc.io/address/0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5) |
| Network | Arc testnet, chain id 5042002 |
| Deploy transaction | [`0x9ef26675a98f8323f0cb623651a63e4ae325ce5bf9c05741747186d4cf35e75a`](https://explorer.testnet.arc.io/tx/0x9ef26675a98f8323f0cb623651a63e4ae325ce5bf9c05741747186d4cf35e75a), 2026-11-05 22:20 UTC, sent by Arc Studio |
| Arguments | `maxExpiry` 3600 s, `answerWindow` 60 s, `cooldown` 7200 s, USDC `0x3600000000000000000000000000000000000000`, payment domain `GatewayWalletBatched` version `1` at `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` with a zero `paymentDomainSalt`, `disputeCost` 10500 (0.0105 USDC) |
| Earlier deployments | Four, all from earlier source. The last of them is `0x20ce7bbfaf66b28cb917f9331a8960eb563f2094`, and its runs are under [Earlier runs](DEMO.md#earlier-runs). The demo no longer uses them |
| Arc Studio | App id `f6f547d3-78ad-4550-9805-8fc08ac65425`, [workspace](https://studio.arc.io/app/f6f547d3-78ad-4550-9805-8fc08ac65425) |
| Share link | {{SHARE_URL}} |
| Live screen | https://vet402-mumbai-live.vercel.app |

I compared the runtime bytecode at that address with a build of `contracts/SealedDelivery.sol` at commit `2d6d920` on 2026-11-05 at 23:20 UTC. All 9,841 bytes match once the 27 immutable slots are masked, metadata hash included. The constructor arguments above appear as written in the input of the deploy transaction.

## Measured costs

The filmed run on this contract, Arc testnet, 2026-11-05 22:21 to 22:46 UTC. The fee is gas used times the gas price each transaction paid, 24.675 to 25 gwei in this run. Arc counts gas in USDC with 18 decimals.

| Call | Gas used | Fee in USDC | Transaction |
|---|---:|---:|---|
| `deposit` | 76,917 | 0.0019 | [`0xebf7b029…`](https://explorer.testnet.arc.io/tx/0xebf7b0293c574e6bd63bfed5b4ed45ecb51c97962d4d6e968da5ecbd43b6466f) |
| `claim` | 268,460 | 0.0067 | [`0x24182416…`](https://explorer.testnet.arc.io/tx/0x24182416082b271fe9a2a94897e4151e3a2b80bb0aeda1c991d2a3189c3e3fd6) |
| `answer` by Seller F | 87,400 | 0.0022 | [`0x211a089a…`](https://explorer.testnet.arc.io/tx/0x211a089a2bd47d5a549accd135fa84ae36d6e49d20a9dbbb34a9d06cb590ec49) |
| `answer` by Seller A | 52,811 | 0.0013 | [`0xd437bafb…`](https://explorer.testnet.arc.io/tx/0xd437bafb360742a03be9f4900f2efaa96a3d2fd8387179e5f2c4c83f50dc792d) |
| `answer` with a wrong key, reverted | 29,279 | 0.0007 | [`0x66112b6d…`](https://explorer.testnet.arc.io/tx/0x66112b6d4e17ffc01e84a3fde32eb6d3a6fc65a3e20140df14238355f3d1f100) |
| `finalize` | 115,781 | 0.0029 | [`0xc60c0312…`](https://explorer.testnet.arc.io/tx/0xc60c0312308f03d84561f7f81671947c3095b255f6cc7a60531c178cabe8d127) |
| `prove` on a 70 byte answer | 123,426 | 0.0031 | [`0xe72c3f4c…`](https://explorer.testnet.arc.io/tx/0xe72c3f4cb07caf1c19757c1b1029749fc89f8c19e31004aa338547b30af3d46b) |
| `flushBurn` | 57,278 | 0.0014 | [`0xbbcf078a…`](https://explorer.testnet.arc.io/tx/0xbbcf078aa93e38ab4c01f183713c22a2686fc173b363b95d0e855d1ce594add4) |
| `withdrawClaimable` | 53,249 | 0.0013 | [`0xdb2e65cb…`](https://explorer.testnet.arc.io/tx/0xdb2e65cb3ac1bae0ea03982d9ef797a402b77d9d55a05936e91d3a429aa59d77) |

On this contract, each seller's first `answer` used 87,400 gas and every later one 52,811. `finalize` used between 81,581 and 115,781 gas across both runs of 2026-11-05. [DEMO.md](DEMO.md#contract-transactions) lists all 37 transactions.

Deposits read from the contract on 2026-11-05 at 23:23 UTC: Seller A 0.1 USDC, Seller D 0.054, Seller E 0.054, Seller F 0.054. Each started at 0.1. Sellers D, E and F each had two verdicts of 0.023 USDC, one in this run and one between 23:14 and 23:16 UTC. After this run the buyer withdrew its three credits of 0.0115 USDC in [`0xdb2e65cb…`](https://explorer.testnet.arc.io/tx/0xdb2e65cb3ac1bae0ea03982d9ef797a402b77d9d55a05936e91d3a429aa59d77), [`0xa42627d4…`](https://explorer.testnet.arc.io/tx/0xa42627d42459b92d6d2d9dab7bb067316b5359a6eb79ef4e208d25b56c4d4903) and [`0x638c68d7…`](https://explorer.testnet.arc.io/tx/0x638c68d78d887691b7fc7ca5c75844def3f6abd4ffea57455a58c205ce582523). Six `flushBurn` calls burned the other 0.0115 USDC of each verdict.

A claim at the price of 0.001 USDC costs more than the price, so the contract runs only when a delivery fails, and a verdict repays the dispute. [contracts/README.md](contracts/README.md#the-economics) has the numbers.

## How to check this, in order

With nothing installed:

1. Open the [contract](https://explorer.testnet.arc.io/address/0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5) on the explorer.
2. Open claim [`0xe5bc6bdb…`](https://explorer.testnet.arc.io/tx/0xe5bc6bdb0cecef65b542e66917fe290429952774973af6b92d0605b76138d3cb) and answer [`0xd437bafb…`](https://explorer.testnet.arc.io/tx/0xd437bafb360742a03be9f4900f2efaa96a3d2fd8387179e5f2c4c83f50dc792d). The `KeyRevealed` event holds the key.
3. Open reverted answer [`0x66112b6d…`](https://explorer.testnet.arc.io/tx/0x66112b6d4e17ffc01e84a3fde32eb6d3a6fc65a3e20140df14238355f3d1f100). The chain refused a wrong key.
4. Open finalize [`0xc60c0312…`](https://explorer.testnet.arc.io/tx/0xc60c0312308f03d84561f7f81671947c3095b255f6cc7a60531c178cabe8d127). The `Silent` event names Seller E and the 0.0115 USDC credit.
5. Run the Arkiv query further down. It returns the payment entity and the settlement entity for transfer `2db76ef8-52a2-4548-bbb6-3bdbc943aad9`, Seller A at 23:11 UTC.
6. Open the box of that payment's claim on Swarm: https://api.gateway.ethswarm.org/bytes/bb095832b29db08053c5506b49c33dd3d45d40cd5d48c2903cdb8f9970a9eaa0. Its `claimId` is the one in claim [`0xca9db10c…`](https://explorer.testnet.arc.io/tx/0xca9db10caa096dc345a90e92a03d5e9f3c884ca7b8e6af3714c48e0a52b04ee4). [arkiv/swarm.md](arkiv/swarm.md#one-entity-and-the-box-it-points-to) shows the Arkiv entity that points to it.
7. Open the live screen, listed in the contract table. It shows receipts and checks them, and nothing on it can pay.

With a clone (commands below, results from a fresh checkout of commit `2d6d920` on 2026-11-05 between 23:18 and 23:26 UTC):

8. `forge test`: 219 tests passed in 16 suites.
9. `bash scripts/test.sh`: 350 tests passed.
10. `npx bun run scripts/sealed-local-e2e.ts`: every scene ran against the real contract on a local anvil chain, with real signatures and with Gateway replaced by a stand-in. It printed `RESULT: all scenes as expected`.

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
SEALED_DELIVERY_ADDRESS=0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5 npx bun run server/index.ts
```

```bash
npx vite
```

Open http://localhost:5173. The first backend start writes fresh keys for the buyer, the hold and the sellers to `.env`, which git ignores.

To pay for real on Arc testnet:

1. Print the buyer address with `cast wallet address --private-key <BUYER_PRIVATE_KEY from .env>` and send it testnet USDC from https://faucet.circle.com.
2. Run `SEALED_DELIVERY_ADDRESS=0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5 npx bun run scripts/sealed-setup.ts --dry-run` to see the plan, then run it again without `--dry-run`. It sends each of Seller A, D, E and F 0.03 USDC for gas and has each deposit 0.1 USDC, so 0.52 USDC in total.
3. Open http://localhost:5173/?demo, which shows the scene buttons. Set a hold, then press "Seller A, line stays up", "Try Seller A", "Try Seller B", "Try Seller D", "Try Seller E" or "Try Seller F".

The sellers close the connection on purpose, apart from the "line stays up" button.

| Optional setting | What it turns on |
|---|---|
| `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNER_KEY` | The World ID approval before a hold. Set all three or none |
| `WORLD_ENVIRONMENT` | `staging` (default, the World ID Simulator) or `production` (the real World App, shown as a QR code) |
| `ARKIV_WRITER_KEY`, `ARKIV_ACCESS_KEY` | The Arkiv receipts. Without them the app runs on local receipts alone |
| `SWARM_API_URL`, `SWARM_POSTAGE_BATCH_ID` | Upload each dispute box through your own Bee API, stamped with your own postage batch. Without them the box goes through the public Swarm gateway. `SWARM_UPLOAD=off` keeps boxes off Swarm |
| `PORT`, `DATA_DIR` | The backend port, 3001 by default, and its data folder |

`npx vite build` makes the published screen. Its only paying routes are the two Vercel functions, `api/try-dispute.ts` and `api/try-job.ts`, each on a fixed Arc testnet wallet.

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

Arkiv is also where a seller's standing lives. Each Silent or Fraud ruling from the contract becomes a readonly `vet402_verdict` entity, and before paying, vet402 refuses any seller with a ruling in the last 7 days, a seller whose record has expired, and any seller it cannot read on Arkiv. Sellers are found by their payTo address when vet402 knows it. Only an answer that kept the seller's promise extends the seller's record.

Writer address: `0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5`

Print it with `npx bun run scripts/arkiv-address.ts`. The script derives the address from `ARKIV_WRITER_KEY` and never prints the key.

One query you can run. It returns the payment entity and the settlement entity for one transfer. Receipts live 30 days, so this one expires around 2026-12-05 unless somebody extends it. After that, put a transfer id from the receipts page in place of the id.

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_receipt'"'"') AND gateway_transfer_id = str('"'"'2db76ef8-52a2-4548-bbb6-3bdbc943aad9'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"expiresAt":true,"attributes":true}}]}'
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

It runs in production with the real World App. On 2026-11-05 at 22:16 UTC I set a budget and approved a hold of 1 USDC with my World App on iOS, verified at an Orb, and the verified result reads environment production, protocol 4.0, proof_of_human. The demo video shows the production approval filmed at 23:25 UTC. Those runs came before the budget had its own signal. The budget signal, the running total, the production limits on the demo scenes, the session token and the cross site check were added on 2026-11-06 and are covered by the backend tests. The integration debrief is in [DEMO.md](DEMO.md#integration-debrief).

## After judging

The buyer side of this goes into vet402's production buyer, which paid through Gateway on Arc mainnet on 2026-09-28. The receipt writer keeps writing one Arkiv entity per payment on Rabdi until Arkiv announces a mainnet.

## How I used AI

Arc Studio started the app and the contract (session `mumbai`). After `arc-studio pull`, Claude Code wrote code and these documents while I set the scope and made the decisions.

## License

[MIT](LICENSE).

One payment. One receipt. Anyone can check it.
