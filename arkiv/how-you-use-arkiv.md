# How vet402 uses Arkiv

## Writing

The backend holds `ARKIV_WRITER_KEY`. Without it the app runs on local receipts alone, exactly as before.

`createArkivSink` in `server/arkiv.ts` sits behind the local receipt store. The local row is saved first and the Arkiv write follows from one queue, one at a time, without viem's nonce manager. The screen and the payment never wait for Arkiv. A failed write is caught and logged, the receipt's sentence stays on screen, and a later pass tries again. A retry looks for the entity first, so a write that landed is not written twice.

1. Gateway reports the payment as received: one payment entity with status "accepted".
2. The answer really arrived and kept its promise: the seller entity is created, or extended if it exists. For a sealed answer that means the key opened it to the seller's promise. A swapped answer extends nothing.
3. Gateway reports the payment completed: one settlement entity with status "settled", holding the payment entity's key.
4. Arc rules on a claim: after `finalize` the contract emits Silent, after `prove` it emits Fraud, and `recordVerdict` queues one `vet402_verdict` entity with the claim id, the seller's payTo address, the ruling, the claim transaction, the contract and the chain id. A retry looks for the claim id first.

No response means no seller write. The payment entity then stores the hash of "no-response:" plus the transfer id.

Payment, settlement and seller entities carry `pay_to`, the address the seller is paid at, when the server knows it for that seller name (`payToOf`). Otherwise they carry the name alone, as before.

`extendEntity` sets a new expiry: the block the extension lands in, plus the lifetime. It does not add the lifetime to what is left, and Arkiv refuses an extension that would end earlier (`ExpiryNotExtended`). So 7 days after the last good delivery is when a seller entity runs out, whatever happened before it. Step (3) of the live check measures this on Rabdi.

## Reading before paying

Before the approval card appears for a Discovery listing or for Seller C, the backend reads that seller from Arkiv with `ownedBy`. It looks the seller up by payTo address when it knows one, and by name otherwise. It reads every page of the seller's payments and rulings. A payment entity counts only once it is older than 60 seconds. Sellers A, B, D, E and F run a separate demo flow that never reaches this check. A ruling against one of them is still written and shown on its receipts, and it stops any purchase that does go through the check.

The rows are checked in this order, and the first that applies decides.

| What Arkiv holds | What happens | The check's sentence |
|---|---|---|
| A ruling against this payTo address in the last 7 days | Not paid, next listing | Arc ruled against this seller in the last 7 days. Not paid. |
| A live seller entity | Goes on | Delivered recently. |
| No seller entity and no payment entity | Goes on | First purchase from this seller. |
| Payment entities and no live seller entity | Not paid, next listing | No recent delivery from this seller. Not paid. |
| The read failed | Not paid, next listing | Arkiv could not be read, so the delivery check did not run. Not paid. |

The note above the card is built in `server/jobs.ts` and reads "{seller}: No recent delivery from this seller. Not paid." for every seller passed over, whichever row stopped it.

## Reading on the receipts page

`receipts.html` is a static page with the writer address written in at build time, or asked from `GET /api/writer` if the build had none. The address is derived from the key, and the key never reaches the browser.

The page reads the public RPC directly, at most once every 10 seconds. Payments and settlements are separate queries on the indexed `kind`, and each is read to its last page, so the 101st receipt is on screen like the first. Sellers and rulings are read the same way. The page keeps the last rows it read, and shows them with "Arkiv is busy. Showing saved rows." when a read fails, such as on HTTP 429. Dates come from blocks through `getBlockTiming`.

Rows the live check writes have a "live-check-" seller name and expire within minutes. The page leaves them out after reading every page, so they never take the place of a real receipt.

## What each Arkiv feature changes on screen

| Arkiv feature | What the user sees |
|---|---|
| Direct reads from the browser | The receipts page opens and loads with the backend down |
| `readonly` | "Settled in batch {tx}" arrives as a second entity, so the first receipt is never rewritten |
| `permissionlessExtension` | "Kept outside this app until {date}" does not depend on vet402 staying alive |
| Expiry on seller entities | "Seller active until {date}", and "No recent delivery from this seller. Not paid." when it runs out |
| `extendEntity` | The seller's date moves to 7 days after each delivery that kept its promise |
| `vet402_verdict` entities | "Arc ruled against this seller on {date}" on that seller's receipts, and no approval card for that seller for 7 days |
| `ownedBy` queries | Every row comes from one writer, so a stranger cannot add a fake receipt or a fake ruling to the page |
| Indexed `kind`, `pay_to` and paging | Every receipt shows, and a seller's standing follows its address, not a name anyone can copy |

## Checking it

`npx bun run scripts/arkiv-live.ts` writes a payment, a settlement and a seller under a "live-check-" name, reads them back and prints the result of each check. Step (3) shows the extension setting the expiry from the block it lands in, step (10) writes a ruling against a fresh address and expects the check to refuse it, and step (11) has the writer's own key try to change a receipt and expects a refusal. Those rows expire within minutes.

To check the screen text for words that must not appear:

```bash
grep -rnEi 'wallet|signature|\bgas\b|rabdi|\bchain\b|0x[0-9a-f]{40}' src/arkiv/ReceiptsPage.tsx src/components/JobCard.tsx receipts.html
```
