# Swarm in vet402

vet402 keeps the evidence of every dispute on Swarm and points to it from a new Arkiv entity. When a buyer claims against a seller, the box it holds goes to Swarm. Anyone can later fetch that box, read the key from Arc and check the answer against the seller's promise, with no vet402 server in between.

## What existed before the event, and what I added

Before ETHGlobal Mumbai, vet402 did not use Swarm at all. There was no Swarm code and no Swarm dependency. This repo itself started at the event (first commit `4c45218`, 2026-11-05 15:30 UTC). The Arkiv receipts (payment, settlement and seller entities) were also built here earlier in the event, in commit `7df3fb3` and after.

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

## What lives where

| Place | What it holds |
|---|---|
| Swarm | The box: `ciphertext`, `claimId`, `plaintextHash`, `ciphertextHash`, `contract`, `chainId`, as JSON. No key. |
| Arkiv | An entity of the new schema `vet402_evidence`: `kind` = "evidence", `claim_id`, `gateway_transfer_id`, `swarm_ref`. |
| Arc | The claim, and the key once the seller reveals it in the `KeyRevealed` event. |

The Swarm reference is in the field **`swarm_ref`** of the `vet402_evidence` entity. vet402 uses no feed.

The evidence entity is new. vet402 never patches an existing entity. It is written from the same single queue as the receipts, without a nonce manager, with `readonly` and `permissionlessExtension`, and it lives 30 days like a receipt.

### Why the reference is not encrypted

An encrypted Swarm reference carries its decryption key, and Arkiv entities are public. vet402 therefore uploads without Swarm encryption and stores the plain 32 byte reference.

That is safe here because the box is already a ciphertext. The seller sealed the answer before vet402 ever saw it. The key that opens it is not in the box and not on Arkiv. It reaches the chain only in a dispute, when the seller answers the claim on Arc. So the reference on Arkiv points to bytes that nobody can read until the seller reveals the key, and after that the whole point is that anyone can read them.

## One entity and the box it points to

Seller A, 2026-11-05 23:11 UTC, on the live contract `0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5`. The box went up through my own Bee node with my own postage batch.

