# Swarm in vet402

vet402 keeps the evidence of every dispute on Swarm and points to it from a new Arkiv entity. When a buyer claims against a seller, the box it holds goes to Swarm. Anyone can later fetch that box, read the key from Arc and check the answer against the seller's promise, with no vet402 server in between.

## What existed before the event, and what I added

Swarm is new to vet402 at ETHGlobal Mumbai: every line of Swarm code and the Swarm dependency came in here. This repo itself started at the event (first commit `4c45218`, 2026-11-05 15:30 UTC). The Arkiv receipts (payment, settlement and seller entities) were also built here earlier in the event, in commit `7df3fb3` and after.

Everything about Swarm below is new work at ETHGlobal Mumbai, in these commits on the `swarm` branch:

| Commit | What it adds |
|---|---|
| `f4d37f7` | bee-js 13.2.0, the evidence box, and a live upload check |
| `4ce7a5b` | The Arkiv evidence entity that points a claim at its box on Swarm |
| `e20cd85` | The upload of the box right after a claim |
| `df6a886` | The published screen opens an answer from Arkiv, Swarm and Arc |
| `80a0d01` | Tests for all of the above |
| `2143ad3` | The local end to end run also keeps and opens every box through Swarm |
| `2d6d920` | Upload through your own Bee API and postage batch with `SWARM_API_URL` and `SWARM_POSTAGE_BATCH_ID`. Merged to `main` from the `swarmstamp` branch |
| `4051a5f` | Each box from my own Bee node pinned there, with its postage date on the evidence entity and on the screen. The receipts page on Swarm under one fixed feed URL (`scripts/swarm-publish.ts`) |

## What lives where

| Place | What it holds |
|---|---|
| Swarm | The box: `ciphertext`, `claimId`, `plaintextHash`, `ciphertextHash`, `contract`, `chainId`, as JSON. No key. |
| Arkiv | An entity of the new schema `vet402_evidence`: `kind` = "evidence", `claim_id`, `gateway_transfer_id`, `swarm_ref`, and `swarm_kept_until` for a box from my own Bee node. vet402 creates it and the buyer on the claim owns it. |
| Arc | The claim, and the key once the seller reveals it in the `KeyRevealed` event. |

The Swarm reference is in the field **`swarm_ref`** of the `vet402_evidence` entity. Each box is found by that reference directly. The receipts page itself goes on Swarm under a feed, described below.

The evidence entity is new. vet402 never patches an existing entity. It is written from the same single queue as the receipts, without a nonce manager, with `readonly` and `permissionlessExtension`, and it lives 30 days like a receipt. It goes out in one `executeBatch` transaction with the dispute's payment and seller entities, and in that transaction it passes to the buyer on the claim. Readers find it by `createdBy(writer)`. More in [how-you-use-arkiv.md](how-you-use-arkiv.md#the-evidence-belongs-to-the-buyer).

## Pinned on my node, with the date it is kept until

When the upload goes to my own Bee node (`SWARM_API_URL` with `SWARM_POSTAGE_BATCH_ID`), `createSwarmWire` pins the box on that node with `bee.pin.add` and reads the batch with `bee.stamp.get`. The batch's TTL, counted from the upload, becomes `swarm_kept_until` on the box's evidence entity. "Open a sealed answer" reads it from Arkiv and shows it under the seller's name:

```
Seller D
Kept on Swarm until 2026-12-13
```

The date is the batch's own: Bee works it out from the batch's balance at today's storage price, and a top up moves it later. A box that went through the public gateway shows the seller's name alone, because the gateway stamps with a batch of its own. The tests in `server/__tests__/swarmKeep.test.tsx` cover the pin, the date on the entity and both screens.

## The receipts page on Swarm under one fixed URL

