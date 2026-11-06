# Reach

Measured from the writer's entities on Rabdi with `arkiv_query`, reading every page of 100, and the writer filter `$owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)`. Each row adds one condition to `arkiv.schema = str('vet402_receipt')` or names another schema.

| What | Query condition | Count |
|---|---|---|
| Payment entities | `kind = str('payment')` | 74 |
| Settlement entities | `kind = str('settlement')` | 66 |
| All receipt entities | none | 140 |
| Seller entities alive | `arkiv.schema = str('vet402_seller')` | 6 |
| Evidence entities | `arkiv.schema = str('vet402_evidence')`, with `$creator` in place of `$owner` | 30, 9 of them owned by their buyers |
| Verdict entities | `arkiv.schema = str('vet402_verdict')` | 6 |

All counts were read together on 2026-11-06 at 06:07 UTC. The 74 payments by seller: Seller A 31, Seller B 9, Seller C 1, Seller D 9, Seller E 9, Seller F 10, Quicknode 4, BotPay 1. 20 of them carry `pay_to`.

The 6 rulings are all Arc's, from the contract `0xe9c35ad2…2a4b` on chain 5042002: 2 Fraud against Seller F (`0x1401…445d`), 2 Silent against Seller E (`0x2d86…93e8`) and 2 Silent against Seller D (`0xb9a6…b80d`). None has the test contract `0x0000…0000` or chain id 0. The live check no longer writes a ruling with the production writer (see [how-you-use-arkiv.md](how-you-use-arkiv.md#checking-it)), so this count holds only Arc's rulings. A ruling refuses for 7 days from its block, so the latest ruling against each one holds them: Seller F until about 2026-11-13 02:01 UTC, Seller E until about 02:02 UTC and Seller D until about 02:04 UTC.

To list the rulings yourself:

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_verdict'"'"') AND kind = str('"'"'verdict'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"createdAt":true,"attributes":true}}]}'
```

The receipts page reads every page, 100 entities at a time, so all 140 are on screen.

## Who uses it

These were measured earlier in the event and keep their times.

vet402's buyer is ERC-8004 agent 9907. At 2026-11-05 18:49 UTC its hold wallet had made all 15 recorded payments, and its receipts from before the event are public at https://kzmttkc.github.io/arc-delivery-receipts/.

Every payment since 2026-11-05 17:49 UTC has a receipt on Arkiv that anyone reads on the receipts page, 11 of 11 at that time.

The delivery check acts on these entities. On 2026-11-05 at 18:38 UTC vet402 paid Seller C. About 100 s later, with Seller C's short demo lifetime over, it refused Seller C and offered the next listing, BotPay.

The rulings are read before the local agent pays a catalog listing or Seller C, before a demo pays one of Sellers A to F, and before the public agent pays a catalog listing. A catalog listing's rulings are read by the payTo its listing names. On 2026-11-06 at 03:11 UTC, the read only check against the public endpoint, with no key, answered "Seller F: Arc ruled against this seller in the last 7 days. Not paid." for Seller F's address, nothing for an address with no ruling, and "Delivered recently." for Quicknode by name.

Another buyer can use the rulings without vet402. On 2026-11-06 at 04:36 UTC I ran `isRuledAgainst(payTo, { writer: '0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5' })` from `packages/sealed-delivery` in a separate script, as any x402 buyer would, with no key: `true` for each of the three sellers Arc ruled against (`0x2d861219…`, `0x1401bd7c…`, `0xb9a6f77d…`) and `false` for an address with no ruling. The 6 rulings it read were 4 Silent and 2 Fraud.

Anyone can ask the same question in a browser. The receipts page has a "Check a seller" box: paste a payTo address and the page reads the rulings straight from Arkiv's public RPC, with no vet402 server. On 2026-11-06 at 05:45 UTC Seller F's address `0x1401bd7c…445d` read "Arc ruled against this seller on 2026-11-06 (Fraud)." with a link to the claim on Arc, and "vet402 does not pay this seller until 2026-11-13." The page is live at https://vet402-mumbai-live.vercel.app/receipts.html and on the Swarm feed below.

On 2026-11-06 at 08:29 UTC, 21 of the 42 evidence entities vet402 created belonged to the buyers that filed their claims: 15 to the app's hold `0x24Ab…6ba7` and 6 to the public page's hold `0xD922…506e`. The other 21 came before the handover was added and stay with the writer.

Each dispute now lands on Arkiv as one transaction. The receipt of Seller A's dispute on 2026-11-06 at 04:25 UTC reads "Arkiv: 1 transaction, 3 entities" and "the evidence entity belongs to the buyer 0x24Ab…6ba7". At 04:26 UTC Arkiv held 25 evidence entities from the writer, 4 of them already owned by their buyers.

## After Mumbai

The writer keeps running on Rabdi. These are the steps, each with the check that shows it is done.

1. Keep the judged receipts readable. The first receipts expire around 2026-12-05. Before then I extend the entities that README.md and swarm.md link to, with `extendEntity`, and the README query shows the later `expiresAt`.
2. Wire the payTo address and the rulings into the production buyer, so every new payment, seller and ruling entity carries `pay_to`. In this repo the count is 20 of 74 at 06:07 UTC, and every ruling written from now on carries it too. The check for the production buyer is the same count over its own writer.
3. Move to an Arkiv mainnet when `@arkiv-network/sdk` ships a mainnet chain next to `rabdi`. The chain is named in three places: `server/arkiv.ts`, `src/arkiv/readArkiv.ts` and `scripts/arkiv-live.ts`. I switch all three, run `scripts/arkiv-live.ts` against the new chain until every step passes, and put the new writer address and RPC URL in README.md. Rabdi receipts stay where they are until they expire.

Who else can read this: anybody. The receipts page and the query need no account and no key from vet402.
