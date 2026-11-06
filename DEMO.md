# Demo record

Times are UTC. Every payment to Sellers A to F is 0.001 USDC. On the live contract, the status and batch columns are what Circle's Gateway API returned on 2026-11-06 at 02:12 UTC, and each batch transaction shown read status 1 on Arc. A status of "completed" means settled in the batch shown, and "received" means accepted and waiting for a batch.

## Runs on the live contract

SealedDelivery at [`0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B`](https://explorer.testnet.arc.io/address/0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B), deployed on 2026-11-06 at 01:35:22 UTC with `forge create` from the terminal of the Arc Studio sandbox. This version repays the buyer's claim gas when the seller answers, and counts the buyer's gas for the whole dispute, at the gas price the claim paid, when the seller is silent or lies. Sellers A, D, E and F each deposited 0.5 USDC between 01:37:28 and 01:37:42 UTC. Every dispute box of both runs went to Swarm through my own Bee node, stamped with batch `b6455d93…`, and the public gateway returned each one with status 200 at 02:23 UTC.

### The run of 01:59 to 02:04 UTC

The receipt lines of this run name what the seller's deposit repaid. The app has written them since commit `b1516fe` (01:57 UTC).

| Time | Seller | Gateway transfer id | Status | Batch | Outcome on the receipt |
|---|---|---|---|---|---|
| 01:59:46 | Seller A | `ce288e80-588d-4011-a3ba-3b39f0ee7d04` | received | not yet | Charged once. Key read from Arc. Claim gas repaid by the seller: 0.006949 USDC. Circle record: 1 transfer for this payment. |
| 02:00:38 | Seller F | `f2976e7b-f3bf-4f2b-8eb0-8573d8136551` | received | not yet | Claim gas repaid by the seller: 0.006949 USDC. The answer did not match the seller's promise. Its deposit paid 0.013699 USDC back: the 0.001 USDC price and 0.012699 USDC for the gas of the dispute. |
| 02:02:10 | Seller E | `ef5aa44e-326d-4c14-b172-5e4714ad5155` | received | not yet | The seller stayed silent. Its deposit paid 0.011413 USDC back: the 0.001 USDC price and 0.010413 USDC for the gas of the dispute. |
| 02:03:37 | Seller D | `5e29ef26-8d1b-4482-802a-5f2700d1eb5e` | received | not yet | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.012142 USDC back: the 0.001 USDC price and 0.011142 USDC for the gas of the dispute. |

### The run of 01:42 to 01:46 UTC

The same contract and sellers. The receipt lines then gave the total the deposit paid back, without the split.

| Time | Seller | Gateway transfer id | Status | Batch | Outcome on the receipt |
|---|---|---|---|---|---|
| 01:42:09 | Seller A | `4c985dc0-a59d-4674-9e8a-3d5d25def02b` | completed | [`0xd0b83004…`](https://explorer.testnet.arc.io/tx/0xd0b83004e37e87ef7989a1f959eca260d93ec3fe6dd87fa867d0dc5fc6b4e717) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 01:42:42 | Seller A | `8df8ff6d-df86-4aa1-b9fb-840347074510` | completed | [`0xd0b83004…`](https://explorer.testnet.arc.io/tx/0xd0b83004e37e87ef7989a1f959eca260d93ec3fe6dd87fa867d0dc5fc6b4e717) | Charged once. Delivered. |
| 01:42:58 | Seller F | `dbda6993-d073-4a49-a77d-5fb141d26a99` | completed | [`0xd0b83004…`](https://explorer.testnet.arc.io/tx/0xd0b83004e37e87ef7989a1f959eca260d93ec3fe6dd87fa867d0dc5fc6b4e717) | The answer did not match the seller's promise. Its deposit paid 0.011286 USDC back. |
| 01:44:23 | Seller E | `8803053c-2f8c-4a56-95c5-841305552730` | completed | [`0x91d26e68…`](https://explorer.testnet.arc.io/tx/0x91d26e68501a1ca35861e71d6b292b1b8297e9408cf688781c50dc4bd7eea5fe) | The seller stayed silent. Its deposit paid 0.013268 USDC back. |
| 01:45:48 | Seller D | `120cc649-10f0-49cd-a72b-76177c387742` | completed | [`0x91d26e68…`](https://explorer.testnet.arc.io/tx/0x91d26e68501a1ca35861e71d6b292b1b8297e9408cf688781c50dc4bd7eea5fe) | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.013699 USDC back. |

Time from the start of the run, as the progress line on the screen showed it:

| Run | 01:42 run | 01:59 run |
|---|---|---|
| Seller A, line up, no contract transaction | Delivered at 2.1 s | Not run |
| Seller A, key on chain after a claim | 9.5 s | 7.2 s |
| Seller F, key on chain after a claim | 5.9 s | 7.1 s |
| Seller E, from the claim on the screen to the verdict on the screen | 57.7 s | 57.7 s |
| Seller D, the same | 56.6 s | 58.7 s |

## Contract transactions

All 46 transactions of the live contract from its deploy to 02:05 UTC, read on 2026-11-06 at 02:10 UTC. The fee is gas used times the gas price each one paid, read from its receipt with `cast receipt`. Every one read status 1 except the two marked reverted, where the contract refused Seller D's wrong key on purpose. Scene names come from the events each transaction left. The "Try a dispute" rows come from the card of that name on the published screen, which pays from its own wallets.

| Time | Scene | Call | Sent by | Gas used | Gas price in gwei | Fee in USDC | Transaction |
|---|---|---|---|---:|---:|---:|---|
| 01:35:22 | Deploy | deploy | Studio sandbox deployer | 2,443,571 | 26.25 | 0.064144 | [`0x38095fb7…`](https://explorer.testnet.arc.io/tx/0x38095fb7894b86e2c57be1d1bb6e367ddbc6fd9fc9276ecacc43ac37701b3733) |
| 01:37:28 | Seller A | `deposit` | Seller A | 76,873 | 25 | 0.001922 | [`0x5b33f435…`](https://explorer.testnet.arc.io/tx/0x5b33f435b8c014a645ab9d19513758eea9792995fd053fbbc2493836c26cf3ec) |
| 01:37:33 | Seller D | `deposit` | Seller D | 76,873 | 25 | 0.001922 | [`0x6c4d7170…`](https://explorer.testnet.arc.io/tx/0x6c4d717023e5b67160e104cf571b6cd5fb1d9d33c57208bc39a1abb153023fb5) |
| 01:37:38 | Seller E | `deposit` | Seller E | 76,873 | 25 | 0.001922 | [`0xe9c73765…`](https://explorer.testnet.arc.io/tx/0xe9c737658da1c95aa4adb679722f18b1375b976d602b9103fcefa41de02bcfa6) |
| 01:37:42 | Seller F | `deposit` | Seller F | 76,873 | 25 | 0.001922 | [`0x18030edb…`](https://explorer.testnet.arc.io/tx/0x18030edb6c367c96b2a380bfd46c4fbc59f0cbe287f6d89b4c20eaf625f7f994) |
| 01:37:47 | Try a dispute | `deposit` | Try page seller | 76,873 | 25 | 0.001922 | [`0x84b129cc…`](https://explorer.testnet.arc.io/tx/0x84b129ccc1e6478e0c95b861bdd0d1544322a636e3f853fb1116cfcbc5350127) |
| 01:38:54 | Try a dispute | `claim` | Try page buyer | 271,037 | 25 | 0.006776 | [`0x689b8d27…`](https://explorer.testnet.arc.io/tx/0x689b8d27fc0ac021ed1fe2df4ddc70ab8d32a621c56c07f849e66dc50496a124) |
| 01:38:56 | Try a dispute | `answer` | Try page seller | 131,592 | 25 | 0.003290 | [`0x1a448509…`](https://explorer.testnet.arc.io/tx/0x1a4485096f2db4a424553ee53c8f2bf20719c27ca2e78ede81ac2996617a2764) |
| 01:42:03 | Seller A | `claim` | vet402 hold | 271,013 | 20.5 | 0.005556 | [`0x1269e948…`](https://explorer.testnet.arc.io/tx/0x1269e9487f9fbe1207f1791cfdc9963bf9fb20d93854722c9f794f79c597f94b) |
| 01:42:09 | Seller A | `answer` | Seller A | 131,604 | 20.5 | 0.002698 | [`0xa63eaf5a…`](https://explorer.testnet.arc.io/tx/0xa63eaf5ac05d8ebb22c1467ddc407984e92a7fe573d167f001ab403ac16117a4) |
| 01:42:55 | Seller F | `claim` | vet402 hold | 271,037 | 20.25 | 0.005488 | [`0x3166cf39…`](https://explorer.testnet.arc.io/tx/0x3166cf39c1e8e1519d01919d7d0070bde27c7bb4e2afe8b0a2950c751d67e5b8) |
| 01:42:58 | Seller F | `answer` | Seller F | 131,604 | 20.25 | 0.002665 | [`0xf1de7032…`](https://explorer.testnet.arc.io/tx/0xf1de7032790189fa990df64f25cae545e09cfe8f1c457a8d4814307b9236c870) |
| 01:43:02 | Seller F | `prove` | vet402 hold | 123,452 | 20.91 | 0.002581 | [`0x150ef542…`](https://explorer.testnet.arc.io/tx/0x150ef54297bbdb1eedca156786479bd7794756ae6d82ee1b0fe4792deeb460aa) |
| 01:43:04 | Seller F | `flushBurn` | vet402 hold | 57,256 | 20.91 | 0.001197 | [`0x7e7c1e10…`](https://explorer.testnet.arc.io/tx/0x7e7c1e104179db2edcd2b03ee79c860220b330db731b90857a5716babd36e509) |
| 01:43:14 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,316 | 21.9555 | 0.001171 | [`0x9b7eb68a…`](https://explorer.testnet.arc.io/tx/0x9b7eb68a684713a98e64114d435f17987549087f63624b5758ffaa18f11334b7) |
| 01:43:22 | Seller E | `claim` | vet402 hold | 271,037 | 24.15105 | 0.006546 | [`0xa729e046…`](https://explorer.testnet.arc.io/tx/0xa729e04633170264ea393447055a8f8abd3b1d8acc26e64b505abfc716b8e855) |
| 01:44:27 | Seller E | `finalize` | vet402 hold | 115,862 | 25 | 0.002897 | [`0x16bd6163…`](https://explorer.testnet.arc.io/tx/0x16bd6163a9efd69bdbc46501d6145c605c90da43c530e9dfe2c920760368eb4a) |
| 01:44:28 | Seller E | `flushBurn` | vet402 hold | 57,256 | 25 | 0.001431 | [`0xc47ecec5…`](https://explorer.testnet.arc.io/tx/0xc47ecec5c7b558c6647ed9a0fee4946628b8c749215f9e7dfa6a76435cac47d8) |
| 01:44:39 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,316 | 25 | 0.001333 | [`0x082b65fe…`](https://explorer.testnet.arc.io/tx/0x082b65fe2ee6051342215e4b65e803830160ba77ca52f041b5dadda23a68c628) |
| 01:44:47 | Seller D | `claim` | vet402 hold | 271,025 | 25 | 0.006776 | [`0x6fad73fc…`](https://explorer.testnet.arc.io/tx/0x6fad73fc040c506dfc05a227a1559198af735d9bb940451772ab64f7812bb7f1) |
| 01:44:55 | Seller D | `answer`, reverted | Seller D | 29,267 | 25 | 0.000732 | [`0xba955fd6…`](https://explorer.testnet.arc.io/tx/0xba955fd6b74212f71105c6b58b131fa12d3fccea517497663b8a2e1167d013c4) |
| 01:45:54 | Seller D | `finalize` | vet402 hold | 115,862 | 20.5 | 0.002375 | [`0x1e35b1ba…`](https://explorer.testnet.arc.io/tx/0x1e35b1bac1709fc57a902b5b72cf5b98b34267d3a6a57791901d5d3814619360) |
| 01:45:56 | Seller D | `flushBurn` | vet402 hold | 57,256 | 20.5 | 0.001174 | [`0x8c32b787…`](https://explorer.testnet.arc.io/tx/0x8c32b787d3a70167ae0707d26e44806719eb7fd6ff5a3044e8e910b49e054a56) |
| 01:46:07 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,316 | 21.32 | 0.001137 | [`0xdbfc2bda…`](https://explorer.testnet.arc.io/tx/0xdbfc2bda76a2eec3615a9c3f5b7fe9b4a7ad4867f7ce0ec5dc43e56c4ea3c62a) |
| 01:48:44 | Try a dispute | `claim` | Try page buyer | 271,013 | 25 | 0.006775 | [`0xfcbd07a3…`](https://explorer.testnet.arc.io/tx/0xfcbd07a3833b22b620af2e11835a722bf6de456b53ad0665512b047ea8701d42) |
| 01:48:46 | Try a dispute | `answer` | Try page seller | 97,015 | 25 | 0.002425 | [`0xfe7db237…`](https://explorer.testnet.arc.io/tx/0xfe7db2374dad1d65d305eb0967c8dcbb805252df3539d91a00dd55f37f0805e3) |
| 01:56:28 | Try a dispute | `claim` | Try page buyer | 271,037 | 20.5 | 0.005556 | [`0x4e8db196…`](https://explorer.testnet.arc.io/tx/0x4e8db196572dfa4e25199a3840fd86fc80db754ee6a5eda04f4921d7b167135d) |
| 01:56:29 | Try a dispute | `answer` | Try page seller | 97,015 | 20.5 | 0.001989 | [`0x3b206333…`](https://explorer.testnet.arc.io/tx/0x3b206333f1e1ab42ae0336dda5126bfa49bb17cbe88bc85fb1b7913e63fa6cc7) |
| 01:59:42 | Seller A | `claim` | vet402 hold | 271,013 | 25 | 0.006775 | [`0x6fbe43cb…`](https://explorer.testnet.arc.io/tx/0x6fbe43cb52a151c51b4b01736bcc99f94bc9f98b249c42de09acf54c1af0d5da) |
| 01:59:45 | Seller A | `answer` | Seller A | 97,015 | 25 | 0.002425 | [`0x7e816df8…`](https://explorer.testnet.arc.io/tx/0x7e816df8f4631d9b0172c9a3da16f820f56dc4360f0657816d9914bc29f3fc11) |
| 02:00:33 | Seller F | `claim` | vet402 hold | 271,049 | 25 | 0.006776 | [`0x0bd9b723…`](https://explorer.testnet.arc.io/tx/0x0bd9b7234d1c29973260969109a2827ef35b0d45be73fd9efb570f285361f48f) |
| 02:00:36 | Seller F | `answer` | Seller F | 97,015 | 20.5 | 0.001989 | [`0x5a5e0606…`](https://explorer.testnet.arc.io/tx/0x5a5e06064433ab10ea339b76f5a8c3da64b6fdd37c97175182a67b173a1a74d0) |
| 02:00:43 | Seller F | `prove` | vet402 hold | 106,352 | 20.5 | 0.002180 | [`0xccfb2bd7…`](https://explorer.testnet.arc.io/tx/0xccfb2bd733da6f8a0980a8a6a2a80f04706a792ba78b973a1cc8d6c7d819df12) |
| 02:00:45 | Seller F | `flushBurn` | vet402 hold | 57,256 | 20.5 | 0.001174 | [`0xb153655f…`](https://explorer.testnet.arc.io/tx/0xb153655f54d77e5d0ccbc7587e39b07beaee40df9eeebf304eb82351f911ca08) |
| 02:01:01 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,316 | 20.5 | 0.001093 | [`0xc7be5f1e…`](https://explorer.testnet.arc.io/tx/0xc7be5f1eb6d04ddb1bf4fe0ce56ddee642bdbe4b618c0ab2d0b3f9a03a5ce76f) |
| 02:01:08 | Seller E | `claim` | vet402 hold | 271,025 | 20.5 | 0.005556 | [`0xf1ba70bd…`](https://explorer.testnet.arc.io/tx/0xf1ba70bd45d40f05cccaae9fbf8e3d39b6f027375f3cf28ed5b9b2fa89aa681f) |
| 02:02:13 | Seller E | `finalize` | vet402 hold | 98,774 | 20.5 | 0.002025 | [`0x924ad0c9…`](https://explorer.testnet.arc.io/tx/0x924ad0c91688abcb24c83d9c99efd72e365102f2b626fc0045f39166c716a9ed) |
| 02:02:15 | Seller E | `flushBurn` | vet402 hold | 57,256 | 20.5 | 0.001174 | [`0x16884749…`](https://explorer.testnet.arc.io/tx/0x16884749ae92cdc46d60a4c143e140be5ac3ef2874fb35f7047de56c27ee1071) |
| 02:02:27 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,316 | 20.65375 | 0.001101 | [`0xf70b3e9a…`](https://explorer.testnet.arc.io/tx/0xf70b3e9a3d21ab90bf969cc057b498bf92cd337f76b9d8694918e612f52bbaad) |
| 02:02:33 | Seller D | `claim` | vet402 hold | 271,049 | 21.935 | 0.005945 | [`0x67698fff…`](https://explorer.testnet.arc.io/tx/0x67698fff825e33a5246cbd352e0e22287a39c4f01138e14112dee3842efc066d) |
| 02:02:37 | Seller D | `answer`, reverted | Seller D | 29,279 | 21.935 | 0.000642 | [`0x95b35393…`](https://explorer.testnet.arc.io/tx/0x95b353935b893116dd398828157e1ef7676a368e4428284acd1abc9361d72aa1) |
| 02:03:42 | Seller D | `finalize` | vet402 hold | 98,774 | 20.25 | 0.002000 | [`0x9baef1dd…`](https://explorer.testnet.arc.io/tx/0x9baef1dd448e64221aa186f77a46e3d8ed720e245aabcf42f60e2502d02baa98) |
| 02:03:44 | Seller D | `flushBurn` | vet402 hold | 57,256 | 20.5 | 0.001174 | [`0x715bce74…`](https://explorer.testnet.arc.io/tx/0x715bce745957e570b42a6888608fe43375e8c35ba13230a05ae48fc226fa56e2) |
| 02:03:57 | Buyer credit | `withdrawClaimable` | vet402 hold | 53,316 | 25 | 0.001333 | [`0x54f78e54…`](https://explorer.testnet.arc.io/tx/0x54f78e5472b790dd3a28cc0dde25a8964b7969b3a591b888eb0cc1415068af3a) |
| 02:05:23 | Try a dispute | `claim` | Try page buyer | 271,025 | 25 | 0.006776 | [`0xac4a8b1d…`](https://explorer.testnet.arc.io/tx/0xac4a8b1d6c63b92985cc3ddd82ef7deda5f70eeab4f097fa70a1ef45e25d3084) |
| 02:05:25 | Try a dispute | `answer` | Try page seller | 97,015 | 25 | 0.002425 | [`0xbc1b326e…`](https://explorer.testnet.arc.io/tx/0xbc1b326e4d2d3789e55147bceca60db8db0b1faad90e2bf956868af4ac96d695) |

The contract read at 02:17 UTC:

| Seller | Address | Deposit in USDC | `silentCount` | `fraudCount` |
|---|---|---:|---:|---:|
| Seller A | `0x71f8005aE7757857DC6b7418b9beC75F19546aC3` | 0.487353 | 0 | 0 |
| Seller D | `0xB9a6F77d9EFDFcF165e1259fC650fFA01b06B80D` | 0.448318 | 2 | 0 |
| Seller E | `0x2d86121923E9662D4d926d657FE91A2141BD93e8` | 0.450638 | 2 | 0 |
| Seller F | `0x1401Bd7C7FAb3FE8A429672Fc1C5371456c8445d` | 0.437452 | 0 | 2 |

Each verdict took twice what it credited the buyer: one half to the buyer and one half burned by the `flushBurn` after it. Seller A's two answers repaid 0.005698 and 0.006949 USDC of claim gas, and Seller F's two answers 0.005629 and 0.006949. The buyer withdrew every credit, and `claimable` for the vet402 hold read 0 at 02:17 UTC.

Buyer net per dispute in the 01:59 run, in USDC: what came back, less the price (except after Seller A's answer, when the key came), less the buyer's own gas for the claim, the verdict and the withdrawal.

| Seller | Came back | Buyer net |
|---|---:|---:|
| A, answered | 0.006949 | +0.000174 |
| F, answered, then proven to have lied | 0.020648 | +0.009599 |
| E, silent | 0.011413 | +0.001731 |
| D, wrong key, then silent | 0.012142 | +0.001863 |

The buyer also sent each `flushBurn`, which anyone can send and which the dispute cost does not count. With it, E and D still end +0.000557 and +0.000690.

## What each scene shows

- **Seller B, 2026-11-05 22:40 UTC.** One payment, nothing delivered and no second charge. Then the comparison: a retry with a new signature, marked on the screen "Comparison only. vet402 does not do this." Circle's record shows 2 transfers. Seller B never touches the contract, so this scene ran only on 2026-11-05.
- **Seller A, 01:59 UTC.** The key request closed. vet402 sent a claim, Seller A answered on chain, and the key was on chain 7.2 s from the start. The same answer repaid the buyer 0.006949 USDC of claim gas. Circle's record shows 1 transfer for this payment.
- **Seller A, line up, 01:42 UTC.** The key arrived on its own request. Among the contract's 12 `Claimed` events at 02:10 UTC, none is for this payment.
- **Seller F, 02:00 UTC.** The seller answered with a key that opens something other than what it signed. The answer repaid the claim gas, and `prove` marked FRAUD.
- **Seller E, 02:01 UTC.** The seller said nothing. After the 60 s window, `finalize` marked SILENT.
- **Seller D, 02:02 UTC.** The seller tried a wrong key, the contract reverted it, and the failed transaction stays on the chain. It then said nothing and `finalize` marked SILENT.
- **Seller C, 2026-11-05 22:49 UTC.** The screen read "Seller C: No recent delivery from this seller. Not paid." and vet402 paid nothing. Seller C's Arkiv entity uses a short lifetime for this demo, and every other seller's lasts 7 days.

These sellers are mine. A healthy seller answers, so every payout above comes from a seller I stopped or told to cheat.

## A seller from the catalog, 2026-11-05

Asked whether the latest payment went through, vet402 picked a listing named Quicknode and asked "May I spend up to 0.0001 USDC on this job?" After the approval it paid 0.0001 USDC once. These receipts carry no outcome line, so the last column is the text on the screen.

| Time | Seller | Gateway transfer id | Status | Batch | On the screen |
|---|---|---|---|---|---|
| 22:48:32 | Quicknode | `12166eb9-22bb-431b-b621-c68ad4c93538` | completed | [`0x85f0035f…`](https://explorer.testnet.arc.io/tx/0x85f0035f53533e3d582234b3be960791c717046826a4b26cab56acf6b3fed75f) | "Yes, your payment went through." "Spent 0.0001 USDC" |
| 23:07:48 | Quicknode | `4f44731a-6bb2-48fe-90ff-f8b92b620a2b` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | The same two lines, on the phone layout |

## Earlier runs

These ran on earlier versions of the contract, which charged a fixed dispute cost, or none on the first ones, and did not repay the claim's gas. The demo no longer uses them.

### On `0xa1eff55d…`, 2026-11-05

The earlier version at [`0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5`](https://explorer.testnet.arc.io/address/0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5), deployed by Arc Studio at 22:20 UTC, with a fixed `disputeCost` of 0.0105 USDC. The status and batch columns of these rows are what Circle's Gateway API had returned to the app by 23:20 UTC, and each batch transaction read status 1 on Arc at 23:27 UTC. Sellers A, D, E and F each deposited 0.1 USDC between 22:21 and 22:22 UTC.

#### The filmed run, 22:40 to 22:49 UTC

The video filmed on 2026-11-05 shows these rows. The dispute boxes of this run went to Swarm through the public gateway and its null stamp, because my own postage batch did not exist until 22:53 UTC.

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

#### The second run, 23:11 to 23:16 UTC

The same contract and sellers, after my postage batch existed. Each dispute box went to Swarm through my own Bee node, stamped with batch `b6455d93…`, as [arkiv/swarm.md](arkiv/swarm.md) describes.

| Time | Seller | Gateway transfer id | Status | Batch | Outcome on the receipt |
|---|---|---|---|---|---|
| 23:11:06 | Seller A | `2db76ef8-52a2-4548-bbb6-3bdbc943aad9` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | Charged once. Key read from Arc. Circle record: 1 transfer for this payment. |
| 23:15:27 | Seller E | `66884550-c03f-42e2-89ed-f0ddc83851cc` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 23:16:33 | Seller D | `a2a52883-c727-4a60-9ea2-c1fa16fbf325` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | Wrong key rejected by the contract. The seller stayed silent. Its deposit paid 0.0115 USDC back. |
| 23:16:45 | Seller F | `009ab265-3fd0-495c-8eb4-551669e779e4` | completed | [`0x5945da9d…`](https://explorer.testnet.arc.io/tx/0x5945da9da06fce1103cd2dd1ed8f30136b8b6d77b24c0fd54bd2870903c85271) | The answer did not match the seller's promise. Its deposit paid 0.0115 USDC back. |

Time from the start of the run on `0xa1eff55d…`, as the progress line on the screen showed it:

| Run | Time |
|---|---|
| Seller A, line up, no contract transaction | 1.3 s |
| Seller A, key read from the chain after a claim | 9.0 s, on the third try. The first two took 10.8 s and 10.3 s |
| Seller F, key read from the chain after a claim | 8.6 s |

#### Contract transactions on `0xa1eff55d…`

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

### On Arc mainnet `0xafdb8931…`, 2026-11-05

The earlier version at [`0xafdb8931eebdce7f714ac3905c65a50293eb6db6`](https://explorer.arc.io/address/0xafdb8931eebdce7f714ac3905c65a50293eb6db6) on Arc mainnet, with a fixed dispute cost of 0.009 USDC, deployed by script at 21:59 UTC ([`0xe261a9b5…`](https://explorer.arc.io/tx/0xe261a9b53bf3f947aa69faa00e7a1d2e0f18f4d6759744aef1e9cb0b791f5648)). Sourcify `exact_match`. In round 1 a claim ([`0x48ce856a…`](https://explorer.arc.io/tx/0x48ce856a459569b095aa666370259cd1a6566e2c13a99c9bb901f3e9ac4dcc78)) got its key from the seller's answer ([`0x441dc16a…`](https://explorer.arc.io/tx/0x441dc16a4b6b9b052751655763056a1b60376422f6600fd89e52d2a10b2f4538)). In round 2 the seller stayed silent, and `finalize` at 22:00 UTC ([`0x599a1611…`](https://explorer.arc.io/tx/0x599a161138e9b9698afe3cc788b5d45f7d39e0d4de160471df14b7442c3e4a8d)) credited the buyer 0.01 USDC and burned the same. All of these read status 1. The final version replaced it on mainnet on 2026-11-06, as the [README](README.md#contract) shows.

### Before `0xa1eff55d…`, 2026-11-05

These rows ran before the `0xa1eff55d…` contract. The status and batch columns are what Circle's Gateway API returned at 18:49 UTC. The Seller A and Seller B rows at 16:03 and 16:04 came before any contract was deployed, and the two Seller B rows at 16:04 are the first comparison: a retry with a new signature paid again. The rows from 17:49 to 17:53 ran on an earlier deployment, [`0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2`](https://explorer.testnet.arc.io/address/0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2), with a 0.01 USDC deposit and no dispute cost, so each verdict there paid 0.001 USDC back. The Seller F row at 17:49:19 ended before any claim, and I did not record why it stopped there. The rows from 18:24 to 18:38 ran on the next deployment, [`0x20ce7bbfaf66b28cb917f9331a8960eb563f2094`](https://explorer.testnet.arc.io/address/0x20ce7bbfaf66b28cb917f9331a8960eb563f2094), deployed at 18:23 UTC from source that did not yet take a payment domain salt. Each seller deposited 0.1 USDC there.

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

#### Contract transactions on `0x20ce7bbf…`

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

What ran on 2026-11-05 in the staging Simulator: "Budget set.", a hold of 0.02 USDC, "Not approved: this approval is for another hold." for a proof from another hold, and "Not approved. Nothing was held or paid." for Cancel request.

What ran in production on 2026-11-05 with the real World App on iOS: "Budget set." at 22:16 UTC, "Held 1 USDC for this job." at 22:16 UTC and again at 23:25 UTC for the video, and "Not approved. Nothing was held or paid." for Cancel request at 23:23 UTC. The verified result reads environment production, protocol 4.0, proof_of_human.

### How the approval works since 2026-11-06

- The budget has its own proof. The first budget's createSession carries the signal `budget:<amount>:<budget id>`, and the backend saves the session nullifier with the budget. A budget proof sent again is refused. A new budget is a proveSession of the same session, so only the person who set the first budget can raise it.
- The budget is a running total. Every approved hold counts toward it, so a 1 USDC budget refuses a second 0.6 USDC hold.
- The backend requires protocol 4.0 and `proof_of_human` in every result, and takes the session nullifier as an array or as a single string.
- In production nothing adds to the hold outside an approval. The compare and Seller C scenes spend from the approved hold, and gas for the hold wallet is taken from the approved budget.
- In production "Use the last approval" is the Replay test. It shows the refusal "Not approved: this approval is for another hold." and holds nothing.
- The routes that start, approve or cancel a request need a token that only the app's own page receives. Any POST a browser marks as sent from another site is refused.
- A hold now reads "Held 1 USDC for your agent." The hold is the agent's spending limit, and the jobs it plans afterwards are paid from it.

These changes came after the production runs above, and the backend tests cover them.

### Why Proof of Human and not uniqueness or Selfie Check

The hold asks one thing: is the owner there and releasing the money. It does not ask who the owner is or whether the owner is unique. A budget belongs to a single owner, and the session ties each hold to the person who set it. A Sybil score adds nothing to one owner's budget.

### Time to first success, friction and the one improvement

The full debrief, with the step, what came back and the date of each item, is in [docs/world-feedback.md](docs/world-feedback.md).

- **Time to first success:** about 25 minutes, from handing over the instruction to "Budget set." on staging, 2026-11-05 16:05 to 16:29 UTC.
- **Friction:** the Simulator's Cancel does not reach the app, so the app has its own Cancel request. Pasting the request URL opens the confirmation screen without a press on Continue, and one more press closes it and uses up the request. Signing in to the Developer Portal with World App opened an empty "Anonymous user" team, and "Verification" in its menu is the World App listing, not World ID.
- **Missing capability or documentation:** Selfie Check returned `credential_unavailable` on staging (2026-10-28 UTC), and the IDKit README shows no signal on a session proof.
- **The one improvement with the greatest impact:** send the Simulator's Cancel back to the app.

## Arkiv and Swarm

### A ruling stops the next purchase

Arc's rulings on the live contract are on Arkiv: at 03:15 UTC on 2026-11-06, 2 Fraud against Seller F and 2 Silent each against Seller D and Seller E, written from the runs above. From the `arkiv2` branch on, every demo button reads these rulings by the address that seller is paid at before anything is paid. So within 7 days of a ruling, **Try Seller F** (and D and E) shows "Seller F: Arc ruled against this seller in the last 7 days. Not paid." and the hold is not touched. With the rulings above that lasts until about 2026-11-13 02:01 UTC for Seller F, 02:02 UTC for Seller E and 02:04 UTC for Seller D. Seller A and Seller B have no ruling and run as before.

To see it, start the backend with `ARKIV_WRITER_KEY`, `ARKIV_ACCESS_KEY` and `SEALED_DELIVERY_ADDRESS`, open `/?demo` and press **Try Seller F**. The refusal comes before the payment step, so the receipts list gets no new row. The catalog flow, the Seller C scene and the public agent read the same rulings, by the payTo each listing names.

### The box comes only from Swarm

"Open a sealed answer" lists the claims that have a `vet402_evidence` entity on Arkiv and opens each box from Swarm. The exported file no longer holds a ciphertext or a plaintext hash, so when Swarm does not return the box the screen shows "Box not found on Swarm." and opens nothing. Details in [arkiv/swarm.md](arkiv/swarm.md#run-one-upload-and-one-read-yourself).