`scripts/swarm-publish.ts` builds `receipts.html` and the files it loads with relative paths, uploads them to my Bee node as one collection with `receipts.html` as its index, and pins it. A feed signed with `SWARM_FEED_KEY` then points at that collection, and the feed manifest is the page's fixed address: `bzz://bffd1e6065a6b595d7540e202aac6d7bed3da69ba9abae3530af2eafafec6dd9`, and the same page at https://api.gateway.ethswarm.org/bzz/bffd1e6065a6b595d7540e202aac6d7bed3da69ba9abae3530af2eafafec6dd9/ (first published 2026-11-06 at 04:34 UTC, pinned, status 200 through the public gateway). Each later run uploads the new page and moves the feed, and the address stays the same. The page reads Arkiv straight from the browser, so the copy on Swarm shows every receipt with no vet402 server running.

```bash
npx bun run scripts/swarm-publish.ts --dry-run
SWARM_API_URL=http://127.0.0.1:1633 SWARM_POSTAGE_BATCH_ID=<your batch id> SWARM_FEED_KEY=<a key for this feed> ARKIV_WRITER_ADDRESS=<writer address> npx bun run scripts/swarm-publish.ts
```

The first line builds and lists the files. The second prints the collection, the feed owner, the fixed URL and the batch's date.

### Why the reference is not encrypted

An encrypted Swarm reference carries its decryption key, and Arkiv entities are public. vet402 therefore uploads without Swarm encryption and stores the plain 32 byte reference.

That is safe here because the box is already a ciphertext. The seller sealed the answer before vet402 ever saw it. The key that opens it is not in the box and not on Arkiv. It reaches the chain only in a dispute, when the seller answers the claim on Arc. So the reference on Arkiv points to bytes that nobody can read until the seller reveals the key, and after that the whole point is that anyone can read them.

## One entity and the box it points to

Seller A, 2026-11-06 01:42 UTC, on the live contract `0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B`. The box went up through my own Bee node with my own postage batch.

