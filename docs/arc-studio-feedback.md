# Arc Studio feedback from building vet402 on Arc

I built this project with Arc Studio from the CLI (`@circle-fin/arc-studio-cli` 1.2.1), driven by Claude Code, between 2026-11-05 15:30 UTC and 2026-11-06. These notes are what I ran into, with the command and what came back. The Arc Studio team asked for limitations at the Mumbai workshop, so here they are.

## What worked well

- **The smart contract review caught real bugs.** On the first draft of SealedDelivery it reported a High: a Promise that does not name the buyer could be copied from a pending claim. On the next draft it reported nonce squatting, where a stranger could claim a nonce first and lock the real buyer out. Both were real, and both are fixed in this repo.
- **The Contracts panel.** All four deployments, the 28 functions and the contract state sit in one place, and the latest deployment is easy to tell apart.
- **Starting from a plain prompt.** P1 (phone app with a buyer key and a hold key) came back in about two minutes with the backend, the keys and a working screen.

## Where I lost time

1. **The usage limit is a rolling 24 hour window, and the CLI does not say when room comes back.** `arc-studio usage --json` returned `{"percentUsed":90,"windowMs":86400000}` after about twelve turns. Knowing when the oldest turn drops out would let me plan the last sync instead of saving it blindly.
2. **A file sent to `context/` did not reach the agent.** `arc-studio run --file x.json:context/x.json` was refused with a destination error. Sending it as a plain `--file` put it under `context/`, and the agent reported that `context/` was not delivered, so it re-created the fixture by hand.
3. **`pull --changed` fails after a turn that wrote no files.** It answered "this session's last turn recorded no file changes". Pulling by `--paths` worked. When `pull` skips files to protect local edits, it says how many but not which ones.
4. **Files cannot be removed from the sandbox from the CLI.** After I deleted four test files locally, the sandbox kept them, so Studio's `forge test` counted 223 tests while my checkout had 218.
5. **The sandbox's forge measured gas differently from mine.** A test that compared gas per KB at two sizes passed locally (slopes 1% apart) and failed in Studio (12% apart). I loosened the test. Printing the forge and solc versions next to the test count would make this quick to spot.
6. **Tracing only shows activity from the Studio preview.** My app runs outside the preview, so Tracing said "No trace events yet" while the contract had 71 transactions on Arc testnet (read 2026-11-05 21:30 UTC). A view of the contract's own transactions would cover apps that run elsewhere.
7. **Network details for Arc testnet.** `BatchFacilitatorClient.getSupported()` does not list Arc testnet, so the seller builds its payment terms from constants. The public node `rpc.testnet.arc.io` refused `eth_getLogs` with "rate limit exceeded" during the demo runs, so the app falls back to `rpc.testnet.arc.network` and `arc-testnet.drpc.org`.

## The one change with the biggest effect

Show when the usage window frees up, in `arc-studio usage`. Every other item cost minutes. Not knowing when Studio would be available again shaped the whole schedule of the event.
