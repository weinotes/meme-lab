// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, createBackfiller } from "../src/backfill.js";
import { loadConfig } from "../src/config.js";
import type { IndexerClient } from "../src/indexer.js";
import type { Logger } from "../src/logger.js";
import { makeToken } from "../src/sample-tokens.js";
import { screen } from "../src/screener.js";
import { createStore } from "../src/store.js";

const config = loadConfig({ configPath: "config/default.yaml", env: {} });
const cfg = config.screening;

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const MINT_A = "MintAAA111111111111111111111111111111111111";
const MINT_B = "MintBBB111111111111111111111111111111111111";

function seedToken(store: ReturnType<typeof createStore>, mint: string, symbol: string): void {
  const token = makeToken({ mint, symbol, firstSeenAt: new Date().toISOString() });
  store.upsertToken(token, screen(token, cfg));
}

function marketClient(price: number, counter?: { n: number }): IndexerClient {
  return {
    async lookup() {
      if (counter) counter.n += 1;
      return {
        symbol: "AAA",
        name: null,
        liquidityUsd: 12_000,
        marketCapUsd: 120_000,
        fdvUsd: 120_000,
        priceUsd: price,
        pairAddress: "pair",
        pairUrl: "https://dexscreener.com/solana/pair",
      };
    },
  };
}

test("backfill snapshots market data and respects the min interval", async () => {
  const store = createStore(":memory:");
  seedToken(store, MINT_A, "AAA");
  const counter = { n: 0 };
  const backfiller = createBackfiller(store, marketClient(0.001, counter), silentLogger, {
    minIntervalSec: 600,
    maxAgeHours: 72,
    limit: 100,
    throttleMs: 0,
  });

  const first = await backfiller.runOnce(new Date());
  assert.equal(first.scanned, 1);
  assert.equal(first.snapshotted, 1);
  assert.equal(store.countSnapshots(), 1);

  const second = await backfiller.runOnce(new Date());
  assert.equal(second.snapshotted, 0);
  assert.equal(second.skipped, 1);
  assert.equal(counter.n, 1, "a fresh snapshot should suppress the next lookup");

  store.close();
});

test("backfill skips tokens that have aged out of the window", async () => {
  const store = createStore(":memory:");
  const old = makeToken({ mint: MINT_A, symbol: "OLD", firstSeenAt: "2020-01-01T00:00:00.000Z" });
  store.upsertToken(old, screen(old, cfg));
  const backfiller = createBackfiller(store, marketClient(0.001), silentLogger, {
    minIntervalSec: 0,
    maxAgeHours: 72,
    limit: 100,
    throttleMs: 0,
  });

  const result = await backfiller.runOnce(new Date());
  assert.equal(result.snapshotted, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.countSnapshots(), 0);

  store.close();
});

test("report computes per-token first→last change and aggregates", () => {
  const store = createStore(":memory:");
  seedToken(store, MINT_A, "AAA");
  seedToken(store, MINT_B, "BBB");

  store.insertSnapshot(snap(MINT_A, "2026-01-01T00:00:00.000Z", 0.001));
  store.insertSnapshot(snap(MINT_A, "2026-01-01T01:00:00.000Z", 0.004));
  store.insertSnapshot(snap(MINT_B, "2026-01-01T00:00:00.000Z", 0.002));
  store.insertSnapshot(snap(MINT_B, "2026-01-01T01:00:00.000Z", 0.00002));

  const report = buildReport(store.listTokens(100), store.listSnapshots());
  assert.equal(report.tracked, 2);
  assert.equal(report.winners, 1);
  assert.equal(report.losers, 1);
  assert.equal(report.zeros, 1, "a -99% drop counts as near-zero");
  assert.equal(report.best?.mint, MINT_A);
  assert.equal(report.best?.changePct, 300);
  assert.equal(report.worst?.changePct, -99);

  store.close();
});

function snap(mint: string, observedAt: string, priceUsd: number) {
  return {
    mint,
    observedAt,
    priceUsd,
    marketCapUsd: null,
    fdvUsd: null,
    liquidityUsd: 5000,
    pairAddress: null,
    source: "test",
  };
}
