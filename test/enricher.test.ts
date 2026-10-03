// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Connection } from "@solana/web3.js";
import { createEnricher } from "../src/enricher.js";
import type { IndexerClient } from "../src/indexer.js";
import type { Logger } from "../src/logger.js";
import type { RawEvent } from "../src/types.js";

const MINT = "So11111111111111111111111111111111111111112";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const noIndexer: IndexerClient = {
  async lookup() {
    return null;
  },
};

interface FakeConnOptions {
  /** Stringified supply, or null when the mint account is not parseable. */
  supply: string | null;
  /** How many token accounts getProgramAccounts reports. */
  programAccounts: number;
  /** Raw amounts for getTokenLargestAccounts, largest first. */
  largest?: string[];
}

function fakeConnection(opts: FakeConnOptions): Connection {
  const parsedInfo =
    opts.supply === null
      ? { value: { data: { program: "spl-token" } } }
      : {
          value: {
            data: {
              parsed: {
                info: {
                  mintAuthority: null,
                  freezeAuthority: null,
                  supply: opts.supply,
                  decimals: 6,
                },
              },
            },
          },
        };
  const largest = (opts.largest ?? []).map((amount) => ({ amount }));
  return {
    async getParsedAccountInfo() {
      return parsedInfo;
    },
    async getTokenLargestAccounts() {
      return { value: largest };
    },
    async getProgramAccounts() {
      return Array.from({ length: opts.programAccounts }, (_, i) => ({ pubkey: i, account: {} }));
    },
  } as unknown as Connection;
}

function sampleEvent(): RawEvent {
  return {
    mint: MINT,
    signature: "sample-signature",
    source: "pumpfun",
    seenAt: new Date().toISOString(),
  };
}

const COUNT_HOLDERS = { countHolders: true, timeoutMs: 1000 };

test("positive supply with zero token accounts is unknown, never a fake zero", async () => {
  const enrich = createEnricher(
    fakeConnection({ supply: "1000000000000000", programAccounts: 0 }),
    noIndexer,
    COUNT_HOLDERS,
    silentLogger,
  );
  const token = await enrich(sampleEvent());
  assert.equal(token.holderCount, null);
  assert.ok(token.enrichErrors.some((e) => e.includes("unreliable")));
});

test("unparseable mint with zero accounts is also treated as unknown", async () => {
  const enrich = createEnricher(
    fakeConnection({ supply: null, programAccounts: 0 }),
    noIndexer,
    COUNT_HOLDERS,
    silentLogger,
  );
  const token = await enrich(sampleEvent());
  assert.equal(token.holderCount, null);
});

test("a confirmed zero supply makes a zero-account result trustworthy", async () => {
  const enrich = createEnricher(
    fakeConnection({ supply: "0", programAccounts: 0 }),
    noIndexer,
    COUNT_HOLDERS,
    silentLogger,
  );
  const token = await enrich(sampleEvent());
  assert.equal(token.holderCount, 0);
});

test("a real token-account count is kept as-is", async () => {
  const enrich = createEnricher(
    fakeConnection({ supply: "1000000000000000", programAccounts: 7 }),
    noIndexer,
    COUNT_HOLDERS,
    silentLogger,
  );
  const token = await enrich(sampleEvent());
  assert.equal(token.holderCount, 7);
  assert.equal(token.enrichErrors.length, 0);
});

test("holder counting disabled leaves the count unknown", async () => {
  const enrich = createEnricher(
    fakeConnection({ supply: "1000000000000000", programAccounts: 9 }),
    noIndexer,
    { countHolders: false, timeoutMs: 1000 },
    silentLogger,
  );
  const token = await enrich(sampleEvent());
  assert.equal(token.holderCount, null);
});

test("top-10 concentration is derived from the largest token accounts", async () => {
  const enrich = createEnricher(
    fakeConnection({
      supply: "1000000000000000",
      programAccounts: 3,
      largest: ["800000000000000", "100000000000000", "100000000000000"],
    }),
    noIndexer,
    COUNT_HOLDERS,
    silentLogger,
  );
  const token = await enrich(sampleEvent());
  assert.equal(token.largestAccountPct, 80);
  assert.equal(token.top10Pct, 100);
});
