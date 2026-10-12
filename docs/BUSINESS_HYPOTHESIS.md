# Business hypothesis

The initial user is an API or digital-goods merchant accepting SOL who needs to decide whether a submitted transaction matches an invoice. An agent acting for that merchant needs the same structured decision.

The prototype tests a narrow workflow: issue an invoice, inspect finalized transaction evidence, withhold data on mismatch, release on match and reject receipt reuse within the process. Its synthetic demo demonstrates software behavior, not customer demand.

Validation plan: interview a small set of merchants, observe their current reconciliation process, test a read-only pilot against consented historical invoices, and measure reconciliation time, false matches and unresolved cases. No interviews or pilots were conducted in this sprint.

Possible business: charge for durable shared ledgers, reliable event delivery and operational reporting while keeping a small embeddable verifier. This is a pricing/distribution hypothesis; no price, market size, revenue or acquisition claim is established.

Prerequisites for real commerce include authenticated buyers, invoice-specific payment binding, durable replay protection and security review. The x402-style demo is not a standards-compliant payment service.
