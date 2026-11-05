# Why Arkiv

A receipt that lives inside the app that took the payment proves little. If vet402 stops, the receipt stops with it. I wanted a receipt the buyer can still open when the app is gone, one vet402 itself cannot quietly rewrite.

Arkiv gives me that with three things a plain database does not.

**Nobody can edit a receipt, including vet402.** Receipts are created `readonly`. When I tried to patch one in rehearsal, the network refused it.

**A receipt can outlive vet402.** Receipts also carry `permissionlessExtension`, so anybody can extend them if vet402 stops paying for them. Seller records do not carry it, so a seller cannot keep its own record alive.

**Expiry means something.** A seller entity lasts 7 days and each real delivery extends it. If a seller has payments on record but its entity is gone, it has not delivered lately, and the agent does not pay it. Expiry does this work for me, with no cleanup job and no counter to maintain.

## Does each feature change something the user sees?

| Arkiv feature | What the user sees |
|---|---|
| Direct reads from the browser | The receipts page opens and loads with the backend down |
| `readonly` | "Settled in batch {tx}" arrives as a second entity, so the first receipt is never rewritten |
| `permissionlessExtension` | "Kept outside this app until {date}" does not depend on vet402 staying alive |
| Expiry on seller entities | "Seller active until {date}", and "No recent delivery from this seller. Not paid." when it runs out |
| `extendEntity` | The seller's date moves later after each delivery |
| `ownedBy` queries | Every row comes from one writer, so a stranger cannot add a fake receipt to the page |
