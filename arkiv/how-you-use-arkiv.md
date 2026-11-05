# How vet402 uses Arkiv

## Writing

The backend holds `ARKIV_WRITER_KEY`. Without it the app runs on local receipts alone, exactly as before.

`createArkivSink` in `server/arkiv.ts` sits behind the local receipt store. The local row is saved first and the Arkiv write follows from one queue, one at a time, without viem's nonce manager. The screen and the payment never wait for Arkiv. A failed write is caught and logged, the receipt's sentence stays on screen, and a later pass tries again. A retry looks for the entity first, so a write that landed is not written twice.

1. Gateway reports the payment as received: one payment entity with status "accepted".
2. The response really arrived: the seller entity is created, or extended if it exists.
3. Gateway reports the payment completed: one settlement entity with status "settled", holding the payment entity's key.

No response means no seller write. The payment entity then stores the hash of "no-response:" plus the transfer id.

## Reading before paying

Before the approval card appears for a Discovery listing or for Seller C, the backend reads that seller from Arkiv with `ownedBy`. A payment entity counts only once it is older than 60 seconds. Seller A and Seller B run a separate demo flow that never reaches this check.

| What Arkiv holds | What happens | What the screen says |
|---|---|---|
| A live seller entity | Goes on | Delivered recently. |
| No seller entity and no payment entity | Goes on | First purchase from this seller. |
| Payment entities and no live seller entity | Not paid, next listing | {seller}: No recent delivery from this seller. Not paid. |
| The read failed | Goes on | Arkiv is busy. Buying without the delivery check. |

## Reading on the receipts page

`receipts.html` is a static page with the writer address written in at build time, or asked from `GET /api/writer` if the build had none. The address is derived from the key, and the key never reaches the browser.

The page reads the public RPC directly, at most once every 10 seconds. It keeps the last rows it read, and shows them with "Arkiv is busy. Showing saved rows." when a read fails, such as on HTTP 429. Dates come from the expiry block through `getBlockTiming`.

## Checking it

`npx bun run scripts/arkiv-live.ts` writes a payment, a settlement and a seller under a "live-check-" name, reads them back and prints the result of each check. Those rows expire within minutes.

To check the screen text for words that must not appear:

```bash
grep -rnEi 'wallet|signature|\bgas\b|rabdi|\bchain\b|0x[0-9a-f]{40}' src/arkiv/ReceiptsPage.tsx src/components/JobCard.tsx receipts.html
```
