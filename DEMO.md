# Demo record

All rows are from Arc testnet on 2026-11-05, with times in UTC. Every payment to Sellers A to F is 0.001 USDC. For the runs on the live contract, the status and batch columns are what Circle's Gateway API had returned to the app by 23:20 UTC, and each batch transaction read status 1 on Arc at 23:27 UTC. A status of "completed" means settled in the batch shown, and "received" means accepted and waiting for a batch.

## Runs on the live contract

SealedDelivery at [`0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5`](https://explorer.testnet.arc.io/address/0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5), deployed by Arc Studio at 22:20 UTC. Sellers A, D, E and F each deposited 0.1 USDC between 22:21 and 22:22 UTC.

### The filmed run, 22:40 to 22:49 UTC

The video shows these rows. The dispute boxes of this run went to Swarm through the public gateway and its null stamp, because my own postage batch did not exist until 22:53 UTC.

| Time | Seller | Gateway transfer id | Status | Batch | Outcome on the receipt |
|---|---|---|---|---|---|
| 22:40:20 | Seller B | `f463cf69-d4f9-4876-87c5-e3000f892c6e` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Charged once. Nothing delivered. No second charge. |
| 22:40:39 | Seller B | `17e96a27-92f2-448c-96ee-69db53dc6e04` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Circle record: 2 transfers. Charged twice. |
| 22:40:39 | Seller B | `a375cc06-60dd-4e00-a13d-65527f23d9f4` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Circle record: 2 transfers. Charged twice. |
| 22:41:02 | Seller A | `58442140-a62e-44d8-bd61-c3347603dcc8` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 22:41:27 | Seller A | `57a206a2-b22b-4eaf-a640-c308baf75a2f` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 22:41:53 | Seller A | `bd1d9c5a-4036-4131-987b-9661461ceff4` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 22:42:38 | Seller A | `271b8452-365d-4fda-8d49-0019cbdcb4e2` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Charged once. Delivered. |
| 22:42:58 | Seller F | `4366d134-5d73-49ac-886c-7b5a781c6c54` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | The answer did not match the seller's promise. Its deposit paid 0.0115 USDC back. |
| 22:44:31 | Seller E | `1356dc93-5c7f-4ff8-87d1-ae6bd2ea6603` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 22:45:59 | Seller D | `5293b15e-a839-4fdf-90ff-9e8553bc715b` | completed | [`0xad5a6fc0…`](https://explorer.testnet.arc.io/tx/0xad5a6fc01a330b44e31cf0434b3e5272d3f86687cd7f4b178f32771ff59cbc94) | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.0115 USDC back. |

### The second run, 23:11 to 23:16 UTC

The same contract and sellers, after my postage batch existed. Each dispute box went to Swarm through my own Bee node, stamped with batch `b6455d93…`, as [arkiv/swarm.md](arkiv/swarm.md) describes.

| Time | Seller | Gateway transfer id | Status | Batch | Outcome on the receipt |
|---|---|---|---|---|---|
| 23:11:06 | Seller A | `2db76ef8-52a2-4548-bbb6-3bdbc943aad9` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 23:15:27 | Seller E | `66884550-c03f-42e2-89ed-f0ddc83851cc` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 23:16:33 | Seller D | `a2a52883-c727-4a60-9ea2-c1fa16fbf325` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 23:16:45 | Seller F | `009ab265-3fd0-495c-8eb4-551669e779e4` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | The answer did not match the seller's promise. Its deposit paid 0.0115 USDC back. |

### A seller from the catalog

Asked whether the latest payment went through, vet402 picked a listing named Quicknode and asked "May I spend up to 0.0001 USDC on this job?" After the approval it paid 0.0001 USDC once. These receipts carry no outcome line, so the last column is the text on the screen.

| Time | Seller | Gateway transfer id | Status | Batch | On the screen |
|---|---|---|---|---|---|
| 22:48:32 | Quicknode | `12166eb9-22bb-431b-b621-c68ad4c93538` | completed | [`0x85f0035f…`](https://explorer.testnet.arc.io/tx/0x85f0035f53533e3d582234b3be960791c717046826a4b26cab56acf6b3fed75f) | "Yes, your payment went through." "Spent 0.0001 USDC" |
| 23:07:48 | Quicknode | `4f44731a-6bb2-48fe-90ff-f8b92b620a2b` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | The same two lines, on the phone layout |

Time from the start of the run, as the progress line on the screen showed it:

| Run | Time |
|---|---|
| Seller A, line up, no contract transaction | 1.3 s |
| Seller A, key read from the chain after a claim | 9.0 s, on the third try. The first two took 10.8 s and 10.3 s |
| Seller F, key read from the chain after a claim | 8.6 s |

## Contract transactions

All 37 transactions of the two runs and of the deposits before them. The fee is gas used times the gas price each one paid, read from its receipt. Scene names come from the events each transaction left. Between 22:22 and 22:35 UTC, 11 more transactions reached the contract from checks before the film: 5 claims, 5 answers and a 0.5 USDC deposit from an address outside these tables. None of them ended in a verdict.

| Time | Scene | Call | Sent by | Gas used | Gas price in gwei | Fee in USDC | Transaction |
|---|---|---|---|---:|---:|---:|---|
| 22:21:47 | Seller A | `deposit` | Seller A | 76,917 | 25 | 0.0019 | [`0xebf7b029…`](https://explorer.testnet.arc.io/tx/0xebf7b0293c574e6bd63bfed5b4ed45ecb51c97962d4d6e968da5ecbd43b6466f) |
| 22:21:53 | Seller D | `deposit` | Seller D | 76,917 | 25 | 0.0019 | [`0xfadac172…`](https://explorer.testnet.arc.io/tx/0xfadac1723b1293221b523b767e82d9a489235777c7cc58064e1f4e44e0ffc963) |
| 22:21:56 | Seller E | `deposit` | Seller E | 76,917 | 25 | 0.0019 | [`0x7e099b77…`](https://explorer.testnet.arc.io/tx/0x7e099b7758c234226395913c1c6156f0db33ac95e4d532af93a00304f00f8948) |
| 22:22:01 | Seller F | `deposit` | Seller F | 76,917 | 25 | 0.0019 | [`0xdb181507…`](https://explorer.testnet.arc.io/tx/0xdb1815072c26f3e7799f30c4d2bedba2eeba1dbbd7c722cbd2a8106a036f021b) |
| 22:40:54 | Seller A | `claim` | vet402 hold | 268,376 | 24.675 | 0.0066 | [`0x825fe0c5…`](https://explorer.testnet.arc.io/tx/0x825fe0c574da4f252115544633bd1b5d3aefe9a329bf63a784a8234a967c1dbe) |
| 22:41:00 | Seller A | `answer` | Seller A | 52,811 | 24.675 | 0.0013 | [`0xc3797d8f…`](https://explorer.testnet.arc.io/tx/0xc3797d8f451badc0a20595b6e944f91edda32c375cc5c178ade9c63a7aa39460) |
| 22:41:20 | Seller A | `claim` | vet402 hold | 268,424 | 24.675 | 0.0066 | [`0x03e72e28…`](https://explorer.testnet.arc.io/tx/0x03e72e28df61659c41939b3f766e6babc00709ff46e1586d82c2a8e4f6f3ee0c) |
| 22:41:24 | Seller A | `answer` | Seller A | 52,811 | 24.675 | 0.0013 | [`0xa25c9e9f…`](https://explorer.testnet.arc.io/tx/0xa25c9e9f0bf182d3a59efceb5733fdc718be8246a8881a05dd4563fddec65ee5) |
| 22:41:47 | Seller A | `claim` | vet402 hold | 268,400 | 24.675 | 0.0066 | [`0xe5bc6bdb…`](https://explorer.testnet.arc.io/tx/0xe5bc6bdb0cecef65b542e66917fe290429952774973af6b92d0605b76138d3cb) |
| 22:41:52 | Seller A | `answer` | Seller A | 52,811 | 24.675 | 0.0013 | [`0xd437bafb…`](https://explorer.testnet.arc.io/tx/0xd437bafb360742a03be9f4900f2efaa96a3d2fd8387179e5f2c4c83f50dc792d) |
| 22:42:53 | Seller F | `claim` | vet402 hold | 268,436 | 24.675 | 0.0066 | [`0xb9214a10…`](https://explorer.testnet.arc.io/tx/0xb9214a1089666e9b82106c425095b94e2da39f968ea71056d6fbdc7afd1d8db1) |
| 22:42:56 | Seller F | `answer` | Seller F | 87,400 | 25 | 0.0022 | [`0x211a089a…`](https://explorer.testnet.arc.io/tx/0x211a089a2bd47d5a549accd135fa84ae36d6e49d20a9dbbb34a9d06cb590ec49) |
| 22:43:03 | Seller F | `prove` | vet402 hold | 123,426 | 25 | 0.0031 | [`0xe72c3f4c…`](https://explorer.testnet.arc.io/tx/0xe72c3f4cb07caf1c19757c1b1029749fc89f8c19e31004aa338547b30af3d46b) |
| 22:43:04 | Seller F | `flushBurn` | vet402 hold | 57,278 | 25 | 0.0014 | [`0xbbcf078a…`](https://explorer.testnet.arc.io/tx/0xbbcf078aa93e38ab4c01f183713c22a2686fc173b363b95d0e855d1ce594add4) |
| 22:43:19 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,249 | 25 | 0.0013 | [`0xdb2e65cb…`](https://explorer.testnet.arc.io/tx/0xdb2e65cb3ac1bae0ea03982d9ef797a402b77d9d55a05936e91d3a429aa59d77) |
| 22:43:29 | Seller E | `claim` | vet402 hold | 268,460 | 25 | 0.0067 | [`0x24182416…`](https://explorer.testnet.arc.io/tx/0x24182416082b271fe9a2a94897e4151e3a2b80bb0aeda1c991d2a3189c3e3fd6) |
| 22:44:35 | Seller E | `finalize` | vet402 hold | 115,781 | 25 | 0.0029 | [`0xc60c0312…`](https://explorer.testnet.arc.io/tx/0xc60c0312308f03d84561f7f81671947c3095b255f6cc7a60531c178cabe8d127) |
| 22:44:37 | Seller E | `flushBurn` | vet402 hold | 57,278 | 25 | 0.0014 | [`0x2e1caab0…`](https://explorer.testnet.arc.io/tx/0x2e1caab06c3efd9cb71782f22790f0978baea46dd04ac1894229068f92f877ba) |
| 22:44:50 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,249 | 25 | 0.0013 | [`0xa42627d4…`](https://explorer.testnet.arc.io/tx/0xa42627d42459b92d6d2d9dab7bb067316b5359a6eb79ef4e208d25b56c4d4903) |
| 22:44:58 | Seller D | `claim` | vet402 hold | 268,460 | 25 | 0.0067 | [`0xf011ece9…`](https://explorer.testnet.arc.io/tx/0xf011ece93a231868a637ac2a881411d1150af78230a920f4f4b07bdb7a12ac26) |
| 22:45:01 | Seller D | `answer, reverted` | Seller D | 29,279 | 25 | 0.0007 | [`0x66112b6d…`](https://explorer.testnet.arc.io/tx/0x66112b6d4e17ffc01e84a3fde32eb6d3a6fc65a3e20140df14238355f3d1f100) |
| 22:46:02 | Seller D | `finalize` | vet402 hold | 115,781 | 25 | 0.0029 | [`0xcf628ca2…`](https://explorer.testnet.arc.io/tx/0xcf628ca23d50eb6e9197c0bfc1882d2d5fda81c73f3018fb1ca9f161d7a053a5) |
| 22:46:04 | Seller D | `flushBurn` | vet402 hold | 57,278 | 25 | 0.0014 | [`0xfb9b9609…`](https://explorer.testnet.arc.io/tx/0xfb9b960985db481d10190d23ffdea5b895b8789e7bbf0bef582216a81f3f090c) |
| 22:46:16 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,249 | 25 | 0.0013 | [`0x638c68d7…`](https://explorer.testnet.arc.io/tx/0x638c68d78d887691b7fc7ca5c75844def3f6abd4ffea57455a58c205ce582523) |
| 23:11:01 | Seller A | `claim` | vet402 hold | 268,424 | 20 | 0.0054 | [`0xca9db10c…`](https://explorer.testnet.arc.io/tx/0xca9db10caa096dc345a90e92a03d5e9f3c884ca7b8e6af3714c48e0a52b04ee4) |
| 23:11:04 | Seller A | `answer` | Seller A | 52,811 | 20 | 0.0011 | [`0x0f6752e5…`](https://explorer.testnet.arc.io/tx/0x0f6752e5cabab8a243601cc6b79d93fbd6c1490cff61174a4a7beb3344557c95) |
| 23:14:26 | Seller E | `claim` | vet402 hold | 268,436 | 20 | 0.0054 | [`0xfc53d7bf…`](https://explorer.testnet.arc.io/tx/0xfc53d7bf96d122402f1b8314d65267d92375daca55e4a1ccfca4ccb7c7489718) |
| 23:15:29 | Seller E | `finalize` | vet402 hold | 98,681 | 20 | 0.0020 | [`0x192eaa0f…`](https://explorer.testnet.arc.io/tx/0x192eaa0f1f97dee3e7f609418315dab4fa3f2c11f8af7b5d0736cfeaecf69b74) |
| 23:15:30 | Seller E | `flushBurn` | vet402 hold | 57,278 | 20 | 0.0011 | [`0xee177c11…`](https://explorer.testnet.arc.io/tx/0xee177c111a875776bb356839c49ae3c8b6129f23fef9985bd0e930ea077a4e6b) |
| 23:15:33 | Seller D | `claim` | vet402 hold | 268,448 | 20 | 0.0054 | [`0x58874455…`](https://explorer.testnet.arc.io/tx/0x58874455cae2ee594abde78a6e1bc959d8fedf7567f18f3211b88b9804da040d) |
| 23:15:36 | Seller D | `answer, reverted` | Seller D | 29,279 | 20 | 0.0006 | [`0xb76b244b…`](https://explorer.testnet.arc.io/tx/0xb76b244b0c0464728071d5e3a63b00d05584716d79d89551d3446ccf5687e1f6) |
| 23:16:34 | Seller D | `finalize` | vet402 hold | 81,581 | 20 | 0.0016 | [`0xd8eadc3a…`](https://explorer.testnet.arc.io/tx/0xd8eadc3adf83198cd8fa617fb74df623c5f01050cc7bed9453a46ff266254c6b) |
| 23:16:36 | Seller D | `flushBurn` | vet402 hold | 57,278 | 20.6 | 0.0012 | [`0xf89b75f5…`](https://explorer.testnet.arc.io/tx/0xf89b75f5d1e94c3f563d4816591be37fc761ee2b864c4bcaabb57d5c39c5bdc9) |
| 23:16:39 | Seller F | `claim` | vet402 hold | 268,448 | 20.0015 | 0.0054 | [`0xf0aff221…`](https://explorer.testnet.arc.io/tx/0xf0aff221c7c035a245bdbd478b0e3ad5c063f649e249f8cc6630e1dd43977afa) |
| 23:16:44 | Seller F | `answer` | Seller F | 52,811 | 20 | 0.0011 | [`0xce350719…`](https://explorer.testnet.arc.io/tx/0xce350719108ff80906dcb72fa72f7807257ad20ce4cf843c384e481d785d5dac) |
| 23:16:47 | Seller F | `prove` | vet402 hold | 89,226 | 20 | 0.0018 | [`0x3b79b1c3…`](https://explorer.testnet.arc.io/tx/0x3b79b1c3d425d87c451ced48244532871f593a0b947698b47d40a0765ce3e9ed) |
| 23:16:49 | Seller F | `flushBurn` | vet402 hold | 57,278 | 20 | 0.0011 | [`0x323eeb1b…`](https://explorer.testnet.arc.io/tx/0x323eeb1b3a71432aa1375c6ef6a0b1094aac3f3df812ca3361391e7ca84222a6) |

The contract read at 23:23 UTC:

| Seller | Address | Deposit in USDC | `silentCount` | `fraudCount` |
|---|---|---:|---:|---:|
| Seller A | `0x71f8005aE7757857DC6b7418b9beC75F19546aC3` | 0.1 | 0 | 0 |
| Seller D | `0xB9a6F77d9EFDFcF165e1259fC650fFA01b06B80D` | 0.054 | 2 | 0 |
| Seller E | `0x2d86121923E9662D4d926d657FE91A2141BD93e8` | 0.054 | 2 | 0 |
| Seller F | `0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d` | 0.054 | 0 | 2 |

Each verdict took 0.023 USDC, which is 2 x (0.001 + 0.0105): 0.0115 credited to the buyer and 0.0115 burned. The buyer withdrew the three credits of the filmed run, 0.0345 USDC in all, in three `withdrawClaimable` calls. The three credits of the second run, also 0.0345 USDC, were still claimable at 23:23 UTC.

## What each scene shows

- **Seller B, 22:40 UTC.** One payment, nothing delivered and no second charge. Then the comparison: a retry with a new signature, marked on the screen "Comparison only. vet402 does not do this." Circle's record shows 2 transfers.
- **Seller A, 22:41 UTC.** The key request closed. vet402 sent a claim, Seller A answered on chain, and the run had the key 9.0 s from its start. Circle's record shows 1 transfer for this payment.
- **Seller A, line up, 22:42 UTC.** The key arrived on its own request. Among the contract's 15 `Claimed` events at 23:31 UTC, none is for this payment.
- **Seller F, 22:42 UTC.** The seller answered with a key that opens something other than what it signed. `prove` marked FRAUD.
- **Seller E, 22:43 UTC.** The seller said nothing. After the 60 s window, `finalize` marked SILENT.
- **Seller D, 22:44 UTC.** The seller tried a wrong key, the contract reverted it, and the failed transaction stays on the chain. It then said nothing and `finalize` marked SILENT.
- **Seller C, 22:49 UTC.** The screen read "Seller C: No recent delivery from this seller. Not paid." and vet402 paid nothing. Seller C's Arkiv entity uses a short lifetime for this demo, and every other seller's lasts 7 days.

These sellers are mine. A healthy seller answers, so every payout above comes from a seller I stopped or told to cheat.

## Earlier runs

These rows ran before the live contract. The status and batch columns are what Circle's Gateway API returned at 18:49 UTC. The Seller A and Seller B rows at 16:03 and 16:04 came before any contract was deployed, and the two Seller B rows at 16:04 are the first comparison: a retry with a new signature paid again. The rows from 17:49 to 17:53 ran on an earlier deployment, [`0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2`](https://explorer.testnet.arc.io/address/0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2), with a 0.01 USDC deposit and no dispute cost, so each verdict there paid 0.001 USDC back. The Seller F row at 17:49:19 ended before any claim, and I did not record why it stopped there. The rows from 18:24 to 18:38 ran on the next deployment, [`0x20ce7bbfaf66b28cb917f9331a8960eb563f2094`](https://explorer.testnet.arc.io/address/0x20ce7bbfaf66b28cb917f9331a8960eb563f2094), deployed at 18:23 UTC from source that did not yet take a payment domain salt. Each seller deposited 0.1 USDC there.

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
| 18:24:45 | Seller A | `54df1711-eb16-4cb2-8feb-2a3636ec2675` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 18:25:00 | Seller F | `9d3fa911-7595-4b5f-8b9e-1c504ab7b50e` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | The answer did not match the seller's promise. Its deposit paid 0.0115 USDC back. |
| 18:26:09 | Seller E | `43e8770a-826d-4f21-9fe4-1214b1c0a68e` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 18:27:15 | Seller D | `1c0a0988-9a4c-4782-bfbc-64ac56428bb6` | completed | [`0xdc85805b…`](https://explorer.testnet.arc.io/tx/0xdc85805b12ed11f79167962d47d0e6d046f74c5d94170a5bb9f800a315ec835a) | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 18:36:01 | Seller A | `9cf02586-792d-4d80-b499-486f9894a20d` | received | not yet | Charged once. Delivered. |
| 18:38:20 | Seller C | `edacb3b5-452a-486d-971f-ff1ccf1767f5` | received | not yet | Paid once. 65 byte answer. |

The 25 gwei figures behind `DISPUTE_COST` come from the deployment at `0x2dab71e2…`: claim [`0xe458fddb…`](https://explorer.testnet.arc.io/tx/0xe458fddb561de5fb6425cf7c2775b26a465623d138187ed577d1d868f3528200) (268,317 gas), finalize [`0x89f03886…`](https://explorer.testnet.arc.io/tx/0x89f03886270480150bbdbf08e6d99eecd14c180b395db98e3b93350bc9932a4e) (98,681 gas) and withdrawClaimable [`0x6f06623e…`](https://explorer.testnet.arc.io/tx/0x6f06623e2c72f1aaf3e4e19ff2ba9a3ef6e8a9a32bea258da64bf3879fb95c40) (53,271 gas), 0.0105 USDC together.

### Contract transactions on `0x20ce7bbf…`

All 18 transactions of the 18:24 to 18:28 run. The fee is gas used times the 20 gwei each one paid, read from its receipt.

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

That contract read at 18:49 UTC:

| Seller | Address | Deposit in USDC | `silentCount` | `fraudCount` |
|---|---|---:|---:|---:|
| Seller A | `0x71f8005aE7757857DC6b7418b9beC75F19546aC3` | 0.1 | 0 | 0 |
| Seller D | `0xB9a6F77d9EFDFcF165e1259fC650fFA01b06B80D` | 0.077 | 1 | 0 |
| Seller E | `0x2d86121923E9662D4d926d657FE91A2141BD93e8` | 0.077 | 1 | 0 |
| Seller F | `0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d` | 0.077 | 0 | 1 |

Each verdict took 0.023 USDC, which is 2 x (0.001 + 0.0105): 0.0115 credited to the buyer and 0.0115 burned. The buyer withdrew its three credits, 0.0345 USDC, in [`0x436a0d25…`](https://explorer.testnet.arc.io/tx/0x436a0d25d21e4d11e1e2f80a083e0a41efbd3ca174ad5db0ff3d427b6116fb99).

Time from the start of those runs:

| Run | Time |
|---|---|
| Seller A, line up, no contract transaction | 1,120 ms |
| Seller A, key read from the chain after a claim | 6,758 ms |
| Seller F, key read from the chain after a claim | 12,787 ms |

# Integration debrief

## World ID

What ran on 2026-11-05 in the staging Simulator: "Budget set.", a hold of 0.02 USDC, "Not approved: this approval is for another hold." for a proof from another hold, and "Not approved. Nothing was held or paid." for Cancel request. It has not run in the real World App.

What ran in production on 2026-11-05 with the real World App on iOS: "Budget set." at 22:16 UTC, "Held 1 USDC for this job." at 22:16 UTC and again at 23:25 UTC for the video, and "Not approved. Nothing was held or paid." for Cancel request at 23:23 UTC. The verified result reads environment production, protocol 4.0, proof_of_human.

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
