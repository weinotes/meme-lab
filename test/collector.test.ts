// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { extractMints } from "../src/collector.js";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OTHER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

function tokenInstruction(type: string, mint: string) {
  return {
    programId: { toBase58: () => TOKEN_PROGRAM },
    parsed: { type, info: { mint } },
  };
}

function fakeTx(
  instructions: unknown[],
  innerInstructions: { instructions: unknown[] }[] = [],
): ParsedTransactionWithMeta {
  return {
    transaction: { message: { instructions } },
    meta: { innerInstructions },
  } as unknown as ParsedTransactionWithMeta;
}

test("extracts a mint from a top-level initializeMint", () => {
  const mints = extractMints(fakeTx([tokenInstruction("initializeMint", "MintA")]));
  assert.deepEqual(mints, ["MintA"]);
});

test("extracts a mint from initializeMint2 nested in inner instructions", () => {
  const mints = extractMints(
    fakeTx([], [{ instructions: [tokenInstruction("initializeMint2", "MintB")] }]),
  );
  assert.deepEqual(mints, ["MintB"]);
});

test("ignores other token instructions and foreign programs", () => {
  const mints = extractMints(
    fakeTx([
      tokenInstruction("mintTo", "MintC"),
      tokenInstruction("transfer", "MintD"),
      { programId: { toBase58: () => OTHER_PROGRAM }, parsed: { type: "initializeMint", info: { mint: "MintE" } } },
      { programId: { toBase58: () => TOKEN_PROGRAM } },
    ]),
  );
  assert.deepEqual(mints, []);
});

test("deduplicates the same mint seen twice", () => {
  const mints = extractMints(
    fakeTx([tokenInstruction("initializeMint", "MintF")], [
      { instructions: [tokenInstruction("initializeMint", "MintF")] },
    ]),
  );
  assert.deepEqual(mints, ["MintF"]);
});

test("returns nothing for a null transaction", () => {
  assert.deepEqual(extractMints(null), []);
});

test("accepts a plain string programId (as seen in inner instructions)", () => {
  const mints = extractMints(
    fakeTx([
      {
        programId: TOKEN_PROGRAM,
        parsed: { type: "initializeMint2", info: { mint: "MintG" } },
      } as unknown as ReturnType<typeof tokenInstruction>,
    ]),
  );
  assert.deepEqual(mints, ["MintG"]);
});
