# Friction

I am the builder of vet402, and I used Arkiv (`@arkiv-network/sdk@1.0.1` on Rabdi) to write one readonly receipt per payment, one seller entity that expires 7 days after the seller's last delivery, one readonly ruling per Arc verdict and one evidence entity per dispute that passes to its buyer, at ETHGlobal Mumbai between 2026-11-05 15:30 UTC and 2026-11-06 04:40 UTC. Each suggestion below says what would make Arkiv even better, with what I expected, what came back and how to reproduce it.

## What worked well

- **The readonly refusal explains itself.** When vet402's own writer key tried to patch a readonly receipt, the SDK answered "entity … was created readonly, so its contents can never change. Its expiry can still be extended, and it can be transferred or deleted". It names the rule and what is still allowed, so the live check could assert it as is.
- **Type errors point at the column.** A bare bigint for a u64 column fails the type check at `createEntity`, and the compiler message named the column. Wrapping it in `u64(value)` took a minute.
- **The node lists what it accepts.** A stray `key` next to `select` in a hand written `arkiv_query` came back as `unknown field`, with the allowed fields listed in the same answer.
- **The README covers paging well.** It shows `limit` with `offset`, and paging by key with `gt("$key", key(lastKey))` for readers that run while others write. vet402 now pages with `asc("$key")` and an offset.
- **Readonly with permissionless extension fits a receipt.** Anyone can keep a vet402 receipt alive if vet402 stops, and nobody, vet402 included, can change it.

## What would make it even better

1. **The access key in a header.** On 2026-11-05 before 16:24 UTC I called Rabdi with a wrong access key on purpose. The 401 error's `message` held the full RPC URL with the key in its path, and `shortMessage` held the clean text. To reproduce, build the chain with `rabdi({ accessKey: "wrong" })`, make any read, and print `error.message`. vet402 logs only `shortMessage`, with known secrets removed. Carrying the key in a header would keep it out of every app's logs at once.
   To see it in one command: `npx bun run scripts/arkiv-401.ts`. With a made-up key, on 2026-11-06 at 08:15 UTC it printed `error.message holds the key: true`, `shortMessage holds the key: false`, and this masked message:
   ```
   HTTP request failed.

   Status: 401
   URL: https://rpc.rabdi.db-chain.testnet.arkiv.network/<access key>
   ```
2. **A timestamp next to the block.** On 2026-11-05 before 16:24 UTC, `$createdAt` read back as a block number, such as 544, and "older than 60 seconds" came from that number, the current block and the block duration from `getBlockTiming`. A timestamp field on the entity would make it one read.
3. **Sorting by `$createdAt`.** On 2026-11-06 before 01:04 UTC I wanted the newest ruling and the oldest payment for a seller as one row each. The README notes "$createdAt cannot be sorted on", so vet402 reads every page and compares the blocks. Sorting by creation, even by block, would make "latest" a single query.
4. **A pointer to `withCount()` in the paging section.** On 2026-11-06 before 01:04 UTC a reader that asked for one page with `limit(100)`, the node's maximum, showed 100 of 105 receipts. To reproduce, write 101 entities under one schema and read them with `limit(100)`. vet402 pages to the end (commit `c4b0dfe`). `withCount()` in the SDK's type definitions returns the total, and one line about it in the README's paging section would make the last page obvious at a glance.
5. **One README sentence on `extendEntity`.** On 2026-11-06 at 01:46 UTC the live check (`npx bun run scripts/arkiv-live.ts`, step 3) extended a seller entity by its lifetime and printed "seller expiry block 271940 to 271946. Sent at block 271912, landed by 271916, lifetime 32 blocks, so the expiry was set from the landing block, not 271972". I had expected 271972, the old expiry plus the lifetime, and found the rule in a comment in the SDK's type definitions. The sentence "an extension sets the expiry to the landing block plus the duration" in the README would answer it right away.
6. **A short reference for the raw query options.** On 2026-11-05 before 16:24 UTC I wrote `arkiv_query` by hand for the README's curl example. The node answered `unknown field` to my first try, with the allowed fields listed, and I read the shape of the options from the SDK source. A short table of the `arkiv_query` parameters next to the query builder docs would make hand written queries quick.
7. **A quiet mode for the public endpoint notice.** On 2026-11-05 before 16:24 UTC, `rabdi({ accessKey: "" })` printed "Rabdi: no access key, so requests go to the public endpoint, which is heavily rate limited." once per process, including every test run. An option to silence it in tests, and the limit's numbers in the notice, would make it even more useful.

8. **A note on `createdBy` next to `changeOwnership`.** On 2026-11-06 around 04:00 UTC vet402 began passing each evidence entity to the buyer that filed the claim. A reader that filters with `ownedBy(writer)` then stops seeing those entities, which is right, and `createdBy(writer)` keeps finding them. vet402's readers use `createdBy` for evidence and `ownedBy` for rulings. One sentence in the ownership section, saying that `$creator` stays fixed while `$owner` moves, would point a builder to the right filter. The query below shows both on one entity.
9. **`predictEntityKeys` beside `executeBatch` in the README.** vet402 writes the payment, seller and evidence entities of a dispute in one `executeBatch`, and passes the evidence to the buyer in the same transaction, with its key from `predictEntityKeys`. Another write from the same account between the prediction and the batch moves the keys, so vet402 sends the batch again without the handover and calls `changeOwnership` after it (server/arkiv.ts, test K1 in `server/__tests__/arkivBatch.test.ts`). An example of the two together in the README, with a line on when a prediction holds, would save that test.

## The one change with the biggest effect

Carry the access key in a header instead of the RPC URL. It keeps the key out of every app's logs at once, with no change in the apps.

Live run on the event network: `npx bun run scripts/arkiv-live.ts` passed every check on Rabdi on 2026-11-05.
