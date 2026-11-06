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

The public deploy writes too, when it holds the writer key. `api/try-dispute` puts Arkiv behind the try's own receipt row: after the result it waits for the claimed box's Swarm reference and for Gateway's transfer id, then writes the payment, the seller and the evidence entities, all inside the function's 60 seconds. Without `ARKIV_WRITER_KEY` on the deploy it writes nothing and puts nothing on Swarm.

`extendEntity` sets a new expiry: the block the extension lands in, plus the lifetime. It does not add the lifetime to what is left, and Arkiv refuses an extension that would end earlier (`ExpiryNotExtended`). So 7 days after the last good delivery is when a seller entity runs out, whatever happened before it. Step (3) of the live check measures this on Rabdi.

## Reading before paying

Every path that pays a seller reads Arkiv first, and the reads filter on the writer with `ownedBy`.

| Path | Who | What is read | By |
|---|---|---|---|
| "Ask the agent" in the app | Discovery listings | Delivery record and rulings | Delivery record by name. Rulings by the payTo the listing names (`Candidate.payTo`) |
| The Seller C scene | Seller C, then the cheapest listing | Delivery record and rulings | Seller C by its own address. The listing as above |
| The lost answer demo | Sellers A, B, D, E and F | Rulings only | The address vet402 pays that seller at |
| `api/try-job` on the public deploy | Discovery listings | Delivery record and rulings, read only | As in the app. It needs only the writer's address (`ARKIV_WRITER_ADDRESS`), no key |

A listing's delivery record is still found by name, because a listing could name another seller's address and borrow its record. Its rulings are read by the address it names, and a name listed under several addresses is stopped when any of them was ruled against. The pick itself is always read before it is offered: the ranking reads the five front runners, and when the pick falls below them, it is read too and the ranking runs again.

The demo sellers are read for rulings only. Seller B, D, E and F never deliver on purpose, so their delivery record would stop the scene it exists to show. A ruling does stop them: after Arc's Fraud ruling on Seller F, **Try Seller F** answers "Seller F: Arc ruled against this seller in the last 7 days. Not paid." and nothing is paid. The same goes for D and E after Silent.

A payment entity counts only once it is older than 60 seconds. Every page of the seller's payments and rulings is read. The rows are checked in this order, and the first that applies decides.

| What Arkiv holds | What happens | The check's sentence |
|---|---|---|
| A ruling against this payTo address in the last 7 days | Not paid, next listing | Arc ruled against this seller in the last 7 days. Not paid. |
| A live seller entity | Goes on | Delivered recently. |
| No seller entity and no payment entity | Goes on | First purchase from this seller. |
| Payment entities and no live seller entity | Not paid, next listing | No recent delivery from this seller. Not paid. |
| The read failed | Not paid, next listing | Arkiv could not be read, so the delivery check did not run. Not paid. |

The note above the card is built in `server/jobs.ts` and carries the check's own sentence for each seller passed over, for example "{seller}: Arc ruled against this seller in the last 7 days. Not paid." The demo shows the same sentence when it refuses a seller.

Another x402 buyer can read the same rulings with `isRuledAgainst(payTo, { writer })` from `packages/sealed-delivery`. It sends the query in [schema.md](schema.md#vet402_verdict) over plain JSON-RPC, with no key.

## Reading on the receipts page

`receipts.html` is a static page with the writer address written in at build time, or asked from `GET /api/writer` if the build had none. The address is derived from the key, and the key never reaches the browser.

The page reads the public RPC directly, at most once every 10 seconds. Payments and settlements are separate queries on the indexed `kind`, and each is read to its last page, so the 101st receipt is on screen like the first. Sellers and rulings are read the same way. The page keeps the last rows it read, and shows them with "Arkiv is busy. Showing saved rows." when a read fails, such as on HTTP 429. Dates come from blocks through `getBlockTiming`.

Rows the live check writes have a "live-check-" seller name and expire within minutes. The page leaves them out after reading every page, so they never take the place of a real receipt.

## What each Arkiv feature changes on screen

| Arkiv feature | What the user sees |
|---|---|
| Direct reads from the browser | The receipts page opens and loads with the backend down |
| `readonly` | "Settled in batch {tx}" arrives as a second entity, so the first receipt is never rewritten |
| `permissionlessExtension` | "Kept outside this app until {date}" holds whether or not vet402 keeps running |
| Expiry on seller entities | "Seller active until {date}", and "No recent delivery from this seller. Not paid." when it runs out |
| `extendEntity` | The seller's date moves to 7 days after each delivery that kept its promise |
| `vet402_verdict` entities | "Arc ruled against this seller on {date}" on that seller's receipts, and no approval card for that seller for 7 days |
| `ownedBy` queries | Every row comes from one writer, so a stranger cannot add a fake receipt or a fake ruling to the page |
| Indexed `kind`, `pay_to` and paging | Every receipt shows, and a seller's standing follows its address, not a name anyone can copy |

## Checking it

`npx bun run scripts/arkiv-live.ts` writes a payment, a settlement and a seller under a "live-check-" name, reads them back and prints the result of each check. Step (3) shows the extension setting the expiry from the block it lands in, and step (11) has the writer's own key try to change a receipt and expects a refusal. Those rows expire within minutes.

Step (10) writes a ruling against a fresh address with `ARKIV_OTHER_KEY`, as a writer of its own, and expects that writer's check to refuse it. Step (10b) expects the production writer's check to ignore it. The production writer never writes a test ruling, so the rulings it holds are only Arc's. Without `ARKIV_OTHER_KEY`, step (10) is skipped.

To check the screen text for words that must not appear:

```bash
grep -rnEi 'wallet|signature|\bgas\b|rabdi|\bchain\b|0x[0-9a-f]{40}' src/arkiv/ReceiptsPage.tsx src/components/JobCard.tsx receipts.html
```
