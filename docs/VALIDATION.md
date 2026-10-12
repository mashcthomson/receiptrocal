# Validation record

Development checks, 13-10-26. Host: Thayara (laptop). Node v22.23.3. This is not the required independent Master review on Mac/NUC.

## Final suite

Timestamp: 2026-10-13T05:45:21.210686+11:00.
Command from app/: `npm test`.
Exit: 0.
Result: 145 tests, 145 passed, 0 failed, 0 skipped.

Coverage includes exact integer amounts, signature binding, program allowlists, malformed evidence, HTTP boundary checks, concurrent receipt reuse, synthetic provenance, RPC failures, CLI output, MCP protocol and size limits, merchant invoice ownership and 402/200/409 behavior.

CLI demo: all six synthetic cases matched expected statuses. Merchant walkthrough at 05:38:25 AEDT: unpaid 402, unsuitable receipt 402, matching fixture 200, fresh invoice 402, reused receipt 409. No funds or keys involved.

HTTP smoke at 05:33:32 AEDT: page, JS, CSS, SVG, health and demo routes returned 200. Browser rendering and interactive click-through were not performed in this development pass; Master review is requested on Mac/NUC.

## Live read observations

Canonical Solana mainnet and devnet endpoints each returned HTTP 200 and finalized getTransaction data. Observed slots: mainnet 456146147, devnet 510354947. These were read-only queries against public transactions. They do not establish that any customer invoice was paid. The inspected mainnet transaction includes an unsupported program, so the verifier returns needs_review.

An earlier builder sandbox attempt returned DNS EAI_AGAIN. The later orchestrator process succeeded. Both observations were preserved in local evidence archives. No claim of universal endpoint availability is made.

## Independent gate

Master has been asked to review an immutable snapshot on Mac or NUC. No verdict is available at this record's writing. Do not present the prototype as independently reviewed until that verdict is recorded. Tests establish behavior for exercised cases, not production security or customer demand.
