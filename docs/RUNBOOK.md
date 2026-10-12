# Local runbook

Requires Node >=22. No dependency installation or credentials.

From `app/`:

```sh
npm test
npm run demo
npm run merchant:demo
npm start
```

The desk binds http://127.0.0.1:4318. `PORT` may select another local port. Stop your own server with Ctrl+C when finished. Never stop an unrelated process to claim a port.

The CLI demo emits JSON. A zero exit means all six expected fixture statuses matched. `node cli.mjs verify --invoice invoice.json --signature SIGNATURE --cluster devnet` emits a live report or an explicit error. Its ledger does not persist between invocations.

Invoice example (replace recipient with a real public recipient address, not a secret):

```json
{"id":"invoice-001","recipient":"BASE58_PUBLIC_ADDRESS","amountLamports":"1000000000"}
```

## Merchant

`npm run merchant:demo` runs an offline, synthetic buyer walkthrough on an ephemeral loopback port, then exits. Expected statuses: 402, 402, 200, 402, 409.

`npm run merchant` leaves a demo server on port 4319. `GET /api/paid/report` returns a merchant-issued invoice. A retry uses headers `x-receiptrail-invoice` and `x-receiptrail-signature`. Use the invoice ID actually issued by that server and a supplied fixture signature. Do not use a fabricated ID or a real payment in demo mode.

Live configuration, for a read-only inspection of already-existing evidence:

```sh
node agent/merchant-demo.mjs --live --recipient PUBLIC_ADDRESS --lamports INTEGER --cluster devnet
```

Live invoices normally start at issue time. No payment should be created for this sprint. An explicit `--not-before UNIX_SECONDS` can support a historical diagnostic, but it is not evidence of a newly paid invoice. Missing configuration fails. Demo and live states are separate, in memory, and reset on restart.

## MCP

Configure the client command as `node`, with one argument: the absolute path to `app/agent/mcp.mjs`. Launch the module directly; npm banners can corrupt stdio protocol output. JSON-RPC messages are newline-delimited. Initialize first, then call `tools/list` or `tools/call`.

Demo tool arguments: `{"mode":"demo","caseId":"paid","includeEvidence":true}` for `verify_invoice_payment`. Live arguments require an invoice and signature; caller-supplied transaction evidence is rejected. `list_demo_cases` takes `{}`.

## Evidence and review

All fixture results are synthetic. Live RPC can time out, rate-limit, return no transaction or return unsupported instructions. Preserve that result. Never change source labels or substitute fixture success.

Formal review is assigned to Master on Mac or NUC. Browser rendering and click-through require that gate. Local development test results do not certify it. The orchestration folder contains REVIEW-REQUEST.md, per-lane reports and timestamped evidence.
