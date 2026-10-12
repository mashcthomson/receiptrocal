import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { verifyPayment } from "../lib/verify.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.dirname(testDirectory);
const fixturePath = path.join(appDirectory, "fixtures", "demo.json");
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodedBase58Length(value) {
  assert.equal(typeof value, "string");
  assert.match(value, /^[1-9A-HJ-NP-Za-km-z]+$/);

  let decoded = 0n;
  for (const character of value) {
    decoded = decoded * 58n + BigInt(alphabet.indexOf(character));
  }

  let byteLength = 0;
  while (decoded > 0n) {
    decoded >>= 8n;
    byteLength += 1;
  }
  const leadingZeroBytes = value.match(/^1*/)[0].length;
  return leadingZeroBytes + byteLength;
}

test("demo fixture catalog has the required stable cases", () => {
  assert.deepEqual(
    fixtures.map(({ id }) => id),
    ["paid", "underpaid", "wrong-recipient", "duplicate", "failed", "unavailable"]
  );
  assert.equal(new Set(fixtures.map(({ id }) => id)).size, fixtures.length);
});

test("fixtures use explicit synthetic provenance and valid identifiers", () => {
  for (const fixture of fixtures) {
    assert.equal(fixture.evidence.source, "fixture", fixture.id);
    assert.equal(fixture.evidence.commitment, "finalized", fixture.id);
    assert.equal(decodedBase58Length(fixture.invoice.recipient), 32, fixture.id);
    assert.equal(decodedBase58Length(fixture.evidence.signature), 64, fixture.id);
    assert.match(fixture.invoice.amountLamports, /^[1-9][0-9]*$/, fixture.id);

    const transaction = fixture.evidence.transaction;
    if (transaction === null) {
      continue;
    }
    assert.equal(
      transaction.transaction.signatures[0],
      fixture.evidence.signature,
      fixture.id
    );
    for (const instruction of transaction.transaction.message.instructions) {
      assert.equal(instruction.programId, "11111111111111111111111111111111");
      assert.equal(instruction.program, "system");
      assert.equal(instruction.parsed.type, "transfer");
      assert.equal(decodedBase58Length(instruction.parsed.info.source), 32);
      assert.equal(decodedBase58Length(instruction.parsed.info.destination), 32);
    }
  }
});

test("every fixture produces its declared verifier status", () => {
  for (const fixture of fixtures) {
    const result = verifyPayment(fixture.invoice, fixture.evidence, {
      usedSignatures: fixture.usedSignatures ?? []
    });
    assert.equal(result.status, fixture.expectedStatus, fixture.id);
  }
});

test("CLI demo verifies all fixture cases", () => {
  const stdout = execFileSync(
    process.execPath,
    [path.join(appDirectory, "cli.mjs"), "demo"],
    { encoding: "utf8" }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.mode, "synthetic-demo");
  assert.equal(report.source, "fixture");
  assert.equal(report.allPassed, true);
  assert.equal(report.cases.length, fixtures.length);
  assert.ok(report.cases.every(({ passed }) => passed));
});
