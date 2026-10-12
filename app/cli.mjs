#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { fetchEvidence } from "./lib/rpc.mjs";
import { verifyPayment } from "./lib/verify.mjs";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(appDirectory, "fixtures", "demo.json");

const limitations = [
  "ReceiptRail is read-only and does not move funds.",
  "Fixture results are synthetic and are not onchain verification.",
  "Live results rely on the selected Solana RPC provider.",
  "The CLI does not preserve duplicate-signature state across invocations."
];

function usage() {
  return [
    "Usage:",
    "  node cli.mjs demo",
    "  node cli.mjs verify --invoice PATH --signature SIG [--cluster devnet|mainnet-beta]"
  ].join("\n");
}

function parseVerifyArguments(args) {
  const values = { cluster: "mainnet-beta" };
  const supported = new Set(["--invoice", "--signature", "--cluster"]);

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!supported.has(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${flag ?? "(end)"}.\n${usage()}`);
    }
    values[flag.slice(2)] = value;
  }

  if (!values.invoice || !values.signature) {
    throw new Error(`Both --invoice and --signature are required.\n${usage()}`);
  }
  if (!["devnet", "mainnet-beta"].includes(values.cluster)) {
    throw new Error("--cluster must be devnet or mainnet-beta.");
  }
  return values;
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} at ${filePath}: ${error.message}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} at ${filePath}: ${error.message}`);
  }
}

async function runDemo() {
  const fixtures = await readJson(fixturePath, "demo fixtures");
  const cases = fixtures.map((fixture) => {
    const result = verifyPayment(fixture.invoice, fixture.evidence, {
      usedSignatures: fixture.usedSignatures ?? []
    });
    return {
      id: fixture.id,
      title: fixture.title,
      expectedStatus: fixture.expectedStatus,
      passed: result.status === fixture.expectedStatus,
      result
    };
  });
  const allPassed = cases.every((fixtureCase) => fixtureCase.passed);

  console.log(JSON.stringify({
    mode: "synthetic-demo",
    source: "fixture",
    notice: "Synthetic fixtures only. These results are not onchain verification.",
    allPassed,
    cases,
    limitations
  }, null, 2));
  process.exitCode = allPassed ? 0 : 1;
}

async function runVerify(args) {
  const options = parseVerifyArguments(args);
  const invoicePath = path.resolve(process.cwd(), options.invoice);
  const invoice = await readJson(invoicePath, "invoice");
  const evidence = await fetchEvidence(options.signature, {
    cluster: options.cluster
  });
  const result = verifyPayment(invoice, evidence);

  console.log(JSON.stringify({
    mode: "live-rpc",
    invoice,
    evidence,
    result,
    limitations
  }, null, 2));
  process.exitCode = result.status === "matched" ? 0 : 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "demo" && args.length === 0) {
    await runDemo();
    return;
  }
  if (command === "verify") {
    await runVerify(args);
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: {
      code: error.code ?? "CLI_ERROR",
      message: error.message
    }
  }, null, 2));
  process.exitCode = 2;
});
