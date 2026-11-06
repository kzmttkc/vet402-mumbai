# Arkiv schema

vet402 writes to Arkiv's Rabdi testnet (chain id 7794095) with `@arkiv-network/sdk@1.0.1`. One key writes everything, and every query filters on that key's address with `ownedBy`.

The definitions live in `src/arkiv/schema.ts`.

Each table says which query reads a column. A column is indexed only when some query filters on it. On 2026-11-06 I took the index off `job_id`, `status` and `payment_key`, because no query filtered on them. Entities written before that still carry the index flag on those three. Reads never compare the flag, so old and new entities read the same.

Every list read sorts by `$key`, takes 100 rows a page and moves the offset by the rows plus the ones the schema skipped, up to 20 pages (`src/arkiv/pages.ts`). A query that matches more than 2,000 entities stops with an error instead of returning part of them.

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
| times_received | u64 | no | How many times the paid response came back | Shown on the receipts page |
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
| kind | str | yes | "evidence" | `createEvidenceReader` and `findEvidenceKey` |
| claim_id | str | yes | The claim id on Arc | `createEvidenceReader`, which "Open a sealed answer" uses, and `findEvidenceKey` |
| gateway_transfer_id | str | yes | The Gateway transfer id of the claimed payment | The hand query in swarm.md, the README query with `vet402_evidence` in place of `vet402_receipt` |
| swarm_ref | str | no | The plain 32 byte Swarm reference of the box, as hex | Read by `createEvidenceReader` |

Flags: `readonly` and `permissionlessExtension`, like a receipt. All 11 evidence entities read back with flags `raw: 3` on 2026-11-06 at 01:01 UTC.

Lifetime: 30 days.

## vet402_verdict

One per ruling. When the contract on Arc emits Silent (after `finalize`) or Fraud (after `prove`), vet402 copies the ruling to Arkiv. The delivery check reads it before anything else.

| Attribute | Type | Indexed | Holds | Queried by |
|---|---|---|---|---|
| kind | str | yes | "verdict" | `readSeller`, `findVerdictKey` and the receipts page |
| claim_id | str | yes | The claim id on Arc | `findVerdictKey`, so a retry never writes a ruling twice |
| seller | str | yes | The payTo address the ruling is against, lowercase | `readSeller` |
| verdict | str | no | "silent" or "fraud" | Read by hand. The receipts page shows the date of the latest ruling of either kind |
| claim_tx | str | no | The claim's transaction on Arc. Optional | Read by hand, to open the claim on the explorer |
| contract | str | no | The contract that ruled, lowercase | Read by hand, to check the Silent or Fraud event for `claim_id` |
| chain_id | u64 | no | The chain of that contract, 5042002 for Arc testnet | Read by hand, with `contract` |

Flags: `readonly` and `permissionlessExtension`. Nobody can soften a ruling, and anybody can keep one visible.

Lifetime: 30 days. A ruling stops payment for 7 days, counted from the block it was written in (`$createdAt`). Extending it keeps it readable and does not stretch those 7 days.

## What is never written

The response body, the job text the user typed, any World ID value, and any address of the user. No bytes columns are used, and no entity is ever patched.
