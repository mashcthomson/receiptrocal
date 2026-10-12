# ReceiptRail submission pack

Prepared 13-10-26. Track: Solana ecosystem. Local code path: `/home/mash/MASTER/hackathon-20261013`.

## Paste-ready title and pitch

**ReceiptRail**

Agents and merchants check that a Solana payment settles a specific invoice before they release goods.

## Description

A transaction link is not enough to reconcile an invoice. The recipient, amount, execution outcome and previous use of that receipt all matter.

ReceiptRail is a read-only SOL invoice verification prototype. It compares invoice expectations with finalized transaction data from canonical Solana RPC endpoints, uses exact integer arithmetic, and returns a machine-readable decision with inspectable evidence. A local browser desk and CLI make the same checks accessible to people. Stdio MCP tools let agents request verification. An x402-style merchant demonstration returns HTTP 402 with an invoice and releases a synthetic dataset only when the receipt matches.

The demo includes a matching payment, one-lamport underpayment, wrong recipient, duplicate receipt, failed transaction and unavailable transaction. Every fixture is visibly synthetic. Live RPC errors remain errors; the app never substitutes demo success. Replay protection is scoped to each running process and resets on restart.

The project uses Node 22 built-ins with no external npm dependencies. It holds no private keys, connects no wallet and never signs or sends payments. Current support is native SOL, with a conservative instruction allowlist. It trusts RPC observations and is not a cryptographic proof or production checkout.

## Demonstrated evidence

- Final development suite: 145 tests passed, zero failures on 13-10-26. The exact timestamp and command are recorded in [docs/VALIDATION.md](docs/VALIDATION.md). This includes the oversized MCP input regression.
- CLI demo: all six synthetic cases return their expected statuses.
- Merchant walkthrough: unpaid 402, rejected receipt 402, matching fixture 200, reused receipt on a new invoice 409.
- Real mainnet and devnet RPC reads succeeded. These are transaction observations, not proof that a customer invoice was paid. The observed mainnet transaction contains an unsupported program and correctly requires review.
- Formal Mac/NUC review and browser inspection are requested. Do not describe that gate as passed until its verdict exists.

## Run and demo steps

```sh
cd /home/mash/MASTER/hackathon-20261013/app
npm test
npm run demo
npm run merchant:demo
npm start
```

Open http://127.0.0.1:4318 and select **Run all cases** in Demo. Inspect `paid` (1 SOL), `underpaid` (500,000,000 lamports expected, 499,999,999 observed), `wrong-recipient`, `duplicate`, `failed` and `unavailable`. Failed execution is `mismatch`; unavailable evidence is `needs_review`. Download evidence JSON from a selected result.

For Live, enter an actual invoice expectation and a transaction signature, then **Verify against RPC**. Show the returned result honestly, including unsupported transactions or network errors. Do not make a payment for the demo.

For agent integration, configure a stdio MCP client with `node /absolute/path/to/app/agent/mcp.mjs`. Available tools are `list_demo_cases` and `verify_invoice_payment`. The merchant is x402-style only, not x402 protocol compatible.

## Presentation video script, about 2 to 3 minutes

"ReceiptRail helps agents and merchants check whether a Solana transaction matches a particular invoice before releasing goods.

Imagine a service that sells a dataset. A buyer sends a transaction link. Before delivering the data, the merchant needs to know more than whether that link exists. Did the transfer reach the right address? Was the amount exact? Did the transaction succeed? Has that same receipt already been used for another invoice?

We built one small verifier and exposed it in four ways: a browser desk, a JSON command-line tool, an MCP server for agents, and an HTTP 402 merchant demonstration.

The verifier takes an invoice and reads finalized Solana transaction evidence. It checks the transaction identity, successful execution, supported transfer instructions, recipient and amount. Amounts are integer lamports, compared with BigInt. Unsupported transactions ask for review instead of receiving a green result.

The browser shows the evidence behind each decision. The MCP tools make the same checks available to agents. In the merchant demo, an initial request receives a 402 invoice. A rejected receipt leaves the data withheld. A matching receipt releases the dataset, and reusing it for a second invoice is rejected.

This prototype never holds keys or moves money. Its repeatable demonstration uses clearly labelled synthetic fixtures. We also exercised actual read-only mainnet and devnet RPC calls, without claiming that those public transactions paid a customer invoice.

Our initial customer hypothesis is a small team selling APIs or digital goods for SOL. We would validate that hypothesis through merchant interviews and measured reconciliation trials before claiming demand. A future paid product could add a shared durable ledger, webhooks and operational reporting.

Today, the boundaries are explicit: SOL only, trusted RPC data, and replay protection local to each process. Matching a public receipt does not prove buyer identity. This is a focused demonstration of inspectable payment verification for agent commerce, with clear next steps for production use."

## Product demo video script, under 3 minutes

**0:00 to 0:25:** Show `npm run demo`. Say: "These are synthetic fixtures, verified by the same core used for live RPC data. The CLI returns JSON with the result and its provenance."

**0:25 to 1:15:** Open the browser Demo and run all cases. Say: "The paid case matches one SOL. This case is one lamport short. This one pays the wrong recipient. A reused signature is duplicate. A failed transaction is a mismatch; unavailable data needs review." Select a result and download its evidence JSON.

**1:15 to 1:40:** Show Live and its invoice fields. Say: "Live mode reads finalized Solana RPC data. We have verified retrieval from mainnet and devnet. An unsupported transaction remains a review case. We have not made a payment or demonstrated a customer invoice settlement."

**1:40 to 2:35:** Run `npm run merchant:demo`. Say: "This buyer flow is also synthetic. The merchant first returns 402. An unsuitable receipt does not release data. A matching fixture returns 200. Reusing it on a new invoice returns 409. This is x402-style, not a claim of protocol compatibility."

**2:35 to 2:50:** Show the MCP tool names. Say: "Agents can request the same read-only verification through MCP. The next steps are durable replay protection, buyer authentication and merchant validation."

## Business hypothesis and development disclosure

Target: API and digital-goods sellers accepting SOL. Proposed paid features: durable shared reconciliation, event delivery and reporting. No customer interviews, users, revenue, market-size estimates or production security claims are supplied for this sprint.

Code, fixtures, interface and logo were generated during the 13-10-26 sprint with AI coding agents. No existing operator product code was reused. The implementation uses Node built-ins and Solana's public RPC interface. Disclose AI-assisted development and this date accurately.

## Operator-only completion fields

- Founder name, background, location and contact: fill with actual details.
- Repository URL: add a repo the judges can access. Current deliverable is a local Git repository; no remote has been published. The official FAQ permits a private repo with judge access.
- Presentation video URL and product demo video URL: record from these scripts and add the actual links.
- Logo: `app/public/logo.svg`.
- Confirm registration and personal eligibility; the agent did not sign in or submit.
- Confirm the Master review verdict before presenting the prototype as reviewed.

Official deadline: 13-10-26 17:59 AEDT, converted from 12-10-26 23:59 Pacific. Keep 16:00 as the internal submission buffer. Source: [official rules](https://colosseum.com/legal/Crypto%20World%27s%20Fair%20Hackathon%20Rules.pdf). Repository and video requirements: [official FAQ](https://colosseum.com/hackathon).
