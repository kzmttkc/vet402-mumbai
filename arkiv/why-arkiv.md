# Why Arkiv

A receipt that lives inside the app that took the payment proves little. If vet402 stops, the receipt stops with it. I wanted a receipt the buyer can still open when the app is gone, one vet402 itself cannot quietly rewrite.

Arkiv gives me that with four things a plain database does not.

**Nobody can edit a receipt, including vet402.** Receipts are created `readonly`, and every receipt on Rabdi reads its flags back as `raw: 3`, readonly and open to extension, on 2026-11-06 at 01:01 UTC. Arkiv's SDK says a readonly entity's attributes can never change, and the engine has a `ReadOnlyEntity` error for a write that tries. Step (11) of `scripts/arkiv-live.ts` has vet402's own key try to change a receipt and passes only when the network refuses.

**A receipt can outlive vet402.** Receipts also carry `permissionlessExtension`, so anybody can extend them if vet402 stops paying for them. Seller records do not carry it. All 4 seller entities read back `raw: 1` at the same time, so only vet402's key can extend one. Step (9) of the live check tries with a second key and passes only when it is refused.

**Expiry means something.** A seller entity lasts 7 days, and a delivery that kept its promise extends it. If a seller has payments on record but its entity is gone, it has not delivered lately, and the agent does not pay it. Expiry does this work for me, with no cleanup job and no counter to maintain.

**Arkiv holds the ruling, not only the receipt.** A seller could not extend its own record, but vet402 used to extend it after any answer came back, even one that Arc then ruled a fraud. Now an answer that does not open to the seller's promise extends nothing, and every Silent or Fraud event from the contract becomes a readonly `vet402_verdict` entity with the claim id, the seller's payTo address, the ruling, the claim transaction, the contract and the chain. Before paying, the delivery check reads those entities first and refuses any seller with a ruling in the last 7 days. The seller's standing is what Arkiv says it is, and anybody can read the same entities and check each one against the event on Arc.

The rest of the check also leans on Arkiv instead of guessing around it. A seller is found by its payTo address when vet402 knows it, so a catalog listing cannot borrow another seller's record by using its name. When Arkiv cannot be read, vet402 does not pay. It says "Arkiv could not be read, so the delivery check did not run. Not paid."

What each Arkiv feature changes on screen is in [how-you-use-arkiv.md](how-you-use-arkiv.md#what-each-arkiv-feature-changes-on-screen).

## What I did not put on Arkiv, and why

Everything on Arkiv is public, and every entity is a fact that should not change. What fails either test stays off.

| Kept off Arkiv | Where it lives instead | Why |
|---|---|---|
| The response body | The buyer's local receipt only. Arkiv holds its SHA-256 and size | It is the buyer's purchase. The hash is enough to prove which answer came back |
| The job text the user typed | The backend | It is the user's own words, and nothing a stranger needs to check a receipt |
| Any address of the user, and any World ID value | The backend | A public receipt must not say who bought what. Only the seller's address is written |
| The sealed answer itself | Swarm, as a box with no key in it. Arkiv holds the reference | It is bytes, and vet402 uses no bytes columns. Swarm is built for content by reference |
| The key that opens a sealed answer | Arc, in the `KeyRevealed` event | The contract checks the key against the seller's promise. A copy elsewhere would decide nothing |
| The deposit, the claim and the payout | The contract on Arc | Money moves there. Arkiv copies only the ruling, with the contract and claim id to check it by |
| The hold, the budget and each approval | The backend's own store | They change during a job, and Arkiv entities here never change |
| A payment's status as one field that moves on | Two entities, payment and settlement | Gateway decides the status. Patching one entity would give up `readonly` |
| A count of deliveries per seller | Nothing. It is counted with a query over payment entities | A stored counter would need patching and could drift from the entities it counts |
