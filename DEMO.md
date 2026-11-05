# Demo record

All rows are from Arc testnet on 2026-11-05, with times in UTC. Every payment is 0.001 USDC. The status and batch columns are what Circle's Gateway API returned for each transfer at 18:15 UTC. "completed" means settled in the batch shown.

## Receipts

| Time | Seller | Gateway transfer id | Status | Batch | Outcome on the receipt |
|---|---|---|---|---|---|
| 16:03:31 | Seller A | `4b1ea092-54df-4547-8a23-fb306f1fdb8b` | completed | [`0x9318db6d…`](https://explorer.testnet.arc.io/tx/0x9318db6df3722facf089c186ca5b0f6f25440cd5f67d73edbf18508468ef9948) | Charged once. Delivered on the second fetch. Circle record: 1 transfer for this payment. |
| 16:03:44 | Seller B | `0d717419-5903-4496-8e87-b1629451c9a2` | completed | [`0x9318db6d…`](https://explorer.testnet.arc.io/tx/0x9318db6df3722facf089c186ca5b0f6f25440cd5f67d73edbf18508468ef9948) | Charged once. Nothing delivered. No second charge. |
| 16:04:02 | Seller B | `e9cbd6d5-d3a3-4693-9e6d-f9d33a197b31` | completed | [`0x9318db6d…`](https://explorer.testnet.arc.io/tx/0x9318db6df3722facf089c186ca5b0f6f25440cd5f67d73edbf18508468ef9948) | Circle record: 2 transfers. Charged twice. |
| 16:04:03 | Seller B | `b9d962ef-6276-4f29-a94d-87618539a6fd` | completed | [`0x9318db6d…`](https://explorer.testnet.arc.io/tx/0x9318db6df3722facf089c186ca5b0f6f25440cd5f67d73edbf18508468ef9948) | Circle record: 2 transfers. Charged twice. |
| 17:49:06 | Seller A | `1302d43e-32bb-4e10-a765-4c15488780d9` | completed | [`0x19bb16c2…`](https://explorer.testnet.arc.io/tx/0x19bb16c2b252ed93ccb2e40d810599a6d27c61411b392c5baa4743b7d1609dbd) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 17:49:19 | Seller F | `7fccd434-0109-4eae-a5d2-ef371b4c4be6` | completed | [`0xddbab659…`](https://explorer.testnet.arc.io/tx/0xddbab659d84be4606e4576450121a372b83c7a7ddb86fe4600b067394d365a5f) | Charged once. Nothing delivered. No second charge. |
| 17:51:07 | Seller F | `2e004a69-69f2-4edd-b15c-af8e97b5cff5` | completed | [`0xddbab659…`](https://explorer.testnet.arc.io/tx/0xddbab659d84be4606e4576450121a372b83c7a7ddb86fe4600b067394d365a5f) | The answer did not match the seller's promise. Its deposit paid 0.001 USDC back. |
| 17:52:19 | Seller E | `c1a0c172-8687-4e26-8d4d-ceb24f9b8516` | completed | [`0xddbab659…`](https://explorer.testnet.arc.io/tx/0xddbab659d84be4606e4576450121a372b83c7a7ddb86fe4600b067394d365a5f) | The seller stayed silent. Its deposit paid 0.001 USDC back. |
| 17:53:44 | Seller D | `af62782f-6acc-4be3-91bf-ae0277441745` | completed | [`0xddbab659…`](https://explorer.testnet.arc.io/tx/0xddbab659d84be4606e4576450121a372b83c7a7ddb86fe4600b067394d365a5f) | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.001 USDC back. |

The two Seller B rows at 16:04 are the comparison: a retry with a new signature paid again. The Seller F row at 17:49:19 ended before any claim. I kept it in the record, and I did not record why it stopped there. The Seller F run at 17:51:07 is the one that went through.

## Contract transactions

SealedDelivery at [`0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2`](https://explorer.testnet.arc.io/address/0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2). The fee is gas used times the 25 gwei each of these transactions paid.

| Time | Scene | Call | Sent by | Gas used | Fee in USDC | Transaction |
|---|---|---|---|---:|---:|---|
| 17:48:27 | Seller A | `deposit` | Seller A | 76,905 | 0.0019 | [`0xb74ac810…`](https://explorer.testnet.arc.io/tx/0xb74ac810b86ae0a43c84a8e699ccda27c7ad626097118af3541535504be1c55b) |
| 17:48:30 | Seller D | `deposit` | Seller D | 76,905 | 0.0019 | [`0x7bb5b99f…`](https://explorer.testnet.arc.io/tx/0x7bb5b99f7baf6a8778edeb873038d17655d17c6fba76fd12b85588f24d0b02fa) |
| 17:48:35 | Seller E | `deposit` | Seller E | 76,905 | 0.0019 | [`0x3f6961a8…`](https://explorer.testnet.arc.io/tx/0x3f6961a8e4272d6c7597649b151d37d96807b95df7f00f47f22eed1737ba9217) |
| 17:48:39 | Seller F | `deposit` | Seller F | 76,905 | 0.0019 | [`0xaa8c1fa4…`](https://explorer.testnet.arc.io/tx/0xaa8c1fa4ef61d60d44b83fc5a167a7597aa3b57d73d76f883ca615db3f84cd8e) |
| 17:49:01 | Seller A | `claim` | vet402 hold | 268,269 | 0.0067 | [`0x110749e4…`](https://explorer.testnet.arc.io/tx/0x110749e4ede9ad6cdc2f0579f4819dd752167a72f0f2a8b1c735448ac90245c2) |
| 17:49:05 | Seller A | `answer` | Seller A | 87,355 | 0.0022 | [`0xf83c4872…`](https://explorer.testnet.arc.io/tx/0xf83c4872ec5e23c14a5d8d5e7ede1434ee04824fd43120121be961b06978f8c8) |
| 17:51:00 | Seller F | `claim` | vet402 hold | 268,305 | 0.0067 | [`0x958a3d1d…`](https://explorer.testnet.arc.io/tx/0x958a3d1d8288e2b83b3f260b06bad539f836224092fbe55d992412798efc2244) |
| 17:51:06 | Seller F | `answer` | Seller F | 87,355 | 0.0022 | [`0xf5ed51eb…`](https://explorer.testnet.arc.io/tx/0xf5ed51eb0455afd233e0e567a451832911ced19c1178afce1955c2fc1428c820) |
| 17:51:10 | Seller F | `prove` | vet402 hold | 123,414 | 0.0031 | [`0xd74eee02…`](https://explorer.testnet.arc.io/tx/0xd74eee02e9f7f8714ac33a64b140eee26826a7333b4097c65b24057699d88c1b) |
| 17:51:12 | Seller F | `flushBurn` | vet402 hold | 57,233 | 0.0014 | [`0xd5b8e351…`](https://explorer.testnet.arc.io/tx/0xd5b8e3510fa64e985eeca64c0edfe8b852f58d5ad47d7ef47fd7683b7b461a09) |
| 17:51:17 | Seller E | `claim` | vet402 hold | 268,329 | 0.0067 | [`0x5ef6c066…`](https://explorer.testnet.arc.io/tx/0x5ef6c066a4cd2090a35e20fb92d921d3442d6a33821cb7a2d9c3b5940f02afee) |
| 17:52:39 | Seller E | `finalize` | vet402 hold | 98,681 | 0.0025 | [`0x89f03886…`](https://explorer.testnet.arc.io/tx/0x89f03886270480150bbdbf08e6d99eecd14c180b395db98e3b93350bc9932a4e) |
| 17:52:40 | Seller E | `flushBurn` | vet402 hold | 57,233 | 0.0014 | [`0x62334f53…`](https://explorer.testnet.arc.io/tx/0x62334f53881b0a32739782ed795c2b82eaf6e9b1c036b1cfb9c6f67319f0916e) |
| 17:52:44 | Seller D | `claim` | vet402 hold | 268,317 | 0.0067 | [`0xe458fddb…`](https://explorer.testnet.arc.io/tx/0xe458fddb561de5fb6425cf7c2775b26a465623d138187ed577d1d868f3528200) |
| 17:52:50 | Seller D | `answer, reverted` | Seller D | 29,234 | 0.0007 | [`0x5ec88c38…`](https://explorer.testnet.arc.io/tx/0x5ec88c38d1ce2ae44de817e5ba932ab559e0025b63cd135d01f4625e31e023ab) |
| 17:55:01 | Seller D | `finalize` | vet402 hold | 98,681 | 0.0025 | [`0x3c4414d4…`](https://explorer.testnet.arc.io/tx/0x3c4414d4572b34f034b2e675406c0ebdafd1b7bf9c563f39dc8900c1db24bf5d) |
| 17:55:02 | Seller D | `flushBurn` | vet402 hold | 57,233 | 0.0014 | [`0xdf33813c…`](https://explorer.testnet.arc.io/tx/0xdf33813c0648391e5bfc6ef36472e8345243a0ef515c55eb10d8d013661e20a3) |
| 17:55:39 | All credits | `withdrawClaimable` | vet402 hold | 53,271 | 0.0013 | [`0x6f06623e…`](https://explorer.testnet.arc.io/tx/0x6f06623e2c72f1aaf3e4e19ff2ba9a3ef6e8a9a32bea258da64bf3879fb95c40) |

The contract read on 2026-11-05 at 18:15 UTC:

| Seller | Address | Deposit in USDC | `silentCount` | `fraudCount` |
|---|---|---:|---:|---:|
| Seller A | `0x71f8005aE7757857DC6b7418b9beC75F19546aC3` | 0.010 | 0 | 0 |
| Seller D | `0xB9a6F77d9EFDFcF165e1259fC650fFA01b06B80D` | 0.008 | 1 | 0 |
| Seller E | `0x2d86121923E9662D4d926d657FE91A2141BD93e8` | 0.008 | 1 | 0 |
| Seller F | `0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d` | 0.008 | 0 | 1 |

Each seller deposited 0.01 USDC. Each verdict took 0.002 USDC: 0.001 credited to the buyer and 0.001 burned.

## What each scene shows

- **Seller A, 16:03 UTC.** The first response was lost after settlement. vet402 asked again with the same payment and got the stored answer. Circle's record shows 1 transfer for this payment.
- **Seller A, 17:49 UTC.** The key request closed. vet402 sent a claim, Seller A answered on chain, and the run read the key from Arc in 9.4 s. Circle's record shows 1 transfer for this payment.
- **Seller F, 17:51 UTC.** The seller answered with a key that opens something other than what it signed. `prove` marked FRAUD.
- **Seller E, 17:51 UTC.** The seller said nothing. After the 60 s window, `finalize` marked SILENT.
- **Seller D, 17:52 UTC.** The seller tried a wrong key, the contract reverted it, and the failed transaction stays on the chain. It then said nothing and `finalize` marked SILENT.
- **Seller B, 16:03 UTC.** The seller declares no recovery. On its own run, vet402 stopped at "Charged once. Nothing delivered. No second charge." The comparison shows what a retry with a new signature does instead.

These sellers are mine. A healthy seller answers, so every payout above comes from a seller I stopped on purpose.

## Still to record

- Return to hold on the screen: `{{TODO: run, amounts, time}}`. The `withdrawClaimable` step has run (table above).
- Seller C and the delivery check: `{{TODO: run, receipt, time}}`.
- The normal path on Arc testnet with `SELLER_DROP_RESPONSE=off`: `{{TODO: transfer id, claim count, time}}`. It has run on a local anvil chain with `scripts/sealed-local-e2e.ts`.

# Integration debrief

## World ID

On 2026-11-05 the staging Simulator passed the budget approval, the hold approval, the refusal of an approval made for another hold, and Cancel.

### Time to first success

{{TODO}}

### Friction

From the staging Simulator on 2026-11-04:

- Pasting the request URL opens the confirmation screen without a press on Continue. One extra press closes it, and the request is used up.
- The Continue button on the confirmation screen sits below the visible area. I pressed it through the page's DOM.
- The app's tab has to stay in front during the approval. In a background tab, the screen does not move on.

From the demo run: {{TODO}}

### Missing capability or documentation

{{TODO}}

### The one improvement with the greatest impact

{{TODO}}
