# Reach

- **The vet402 app in this repo** reads Arc's rulings on Arkiv before every payment, and the public agent runs the same check. vet402's production buyer, ERC-8004 agent 9907, takes the same check next (steps below).
- **Two third-party sellers from Circle's Discovery catalog**, Quicknode and BotPay, have vet402's payments to them on Arkiv: 4 and 1.
- **88 payment entities and 6 rulings** were on Arkiv on 2026-11-06 at 10:56 UTC, counted page by page in [the table below](#counted-from-arkiv).

Every x402 seller that seals its answers with `packages/sealed-delivery` and deposits into SealedDelivery is under the same rulings. Each Silent or Fraud verdict of the contract becomes a readonly `vet402_verdict` entity on Arkiv, keyed by the seller's payTo address, and any buyer reads it before paying with one `arkiv_query` and no key. A seller joins by naming its payTo in its 402 answer, so the check covers a catalog listing from its first payment, with no list kept by vet402.

## Today on Arkiv, 2026-11-06

Read on 2026-11-06 from 10:56:44 to 10:56:50 UTC (Arkiv block 288421), the same way as the README's curl, unless a line gives its own time.

- **6 rulings of Arc entered Arkiv today**, between 01:43 and 02:04 UTC, from the live contract `0xe9c35ad2…2a4b`. They keep vet402 from paying Seller F `0x1401…445d`, Seller E `0x2d86…93e8` and Seller D `0xb9a6…b80d` until about 2026-11-13. `isRuledAgainst` from `packages/sealed-delivery` read `true` for Seller F and `false` for Seller A at 10:20 UTC, as the README shows.
- **34 payment entities were written today**: 25 for the demo sellers paid at their own addresses (Seller A 19, Seller D 2, Seller E 2, Seller F 2) and 9 for the public page's Try a dispute, whose seller is paid at `0x4ac4…55d1`.
- **The public agent read Arkiv before its pick.** At 10:55:03 UTC a plan for "Did my last payment go through?" on `https://vet402-mumbai-live.vercel.app/api/try-job` (`{"step":"plan"}`, which pays nothing) picked vet402 Payment Check with the delivery line "First purchase from this seller.", the sentence the check gives a seller with no entity on Arkiv.

## Counted from Arkiv

Read on 2026-11-06 from 10:56:44 to 10:56:50 UTC (Arkiv block 288421), with the query of the README's curl: `arkiv_query` on `https://rpc.rabdi.db-chain.testnet.arkiv.network`, no key, the writer filter `$owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)`, and every page of 100 (`"limit":"0x64"`, then `"offset":"0x64"`, `"0xc8"` and on, until a page holds fewer than 100). Evidence entities are read with `$creator` in place of `$owner`, because each one passes to its buyer.

Payments by who runs the seller, from `arkiv.schema = str('vet402_receipt')` with `kind = str('payment')` and `kind = str('settlement')`, counted by the `seller` attribute, and by `pay_to` for the seller of Try a dispute:

| Seller | Who runs it | Payment entities | Settlement entities |
|---|---|---:|---:|
| Quicknode, Arc Testnet JSON-RPC node | A third party, from Circle's Discovery catalog for Arc testnet | 4 | 4 |
| BotPay, `/pay` | A third party, from the same catalog | 1 | 1 |
| Sellers A to F | vet402, one demo seller per path of the contract: A 36, B 9, C 1, D 9, E 9, F 10 payments | 74 | 71 |
| The seller of Try a dispute | vet402, on the public page. Its receipts name it Seller A, and it is paid at `0x4ac46671e2dd33e6b9f3e781b267cfd5ed6655d1` | 9 | 0 |
| All | | 88 | 76 |

34 of the 88 payment entities carry `pay_to`, the address the rulings are read by.

| Entity | Query condition | Count |
|---|---|---:|
| Seller entities alive | `arkiv.schema = str('vet402_seller')` | 6 |
| Evidence entities | `arkiv.schema = str('vet402_evidence')`, by `$creator` | 44, 23 of them owned by the buyers that filed the claims: 15 by the app's hold `0x24ab…6ba7` and 8 by the public page's hold `0xd922…506e` |
| Verdict entities | `arkiv.schema = str('vet402_verdict') AND kind = str('verdict')` | 6 |

The 6 rulings are all Arc's, from the contract `0xe9c35ad2…2a4b` on chain 5042002 (`chain_id` 0x4cef52): 2 Fraud against Seller F (`0x1401…445d`), 2 Silent against Seller E (`0x2d86…93e8`) and 2 Silent against Seller D (`0xb9a6…b80d`). A ruling refuses for 7 days from its block, so the latest ruling against each one holds them: Seller F until about 2026-11-13 02:01 UTC, Seller E until about 02:02 UTC and Seller D until about 02:04 UTC.

To list the rulings yourself:

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_verdict'"'"') AND kind = str('"'"'verdict'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"createdAt":true,"attributes":true}}]}'
```

The receipts page reads every page, 100 entities at a time, so all 164 receipt entities are on screen.

## Who uses it

These were measured earlier in the event and keep their times.

vet402's buyer is ERC-8004 agent 9907. At 2026-11-05 18:49 UTC its hold wallet had made all 15 recorded payments, and its receipts from before the event are public at https://kzmttkc.github.io/arc-delivery-receipts/.

Every payment since 2026-11-05 17:49 UTC has a receipt on Arkiv that anyone reads on the receipts page, 11 of 11 at that time.

The delivery check acts on these entities. On 2026-11-05 at 18:38 UTC vet402 paid Seller C. About 100 s later, with Seller C's short demo lifetime over, it refused Seller C and offered the next listing, BotPay.

The rulings are read before the local agent pays a catalog listing or Seller C, before a demo pays one of Sellers A to F, and before the public agent pays a catalog listing. A catalog listing's rulings are read by the payTo its listing names. On 2026-11-06 at 03:11 UTC, the read only check against the public endpoint, with no key, answered "Seller F: Arc ruled against this seller in the last 7 days. Not paid." for Seller F's address, nothing for an address with no ruling, and "Delivered recently." for Quicknode by name.

Another buyer can use the rulings without vet402. On 2026-11-06 at 04:36 UTC I ran `isRuledAgainst(payTo, { writer: '0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5' })` from `packages/sealed-delivery` in a separate script, as any x402 buyer would, with no key: `true` for each of the three sellers Arc ruled against (`0x2d861219…`, `0x1401bd7c…`, `0xb9a6f77d…`) and `false` for an address with no ruling. The 6 rulings it read were 4 Silent and 2 Fraud.

Anyone can ask the same question in a browser. The receipts page has a "Check a seller" box: paste a payTo address and the page reads the rulings straight from Arkiv's public RPC, with no vet402 server. On 2026-11-06 at 05:45 UTC Seller F's address `0x1401bd7c…445d` read "Arc ruled against this seller on 2026-11-06 (Fraud)." with a link to the claim on Arc, and "vet402 does not pay this seller until 2026-11-13." The page is live at https://vet402-mumbai-live.vercel.app/receipts.html and on its Swarm feed in [swarm.md](swarm.md#the-receipts-page-on-swarm-under-one-fixed-url).

On 2026-11-06 at 10:56 UTC, 23 of the 44 evidence entities vet402 created belonged to the buyers that filed their claims: 15 to the app's hold `0x24Ab…6ba7` and 8 to the public page's hold `0xD922…506e`. The other 21 came before the handover was added and stay with the writer.

Each dispute now lands on Arkiv as one transaction. The receipt of Seller A's dispute on 2026-11-06 at 04:25 UTC reads "Arkiv: 1 transaction, 3 entities" and "the evidence entity belongs to the buyer 0x24Ab…6ba7". At 04:26 UTC Arkiv held 25 evidence entities from the writer, 4 of them already owned by their buyers.

## Into vet402's production buyer

The writer keeps running on Rabdi. These are the steps, each with the check that shows it is done.

1. **Keep the judged receipts readable.** The first receipts expire around 2026-12-05. Before then I extend the entities that README.md and swarm.md link to, with `extendEntity`. Done when the README's receipt query shows the later `expiresAt`.
2. **Read the rulings before every production payment.** vet402's production buyer, which paid through Gateway on Arc mainnet on 2026-09-28, calls `isRuledAgainst(accept.payTo, { writer })` from `packages/sealed-delivery` before it signs, and skips a seller that reads true. Done when a test payment to Seller F's address `0x1401bd7c7fab3fe8a429672fc1c5371456c8445d` stops before any signature, and one to an address with no ruling goes through.
3. **Write every production payment with its payTo.** The production buyer writes its payment, settlement, seller and ruling entities through `server/arkiv.ts`, so each carries `pay_to`. Done when the paged count above, run over the production writer's address, shows `pay_to` on every payment entity created after the switch.
4. **Move to an Arkiv mainnet** when `@arkiv-network/sdk` ships a mainnet chain next to `rabdi`. The chain is named in three places: `server/arkiv.ts`, `src/arkiv/readArkiv.ts` and `scripts/arkiv-live.ts`. Done when `scripts/arkiv-live.ts` passes every step against the new chain, and README.md names the new writer address and RPC URL. Rabdi receipts stay where they are until they expire.

Who else can read this: anybody. The receipts page and the query need no account and no key from vet402.
