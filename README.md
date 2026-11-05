# vet402 on Arc

Started at ETHGlobal Mumbai on 2026-11-05 21:00 IST.

The existing product is vet402 (https://github.com/kzmttkc/vet402). Its last pre-event commit carries the tag `mumbai-pre-event-2026`. Everything in this repository was written during the event.

## Receipts on Arkiv

vet402 keeps a copy of every receipt on Arkiv's Rabdi testnet, so a receipt stays readable when this app is down. The receipts page reads Arkiv directly from the browser.

Writer address: `{{WRITER_ADDRESS}}`

Print it with `npx bun run scripts/arkiv-address.ts`. The script derives the address from `ARKIV_WRITER_KEY` and never prints the key.

One query you can run. Put a transfer id from the receipts page in place of `TRANSFER_ID`. It returns the payment entity and the settlement entity for that transfer.

```bash
curl -sL https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":["arkiv.schema = str('"'"'vet402_receipt'"'"') AND gateway_transfer_id = str('"'"'TRANSFER_ID'"'"') AND $owner = addr({{WRITER_ADDRESS}})",{"select":{"key":true,"expiresAt":true,"attributes":true}}]}'
```

Explorer: https://rabdi.explorer.arkiv.network

More in [arkiv/](arkiv/schema.md).
