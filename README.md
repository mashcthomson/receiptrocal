# ReceiptRail

Agents and merchants check whether a Solana payment matches a specific invoice before releasing goods.

ReceiptRail is a local, read-only SOL invoice verifier with a browser desk, JSON CLI, stdio MCP tools and an x402-style merchant demonstration. It uses Node 22 built-ins. No npm installation, wallet, keys or signing are needed.

## Run

```sh
cd app
npm test
npm run demo
npm run merchant:demo
npm start
```

Open http://127.0.0.1:4318. Choose **Demo**, then **Run all cases**. Inspect each result and download its evidence JSON. All demo data is synthetic. **Live** queries the selected canonical Solana RPC endpoint and never falls back to fixtures.

The merchant walkthrough prints 402 for an unpaid request, 402 for rejected evidence, 200 for a matching synthetic receipt, then 409 when the receipt is reused for a new invoice. It is x402-style, not x402 protocol compatible.

## Interfaces

- Browser desk: `npm start`, loopback port 4318.
- CLI: `node cli.mjs demo` emits JSON; `node cli.mjs verify --invoice invoice.json --signature SIGNATURE --cluster devnet` reads RPC.
- MCP: run `node /absolute/path/to/app/agent/mcp.mjs` directly in a stdio client. Tools: `list_demo_cases`, `verify_invoice_payment`. Do not launch through npm in a protocol client because npm can add stdout banners.
- Merchant demo server: `npm run merchant`, loopback port 4319. Endpoint: `/api/paid/report`. For an automated buyer flow, use `npm run merchant:demo`.

An invoice contains `id`, `recipient` and a positive integer-string `amountLamports`; optional `notBefore` is Unix seconds. One SOL is 1,000,000,000 lamports. The verifier returns `matched`, `mismatch`, `duplicate` or `needs_review`, with reasons and provenance.

## What is checked

The verifier binds the requested signature to the transaction's first signature, requires successful finalized evidence, validates exact System Program SOL transfers and compares amounts using BigInt. Known fee-budget and memo programs may accompany transfers. Unknown programs, SPL tokens and opaque transfer instructions require review. Recipient outflows and self-transfers are not accepted as simple invoice payments.

The browser server, MCP server and merchant each maintain their own in-memory replay ledger. Repeating an unchanged invoice/signature is idempotent; using a receipt for another invoice is rejected within that process. Ledgers are neither shared nor durable. The one-shot CLI has no cross-run replay protection.

## Boundaries

This is a hackathon prototype, not a production checkout or a cryptographic proof system. RPC data is trusted. Matching a public transaction does not establish the presenter's identity or ownership of the payment. Durable shared storage, authenticated buyers, invoice-specific onchain references, token support and production hardening are future work. No customer payments, traction or security certification are claimed.

Development checks and real mainnet/devnet RPC reads were performed on 13-10-26. Formal independent review and browser inspection are requested from Master on Mac/NUC. See the local orchestration records for the current verdict; do not infer approval from passing development tests.

See [runbook](docs/RUNBOOK.md), [architecture](docs/ARCHITECTURE.md), [limitations](docs/LIMITATIONS.md) and [submission pack](SUBMIT.md).
