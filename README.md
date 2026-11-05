# vet402 on Arc

When an AI agent pays for an API, nothing guarantees the answer arrives. On 2026-09-28, one Arc mainnet transaction settled 50 purchases by vet402, an AI agent I already own. 31 delivered. 19 were charged and returned nothing it could use. vet402's own requests may explain some of those 19, and 41 of the 50 went to one seller.

When a paid answer is lost, a retry with a new signature pays again. I measured it at the event: on 2026-11-05 at 16:04 UTC, Seller B took transfers `e9cbd6d5-d3a3-4693-9e6d-f9d33a197b31` and `b9d962ef-6276-4f29-a94d-87618539a6fd` for one request, and Circle's record shows 2 transfers.

vet402 answers this in two layers. It asks the seller again with the proof of the payment it already made, and Circle's record still shows one transfer. For a seller with a deposit on Arc, the paid answer also comes as a sealed box and the key comes on a separate request. If the key never comes, vet402 files a claim on the SealedDelivery contract. The seller then publishes the key on Arc, or its deposit pays twice the price.

Proof on Arc testnet, 2026-11-05 UTC, each at a price of 0.001 USDC. All rows are in [DEMO.md](DEMO.md).

| Case | Result | Onchain proof |
|---|---|---|
| Seller A lost the answer and kept it | Charged once. Delivered on the second fetch. Circle record: 1 transfer for this payment. | Batch [`0x9318db6d…`](https://explorer.testnet.arc.io/tx/0x9318db6df3722facf089c186ca5b0f6f25440cd5f67d73edbf18508468ef9948) |
| Seller A closed the key request | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. The run read the key in 9.4 s. | Claim [`0x110749e4…`](https://explorer.testnet.arc.io/tx/0x110749e4ede9ad6cdc2f0579f4819dd752167a72f0f2a8b1c735448ac90245c2), answer [`0xf83c4872…`](https://explorer.testnet.arc.io/tx/0xf83c4872ec5e23c14a5d8d5e7ede1434ee04824fd43120121be961b06978f8c8) |
| Seller E said nothing | Its deposit paid 0.001 USDC back. It went from 0.01 to 0.008 USDC. | Claim [`0x5ef6c066…`](https://explorer.testnet.arc.io/tx/0x5ef6c066a4cd2090a35e20fb92d921d3442d6a33821cb7a2d9c3b5940f02afee), finalize [`0x89f03886…`](https://explorer.testnet.arc.io/tx/0x89f03886270480150bbdbf08e6d99eecd14c180b395db98e3b93350bc9932a4e) |
| Seller D tried a wrong key, then said nothing | Wrong key rejected by the contract. Its deposit paid 0.001 USDC back. | Reverted answer [`0x5ec88c38…`](https://explorer.testnet.arc.io/tx/0x5ec88c38d1ce2ae44de817e5ba932ab559e0025b63cd135d01f4625e31e023ab), finalize [`0x3c4414d4…`](https://explorer.testnet.arc.io/tx/0x3c4414d4572b34f034b2e675406c0ebdafd1b7bf9c563f39dc8900c1db24bf5d) |
| Seller F swapped the answer | The answer did not match the seller's promise. Its deposit paid 0.001 USDC back. | Answer [`0xf5ed51eb…`](https://explorer.testnet.arc.io/tx/0xf5ed51eb0455afd233e0e567a451832911ced19c1178afce1955c2fc1428c820), prove [`0xd74eee02…`](https://explorer.testnet.arc.io/tx/0xd74eee02e9f7f8714ac33a64b140eee26826a7333b4097c65b24057699d88c1b) |

## Architecture

![vet402 architecture: the normal path sends 0 SealedDelivery transactions, and a claim appears only in a dispute](docs/architecture.png)

Vector version: [docs/architecture.svg](docs/architecture.svg).

When the key arrives over HTTP, that payment causes 0 SealedDelivery transactions. vet402 and the seller send nothing to the chain for it. Circle still settles the payment in a Gateway batch that Circle sends, and one batch can carry many payments. Batch [`0x9318db6d…`](https://explorer.testnet.arc.io/tx/0x9318db6df3722facf089c186ca5b0f6f25440cd5f67d73edbf18508468ef9948) carried 4 of the receipts in DEMO.md.

The count of 0 comes from the code path `sealedRun` in `server/demo.ts` and from the scene "A switch off" in `scripts/sealed-local-e2e.ts`, which passed on a local anvil chain on 2026-11-05. The sealed runs on Arc testnet in this README all had the key request closed on purpose. `{{TODO: one Arc testnet run with SELLER_DROP_RESPONSE=off, with its transfer id and the claim count}}`

## Contract

| | |
|---|---|
| Contract | `SealedDelivery`, source in [contracts/SealedDelivery.sol](contracts/SealedDelivery.sol), design in [contracts/README.md](contracts/README.md) |
| Address | [`0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2`](https://explorer.testnet.arc.io/address/0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2) |
| Network | Arc testnet, chain id 5042002 |
| Deploy transaction | [`0x36b5f57021d61bbb1c7a1a9b02b5f82330f89cd115c6e0f1c87430266471e4a8`](https://explorer.testnet.arc.io/tx/0x36b5f57021d61bbb1c7a1a9b02b5f82330f89cd115c6e0f1c87430266471e4a8), 2026-11-05 17:47 UTC |
| Timing arguments | `maxExpiry` 3600 s, `answerWindow` 60 s, `cooldown` 7200 s |
| Arc Studio | App id `f6f547d3-78ad-4550-9805-8fc08ac65425`, [workspace](https://studio.arc.io/app/f6f547d3-78ad-4550-9805-8fc08ac65425) |
| Share link | `{{TODO: Netlify URL from Share app}}` |
| Live screen | `{{TODO: live screen URL after the public export}}` |

I compared the runtime bytecode at that address with a build of `contracts/SealedDelivery.sol` from this repository on 2026-11-05. They match once the immutable values are masked, and the metadata hash matches too.

## Measured costs

Arc testnet, 2026-11-05 UTC. The fee is gas used times the 25 gwei paid by each of these transactions. Arc counts gas in USDC with 18 decimals.

| Call | Gas used | Fee in USDC | Example |
|---|---:|---:|---|
| `deposit` | 76,905 | 0.0019 | [`0xb74ac810…`](https://explorer.testnet.arc.io/tx/0xb74ac810b86ae0a43c84a8e699ccda27c7ad626097118af3541535504be1c55b) |
| `claim` | 268,317 | 0.0067 | [`0xe458fddb…`](https://explorer.testnet.arc.io/tx/0xe458fddb561de5fb6425cf7c2775b26a465623d138187ed577d1d868f3528200) |
| `answer` | 87,355 | 0.0022 | [`0xf83c4872…`](https://explorer.testnet.arc.io/tx/0xf83c4872ec5e23c14a5d8d5e7ede1434ee04824fd43120121be961b06978f8c8) |
| `answer` with a wrong key, reverted | 29,234 | 0.0007 | [`0x5ec88c38…`](https://explorer.testnet.arc.io/tx/0x5ec88c38d1ce2ae44de817e5ba932ab559e0025b63cd135d01f4625e31e023ab) |
| `finalize` | 98,681 | 0.0025 | [`0x89f03886…`](https://explorer.testnet.arc.io/tx/0x89f03886270480150bbdbf08e6d99eecd14c180b395db98e3b93350bc9932a4e) |
| `prove` on a 70 byte answer | 123,414 | 0.0031 | [`0xd74eee02…`](https://explorer.testnet.arc.io/tx/0xd74eee02e9f7f8714ac33a64b140eee26826a7333b4097c65b24057699d88c1b) |
| `flushBurn` | 57,233 | 0.0014 | [`0xd5b8e351…`](https://explorer.testnet.arc.io/tx/0xd5b8e3510fa64e985eeca64c0edfe8b852f58d5ad47d7ef47fd7683b7b461a09) |
| `withdrawClaimable` | 53,271 | 0.0013 | [`0x6f06623e…`](https://explorer.testnet.arc.io/tx/0x6f06623e2c72f1aaf3e4e19ff2ba9a3ef6e8a9a32bea258da64bf3879fb95c40) |

Deposits read from the contract on 2026-11-05 at 18:15 UTC: Seller A 0.01 USDC, Seller D 0.008, Seller E 0.008, Seller F 0.008. Each started at 0.01. The buyer withdrew its 0.003 USDC of credits in [`0x6f06623e…`](https://explorer.testnet.arc.io/tx/0x6f06623e2c72f1aaf3e4e19ff2ba9a3ef6e8a9a32bea258da64bf3879fb95c40).

What these costs mean for a sub-cent price is in [contracts/README.md](contracts/README.md#limits).

## How to check this, in order

With nothing installed:

1. Open the [contract](https://explorer.testnet.arc.io/address/0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2) on the explorer.
2. Open claim [`0x110749e4…`](https://explorer.testnet.arc.io/tx/0x110749e4ede9ad6cdc2f0579f4819dd752167a72f0f2a8b1c735448ac90245c2) and answer [`0xf83c4872…`](https://explorer.testnet.arc.io/tx/0xf83c4872ec5e23c14a5d8d5e7ede1434ee04824fd43120121be961b06978f8c8). The `KeyRevealed` event holds the key.
3. Open reverted answer [`0x5ec88c38…`](https://explorer.testnet.arc.io/tx/0x5ec88c38d1ce2ae44de817e5ba932ab559e0025b63cd135d01f4625e31e023ab). The chain refused a wrong key.
4. Run the Arkiv query further down. It returns the payment entity and the settlement entity for transfer `1302d43e-32bb-4e10-a765-4c15488780d9`.
5. Open the live screen, listed in the contract table. It shows receipts and checks them, and nothing on it can pay.

With a clone (commands below, results from a clean clone of commit `0676762` on 2026-11-05):

6. `forge test`: 214 tests passed.
7. `bash scripts/test.sh`: 299 tests passed.
8. `npx bun run scripts/sealed-local-e2e.ts`: every scene ran against the real contract on a local anvil chain, with real signatures, and with Gateway replaced by a stand-in. It printed `RESULT: all scenes as expected`.

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
SEALED_DELIVERY_ADDRESS=0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2 npx bun run server/index.ts
```

```bash
npx vite
```

Open http://localhost:5173. The first backend start writes fresh keys for the buyer, the hold and the sellers to `.env`, which git ignores.

To pay for real on Arc testnet:

1. Print the buyer address with `cast wallet address --private-key <BUYER_PRIVATE_KEY from .env>` and send it testnet USDC from https://faucet.circle.com.
2. Run `SEALED_DELIVERY_ADDRESS=0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2 npx bun run scripts/sealed-setup.ts --dry-run` to see the plan, then run it again without `--dry-run`. It sends each of Seller A, D, E and F 0.02 USDC for gas and has each deposit 0.01 USDC, so 0.12 USDC in total.
3. Set a hold on the screen, then press "Try Seller A", "Try Seller B", "Try Seller D", "Try Seller E" or "Try Seller F".

The sellers close the connection on purpose. Set `SELLER_DROP_RESPONSE=off` on the backend to see the normal path, where the key arrives over HTTP.

| Optional setting | What it turns on |
|---|---|
| `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNER_KEY` | The World ID approval before a hold. Set all three or none |
| `ARKIV_WRITER_KEY`, `ARKIV_ACCESS_KEY` | The Arkiv receipts. Without them the app runs on local receipts alone |
| `PORT`, `DATA_DIR` | The backend port, 3001 by default, and its data folder |

`npx vite build` makes the published screen, which has no paying route.

## Boundary

Pre-event work ends at tag `mumbai-pre-event-2026` in the older repository. This repository starts after it, and the last two lines of this section name the only files here that I did not write at the event.

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
- Brought in from before the event: `src/existing/arc-gateway.ts`, copied from the tag. Its first line says so.
- Generated by Arc Studio at commit `a6e3fa2`: the starter app, including `AGENTS.md`, `scripts/compass-*`, `scripts/self-deploy.ts` and `scripts/fetch-abi.ts`.

## Receipts on Arkiv

vet402 keeps a copy of every receipt on Arkiv's Rabdi testnet, so a receipt stays readable when this app is down. The receipts page reads Arkiv directly from the browser.

Writer address: `0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5`

Print it with `npx bun run scripts/arkiv-address.ts`. The script derives the address from `ARKIV_WRITER_KEY` and never prints the key.

One query you can run. It returns the payment entity and the settlement entity for one transfer. Receipts live 30 days, so this one expires around 2026-12-05 unless somebody extends it. After that, put a transfer id from the receipts page in place of the id.

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_receipt'"'"') AND gateway_transfer_id = str('"'"'1302d43e-32bb-4e10-a765-4c15488780d9'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"expiresAt":true,"attributes":true}}]}'
```

Explorer: https://rabdi.explorer.arkiv.network

More in [arkiv/](arkiv/schema.md).

## World ID

vet402 pays with my money and its keys sit on my server. The credential is Proof of Human. The only question at the moment of a hold is whether a person, and not the agent, released the money. Nothing here needs to know who that person is.

The backend signs each request and sends each result to World's verify endpoint before it creates a hold. One session is created per budget. Each hold then needs a session proof with that hold's id and amount as its signal, and the backend compares the session id with the stored one in full. An approval made for another hold is refused with "Not approved: this approval is for another hold." Cancel leaves "Not approved. Nothing was held or paid."

The demo runs in World's staging Simulator. The integration debrief is in [DEMO.md](DEMO.md#integration-debrief).

## After judging

The hold and the recovery rule go into vet402's production buyer, which paid through Gateway on Arc mainnet on 2026-09-28. The receipt writer keeps writing one Arkiv entity per payment on Rabdi until Arkiv announces a mainnet.

## How I used AI

Arc Studio started the app (session `mumbai`). After `arc-studio pull`, Claude Code wrote code and these documents while I set the scope and made the decisions.

## License

[MIT](LICENSE).

One payment. One receipt. Anyone can check it.
