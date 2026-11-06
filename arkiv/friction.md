# Friction

I am the builder of vet402, and I used Arkiv (`@arkiv-network/sdk@1.0.1` on Rabdi) to write one readonly receipt per payment and one seller entity that expires 7 days after the seller's last delivery, at ETHGlobal Mumbai between 2026-11-05 15:30 UTC and 2026-11-06 01:50 UTC. Each item below answers two questions: what got in my way or is missing, and, when something broke, what I expected, what happened and how to reproduce it.

## What worked well

- **The readonly refusal explains itself.** When vet402's own writer key tried to patch a readonly receipt, the SDK answered "entity … was created readonly, so its contents can never change. Its expiry can still be extended, and it can be transferred or deleted". It names the rule and what is still allowed, so the live check could assert it as is.
- **Type errors point at the column.** A bare bigint for a u64 column fails the type check at `createEntity`, and the compiler message named the column. Wrapping it in `u64(value)` took a minute.
- **The node lists what it accepts.** A stray `key` next to `select` in a hand written `arkiv_query` came back as `unknown field`, with the allowed fields listed in the same answer.
- **The README covers paging well.** It shows `limit` with `offset`, and paging by key with `gt("$key", key(lastKey))` for readers that run while others write. vet402 now pages with `asc("$key")` and an offset.
- **Readonly with permissionless extension fits a receipt.** Anyone can keep a vet402 receipt alive if vet402 stops, and nobody, vet402 included, can change it.

## Where I lost time

1. **The access key can land in logs.** On 2026-11-05 before 16:24 UTC I called Rabdi with a wrong access key on purpose. I expected an error without the key in it. I got a 401, and the error's `message` held the full RPC URL with the key in its path, while `shortMessage` did not. To reproduce, build the chain with `rabdi({ accessKey: "wrong" })`, make any read, and print `error.message`. vet402 now logs only `shortMessage`, with known secrets removed. Sending the key in a header instead of the URL would remove the risk for every app.
2. **Age is in blocks.** On 2026-11-05 before 16:24 UTC, `$createdAt` read back as a block number, such as 544. "Older than 60 seconds" takes that number, the current block and the block duration from `getBlockTiming`. A timestamp field on the entity would save the extra call.
3. **`$createdAt` cannot be sorted.** On 2026-11-06 before 01:04 UTC I wanted the newest ruling and the oldest payment for a seller as one row each. The README says so in its own example: "$createdAt cannot be sorted on". I read every page and compare the blocks myself. Sorting by creation, even only by block, would make "latest" a single query.
4. **A page of exactly 100 gives no sign that more exist.** On 2026-11-06 before 01:04 UTC my first reader asked for one page with `limit(100)`, the node's maximum. With 105 receipts on Rabdi it showed 100 and dropped 5, with no error. To reproduce, write 101 entities under one schema and read them with `limit(100)`. The fix on my side was to page to the end (commit `c4b0dfe`). Later I found `withCount()` in the SDK's type definitions, which returns the total, but the README's paging section does not mention it. One line about `withCount()` there, or a warning when a page comes back full at the maximum, would make the last page obvious.
5. **An extension sets the expiry, it does not add to it, and the README does not say so.** On 2026-11-06 at 01:46 UTC the live check (`npx bun run scripts/arkiv-live.ts`, step 3) extended a seller entity by its lifetime and printed "seller expiry block 271940 to 271946. Sent at block 271912, landed by 271916, lifetime 32 blocks, so the expiry was set from the landing block, not 271972". I expected 271972, the old expiry plus the lifetime. The README has no section on `extendEntity`, and I found the rule in a comment in the SDK's type definitions. One sentence in the README, "an extension sets the expiry to the landing block plus the duration", would answer it.
6. **The raw query options have no short reference.** On 2026-11-05 before 16:24 UTC I wrote `arkiv_query` by hand for the README's curl example. The node answered `unknown field` to my first try, and I read the shape of the options from the SDK source because the README covers only the query builder. A short table of the `arkiv_query` parameters would save that.
7. **Without an access key the public endpoint is heavily limited, and the warning prints in every process.** On 2026-11-05 before 16:24 UTC, `rabdi({ accessKey: "" })` printed "Rabdi: no access key, so requests go to the public endpoint, which is heavily rate limited." once per process, so it shows up in every test run too. A way to silence it in tests, and the limit's numbers in the warning, would help.

## The one change with the biggest effect

Send the access key in a header instead of the RPC URL. Every app that logs an RPC error today can leak its key, and the fix on the SDK side protects all of them at once.

Live run on the event network: `npx bun run scripts/arkiv-live.ts` passed every check on Rabdi on 2026-11-05.
