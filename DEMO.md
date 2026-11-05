# Demo record

All rows are from Arc testnet on 2026-11-05, with times in UTC. Every payment is 0.001 USDC. The status and batch columns are what Circle's Gateway API returned for each transfer at 18:49 UTC. A status of "completed" means settled in the batch shown, and "received" means accepted and waiting for a batch.

## Runs on the live contract

SealedDelivery at [`0x20ce7bbfaf66b28cb917f9331a8960eb563f2094`](https://explorer.testnet.arc.io/address/0x20ce7bbfaf66b28cb917f9331a8960eb563f2094), deployed at 18:23 UTC. Each seller deposited 0.1 USDC.

| Time | Seller | Gateway transfer id | Status | Batch | Outcome on the receipt |
|---|---|---|---|---|---|
| 18:24:45 | Seller A | `54df1711-eb16-4cb2-8feb-2a3636ec2675` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 18:25:00 | Seller F | `9d3fa911-7595-4b5f-8b9e-1c504ab7b50e` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | The answer did not match the seller's promise. Its deposit paid 0.0115 USDC back. |
| 18:26:09 | Seller E | `43e8770a-826d-4f21-9fe4-1214b1c0a68e` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 18:27:15 | Seller D | `1c0a0988-9a4c-4782-bfbc-64ac56428bb6` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 18:36:01 | Seller A | `9cf02586-792d-4d80-b499-486f9894a20d` | received | not yet | Charged once. Delivered. |
| 18:38:20 | Seller C | `edacb3b5-452a-486d-971f-ff1ccf1767f5` | received | not yet | Paid once. 65 byte answer. |

Time from the start of the run:

| Run | Time |
|---|---|
| Seller A, line up, no contract transaction | 1,120 ms |
| Seller A, key read from the chain after a claim | 6,758 ms |
| Seller F, key read from the chain after a claim | 12,787 ms |

## Contract transactions

All 18 transactions of the run. The fee is gas used times the 20 gwei each one paid, read from its receipt. Scene names come from the events each transaction left.

| Time | Scene | Call | Sent by | Gas used | Fee in USDC | Transaction |
|---|---|---|---|---:|---:|---|
| 18:24:05 | Seller A | `deposit` | Seller A | 76,917 | 0.0015 | [`0x04152b3e…`](https://explorer.testnet.arc.io/tx/0x04152b3e50acdcf1abaac7b364dc166498891cdd92c3b141d62c8b6513cd0c6d) |
| 18:24:08 | Seller D | `deposit` | Seller D | 76,917 | 0.0015 | [`0xd045569f…`](https://explorer.testnet.arc.io/tx/0xd045569fb6d1514caf435f17837604ea8cb5167e706a3d838005cbe04bf8ae09) |
| 18:24:13 | Seller E | `deposit` | Seller E | 76,917 | 0.0015 | [`0xf7fb5e56…`](https://explorer.testnet.arc.io/tx/0xf7fb5e56204d65152a948f2d6cc74b2f54e4b7812af999eb41d4c3cb4397909e) |
| 18:24:17 | Seller F | `deposit` | Seller F | 76,917 | 0.0015 | [`0x81f793ce…`](https://explorer.testnet.arc.io/tx/0x81f793cebcb3ea8b6afc4e94eae085f6944662c643789fa7875056dd8d05fd46) |
| 18:24:42 | Seller A | `claim` | vet402 hold | 268,424 | 0.0054 | [`0xd67c5d03…`](https://explorer.testnet.arc.io/tx/0xd67c5d030004f9695035aae255e1bd66b75f8ded9a5cda6978997b4bd6ba9bf8) |
| 18:24:44 | Seller A | `answer` | Seller A | 87,400 | 0.0017 | [`0x69391c38…`](https://explorer.testnet.arc.io/tx/0x69391c38549ab90e586b012ba944feb94c4ec664852fe81941d6f894ae59d55a) |
| 18:24:51 | Seller F | `claim` | vet402 hold | 268,460 | 0.0054 | [`0x917d7469…`](https://explorer.testnet.arc.io/tx/0x917d74690fa2f67185d0a6efae470250045f25b407ff5cf3c70cd8e146c58bcc) |
| 18:24:57 | Seller F | `answer` | Seller F | 87,400 | 0.0017 | [`0x118c709d…`](https://explorer.testnet.arc.io/tx/0x118c709d54106e4bcfe152024212a07453b9c51f74d649a201b06fcbe7d37140) |
| 18:25:03 | Seller F | `prove` | vet402 hold | 123,426 | 0.0025 | [`0x47d1364e…`](https://explorer.testnet.arc.io/tx/0x47d1364ecb9c29e640e6a25829fcda33efeee668401e8a8f68564d1e7a1ba13e) |
| 18:25:04 | Seller F | `flushBurn` | vet402 hold | 57,278 | 0.0011 | [`0x6752770d…`](https://explorer.testnet.arc.io/tx/0x6752770d58e4f334ff5a10a3b2234b4f8406e94ce073ee8ac17524f6f1f6e37e) |
| 18:25:08 | Seller E | `claim` | vet402 hold | 268,436 | 0.0054 | [`0xc5c53a10…`](https://explorer.testnet.arc.io/tx/0xc5c53a10de47f010249539dce24000f4745fcad20d0d85a4c0d7c8a6bdaa7163) |
| 18:26:14 | Seller D | `claim` | vet402 hold | 268,460 | 0.0054 | [`0x254c013b…`](https://explorer.testnet.arc.io/tx/0x254c013b1b7f52b9b663062ab6f2069eff06b6bf54ec529df89eb19c44fa6710) |
| 18:26:21 | Seller D | `answer, reverted` | Seller D | 29,279 | 0.0006 | [`0x51984021…`](https://explorer.testnet.arc.io/tx/0x51984021d48067cf593d6eef56889c5296d5e756c088fc47f16149166fbdb059) |
| 18:28:29 | Seller E | `finalize` | vet402 hold | 98,669 | 0.0020 | [`0xc41cc0cb…`](https://explorer.testnet.arc.io/tx/0xc41cc0cb903d976d4dc18a8fa252d5730646adf962e174b64f4f6b0c76f96b93) |
| 18:28:30 | Seller E | `flushBurn` | vet402 hold | 57,278 | 0.0011 | [`0x6d18b826…`](https://explorer.testnet.arc.io/tx/0x6d18b8266515e635bd12905224835567873a2098821faab609432b5ec4b35203) |
| 18:28:33 | Seller D | `finalize` | vet402 hold | 98,681 | 0.0020 | [`0xad945fdd…`](https://explorer.testnet.arc.io/tx/0xad945fdd6a3df5b4d4f034a481a555b2667bcd32fcac422bda4469af4c63d895) |
| 18:28:35 | Seller D | `flushBurn` | vet402 hold | 57,278 | 0.0011 | [`0x0ca5d690…`](https://explorer.testnet.arc.io/tx/0x0ca5d690fb1d308dc2486d842a71e9de6bd2308acef6f25e41bdd3aa41b1d21a) |
| 18:28:37 | All credits | `withdrawClaimable` | vet402 hold | 53,249 | 0.0011 | [`0x436a0d25…`](https://explorer.testnet.arc.io/tx/0x436a0d25d21e4d11e1e2f80a083e0a41efbd3ca174ad5db0ff3d427b6116fb99) |

The contract read at 18:49 UTC:

| Seller | Address | Deposit in USDC | `silentCount` | `fraudCount` |
|---|---|---:|---:|---:|
| Seller A | `0x71f8005aE7757857DC6b7418b9beC75F19546aC3` | 0.1 | 0 | 0 |
| Seller D | `0xB9a6F77d9EFDFcF165e1259fC650fFA01b06B80D` | 0.077 | 1 | 0 |
| Seller E | `0x2d86121923E9662D4d926d657FE91A2141BD93e8` | 0.077 | 1 | 0 |
| Seller F | `0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d` | 0.077 | 0 | 1 |

Each verdict took 0.023 USDC, which is 2 x (0.001 + 0.0105): 0.0115 credited to the buyer and 0.0115 burned. The buyer withdrew its three credits, 0.0345 USDC, in [`0x436a0d25…`](https://explorer.testnet.arc.io/tx/0x436a0d25d21e4d11e1e2f80a083e0a41efbd3ca174ad5db0ff3d427b6116fb99).

## What each scene shows

- **Seller A, line up, 18:36 UTC.** The key arrived on its own request. Among the contract's 4 `Claimed` events at 18:49 UTC, none is for this payment.
- **Seller A, 18:24 UTC.** The key request closed. vet402 sent a claim, Seller A answered on chain, and the run had the key 6,758 ms from its start. Circle's record shows 1 transfer for this payment.
- **Seller F, 18:24 UTC.** The seller answered with a key that opens something other than what it signed. `prove` marked FRAUD.
- **Seller E, 18:25 UTC.** The seller said nothing. After the 60 s window, `finalize` marked SILENT.
- **Seller D, 18:26 UTC.** The seller tried a wrong key, the contract reverted it, and the failed transaction stays on the chain. It then said nothing and `finalize` marked SILENT.
- **Seller C, 18:38 UTC.** vet402 paid Seller C once. About 100 s later it read "Seller C: No recent delivery from this seller. Not paid." and offered the next listing, BotPay, which I did not pay. Seller C's Arkiv entity uses a short lifetime for this demo, and every other seller's lasts 7 days.

These sellers are mine. A healthy seller answers, so every payout above comes from a seller I stopped or told to cheat.

## Earlier runs

The receipt list also holds these rows. The Seller A and Seller B rows came before any contract was deployed, and the two Seller B rows at 16:04 are the comparison: a retry with a new signature paid again. The rows from 17:49 to 17:53 ran on an earlier deployment, [`0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2`](https://explorer.testnet.arc.io/address/0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2), with a 0.01 USDC deposit and no dispute cost, so each verdict there paid 0.001 USDC back. The Seller F row at 17:49:19 ended before any claim, and I did not record why it stopped there.

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

The 25 gwei figures behind `DISPUTE_COST` come from that earlier deployment: claim [`0xe458fddb…`](https://explorer.testnet.arc.io/tx/0xe458fddb561de5fb6425cf7c2775b26a465623d138187ed577d1d868f3528200) (268,317 gas), finalize [`0x89f03886…`](https://explorer.testnet.arc.io/tx/0x89f03886270480150bbdbf08e6d99eecd14c180b395db98e3b93350bc9932a4e) (98,681 gas) and withdrawClaimable [`0x6f06623e…`](https://explorer.testnet.arc.io/tx/0x6f06623e2c72f1aaf3e4e19ff2ba9a3ef6e8a9a32bea258da64bf3879fb95c40) (53,271 gas), 0.0105 USDC together.

# Integration debrief

## World ID

What ran on 2026-11-05 in the staging Simulator: "Budget set.", a hold of 0.02 USDC, "Not approved: this approval is for another hold." for a proof from another hold, and "Not approved. Nothing was held or paid." for Cancel request. It has not run in the real World App.

### Time to first success

About 25 minutes, from handing over the instruction to "Budget set." on staging, 2026-11-05 16:05 to 16:29 UTC.

### Friction

- The Simulator's Cancel does not reach the app, so I put Cancel request in the app.
- Pasting the request URL opens the confirmation screen without a press on Continue. One extra press closes it, and the request is used up.
- The Continue button on the confirmation screen is cut off at the bottom.
- The app's tab has to stay in front during the approval. In a background tab the screen does not move on (seen on 2026-11-04).
- I made a hold above the budget fail on purpose, so a 0.05 USDC request against a 0.02 USDC budget reads "Not approved." That is this app's rule, and a tester should expect it.

### Missing capability or documentation

Selfie Check returned `credential_unavailable` on staging for both request and createSession (2026-10-28 UTC). Only `proof_of_human` passes there. The Simulator's screen reads "Unique device" while the returned identifier is `proof_of_human`.

### The one improvement with the greatest impact

Send the Simulator's Cancel back to the app.