| | Value |
|---|---|
| Arkiv entity key | `0x0c8a2ee0a536c341398f2f0dbd4b0006c1e578d943249b3bb84e7d5494c66162` |
| `claim_id` in it | `0x7eeb3f36efec914a69c0d49320ec6724bed39a1e55f65b8e56a5bd275051fe62` |
| `gateway_transfer_id` in it | `2db76ef8-52a2-4548-bbb6-3bdbc943aad9` |
| `swarm_ref` in it | `bb095832b29db08053c5506b49c33dd3d45d40cd5d48c2903cdb8f9970a9eaa0` |
| Open the box | https://api.gateway.ethswarm.org/bytes/bb095832b29db08053c5506b49c33dd3d45d40cd5d48c2903cdb8f9970a9eaa0 |
| The claim on Arc | [`0xca9db10c…`](https://explorer.testnet.arc.io/tx/0xca9db10caa096dc345a90e92a03d5e9f3c884ca7b8e6af3714c48e0a52b04ee4), 23:11:01 UTC |
| The key on Arc | [`0x0f6752e5…`](https://explorer.testnet.arc.io/tx/0x0f6752e5cabab8a243601cc6b79d93fbd6c1490cff61174a4a7beb3344557c95), `KeyRevealed` at 23:11:04 UTC |

The public gateway returned the box with status 200 on 2026-11-05 at 23:24 UTC, although my node uploaded it. Its `claimId` and `contract` match the claim transaction, and its `chainId` is 5042002. The same query that README.md uses for receipts returns this entity with `vet402_evidence` in place of `vet402_receipt`.

The boxes of the three other disputes in that run, Seller E at 23:15, Seller D at 23:16 and Seller F at 23:16 UTC, went up the same way. My node lists an upload tag for each of the four boxes, from 23:11:02 to 23:16:40 UTC, every chunk synced. The public gateway returned each box with status 200 at 23:24 UTC:

- https://api.gateway.ethswarm.org/bytes/2a12ecc1691996d7d0af105e53b5b6ad4ff9dc99dfec72c4919fb7e2153eb3e5
- https://api.gateway.ethswarm.org/bytes/4d4a9e9c95662d123e69c6634405861460446d7ea2941bea9db9d6561aaf0840
- https://api.gateway.ethswarm.org/bytes/82cd27c6378f1020b0d24bb6198770f00f187b498192f1fcade04728b0688103

The filmed run, 22:40 to 22:46 UTC, came before I had a batch. Its boxes went through the public gateway with bee-js's `NULL_STAMP`, as described below.

A box from the live check (`scripts/swarm-live.ts`, 2026-11-05 UTC), not tied to an entity, to show the read works:
https://api.gateway.ethswarm.org/bytes/b9e5a7f642e46a03ab213b7446b93698da4a71e651f6e8bce5e9d35f9ad4c712

## Postage stamp, wallet and node

- **Node:** my own Bee 2.8.3 light node, with its API at `127.0.0.1:1633` on my machine. The server reaches it through bee-js 13.2.0 when `SWARM_API_URL` points there.
- **Wallet:** the node's own address on Gnosis Chain, `0x8620Bd0D7b9C1Cd5eCa426B639F2e38ba5FEdb94`. I funded it with xDAI and xBZZ through https://fund.ethswarm.org, and the node bought the batch itself.
- **Batch ID:** `b6455d939e16dd59c5295e70b8123fe8412e224614eec41aeee0c3d3e5ecf9c0`, depth 17, amount 95011833600 per chunk, immutable.
- **Purchase:** Gnosis Chain transaction `0xca6451b9425077d4a0a15fb588bd2c7a13fc83659dd823a71e59cbc9ac1cba12`, block 49129674, 2026-11-05 22:53 UTC, sent by the node's wallet to the Swarm postage stamp contract `0x45a1502382541cd610cc9068e88727426b696293`, which emitted `BatchCreated` for this batch.
- **Lifetime:** `GET /stamps/<batch>` on my node answered `batchTTL` 2360122 s on 2026-11-05 at 23:24 UTC, so the batch lasts until about 2026-12-03 07:00 UTC unless I top it up.
- **Code:** `SWARM_API_URL` names the Bee API and `SWARM_POSTAGE_BATCH_ID` the batch it stamps with (commit `2d6d920`). Without them the upload goes to the public gateway at `https://api.gateway.ethswarm.org` with bee-js's `NULL_STAMP` (64 zeros), and the gateway stamps it with a batch of its own. That batch belongs to the gateway, and its ID is not visible from outside.

Which boxes went which way, all on 2026-11-05:

| Run | Upload path | Stamp |
|---|---|---|
| The filmed run, 22:40 to 22:46 UTC | The public gateway | The gateway's own batch, through `NULL_STAMP` |
| The second run, 23:11 to 23:16 UTC | My Bee node | `b6455d93…` |

## Files that upload to Swarm and read from it

| File | What it does |
|---|---|
| `src/lib/swarmBox.ts` | `createSwarmWire` uploads and downloads with bee-js (`bee.data.upload`, `bee.data.download`). `readBox` only accepts a box for the expected claim, contract and chain whose ciphertext matches its hash. |
| `server/swarm.ts` | Builds the box from the claim and uploads it. |
| `server/demo.ts` | Starts the upload right after the claim and puts the reference on the receipt row. A failed upload only logs. |
| `server/arkiv.ts` | Writes the `vet402_evidence` entity once the payment has its Gateway transfer id. |
| `src/arkiv/schema.ts` | The `vet402_evidence` schema. |
| `src/arkiv/readArkiv.ts` | `createEvidenceReader` reads `swarm_ref` for a claim from Arkiv's public RPC. |
| `src/lib/openSealed.ts` | `openFromRecord`: Arkiv, then Swarm, then the key from Arc, then the match. |
| `src/components/OpenSealed.tsx` | "Open a sealed answer" on the published screen. |
| `scripts/swarm-live.ts` | One upload and one read on the real network. |

## Run one upload and one read yourself

You need Node and network access. No key, no wallet and no stamp. The script always uses the public gateway.

```bash
npx bun run scripts/swarm-live.ts
```

You should see a reference, a link you can open, and the last line:

```
RESULT: read back the same box
```

To see the whole path on the published screen:

1. Build with the writer address: the build derives it from `ARKIV_WRITER_KEY`, and only the address enters the bundle.
2. Open the page and press **Open** under "Open a sealed answer".
3. The screen shows one line for each source it read, then the result:

```
Record from Arkiv.
Box from Swarm.
Key from Arc.
Matches the seller's promise.
```

If Arkiv or Swarm cannot be read, the screen opens the copy in the exported file and shows only the lines it did read.

## Swarm in the demo video

{{TODO: the moment in the video where Swarm is used}}

## What got in my way

- bee-js 13 moved the raw data calls under `bee.data`. I first looked for `uploadData` in the types and it was not there. The current call is `bee.data.upload(batchId, data)`.
- The public gateway does not say which batch it stamped with. `GET /stamps` there returned 404 on 2026-11-05 UTC. My own node answers `GET /stamps/<batch>` with the depth, the amount and the TTL.
- bee-js made the published page's main script larger, from 367 kB to 447 kB before compression in my build.
- The build prints a warning from the copy of zod that bee-js brings along, about a comment Rollup cannot place. The build still succeeds.
