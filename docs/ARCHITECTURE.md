# Architecture

All application modules are native ESM using Node built-ins.

| Component | Role |
| --- | --- |
| `lib/verify.mjs` | Pure invoice/evidence decision, exact BigInt lamports, conservative instruction parsing |
| `lib/rpc.mjs` | Fixed mainnet/devnet endpoints, finalized getTransaction, signature/envelope validation, bounded request timeout |
| `server.mjs` | Loopback HTTP API, static desk, in-memory invoice/receipt ledger |
| `public/` | Buildless browser desk, separate Demo/Live modes, evidence download |
| `cli.mjs` | JSON demo and live inspection, no persistent ledger |
| `agent/mcp.mjs` | Stdio tools, validated arguments, separate live replay ledger |
| `agent/merchant-demo.mjs` | Merchant-issued invoice, 402 challenge, verified release, 409 replay rejection |
| `fixtures/demo.json` | Six explicitly synthetic cases |

Invoice: `{id, recipient, amountLamports, notBefore?}`. Evidence: `{source, cluster, signature, commitment, fetchedAt, transaction}`. Result includes status, code, reasons, expected/observed lamports, invoice ID, signature, cluster, source, slot and block time.

The RPC adapter requests `getTransaction` with jsonParsed encoding, finalized commitment and maxSupportedTransactionVersion 0. The verifier checks execution success and signature identity before payment semantics. Only parsed System Program SOL transfers are accepted as payments. Exact Compute Budget and Memo program IDs may accompany them. Unknown parent or inner programs require review.

Replay decisions and ledger writes run synchronously after awaited RPC reads, preventing concurrent claims in one process. A signature cannot settle two invoice IDs in that ledger; settled invoice terms cannot silently change. Browser server, MCP server and merchant are independent processes with independent ledgers. Durable shared storage is not implemented.

HTTP desk: GET `/api/health`, GET `/api/demo`, POST `/api/demo/verify` with `{caseId}`, POST `/api/verify` with `{invoice,signature,cluster}`. Errors use non-2xx responses. Static files are allowlisted. The server binds loopback, validates Host/Origin, limits JSON bodies and concurrent RPC work, and sends a restrictive CSP.

The merchant issues random invoice IDs, uses a 15-minute unpaid-invoice lifetime and owns price/recipient terms. Its protected route is `/api/paid/report`. Buyer identity and an invoice-specific onchain reference are not implemented. Public signature possession is not authentication.

MCP protocol supports initialization, tools/list, tools/call and ping. Tools are `list_demo_cases` and `verify_invoice_payment`. Live evidence comes from the adapter, never the caller. Stdout is protocol only, stderr diagnostics. Messages are bounded to 256 KiB, with oversized complete and partial lines rejected.
