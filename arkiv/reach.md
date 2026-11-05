# Reach

Measured from the writer's entities on Rabdi. Run the query in the README against the writer address, `0x4eeA8EdDCC608CBD8b3683F738a473923F2De4C5`, without the transfer id filter. The seller count uses `arkiv.schema = str('vet402_seller')` in the same query.

| What | Count | Measured at |
|---|---|---|
| Payment entities | 11 | 2026-11-05 18:49 UTC |
| Settlement entities | 9 | 2026-11-05 18:49 UTC |
| Seller entities alive | 2 | 2026-11-05 18:49 UTC |

## Who uses it

At 2026-11-05 18:49 UTC, vet402 is the only buyer: all 15 recorded payments, and every Gateway transfer to the six demo sellers, come from its hold wallet. It is ERC-8004 agent 9907, and its earlier receipts are public at https://kzmttkc.github.io/arc-delivery-receipts/.

Every payment since 2026-11-05 17:49 UTC has a receipt on Arkiv that anyone reads on the receipts page, 11 of 11 at that time. The 4 payments before it, from 16:03 to 16:04 UTC, have none.

The delivery check has used these entities once. On 2026-11-05 at 18:38 UTC vet402 paid Seller C. About 100 s later, with Seller C's short demo lifetime over, it refused Seller C and offered the next listing, BotPay, which I did not pay.

## After Mumbai

The receipt writer keeps writing one Arkiv entity per payment on Rabdi until Arkiv announces a mainnet.

Who else can read this: anybody. The receipts page and the query need no account and no key from vet402.
