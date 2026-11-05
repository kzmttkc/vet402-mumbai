# vet402 on Arc

When an AI agent pays for an API, nothing guarantees the answer arrives. On 2026-09-28, one Arc mainnet transaction settled 50 purchases by vet402, an AI agent I already own. 31 delivered. 19 were charged and returned nothing it could use. vet402's own requests may explain some of those 19, and 41 of the 50 went to one seller.

A retry with a new signature pays again. I measured it at the event with Seller B, which declares nothing: Circle's record shows 2 transfers, `e9cbd6d5-d3a3-4693-9e6d-f9d33a197b31` and `b9d962ef-6276-4f29-a94d-87618539a6fd`, 2026-11-05 16:04 UTC. [circlefin/arc-nanopayments#43](https://github.com/circlefin/arc-nanopayments/issues/43) describes the same problem (open, 0 comments, read 2026-11-05 UTC).

With vet402, the answer arrives locked, and the key comes on a separate request. When the key does not come, vet402 sends one claim to SealedDelivery on Arc. The seller then has 60 seconds to put the key on chain. If it stays silent or swaps the answer, its deposit pays 2 x (price + 0.0105 USDC): half to the buyer, the rest burned.

Proof on Arc testnet, 2026-11-05 UTC, each at a price of 0.001 USDC. Each seller deposited 0.1 USDC. I run these sellers, so every payout comes from a seller I stopped or told to cheat. All rows are in [DEMO.md](DEMO.md).

