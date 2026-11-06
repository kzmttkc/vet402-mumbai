# Instructions sent to Arc Studio

These are the instructions Claude Code wrote for Arc Studio during ETHGlobal Mumbai, copied as sent from `prompts/studio/`. Arc Studio ran them in the session `mumbai` (app id `f6f547d3-78ad-4550-9805-8fc08ac65425`). The plan they follow, and the decisions in it that are mine, are in the AI table of the [README](../README.md#how-i-used-ai).

One change from the files as sent: in `prompt-sd7.txt` the zero payment domain salt was written out as `0x` and 64 zeros. Here it reads `bytes32(0)`, the same value. The scripts that hold keys or fund wallets are not copied.

Times are 2026-11-05 UTC, taken from when each turn's output was saved. A turn's files reached this repo with `arc-studio pull`, in the commit named in the last column.

| File | Turn | Saved | What the turn built |
|---|---|---|---|
| [prompt-p1.txt](studio/prompt-p1.txt) | p1 | 15:33 | The starter app: one phone screen, an Express backend, a buyer key and a hold key. Pulled in `a6e3fa2` |
| [prompt-p2.txt](studio/prompt-p2.txt) | p2 | 15:38 | The hold button, which moves the chosen amount into Gateway for the hold key with `depositFor`, and the hold balance in plain words (`5494960`) |
| [prompt-p3.txt](studio/prompt-p3.txt) | p3 | 15:43 | The Discovery call, the first planner and the approval card that asks "May I spend up to {amount} on this job?" (`4ed74f6`) |
| [prompt-p4.txt](studio/prompt-p4.txt) | p4 | 15:47 | One payment from the hold through Gateway batched settlement, and one receipt row per payment (`c3d8511`) |
| [prompt-p4b.txt](studio/prompt-p4b.txt) | p4b | 15:54 | The pay route through vet402's existing Gateway code, `src/existing/arc-gateway.ts`, pinned to Arc testnet (`211a2e6`) |
| [prompt-p5.txt](studio/prompt-p5.txt) | p5 | 16:02 | Sellers A and B, the second fetch with the same payment, the check of Circle's transfer record, and the comparison that pays twice (`9526eb4`, `29f324f`) |
| [prompt-p6a.txt](studio/prompt-p6a.txt) | p6a, not run | | Arc Studio never ran it. No output of this turn exists and no Arkiv file came from a pull. Claude Code built the Arkiv receipts from it (`7df3fb3`, `08a282c`, `50eb76c`) |
| [prompt-p6w.txt](studio/prompt-p6w.txt) | p6w, not run | | Arc Studio never ran it. No output of this turn exists and no World ID file came from a pull. Claude Code built the World ID approvals from it (`6262f7b`, `c33c880`) |
| [prompt-sd1.txt](studio/prompt-sd1.txt) | sd1 | 16:17 | The first SealedDelivery and its tests, with the real EIP-3009 vector. Its review reported a High: a Promise that did not name the buyer could be copied ([feedback](../docs/arc-studio-feedback.md)) |
| [prompt-sd2.txt](studio/prompt-sd2.txt) | sd2 | 16:24 | Claims keyed by claim id, which closes nonce squatting. Deployed `0x2750c52890c4b90394a984242650e3e8eb8cae6f` |
| [prompt-sd3.txt](studio/prompt-sd3.txt) | sd3 | 16:55 | The double verdict with a burned half, `coverageFor`, `prove` with its keystream, and `src/lib/sealed.ts`. It stopped before the build and the deploy. Pulled in `b1d5683` |
| [prompt-sd4.txt](studio/prompt-sd4.txt) | sd4 | 16:58 | Build, tests, scan, and the deploy of `0x087f60c05a283299c3d315ef8da67be4a958ba43` (`a15df1e`) |
| [prompt-sd5.txt](studio/prompt-sd5.txt) | sd5 | 17:47 | The contract and tests Claude Code sent, with the token and payment domain as constructor arguments. Deployed `0x2dab71e2e13d8f6acef80b8964776b2bc24f69d2` |
| [prompt-sd6.txt](studio/prompt-sd6.txt) | sd6 | 18:23 | The same with `disputeCost` 10500. Deployed `0x20ce7bbfaf66b28cb917f9331a8960eb563f2094` |
| [prompt-sd7.txt](studio/prompt-sd7.txt) | sd7 | 22:20 | The contract with the payment domain salt. Deployed `0xa1eff55da9f1cee94d608e2570bda89f8f2ce5b5`, an earlier version with a fixed `disputeCost` that the demo no longer uses. It was the last deployment made by an Arc Studio turn |
| [prompt-share.txt](studio/prompt-share.txt) | share | | Claude Code sent the current app files to Arc Studio, and this turn only confirmed they were in place, with no change, build or test |

The final contract, `0xE9C35ad2caF5D76CA5a5F61ca2256995197C2A4B`, came from no instruction here. On 2026-11-06 its source was pasted into the code editor of the same Studio sandbox, tested there with forge 1.7.1 (246 passed, 0 failed), and deployed at 01:35:22 UTC with `forge create` from the sandbox terminal ([`0x38095fb7…`](https://explorer.testnet.arc.io/tx/0x38095fb7894b86e2c57be1d1bb6e367ddbc6fd9fc9276ecacc43ac37701b3733)). The five deployments above were the turns of Studio's agent.
