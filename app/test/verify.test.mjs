import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPayment } from '../lib/verify.mjs';

const address = suffix => '1'.repeat(31) + suffix;
const recipient = address('2');
const sender = address('3');
const signature = '1'.repeat(63) + '2';
const otherSignature = '1'.repeat(63) + '3';
function transfer(destination = recipient, amount = 100, source = sender) {
  return { program: 'system', programId: '11111111111111111111111111111111',
    parsed: { type: 'transfer', info: { source, destination, lamports: amount } } };
}
function fixture() {
  return {
    invoice: { id: 'invoice-1', recipient, amountLamports: '100' },
    evidence: { source: 'fixture', cluster: 'devnet', signature, commitment: 'finalized',
      fetchedAt: '2026-10-12T18:00:00.000Z', transaction: {
        slot: 100, blockTime: 1791828000,
        transaction: { signatures: [signature], message: { instructions: [transfer()] } },
        meta: { err: null, innerInstructions: null },
      } },
  };
}
function run(mutate = () => {}, options) {
  const data = fixture();
  mutate(data, data.evidence.transaction);
  const result = verifyPayment(data.invoice, data.evidence, options);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  return result;
}
function expectCase(title, mutate, status, code, options) {
  test(title, () => {
    const result = run(mutate, options);
    assert.equal(result.status, status);
    if (code) assert.equal(result.code, code);
    assert.ok(result.reasons.length);
  });
}

