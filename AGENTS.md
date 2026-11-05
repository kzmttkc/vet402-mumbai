# vet402 on Arc

Arc Studio's project memory for this app. README.md explains what the app does, and contracts/README.md explains SealedDelivery.

- The hold key is the only key that pays. It is never a seller.
- A paid request goes through `server/sendOnce.ts`, which never retries on its own.
- Tests run from `scripts/test.sh`, in an empty temporary folder, and never read `.env` or `data/`.
