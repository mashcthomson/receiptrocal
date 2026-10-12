const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const ANCILLARY_PROGRAMS = new Set([
  'ComputeBudget111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
]);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

function base58Bytes(value, length) {
  if (typeof value !== 'string' || value.length < length || value.length > Math.ceil(length * 1.38)) return false;
  let number = 0n;
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) { bytes++; number >>= 8n; }
  for (const char of value) { if (char !== '1') break; bytes++; }
  return bytes === length;
}

function lamports(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (integer(value)) return BigInt(value);
  return null;
}

/** Read-only reconciliation of trusted-provider parsed data, not cryptographic proof.
 * Only the exact allowlisted no-transfer ancillary programs may be ignored.
 * Any other instruction we cannot interpret makes the transaction needs_review.
 * usedSignatures is a caller-scoped list of signatures already used elsewhere.
 */
export function verifyPayment(invoice, evidence, options = {}) {
  const result = {
    status: 'needs_review', code: 'INVALID_INPUT', reasons: [],
    invoiceId: typeof invoice?.id === 'string' ? invoice.id : '',
    signature: typeof evidence?.signature === 'string' ? evidence.signature : null,
    expectedLamports: typeof invoice?.amountLamports === 'string' ? invoice.amountLamports : '',
    observedLamports: null,
    recipient: typeof invoice?.recipient === 'string' ? invoice.recipient : '',
    source: typeof evidence?.source === 'string' ? evidence.source : '',
    cluster: typeof evidence?.cluster === 'string' ? evidence.cluster : '',
    slot: null, blockTime: null,
  };
  const finish = (status, code, reason) => ({ ...result, status, code, reasons: [reason] });
  if (!object(invoice) || typeof invoice.id !== 'string' || !invoice.id.trim()
      || !base58Bytes(invoice.recipient, 32)
      || typeof invoice.amountLamports !== 'string' || !/^[1-9][0-9]*$/.test(invoice.amountLamports)
      || (invoice.notBefore !== undefined && !integer(invoice.notBefore))) {
    return finish('needs_review', 'INVALID_INVOICE', 'Invoice requires an id, a 32-byte base58 recipient, positive integer-string lamports, and an optional nonnegative Unix timestamp.');
  }
  if (!object(options) || (options.usedSignatures !== undefined && (!Array.isArray(options.usedSignatures)
      || options.usedSignatures.some(signature => !base58Bytes(signature, 64))))) {
    return finish('needs_review', 'INVALID_LEDGER', 'usedSignatures must be an array of valid transaction signatures.');
  }
  if (!object(evidence) || !['fixture', 'rpc'].includes(evidence.source)
      || !['mainnet-beta', 'devnet'].includes(evidence.cluster)
      || !base58Bytes(evidence.signature, 64)
      || typeof evidence.fetchedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(evidence.fetchedAt)
      || !Number.isFinite(Date.parse(evidence.fetchedAt))) {
    return finish('needs_review', 'INVALID_EVIDENCE', 'Evidence requires valid provenance, cluster, signature and ISO fetch timestamp.');
  }
  if (evidence.commitment !== 'finalized') return finish('needs_review', 'NOT_FINALIZED', 'Only finalized transaction evidence can settle an invoice.');
  const tx = evidence.transaction;
  if (tx === null) return finish('needs_review', 'TRANSACTION_UNAVAILABLE', 'The transaction is unavailable from this evidence source.');
  if (!object(tx) || !integer(tx.slot) || !(tx.blockTime === null || integer(tx.blockTime))
      || !object(tx.transaction) || !object(tx.transaction.message)
      || !Array.isArray(tx.transaction.signatures) || tx.transaction.signatures.length === 0
      || tx.transaction.signatures.some(signature => !base58Bytes(signature, 64))
      || !Array.isArray(tx.transaction.message.instructions) || !object(tx.meta)
      || !Object.hasOwn(tx.meta, 'err')) {
    return finish('needs_review', 'INVALID_TRANSACTION', 'Transaction identity, execution metadata, slot, timestamp or instructions are malformed or missing.');
  }
  result.slot = tx.slot;
  result.blockTime = tx.blockTime;
  if (tx.transaction.signatures[0] !== evidence.signature) return finish('mismatch', 'SIGNATURE_MISMATCH', 'The requested signature is not the transaction id (first signature).');
  if (tx.meta.err !== null) {
    return object(tx.meta.err) || typeof tx.meta.err === 'string'
      ? finish('mismatch', 'TRANSACTION_FAILED', 'The transaction failed and cannot settle an invoice.')
      : finish('needs_review', 'INVALID_METADATA', 'Transaction execution metadata is unknown.');
  }
  if (options.usedSignatures?.includes(evidence.signature)) return finish('duplicate', 'SIGNATURE_ALREADY_USED', 'This signature has already been used in the supplied workspace ledger.');
  if (invoice.notBefore !== undefined) {
    if (tx.blockTime === null) return finish('needs_review', 'TIMESTAMP_UNAVAILABLE', 'A block timestamp is required to check the invoice start time.');
    if (tx.blockTime < invoice.notBefore) return finish('mismatch', 'PAYMENT_TOO_EARLY', 'The transaction predates the invoice start time.');
  }
  const instructions = [...tx.transaction.message.instructions];
  if (tx.meta.innerInstructions !== undefined && tx.meta.innerInstructions !== null) {
    if (!Array.isArray(tx.meta.innerInstructions)) return finish('needs_review', 'INVALID_INNER_INSTRUCTIONS', 'Inner instructions must be an array or null.');
    const indexes = new Set();
    for (const group of tx.meta.innerInstructions) {
      if (!object(group) || !integer(group.index) || group.index >= tx.transaction.message.instructions.length
          || indexes.has(group.index) || !Array.isArray(group.instructions)) {
        return finish('needs_review', 'INVALID_INNER_INSTRUCTIONS', 'Inner instruction groups have invalid or duplicate parent indexes.');
      }
      indexes.add(group.index);
      for (const instruction of group.instructions) instructions.push(instruction);
    }
  }
  let observed = 0n;
  let transfers = 0;
  for (const instruction of instructions) {
    // Program identity, not a display label or parsed payload, controls this exemption.
    // Ancillary instructions never contribute lamports to the observed payment.
    if (object(instruction) && ANCILLARY_PROGRAMS.has(instruction.programId)) continue;
    if (!object(instruction) || instruction.programId !== SYSTEM_PROGRAM
        || !object(instruction.parsed) || instruction.parsed.type !== 'transfer') {
      return finish('needs_review', 'UNSUPPORTED_INSTRUCTION', 'Only parsed System Program SOL transfers and allowlisted ComputeBudget/Memo ancillary instructions are supported; all other programs require review.');
    }
    const info = instruction.parsed.info;
    if (!object(info) || !base58Bytes(info.source, 32) || !base58Bytes(info.destination, 32)) {
      return finish('needs_review', 'INVALID_TRANSFER', 'A transfer has malformed source or destination addresses.');
    }
    const amount = lamports(info.lamports);
    if (amount === null || amount > 18446744073709551615n) return finish('needs_review', 'INVALID_AMOUNT', 'Transfer lamports must be an exact nonnegative u64 integer; unsafe JSON numbers are rejected.');
    if (info.source === info.destination) return finish('needs_review', 'SELF_TRANSFER', 'A self-transfer does not demonstrate a payment.');
    if (info.destination === invoice.recipient) { observed += amount; transfers++; }
    // A recipient spending in the same transaction can make gross receipts misleading.
    if (info.source === invoice.recipient) return finish('needs_review', 'RECIPIENT_OUTFLOW', 'The invoice recipient also sends SOL in this transaction; review the net payment.');
  }
  result.observedLamports = observed.toString();
  if (!transfers) return finish('mismatch', 'RECIPIENT_NOT_PAID', 'No supported SOL transfer pays the invoice recipient.');
  if (observed !== BigInt(invoice.amountLamports)) return finish('mismatch', 'AMOUNT_MISMATCH', 'The total transferred to the recipient does not equal the invoice amount.');
  return finish('matched', 'PAYMENT_MATCHED', evidence.source === 'fixture'
    ? 'Synthetic fixture matches the invoice; this is not onchain verification.'
    : 'Finalized RPC-reported SOL transfers match the invoice; provenance relies on the RPC provider.');
}
