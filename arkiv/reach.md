# Reach

Measured from the writer's entities on Rabdi with `arkiv_query`, `count: true` and the writer filter `$owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)`. Each row adds one condition to `arkiv.schema = str('vet402_receipt')` or names another schema. The node answered at block 270253, on 2026-11-06 at 00:51 UTC. A full read of every receipt page at 00:51 UTC returned the same 105.

| What | Query condition | Count |
|---|---|---|
| Payment entities | `kind = str('payment')` | 54 |
| Settlement entities | `kind = str('settlement')` | 51 |
| All receipt entities | none | 105 |
| Seller entities alive | `arkiv.schema = str('vet402_seller')` | 4 |
| Evidence entities | `arkiv.schema = str('vet402_evidence')` | 11 |
| Verdict entities | `arkiv.schema = str('vet402_verdict')` | 0 |

The 54 payments by seller: Seller A 17, Seller B 9, Seller C 1, Seller D 7, Seller E 7, Seller F 8, Quicknode 4, BotPay 1. The 51 settlements are the same sellers less Seller C and two of Seller A's. None of the 105 carries `pay_to` yet, and none is a live check row. The 4 live seller entities are Seller A, Seller F, BotPay and Quicknode.

Before this change, the receipts page asked for one page of 100 and got 100 of the 105, so 5 receipts never reached the screen. It now reads every page.

## Who uses it

These were measured earlier in the event and keep their times.

At 2026-11-05 18:49 UTC, vet402 is the only buyer: all 15 recorded payments, and every Gateway transfer to the six demo sellers, come from its hold wallet. It is ERC-8004 agent 9907, and its earlier receipts are public at https://kzmttkc.github.io/arc-delivery-receipts/.

Every payment since 2026-11-05 17:49 UTC has a receipt on Arkiv that anyone reads on the receipts page, 11 of 11 at that time. The 4 payments before it, from 16:03 to 16:04 UTC, have none.

The delivery check has used these entities once. On 2026-11-05 at 18:38 UTC vet402 paid Seller C. About 100 s later, with Seller C's short demo lifetime over, it refused Seller C and offered the next listing, BotPay, which I did not pay.

## After Mumbai

The writer keeps running on Rabdi. These are the steps, each with the check that shows it is done.

1. Keep the judged receipts readable. The first receipts expire around 2026-12-05. Before then I extend the entities that README.md and swarm.md link to, with `extendEntity`, and the README query shows the later `expiresAt`.
2. Wire the payTo address and the rulings into the production buyer, so every new payment, seller and ruling entity carries `pay_to`. The check is a count of `pay_to` entities above 0 in this table.
3. Move to an Arkiv mainnet when `@arkiv-network/sdk` ships a mainnet chain next to `rabdi`. The chain is named in three places: `server/arkiv.ts`, `src/arkiv/readArkiv.ts` and `scripts/arkiv-live.ts`. I switch all three, run `scripts/arkiv-live.ts` against the new chain until every step passes, and put the new writer address and RPC URL in README.md. Rabdi receipts stay where they are until they expire.

Who else can read this: anybody. The receipts page and the query need no account and no key from vet402.
