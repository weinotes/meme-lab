// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Offline end-to-end check: runs sample tokens through the screener, the store
 * and the alert formatter without touching RPC or the network.
 *
 * Run: npm run dry-run
 */
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { formatAlert } from "../src/notifier.js";
import { SAMPLE_TOKENS } from "../src/sample-tokens.js";
import { screen } from "../src/screener.js";
import { createStore } from "../src/store.js";

function main(): void {
  const config = loadConfig({ configPath: process.argv[2] ?? "config/default.yaml" });
  const logger = createLogger(config.logLevel);
  const store = createStore(":memory:");

  for (const token of SAMPLE_TOKENS) {
    const result = screen(token, config.screening);
    store.upsertToken(token, result);
    process.stdout.write(`\n${"-".repeat(64)}\n${formatAlert(token, result)}\n`);
  }

  process.stdout.write(`\n${"=".repeat(64)}\n`);
  logger.info("dry run complete", {
    tokens: store.countTokens(),
    byVerdict: store.countByVerdict(),
  });
  store.close();
}

main();