| | Value |
|---|---|
| Arkiv entity key | `0x23d6b0048670a9413f774ba86c7db4bca5acaab69a8ab6aa77496e3c0ce13f3c` |
| `claim_id` in it | `0x2c880d2b0768269fb827dca6e23aba464c5aa686f62310d4153d0971b8b582a5` |
| `gateway_transfer_id` in it | `4c985dc0-a59d-4674-9e8a-3d5d25def02b` |
| `swarm_ref` in it | `678485f34be28e46bc7791341ea987e149b38b592ff52ad9aecfa6e292696ec8` |
| Open the box | https://api.gateway.ethswarm.org/bytes/678485f34be28e46bc7791341ea987e149b38b592ff52ad9aecfa6e292696ec8 |
| The claim on Arc | [`0x1269e948…`](https://explorer.testnet.arc.io/tx/0x1269e9487f9fbe1207f1791cfdc9963bf9fb20d93854722c9f794f79c597f94b), 01:42:03 UTC |
| The key on Arc | [`0xa63eaf5a…`](https://explorer.testnet.arc.io/tx/0xa63eaf5ac05d8ebb22c1467ddc407984e92a7fe573d167f001ab403ac16117a4), `KeyRevealed` at 01:42:09 UTC |

The public gateway returned the box with status 200 on 2026-11-06 at 02:23 UTC, although my node uploaded it. Its `claimId` and `contract` match the claim transaction, and its `chainId` is 5042002. Since 2026-11-06 around 04:00 UTC each evidence entity passes to the buyer that filed the claim, so a reader finds evidence by its creator. This query returns the entity of Seller A's dispute at 04:25 UTC with its owner, the buyer `0x24abb3e0…6ba7`, and its creator, vet402's writer:

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_evidence'"'"') AND claim_id = str('"'"'0xce8ba849ddeab4b1ed2bc6fac4573f13c118e46dbadfcc848a6ea5c6662c6026'"'"') AND $creator = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"owner":true,"creator":true,"attributes":true}}]}'
```

It answered key `0x77e1831f5cd82387319e35417d145662bebc76bcf519d2c32900860d6265f003`, owner `0x24abb3e04a7b73426f30369ea6fc36f89d3d6ba7` and creator `0x4eea8eddcc608cbd8b3683f738a473923f2de4c5` on 2026-11-06 at 04:38 UTC.

The boxes of the seven other disputes on this contract that day went up the same way: Seller F, E and D from 01:42 to 01:45 UTC, and Seller A, F, E and D from 01:59 to 02:02 UTC. My node lists an upload tag for each of the eight boxes, from 01:42:05 to 02:02:35 UTC, every chunk synced. The public gateway returned each box with status 200 at 02:23 UTC:

- https://api.gateway.ethswarm.org/bytes/35f6fbb546122abef6e34da823a2912ea79fd04ae66ddb29ccedd44a011fbd28
- https://api.gateway.ethswarm.org/bytes/2a8bf0d7f2369652f787ee3f92d5f54546b24646fefd87d47dd61225bce83b12
- https://api.gateway.ethswarm.org/bytes/19dfd43783e2e309273cbf00efd432bd5e7915ee906df7628453c422d0a4a5ed
- https://api.gateway.ethswarm.org/bytes/8b5135d8023faa2ad42f54ed389ef9d0eaa7aa1265d2218fe318769561a5fb7e
- https://api.gateway.ethswarm.org/bytes/8109114001313445e30688118ea3d5244f7461636854bf96897e223dff33e5f8
- https://api.gateway.ethswarm.org/bytes/07cf85b947baaeebeed763937f89c868d2e39fb15dd1d8d8180db15818cb503a
- https://api.gateway.ethswarm.org/bytes/6fece4c29d688611fd23bedf4830328f502270cddb40dea623aa8948eb53d20d

On the earlier contract `0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5`, the run of 2026-11-05 from 23:11 to 23:16 UTC also went through my node, and Seller A's box of that run is https://api.gateway.ethswarm.org/bytes/bb095832b29db08053c5506b49c33dd3d45d40cd5d48c2903cdb8f9970a9eaa0. The filmed run of 22:40 to 22:46 UTC came before I had a batch. Its boxes went through the public gateway with bee-js's `NULL_STAMP`, as described below.

A box from the live check (`scripts/swarm-live.ts`, 2026-11-05 UTC), not tied to an entity, to show the read works:
https://api.gateway.ethswarm.org/bytes/b9e5a7f642e46a03ab213b7446b93698da4a71e651f6e8bce5e9d35f9ad4c712

## Postage stamp, wallet and node

- **Node:** my own Bee 2.8.3 light node, with its API at `127.0.0.1:1633` on my machine. The server reaches it through bee-js 13.2.0 when `SWARM_API_URL` points there.
- **Wallet:** the node's own address on Gnosis Chain, `0x8620Bd0D7b9C1Cd5eCa426B639F2e38ba5FEdb94`. I funded it with xDAI and xBZZ through https://fund.ethswarm.org, and the node bought the batch itself.
- **Batch ID:** `b6455d939e16dd59c5295e70b8123fe8412e224614eec41aeee0c3d3e5ecf9c0`, depth 17, amount 95011833600 per chunk, immutable.
- **Purchase:** Gnosis Chain transaction `0xca6451b9425077d4a0a15fb588bd2c7a13fc83659dd823a71e59cbc9ac1cba12`, block 49129674, 2026-11-05 22:53 UTC, sent by the node's wallet to the Swarm postage stamp contract `0x45a1502382541cd610cc9068e88727426b696293`, which emitted `BatchCreated` for this batch.
- **Lifetime:** `GET /stamps/<batch>` on my node answered `batchTTL` 2360122 s on 2026-11-05 at 23:24 UTC. The node's wallet topped the batch up on 2026-11-06 at 00:48 UTC (Gnosis transaction `0xd5e201d84908f7ccbc65e40e73b7400383e781020c4dddb8bccb3c21622b49e9`, `BatchTopUp`), and at 04:35 UTC the node answered amount 129774355200 and `batchTTL` 3204665 s, so the batch keeps its boxes until 2026-12-13.
- **Code:** `SWARM_API_URL` names the Bee API and `SWARM_POSTAGE_BATCH_ID` the batch it stamps with (commit `2d6d920`). Without them the upload goes to the public gateway at `https://api.gateway.ethswarm.org` with bee-js's `NULL_STAMP` (64 zeros), and the gateway stamps it with a batch of its own.

Which boxes went which way:

| Run | Upload path | Stamp |
|---|---|---|
| 2026-11-05 22:40 to 22:46 UTC, earlier contract `0xa1eff55d…` | The public gateway | The gateway's own batch, through `NULL_STAMP` |
| 2026-11-05 23:11 to 23:16 UTC, earlier contract `0xa1eff55d…` | My Bee node | `b6455d93…` |
| 2026-11-06 01:42 to 01:46 UTC and 01:59 to 02:04 UTC, live contract `0xE9C35ad2…` | My Bee node | `b6455d93…`, the only batch on the node |
| 2026-11-06 04:17 UTC, live contract `0xE9C35ad2…`, the run in the demo video at 3:18: Seller A's claim [`0x91a2b636…`](https://explorer.testnet.arc.io/tx/0x91a2b636d53a27c98c2abdc2360a9ecb35a5b3a4128adf2f8c6f374b9b7f44c7) for claim id `0x0cf117a0…`, answered through Arc Memo in [`0x398f28ee…`](https://explorer.testnet.arc.io/tx/0x398f28ee3970e29fc0255748ce8e845ba6709863d7a78a469080fb190164f5e2) | My Bee node. Its evidence entity `0x3ec3e34c…` holds `swarm_ref` `4a8c0fce…` and `swarm_kept_until` 2026-12-13, which only an upload through my node carries (Arkiv and Arc read on 2026-11-06 at 09:59 UTC) | `b6455d93…` |
| "Try a dispute yourself" on the public deploy (`api/try-dispute`) | The public gateway | The gateway's own batch, through `NULL_STAMP` |

The public deploy on Vercel puts each claimed box on Swarm through the public gateway with the null stamp, and writes the evidence entity that points to it, with `ARKIV_WRITER_KEY` set on the deploy. A null stamp upload through the gateway answered on 2026-11-06 at 03:03 UTC with reference `c171583664857b5f0dc77e8f5160112169afb16c19022390a70e37368c02874b`, and the gateway returned the same 427 bytes.

## Files that upload to Swarm and read from it

| File | What it does |
|---|---|
| `src/lib/swarmBox.ts` | `createSwarmWire` uploads and downloads with bee-js (`bee.data.upload`, `bee.data.download`). With my own batch it also pins each box (`bee.pin.add`) and records the batch's date (`bee.stamp.get`). `readBox` only accepts a box for the expected claim, contract and chain whose ciphertext matches its hash. |
| `server/swarm.ts` | Builds the box from the claim and uploads it. |
| `server/demo.ts` | Starts the upload right after the claim and puts the reference on the receipt row. A failed upload only logs. |
| `server/tryDisputeWire.ts` | The public try's uploader and Arkiv writer, built only when the deploy holds `ARKIV_WRITER_KEY`. It always uses the public gateway. |
| `server/arkiv.ts` | Writes the `vet402_evidence` entity once the payment has its Gateway transfer id, in one transaction with the payment and the seller, and hands it to the buyer on the claim. |
| `src/arkiv/schema.ts` | The `vet402_evidence` schema. |
| `src/arkiv/readArkiv.ts` | `createEvidenceLister` reads every `vet402_evidence` entity the writer created, with its owner and its Swarm date, and `createEvidenceReader` reads `swarm_ref` for one claim, both from Arkiv's public RPC by `createdBy`. |
| `src/lib/openSealed.ts` | `openableAnswers` builds the list from the evidence entities. `openFromRecord`: Arkiv, then Swarm, then the key from Arc, then the match. There is no fallback. |
| `src/components/OpenSealed.tsx` | "Open a sealed answer" on the published screen, with "Kept on Swarm until {date}" under a box from my own Bee node. |
| `scripts/swarm-live.ts` | One upload and one read on the real network. It reads `SWARM_API_URL` and `SWARM_POSTAGE_BATCH_ID` as the server does. |
| `scripts/swarm-publish.ts` | The receipts page as one collection on my Bee node, behind a feed manifest that keeps one bzz URL. |

## Run one upload and one read yourself

You need Node and network access. No key, no wallet and no stamp. Without the two variables the upload goes through the public gateway and its null stamp.

```bash
npx bun run scripts/swarm-live.ts
```

With your own Bee node and batch, the upload goes there, and the read still goes through the public gateway, to show that anyone can fetch the box:

```bash
SWARM_API_URL=http://127.0.0.1:1633 SWARM_POSTAGE_BATCH_ID=<your batch id> npx bun run scripts/swarm-live.ts
```

You should see a reference, a link you can open, and the last line:

```
RESULT: read back the same box
```

To see the whole path on the published screen:

1. Build with the writer address: the build derives it from `ARKIV_WRITER_KEY`, or takes `ARKIV_WRITER_ADDRESS`, and only the address enters the bundle.
2. Open the page. "Open a sealed answer" lists the claims that have a `vet402_evidence` entity on Arkiv. The exported file adds only each claim's seller name and the block that holds its key. It holds no box: no ciphertext and no plaintext hash.
3. Press **Open**. The screen shows one line for each source it read, then the result:

```
Record from Arkiv.
Box from Swarm.
Key from Arc.
Matches the seller's promise.
```

Swarm is required. There is no copy on the page to open instead, so when a source fails the answer does not open, and the last line says which one:

| What failed | The line |
|---|---|
| Swarm did not return the box | Box not found on Swarm. |
| Arkiv has no evidence entity for the claim | No record on Arkiv for this claim. |
| Arkiv could not be read, or the build has no writer address | Could not read Arkiv. |
| The box from Swarm is for another claim, contract or chain, or its ciphertext is not the one claimed on Arc | This box is not the one claimed on Arc. |

## Swarm in the demo video

From 3:18.2 on the public page: Seller A's box from claim `0x0cf117a0…` (2026-11-06 04:17 UTC) shows "Kept on Swarm until 2026-12-13" under the seller's name, and opening it reads "Record from Arkiv." "Box from Swarm." "Key from Arc." and "Matches the seller's promise." That box went up through my own Bee node with batch `b6455d93…` and is pinned there. At 3:22.8 another Seller A box opens to "Matches the seller's promise." and a Seller F box to "Does not match the seller's promise."

Every box of the 2026-11-06 runs that vet402's own sellers sealed went up through my own Bee node with batch `b6455d93…`, listed above.

## What would make Swarm even better

- **The new `bee.data` calls in the migration notes.** bee-js 13 moved the raw data calls under `bee.data`. I first looked for `uploadData` in the types. The current call is `bee.data.upload(batchId, data)`, and a line in the migration notes would point straight to it.
- **The gateway's batch on request.** `GET /stamps` on the public gateway returned 404 on 2026-11-05 UTC, while my own node answers `GET /stamps/<batch>` with the depth, the amount and the TTL. The same answer from the gateway would let a null stamp upload show its lifetime too.
- **A slimmer browser build.** bee-js took the published page's main script from 367 kB to 447 kB before compression in my build. A smaller entry point for upload and download alone would keep pages light.
- **One build warning less.** The copy of zod that bee-js brings along prints a Rollup warning about a comment it cannot place. The build succeeds, and a bundled zod without that comment would make the output clean.
