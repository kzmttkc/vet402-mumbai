# Arkiv schema

vet402 writes to Arkiv's Rabdi testnet (chain id 7794095) with `@arkiv-network/sdk@1.0.1`. One key writes everything. Every query a payment waits on filters on that key's address: with `ownedBy` for receipts, sellers and rulings, which stay with the writer, and with `createdBy` for evidence, which the writer hands to the buyer on the claim. "Check a seller" on the receipts page also reads rulings from other writers and keeps each only once Arc holds its event ([how-you-use-arkiv.md](how-you-use-arkiv.md#reading-before-paying)).

The definitions live in `src/arkiv/schema.ts`.

Each table says which query reads a column. A column is indexed only when some query filters on it. On 2026-11-06 I took the index off `job_id`, `status` and `payment_key`, because no query filtered on them. Entities written before that still carry the index flag on those three. Reads never compare the flag, so old and new entities read the same.

`kind` keeps its index even in the schemas where it holds one value, because the published queries (the README's curl, `isRuledAgainst` and the receipts page) filter on it, and Arkiv matches a filter only on an indexed column. On 2026-11-06 at 10:59 UTC, `status = str('accepted')`, unindexed since that day, matched 54 of the 88 payment entities, the ones written before the index came off.

One column name means two things, and that is on purpose. `seller` holds the seller's **name** in `vet402_receipt` and `vet402_seller`, because the catalog names a seller and a receipt must show it. `seller` holds the **payTo address** in `vet402_verdict`, because Arc rules against the address that was paid, and a name is something any listing can copy. The address of a receipt or seller entity is in its own column, `pay_to`. So a ruling joins to a receipt on `vet402_verdict.pay_to = vet402_receipt.pay_to` (or `vet402_verdict.seller` on a ruling older than its `pay_to`), never on the two `seller` columns. Entities written before `pay_to` existed carry the name alone: at 03:15 UTC on 2026-11-06, 18 of the 123 receipts carried `pay_to`.

Every list read sorts by `$key`, takes 100 rows a page and moves the offset by the rows plus the ones the schema skipped, up to 20 pages (`src/arkiv/pages.ts`). A query that matches more than 2,000 entities stops with an error instead of returning part of them. The one exception is `isRuledAgainst` with `writers: 'any'`: it stops reading at 2,000 rows and answers from the rulings Arc confirms among them, so a flood of rows from other writers cannot stop payments to an honest seller (`packages/sealed-delivery/src/rulings.ts`).

## vet402_receipt

Shared by payment and settlement entities, so one query returns both for a transfer id.

| Attribute | Type | Indexed | Holds | Queried by |
|---|---|---|---|---|
| kind | str | yes | "payment" or "settlement" | Every read of this schema: `createArkivReader` reads payments and settlements as two queries, `readSeller` and `findPaymentKey` read payments |
| job_id | str | no | The local id of the receipt row | Nothing. It ties an entity back to the local row when I read one by hand |
| seller | str | yes | The seller's name, as the catalog gives it | `readSeller` when vet402 has no payTo address for the seller |
| pay_to | str | yes | The address the seller is paid at, lowercase. Optional | `readSeller` when vet402 knows the address |
| amount_micro | u64 | no | USDC in micro units | Shown on the receipts page |
| gateway_transfer_id | str | yes | The Gateway transfer id | `findPaymentKey`, `createArkivCounter` and the README query |
| response_hash | str | no | SHA-256 of the response body. With no response, SHA-256 of "no-response:" plus the transfer id | Shown on the receipts page |
| response_bytes | u64 | no | Size of the response body | Shown on the receipts page |
| times_received | u64 | no | How many times the paid response came back | Shown on the receipts page. The delivery check reads it to tell a payment that got no answer from one that did |
| status | str | no | "accepted" or "settled" | Nothing. `kind` already tells the two apart |
| batch_tx | str | no | Settlement only, and optional. The batch transaction | Shown on the receipts page |
| payment_key | str | no | Settlement only, and optional. The payment entity's key | The receipts page joins each settlement to its payment in the browser, after reading both |

Flags: `readonly` and `permissionlessExtension`. Nobody can change a receipt, and anybody can keep one alive if vet402 stops.

Lifetime: 30 days. A payment entity is written when Gateway reports the payment as received. A separate settlement entity is written when Gateway reports it completed.

## vet402_seller

One per seller. This is the record the delivery check reads.

| Attribute | Type | Indexed | Holds | Queried by |
|---|---|---|---|---|
| kind | str | yes | "seller" | `readSeller`, `findSellerKey` and the receipts page |
| seller | str | yes | The seller's name | `readSeller` and `findSellerKey` when vet402 has no payTo address for the seller |
| pay_to | str | yes | The address the seller is paid at, lowercase. Optional | `readSeller` and `findSellerKey` when vet402 knows the address |

Flags: `readonly` only. Without `permissionlessExtension`, only vet402's key can extend it, so a seller cannot keep its own record alive. All 4 seller entities on Rabdi read back with flags `raw: 1` on 2026-11-06 at 01:01 UTC.

Lifetime: 7 days (604800 seconds), and Seller C alone uses `SELLER_TTL_SECONDS`. A delivery calls `extendEntity` only when the answer came back and, for a sealed answer, opened to the seller's promise. An extension sets the expiry to the block it lands in plus the lifetime. It does not add to what is left. The number of deliveries is counted by querying payment entities, so it is not stored here.

## vet402_evidence

One per claim. It points the claim at its box on Swarm. More in [swarm.md](swarm.md).

| Attribute | Type | Indexed | Holds | Queried by |
|---|---|---|---|---|
| kind | str | yes | "evidence" | `createEvidenceReader`, `createEvidenceLister` and `findEvidenceKey` |
| claim_id | str | yes | The claim id on Arc | `createEvidenceLister`, which gives "Open a sealed answer" its list, `createEvidenceReader`, which it opens each one with, and `findEvidenceKey` |
| gateway_transfer_id | str | yes | The Gateway transfer id of the claimed payment | The hand query in swarm.md, the README query with `vet402_evidence` in place of `vet402_receipt` |
| swarm_ref | str | no | The plain 32 byte Swarm reference of the box, as hex | Read by `createEvidenceReader`. The published screen has no other copy of the box |
| swarm_kept_until | u64 | no | Unix seconds the postage batch keeps the box on Swarm, when my own Bee node uploaded it and pinned it. Optional | Read by `createEvidenceLister`. "Open a sealed answer" shows "Kept on Swarm until {date}" from it |

Flags: `readonly` and `permissionlessExtension`, like a receipt. All 11 evidence entities read back with flags `raw: 3` on 2026-11-06 at 01:01 UTC.

Owner: the buyer on the claim, the hold that paid and filed it. vet402 creates the entity and hands it over in the same `executeBatch` transaction, so `$creator` is the writer and `$owner` is the buyer. Every read filters on `$creator`. The buyer can extend the entity or delete it, and the creation flags keep every column as vet402 wrote it.

Lifetime: 30 days. A dispute's payment, seller and evidence entities are written together in one transaction, so all three land or none does.

## vet402_verdict

One per ruling. When the contract on Arc emits Silent (after `finalize`) or Fraud (after `prove`), vet402 copies the ruling to Arkiv. The delivery check reads it before anything else.

| Attribute | Type | Indexed | Holds | Queried by |
|---|---|---|---|---|
| kind | str | yes | "verdict" | `readSeller`, `findVerdictKey`, `isRuledAgainst` and the receipts page |
| claim_id | str | yes | The claim id on Arc | `findVerdictKey`, so a retry never writes a ruling twice |
| seller | str | yes | The payTo address the ruling is against, lowercase. Not a name, unlike `seller` in the other schemas | `readSeller`, by vet402's own address for the seller and by the payTo a catalog listing names, `isRuledAgainst`, and "Check a seller" beside `pay_to` |
| pay_to | str | yes | The same payTo address, lowercase. Optional: absent on rulings written before 2026-11-06 | "Check a seller" on the receipts page (`createRulingsReader`), with `pay_to = … OR seller = …`. A row that has `pay_to` is judged by it |
| verdict | str | yes | "silent" or "fraud" | A buyer who wants Fraud rulings alone adds `verdict = str('fraud')`. Rulings written before 2026-11-06 carry it unindexed and match only without that filter. "Check a seller" shows it as Silent or Fraud |
| claim_tx | str | no | The claim's transaction on Arc. Optional | Read by hand, to open the claim on the explorer |
| contract | str | no | The contract that ruled, lowercase | Read by hand, to check the Silent or Fraud event for `claim_id` |
| chain_id | u64 | no | The chain of that contract, 5042002 for Arc testnet | Read by hand, with `contract` |

Flags: `readonly` and `permissionlessExtension`. Nobody can soften a ruling, and anybody can keep one visible. A ruling stays with the writer for life: vet402 hands over evidence, never a ruling. When the ruling arrives while its claim's row is still waiting for Arkiv, it rides in that row's transaction as a fourth entity.

Lifetime: 30 days. A ruling stops payment for 7 days, counted from the block it was written in (`$createdAt`). Extending it keeps it readable and does not stretch those 7 days.

Why two address columns: `pay_to` is the name the receipt and seller schemas give the address, so all three join on one column, and `seller` stays on every ruling so the queries already in use (`readSeller`, `isRuledAgainst`, the curl below) still find old and new rulings alike.

"Check a seller" on the receipts page sends the rulings query with `pay_to = str(…) OR seller = str(…)` from the browser to the public endpoint, with no key and no backend, and answers in one or two sentences: the date and kind of the latest ruling with its claim on the Arc explorer, and while it is under 7 days old the date vet402 pays that address again.

Only Arc's rulings are written by the production writer. The live check writes its test ruling with a second key (`ARKIV_OTHER_KEY`), so no entity of this writer has the test contract `0x0000…0000` or chain id 0.

The rulings against one address, the query `readSeller` and `isRuledAgainst` send (Seller F's address here):

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_verdict'"'"') AND kind = str('"'"'verdict'"'"') AND seller = str('"'"'0x1401bd7c7fab3fe8a429672fc1c5371456c8445d'"'"') AND $owner = addr(0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5)",{"select":{"key":true,"createdAt":true,"attributes":true}}]}'
```

At 03:17 UTC on 2026-11-06 it returned 2 Fraud rulings, from the contract `0xe9c35ad2…2a4b` on chain 5042002.

## What is never written

The response body, the job text the user typed, any World ID value, and any address of the user. The one buyer address on Arkiv is the owner of an evidence entity: the hold that paid, which the claim on Arc already names as its buyer. No bytes columns are used, and no entity is ever patched.
