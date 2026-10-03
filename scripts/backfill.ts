// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { buildReport, createBackfiller, DEFAULT_BACKFILL_OPTIONS } from "../src/backfill.js";
import { loadConfig } from "../src/config.js";
import { createDexScreenerClient } from "../src/indexer.js";
import { createLogger } from "../src/logger.js";
import { createStore } from "../src/store.js";
import { errorMessage } from "../src/util.js";

/**
 * M3 backfill CLI.
 *
 *   node --import tsx scripts/backfill.ts run    [configPath]  # snapshot market data
 *   node --import tsx scripts/backfill.ts report [configPath]  # print first→last stats
 *
 * Read-only: it only queries DexScreener and writes to the local SQLite file.
 */
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "run";
  const configPath = process.argv[3] ?? "config/default.yaml";
  const config = loadConfig({ configPath });
  const logger = createLogger(config.logLevel);
  const store = createStore(config.store.path);

  try {
    if (mode === "report") {
      const report = buildReport(store.listTokens(100_000), store.listSnapshots());
      const pct = (v: number | null): string => (v === null ? "?" : `${v >= 0 ? "+" : ""}${v}%`);
      process.stdout.write(
        [
          `tokens with a price series: ${report.tracked} (snapshots total: ${store.countSnapshots()})`,
          `winners: ${report.winners} | losers: ${report.losers} | near-zero (<=-99%): ${report.zeros}`,
          `mean change: ${pct(report.meanChangePct)} | median change: ${pct(report.medianChangePct)}`,
          report.best ? `best: ${report.best.symbol ?? report.best.mint.slice(0, 6)} ${pct(report.best.changePct)}` : "best: -",
          report.worst ? `worst: ${report.worst.symbol ?? report.worst.mint.slice(0, 6)} ${pct(report.worst.changePct)}` : "worst: -",
          "",
        ].join("\n"),
      );
      return;
    }

    if (mode !== "run") {
      throw new Error(`unknown mode "${mode}" (expected: run | report)`);
    }

    const indexer = createDexScreenerClient(logger, config.dexscreenerEnabled);
    const backfiller = createBackfiller(store, indexer, logger, DEFAULT_BACKFILL_OPTIONS);
    const result = await backfiller.runOnce();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});
