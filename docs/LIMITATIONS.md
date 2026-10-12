# Limits and next steps

- Native SOL only. SPL tokens, including USDC, are unsupported. Complex transactions ask for review.
- Canonical RPC responses are trusted observations, not cryptographic proofs or independent consensus verification.
- Fixture signatures and transaction bodies are synthetic. A demo match is not an onchain payment.
- Matching public transaction data does not prove the presenter's identity, payment ownership or contractual intent. The prototype has no buyer authentication or invoice-specific onchain reference.
- Each server process has its own in-memory ledger. Restarting loses replay protection, and separate instances do not share it. The CLI does not maintain cross-run state.
- Merchant mode is x402-style, not x402 protocol compatible. Its dataset and offline buyer walkthrough are synthetic.
- Live merchant invoices default to a fresh start time. This sprint does not create payments to exercise them. Historical diagnostic overrides must be labelled honestly.
- No funds, private keys, wallet connections, transaction signatures created by this tool, settlement submission or custody.
- Development tests are not a security certification. Formal Mac/NUC review and browser verification are separate gates.
- No actual customers, revenue, interviews or market-size research are claimed.

Production work would require durable transactional storage, authenticated invoice ownership, an appropriate onchain invoice reference, operations/monitoring, broader asset support, abuse controls and independent security review. Those are future work, not shipped capabilities.