| Seller | What it did | Result | Onchain proof |
|---|---|---|---|
| A | Line stayed up | "Charged once. Delivered." 1.1 s from the start | Transfer `9cf02586-792d-4d80-b499-486f9894a20d`, 0 transactions to the contract |
| A | Dropped the key request, answered the claim | "Charged once. Key read from Arc." "Circle record: 1 transfer for this payment." 6.8 s from the start | Claim [`0xd67c5d03…`](https://explorer.testnet.arc.io/tx/0xd67c5d030004f9695035aae255e1bd66b75f8ded9a5cda6978997b4bd6ba9bf8), answer [`0x69391c38…`](https://explorer.testnet.arc.io/tx/0x69391c38549ab90e586b012ba944feb94c4ec664852fe81941d6f894ae59d55a) |
| E | Said nothing | "The seller stayed silent. Its deposit paid 0.0115 USDC back." Deposit 0.077 USDC | Claim [`0xc5c53a10…`](https://explorer.testnet.arc.io/tx/0xc5c53a10de47f010249539dce24000f4745fcad20d0d85a4c0d7c8a6bdaa7163), finalize [`0xc41cc0cb…`](https://explorer.testnet.arc.io/tx/0xc41cc0cb903d976d4dc18a8fa252d5730646adf962e174b64f4f6b0c76f96b93) |
| D | Tried a wrong key, then said nothing | "Wrong key rejected by the contract." "The seller stayed silent. Its deposit paid 0.0115 USDC back." Deposit 0.077 USDC | Claim [`0x254c013b…`](https://explorer.testnet.arc.io/tx/0x254c013b1b7f52b9b663062ab6f2069eff06b6bf54ec529df89eb19c44fa6710), reverted answer [`0x51984021…`](https://explorer.testnet.arc.io/tx/0x51984021d48067cf593d6eef56889c5296d5e756c088fc47f16149166fbdb059), finalize [`0xad945fdd…`](https://explorer.testnet.arc.io/tx/0xad945fdd6a3df5b4d4f034a481a555b2667bcd32fcac422bda4469af4c63d895) |
| F | Swapped the answer, then gave its key | "The answer did not match the seller's promise. Its deposit paid 0.0115 USDC back." Deposit 0.077 USDC | Claim [`0x917d7469…`](https://explorer.testnet.arc.io/tx/0x917d74690fa2f67185d0a6efae470250045f25b407ff5cf3c70cd8e146c58bcc), answer [`0x118c709d…`](https://explorer.testnet.arc.io/tx/0x118c709d54106e4bcfe152024212a07453b9c51f74d649a201b06fcbe7d37140), prove [`0x47d1364e…`](https://explorer.testnet.arc.io/tx/0x47d1364ecb9c29e640e6a25829fcda33efeee668401e8a8f68564d1e7a1ba13e) |

## Architecture

![vet402 architecture: a normal payment sends 0 transactions to SealedDelivery, and a claim appears only in a dispute](docs/architecture.png)

Vector version: [docs/architecture.svg](docs/architecture.svg).

A payment that goes normally sends no transaction to SealedDelivery. Measured on Arc testnet, 2026-11-05 18:36 UTC: Seller A with the line up, 1,120 ms, and no claim for that payment among the contract's 4 `Claimed` events, read at 18:49 UTC. Circle still settles the payment in a Gateway batch that Circle sends, and one batch carries many payments. A seller's deposit takes one transaction up front.

Before paying, vet402 reads `coverageFor(seller, price)`. If the deposit does not cover the verdict, the seller gets the same treatment as Seller B: no claim and no second charge. A box lost on the way comes back on a second fetch with the same payment, for a seller that declares it.

## Contract

| | |
|---|---|
| Contract | `SealedDelivery`, source in [contracts/SealedDelivery.sol](contracts/SealedDelivery.sol), mechanism and limits in [contracts/README.md](contracts/README.md) |
| Address | [`0x20ce7bbfaf66b28cb917f9331a8960eb563f2094`](https://explorer.testnet.arc.io/address/0x20ce7bbfaf66b28cb917f9331a8960eb563f2094) |
| Network | Arc testnet, chain id 5042002 |
| Deploy transaction | [`0x8236770b7f8f67512d16091439b7b35906a476db5c33847e472ea8637ffdf288`](https://explorer.testnet.arc.io/tx/0x8236770b7f8f67512d16091439b7b35906a476db5c33847e472ea8637ffdf288), 2026-11-05 18:23 UTC |
| Arguments | `maxExpiry` 3600 s, `answerWindow` 60 s, `cooldown` 7200 s, `disputeCost` 10500 (0.0105 USDC) |
| Arc Studio | App id `f6f547d3-78ad-4550-9805-8fc08ac65425`, [workspace](https://studio.arc.io/app/f6f547d3-78ad-4550-9805-8fc08ac65425) |
| Share link | {{SHARE_URL}} |
| Live screen | {{PUBLIC_URL}} |

I compared the runtime bytecode at that address with a build of `contracts/SealedDelivery.sol` from this repository on 2026-11-05. They match once the immutable values are masked, and the metadata hash matches too.

## Measured costs

The run on this contract, Arc testnet, 2026-11-05 18:24 to 18:28 UTC. The fee is gas used times the 20 gwei each transaction paid. Arc counts gas in USDC with 18 decimals.

| Call | Gas used | Fee in USDC | Transaction |
|---|---:|---:|---|
| `deposit` | 76,917 | 0.0015 | [`0x04152b3e…`](https://explorer.testnet.arc.io/tx/0x04152b3e50acdcf1abaac7b364dc166498891cdd92c3b141d62c8b6513cd0c6d) |
| `claim` | 268,460 | 0.0054 | [`0x254c013b…`](https://explorer.testnet.arc.io/tx/0x254c013b1b7f52b9b663062ab6f2069eff06b6bf54ec529df89eb19c44fa6710) |
| `answer` | 87,400 | 0.0017 | [`0x69391c38…`](https://explorer.testnet.arc.io/tx/0x69391c38549ab90e586b012ba944feb94c4ec664852fe81941d6f894ae59d55a) |
| `answer` with a wrong key, reverted | 29,279 | 0.0006 | [`0x51984021…`](https://explorer.testnet.arc.io/tx/0x51984021d48067cf593d6eef56889c5296d5e756c088fc47f16149166fbdb059) |
| `finalize` | 98,681 | 0.0020 | [`0xad945fdd…`](https://explorer.testnet.arc.io/tx/0xad945fdd6a3df5b4d4f034a481a555b2667bcd32fcac422bda4469af4c63d895) |
| `prove` on a 70 byte answer | 123,426 | 0.0025 | [`0x47d1364e…`](https://explorer.testnet.arc.io/tx/0x47d1364ecb9c29e640e6a25829fcda33efeee668401e8a8f68564d1e7a1ba13e) |
| `flushBurn` | 57,278 | 0.0011 | [`0x0ca5d690…`](https://explorer.testnet.arc.io/tx/0x0ca5d690fb1d308dc2486d842a71e9de6bd2308acef6f25e41bdd3aa41b1d21a) |
| `withdrawClaimable` | 53,249 | 0.0011 | [`0x436a0d25…`](https://explorer.testnet.arc.io/tx/0x436a0d25d21e4d11e1e2f80a083e0a41efbd3ca174ad5db0ff3d427b6116fb99) |

Deposits read from the contract on 2026-11-05 at 18:49 UTC: Seller A 0.1 USDC, Seller D 0.077, Seller E 0.077, Seller F 0.077. Each started at 0.1. The buyer withdrew 0.0345 USDC, three credits of 0.0115, in [`0x436a0d25…`](https://explorer.testnet.arc.io/tx/0x436a0d25d21e4d11e1e2f80a083e0a41efbd3ca174ad5db0ff3d427b6116fb99). Three `flushBurn` calls burned 0.0115 USDC each.

A claim at the price of 0.001 USDC costs more than the price, so the contract runs only when a delivery fails, and a verdict repays the dispute. [contracts/README.md](contracts/README.md#the-economics) has the numbers.

## How to check this, in order

With nothing installed:

1. Open the [contract](https://explorer.testnet.arc.io/address/0x20ce7bbfaf66b28cb917f9331a8960eb563f2094) on the explorer.
2. Open claim [`0xd67c5d03…`](https://explorer.testnet.arc.io/tx/0xd67c5d030004f9695035aae255e1bd66b75f8ded9a5cda6978997b4bd6ba9bf8) and answer [`0x69391c38…`](https://explorer.testnet.arc.io/tx/0x69391c38549ab90e586b012ba944feb94c4ec664852fe81941d6f894ae59d55a). The `KeyRevealed` event holds the key.
3. Open reverted answer [`0x51984021…`](https://explorer.testnet.arc.io/tx/0x51984021d48067cf593d6eef56889c5296d5e756c088fc47f16149166fbdb059). The chain refused a wrong key.
4. Open finalize [`0xc41cc0cb…`](https://explorer.testnet.arc.io/tx/0xc41cc0cb903d976d4dc18a8fa252d5730646adf962e174b64f4f6b0c76f96b93). The `Silent` event names Seller E and the 0.0115 USDC credit.
5. Run the Arkiv query further down. It returns the payment entity and the settlement entity for transfer `54df1711-eb16-4cb2-8feb-2a3636ec2675`.
6. Open the live screen, listed in the contract table. It shows receipts and checks them, and nothing on it can pay.

With a clone (commands below, results from a clean clone of commit `78fa3a9` on 2026-11-05):

7. `forge test`: 218 tests passed.
8. `bash scripts/test.sh`: 299 tests passed.
9. `npx bun run scripts/sealed-local-e2e.ts`: every scene ran against the real contract on a local anvil chain, with real signatures and with Gateway replaced by a stand-in. It printed `RESULT: all scenes as expected`.

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
SEALED_DELIVERY_ADDRESS=0x20ce7bbfaf66b28cb917f9331a8960eb563f2094 npx bun run server/index.ts
```

```bash
npx vite
```

Open http://localhost:5173. The first backend start writes fresh keys for the buyer, the hold and the sellers to `.env`, which git ignores.

To pay for real on Arc testnet:

1. Print the buyer address with `cast wallet address --private-key <BUYER_PRIVATE_KEY from .env>` and send it testnet USDC from https://faucet.circle.com.
2. Run `SEALED_DELIVERY_ADDRESS=0x20ce7bbfaf66b28cb917f9331a8960eb563f2094 npx bun run scripts/sealed-setup.ts --dry-run` to see the plan, then run it again without `--dry-run`. It sends each of Seller A, D, E and F 0.03 USDC for gas and has each deposit 0.1 USDC, so 0.52 USDC in total.
3. Set a hold on the screen, then press "Seller A, line stays up", "Try Seller A", "Try Seller B", "Try Seller D", "Try Seller E" or "Try Seller F".

The sellers close the connection on purpose, apart from the "line stays up" button.

| Optional setting | What it turns on |
|---|---|
| `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNER_KEY` | The World ID approval before a hold. Set all three or none |
| `ARKIV_WRITER_KEY`, `ARKIV_ACCESS_KEY` | The Arkiv receipts. Without them the app runs on local receipts alone |
| `PORT`, `DATA_DIR` | The backend port, 3001 by default, and its data folder |

`npx vite build` makes the published screen, which has no paying route.

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
- Brought in from before the event: `src/existing/arc-gateway.ts`, copied from the tag. Its first line says so.
- Generated by Arc Studio at commit `a6e3fa2`: the starter app. Commit `341edd6` removed the parts this project does not use.

## Receipts on Arkiv

vet402 keeps a copy of each receipt on Arkiv's Rabdi testnet, so a receipt stays readable when this app is down. The receipts page reads Arkiv directly from the browser.

Writer address: `0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5`

Print it with `npx bun run scripts/arkiv-address.ts`. The script derives the address from `ARKIV_WRITER_KEY` and never prints the key.

One query you can run. It returns the payment entity and the settlement entity for one transfer. Receipts live 30 days, so this one expires around 2026-12-05 unless somebody extends it. After that, put a transfer id from the receipts page in place of the id.

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_receipt'"'"') AND gateway_transfer_id = str('"'"'54df1711-eb16-4cb2-8feb-2a3636ec2675'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"expiresAt":true,"attributes":true}}]}'
```

Explorer: https://rabdi.explorer.arkiv.network

More in [arkiv/](arkiv/schema.md).

## World ID

The moment that needs a person is the hold. vet402 pays with my money and its keys sit on my server. The credential is Proof of Human, because the only question is whether a person, and not the agent, released the money. Nothing here needs to know who that person is.

One session is created per budget. Each hold then needs a session proof of that session, with the hold's id and amount as its signal. The backend signs each request and sends each result to World's verify endpoint before it creates a hold. It accepts a proof only if the session matches the stored one in full, the signal matches this hold, and the session nullifier has never been used. An approval made for another hold reads "Not approved: this approval is for another hold." Cancel request reads "Not approved. Nothing was held or paid."

The demo runs in World's staging Simulator and has not run in the real World App. The integration debrief is in [DEMO.md](DEMO.md#integration-debrief).

## After judging

The buyer side of this goes into vet402's production buyer, which paid through Gateway on Arc mainnet on 2026-09-28. The receipt writer keeps writing one Arkiv entity per payment on Rabdi until Arkiv announces a mainnet.

## How I used AI

Arc Studio started the app and the contract (session `mumbai`). After `arc-studio pull`, Claude Code wrote code and these documents while I set the scope and made the decisions.

## License

[MIT](LICENSE).

One payment. One receipt. Anyone can check it.
