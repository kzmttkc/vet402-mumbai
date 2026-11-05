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

| | Value |
|---|---|
| Arkiv entity key | {{TODO: fill in after the real run on Rabdi}} |
| `swarm_ref` in it | {{TODO}} |
| Open the box | `https://api.gateway.ethswarm.org/bytes/{{TODO}}` |

A box from the live check (`scripts/swarm-live.ts`, 2026-11-06), not tied to an entity, to show the read works:
https://api.gateway.ethswarm.org/bytes/b9e5a7f642e46a03ab213b7446b93698da4a71e651f6e8bce5e9d35f9ad4c712

## Postage stamp, wallet and node

- **Service:** the public Swarm gateway at `https://api.gateway.ethswarm.org`, through bee-js 13.2.0. This is the gateway bee-js exports as `SWARM_GATEWAY_URL`.
- **Batch ID:** I did not buy a batch. bee-js sends its `NULL_STAMP` (64 zeros) and the gateway stamps the upload with a batch of its own. The batch belongs to the gateway, and I could not read its ID. The gateway answers `GET /stamps` with 404 (checked 2026-11-06), and the upload response carries only the reference and a tag number.
- **Wallet that bought it:** not mine. It is whoever runs the gateway's batch.
- Pointing `SWARM_API_URL` at your own Bee node uploads through that node instead, with no code change.

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

You need Node and network access. No key, no wallet and no stamp.

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
- The gateway does not say which batch it stamped with. `GET /stamps` returns 404, so I cannot give a batch ID.
- bee-js made the published page's main script larger, from 367 kB to 447 kB before compression in my build.
- The build prints a warning from the copy of zod that bee-js brings along, about a comment Rollup cannot place. The build still succeeds.
