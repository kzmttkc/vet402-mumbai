# Friction

Only what I hit while building this at ETHGlobal Mumbai, November 2026, on `@arkiv-network/sdk@1.0.1` and Rabdi.

* **The access key can land in logs.** The key sits in the RPC URL. I sent a bad key on purpose and got a 401, and the error's `message` held the full URL with the key in it. Its `shortMessage` did not. vet402 logs only `shortMessage`, with known secrets removed. A setting that sends the key in a header would remove this risk.
* **Age is in blocks.** `$createdAt` reads back as a block number, such as 544. "Older than 60 seconds" takes that number, the current block and the block duration from `getBlockTiming`. A timestamp field on the entity would save the extra call.
* **Numbers need a wrapper.** A bare bigint for a u64 column fails the type check at `createEntity`. It has to be `u64(value)`. The compiler message pointed at the column clearly, so this cost a minute.
* **The raw query options reject a stray field.** My first hand-written `arkiv_query` carried an extra `key` next to `select`, and the node answered with `unknown field`. The answer listed the allowed fields, which made it quick to fix. I read the shape of the request from the SDK source, because I did not find a short reference for it.
* **A warning on every run.** `rabdi({ accessKey: "" })` prints a rate limit warning once per process, so it shows up in test output too.

* **One page holds 100.** `limit(100)` is the node's maximum, and my first reader asked for one page. With 105 receipts on Rabdi the page showed 100 and dropped 5 without any error. Paging takes `orderBy(asc("$key"))`, an offset, and the page's `skipped` count added to that offset. A cursor or a total next to each page would make the last page obvious.
* **`$createdAt` cannot be sorted or filtered.** I wanted the newest ruling and the oldest payment for a seller as one row each. The SDK lists `$createdAt` as a result field only, so I read every page and compare the blocks myself.
* **An extension sets, it does not add.** `extendEntity` with seven days means seven days from the block it lands in, and the engine refuses one that would end earlier. The SDK source says so in its comments. The README did not, so I checked the source and added a step to the live check that measures it.

Live run on the event network: `npx bun run scripts/arkiv-live.ts` passed every check on Rabdi on 2026-11-05.
