# Arkiv schema

vet402 writes to Arkiv's Rabdi testnet (chain id 7794095) with `@arkiv-network/sdk@1.0.1`. One key writes everything, and every query filters on that key's address with `ownedBy`.

The definitions live in `src/arkiv/schema.ts`.

## vet402_receipt

Shared by payment and settlement entities, so one query returns both for a transfer id.

| Attribute | Type | Indexed | Holds |
|---|---|---|---|
| kind | str | yes | "payment" or "settlement" |
| job_id | str | yes | The local id of the receipt row |
| seller | str | yes | The seller's name |
| amount_micro | u64 | no | USDC in micro units |
| gateway_transfer_id | str | yes | The Gateway transfer id |
| response_hash | str | no | SHA-256 of the response body. With no response, SHA-256 of "no-response:" plus the transfer id |
| response_bytes | u64 | no | Size of the response body |
| times_received | u64 | no | How many times the paid response came back |
| status | str | yes | "accepted" or "settled" |
| batch_tx | str | no | Settlement only, and optional. The batch transaction |
| payment_key | str | yes | Settlement only, and optional. The payment entity's key |

Flags: `readonly` and `permissionlessExtension`. Nobody can change a receipt, and anybody can keep one alive if vet402 stops.

Lifetime: 30 days. A payment entity is written when Gateway reports the payment as received. A separate settlement entity is written when Gateway reports it completed.

## vet402_seller

One per seller.

| Attribute | Type | Indexed | Holds |
|---|---|---|---|
| kind | str | yes | "seller" |
| seller | str | yes | The seller's name |

Flags: `readonly` only. Without `permissionlessExtension`, a seller cannot keep its own record alive.

Lifetime: 7 days (604800 seconds), and Seller C alone uses `SELLER_TTL_SECONDS`. Each new delivery calls `extendEntity`. The number of deliveries is counted by querying payment entities, so it is not stored here.

## What is never written

The response body, the job text the user typed, any World ID value, and any address of the user. No bytes columns are used, and no entity is ever patched.