test('returns the contract shape and labels synthetic results honestly', () => {
  assert.deepEqual(run(), {
    status: 'matched', code: 'PAYMENT_MATCHED',
    reasons: ['Synthetic fixture matches the invoice; this is not onchain verification.'],
    invoiceId: 'invoice-1', signature, expectedLamports: '100', observedLamports: '100',
    recipient, source: 'fixture', cluster: 'devnet', slot: 100, blockTime: 1791828000,
  });
});
expectCase('RPC result preserves source and provider limitation', d => { d.evidence.source = 'rpc'; }, 'matched');
test('RPC match explicitly notes provider trust', () => assert.match(run(d => { d.evidence.source = 'rpc'; }).reasons[0], /RPC provider/));
expectCase('underpayment', (_, t) => { t.transaction.message.instructions[0].parsed.info.lamports = 99; }, 'mismatch', 'AMOUNT_MISMATCH');
expectCase('overpayment', (_, t) => { t.transaction.message.instructions[0].parsed.info.lamports = 101; }, 'mismatch', 'AMOUNT_MISMATCH');
expectCase('wrong recipient', (_, t) => { t.transaction.message.instructions = [transfer(address('4'))]; }, 'mismatch', 'RECIPIENT_NOT_PAID');
expectCase('duplicate signature', () => {}, 'duplicate', 'SIGNATURE_ALREADY_USED', { usedSignatures: [signature] });
expectCase('unrelated ledger signature', () => {}, 'matched', undefined, { usedSignatures: [otherSignature] });
expectCase('failed transaction', (_, t) => { t.meta.err = { InstructionError: [0, 'InsufficientFunds'] }; }, 'mismatch', 'TRANSACTION_FAILED');
expectCase('unavailable transaction', d => { d.evidence.transaction = null; }, 'needs_review', 'TRANSACTION_UNAVAILABLE');
expectCase('signature binding', (_, t) => { t.transaction.signatures = [otherSignature]; }, 'mismatch', 'SIGNATURE_MISMATCH');
expectCase('requested signature must be first, not a cosigner', (_, t) => { t.transaction.signatures = [otherSignature, signature]; }, 'mismatch', 'SIGNATURE_MISMATCH');
expectCase('non-finalized receipt', d => { d.evidence.commitment = 'confirmed'; }, 'needs_review', 'NOT_FINALIZED');
expectCase('missing success metadata', (_, t) => { delete t.meta.err; }, 'needs_review', 'INVALID_TRANSACTION');
expectCase('unknown success metadata', (_, t) => { t.meta.err = false; }, 'needs_review', 'INVALID_METADATA');
expectCase('missing timestamp', (_, t) => { delete t.blockTime; }, 'needs_review', 'INVALID_TRANSACTION');
expectCase('null timestamp without constraint', (_, t) => { t.blockTime = null; }, 'matched');
expectCase('null timestamp with constraint', (d, t) => { t.blockTime = null; d.invoice.notBefore = 1; }, 'needs_review', 'TIMESTAMP_UNAVAILABLE');
expectCase('payment predates invoice', (d, t) => { d.invoice.notBefore = t.blockTime + 1; }, 'mismatch', 'PAYMENT_TOO_EARLY');
expectCase('inclusive invoice timestamp', (d, t) => { d.invoice.notBefore = t.blockTime; }, 'matched');
expectCase('forged system label', (_, t) => { t.transaction.message.instructions[0].programId = address('4'); }, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
expectCase('program id authoritative over display label', (_, t) => { t.transaction.message.instructions[0].program = 'custom-label'; }, 'matched');
expectCase('token transfer unsupported', (_, t) => { t.transaction.message.instructions[0].programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; }, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
expectCase('opaque instruction alongside payment cannot cause match', (_, t) => { t.transaction.message.instructions.push({ programId: address('4'), data: 'abc' }); }, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
expectCase('unsupported system instruction', (_, t) => { t.transaction.message.instructions[0].parsed.type = 'createAccount'; }, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
expectCase('self transfer is not payment', (_, t) => { t.transaction.message.instructions = [transfer(recipient, 100, recipient)]; }, 'needs_review', 'SELF_TRANSFER');
expectCase('recipient outflow needs review', (_, t) => { t.transaction.message.instructions.push(transfer(sender, 100, recipient)); }, 'needs_review', 'RECIPIENT_OUTFLOW');
expectCase('empty instructions do not settle', (_, t) => { t.transaction.message.instructions = []; }, 'mismatch', 'RECIPIENT_NOT_PAID');

test('aggregates transfers to recipient only', () => {
  const result = run((_, t) => { t.transaction.message.instructions = [transfer(recipient, 40), transfer(address('4'), 900), transfer(recipient, '60')]; });
  assert.equal(result.status, 'matched');
  assert.equal(result.observedLamports, '100');
});
test('aggregates supported inner instructions once', () => {
  const result = run((_, t) => {
    t.transaction.message.instructions = [transfer(recipient, 40)];
    t.meta.innerInstructions = [{ index: 0, instructions: [transfer(recipient, 60)] }];
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.observedLamports, '100');
});
for (const groups of [{}, [null], [{ index: -1, instructions: [] }], [{ index: 1, instructions: [] }], [{ index: 0, instructions: null }], [{ index: 0, instructions: [] }, { index: 0, instructions: [transfer()] }]]) {
  expectCase(`malformed inner instruction groups ${JSON.stringify(groups)}`, (_, t) => { t.meta.innerInstructions = groups; }, 'needs_review', 'INVALID_INNER_INSTRUCTIONS');
}
test('exact amounts above Number safe integer range', () => {
  const result = run((d, t) => {
    d.invoice.amountLamports = '9007199254740993';
    t.transaction.message.instructions = [transfer(recipient, '9007199254740992'), transfer(recipient, '1')];
  });
  assert.equal(result.status, 'matched');
  assert.equal(result.observedLamports, '9007199254740993');
});
expectCase('one lamport mismatch above safe integer range', (d, t) => {
  d.invoice.amountLamports = '9007199254740993';
  t.transaction.message.instructions = [transfer(recipient, '9007199254740992')];
}, 'mismatch', 'AMOUNT_MISMATCH');
for (const amount of [9007199254740992, -1, 0.5, null, true, {}, [], '1e2', '100.0', '+100', ' 100', '0100', '18446744073709551616']) {
  expectCase(`invalid transfer amount ${JSON.stringify(amount)}`, (_, t) => { t.transaction.message.instructions[0].parsed.info.lamports = amount; }, 'needs_review', 'INVALID_AMOUNT');
}
for (const value of [null, [], 1, true, 'text', {}]) {
  test(`malformed top-level values ${JSON.stringify(value)} never throw`, () => {
    const { invoice, evidence } = fixture();
    assert.equal(verifyPayment(value, evidence).status, 'needs_review');
    assert.equal(verifyPayment(invoice, value).status, 'needs_review');
    assert.equal(verifyPayment(invoice, evidence, value).status, value && typeof value === 'object' && !Array.isArray(value) ? 'matched' : 'needs_review');
  });
}
for (const [key, value] of [['id', ' '], ['recipient', '0'.repeat(32)], ['recipient', '1'.repeat(31)], ['recipient', 'z'.repeat(44)], ['amountLamports', '0'], ['amountLamports', '01'], ['amountLamports', 100], ['notBefore', -1], ['notBefore', '100']]) {
  expectCase(`invalid invoice ${key} ${value}`, d => { d.invoice[key] = value; }, 'needs_review', 'INVALID_INVOICE');
}
for (const [key, value] of [['source', 'onchain'], ['cluster', 'custom'], ['signature', '1'.repeat(63)], ['signature', 'z'.repeat(88)], ['signature', '0'.repeat(88)], ['fetchedAt', 'yesterday']]) {
  expectCase(`invalid evidence ${key} ${value}`, d => { d.evidence[key] = value; }, 'needs_review', 'INVALID_EVIDENCE');
}
for (const mutate of [t => { t.meta = null; }, t => { t.transaction = null; }, t => { t.transaction.message = []; }, t => { t.transaction.signatures = []; }, t => { t.slot = '1'; }, t => { t.blockTime = 1.5; }, t => { t.transaction.message.instructions = {}; }]) {
  expectCase(`malformed transaction ${mutate.toString()}`, (_, t) => mutate(t), 'needs_review', 'INVALID_TRANSACTION');
}
expectCase('null instruction', (_, t) => { t.transaction.message.instructions = [null]; }, 'needs_review');
expectCase('missing transfer info', (_, t) => { delete t.transaction.message.instructions[0].parsed.info; }, 'needs_review', 'INVALID_TRANSFER');
expectCase('invalid transfer source', (_, t) => { t.transaction.message.instructions[0].parsed.info.source = 'invalid'; }, 'needs_review', 'INVALID_TRANSFER');
expectCase('malformed ledger', () => {}, 'needs_review', 'INVALID_LEDGER', { usedSignatures: 'anything' });
expectCase('malformed ledger entry', () => {}, 'needs_review', 'INVALID_LEDGER', { usedSignatures: [null] });
test('large untrusted inner arrays return review without argument-count exceptions', () => {
  const result = run((_, t) => {
    t.meta.innerInstructions = [{ index: 0, instructions: Array(150000).fill(null) }];
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(result.code, 'UNSUPPORTED_INSTRUCTION');
});

const computeBudget = 'ComputeBudget111111111111111111111111111111';
const memo = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
for (const programId of [computeBudget, memo]) {
  test(`allowlisted ancillary instruction alongside SOL transfer: ${programId}`, () => {
    const result = run((_, t) => {
      t.transaction.message.instructions.unshift({ programId, accounts: [], data: 'ErSv31' });
    });
    assert.equal(result.status, 'matched');
    assert.equal(result.observedLamports, '100');
  });
  test(`ancillary parsed transfer payload never counts as payment: ${programId}`, () => {
    const result = run((_, t) => {
      t.transaction.message.instructions = [{ ...transfer(), programId }];
    });
    assert.equal(result.status, 'mismatch');
    assert.equal(result.code, 'RECIPIENT_NOT_PAID');
    assert.equal(result.observedLamports, '0');
  });
  expectCase(`ancillary instruction cannot hide unsafe transfer amount: ${programId}`, (_, t) => {
    t.transaction.message.instructions = [{ programId }, transfer(recipient, 9007199254740992)];
  }, 'needs_review', 'INVALID_AMOUNT');
  expectCase(`ancillary instruction cannot hide underpayment: ${programId}`, (_, t) => {
    t.transaction.message.instructions = [{ programId }, transfer(recipient, 99)];
  }, 'mismatch', 'AMOUNT_MISMATCH');
}
expectCase('compute-budget instructions and parsed memo coexist with exact SOL payment', (_, t) => {
  t.transaction.message.instructions = [
    { programId: computeBudget, accounts: [], data: 'ErSv31', stackHeight: 1 },
    { programId: computeBudget, accounts: [], data: '3WS1gif7RDCs', stackHeight: 1 },
    transfer(),
    { programId: memo, program: 'spl-memo', parsed: 'invoice-1' },
  ];
}, 'matched');
expectCase('ancillary labels cannot exempt an unknown program', (_, t) => {
  t.transaction.message.instructions.push({ programId: address('4'), program: 'spl-memo', parsed: 'invoice-1' });
}, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
expectCase('near-match ancillary program id is not allowlisted', (_, t) => {
  t.transaction.message.instructions.push({ programId: computeBudget + '1', program: 'compute-budget' });
}, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
for (const programId of [address('4'), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']) {
  expectCase(`unsupported parent with inner SOL transfer: ${programId}`, (_, t) => {
    t.transaction.message.instructions = [{ programId: computeBudget }, { programId, program: 'spl-memo' }];
    t.meta.innerInstructions = [{ index: 1, instructions: [transfer()] }];
  }, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
  expectCase(`unsupported inner program alongside valid SOL and ancillary instructions: ${programId}`, (_, t) => {
    t.transaction.message.instructions = [{ programId: memo, parsed: 'invoice-1' }, transfer()];
    t.meta.innerInstructions = [{ index: 1, instructions: [{ programId }] }];
  }, 'needs_review', 'UNSUPPORTED_INSTRUCTION');
}
