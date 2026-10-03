// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Fetch one transaction by signature and run it through the full pipeline:
 * extract new mints -> enrich -> screen -> print alert.
 *
 * Useful for debugging, and for verifying the live path without subscribing to
 * the firehose.
 *
 * Usage:
 *   NODE_USE_ENV_PROXY=1 node --import tsx scripts/fetch-once.ts <signature> [configPath]
 */
import { Connection } from "@solana/web3.js";
import { extractMints, summarizeInstructions } from "../src/collector.js";
import { loadConfig } from "../src/config.js";
import { createEnricher } from "../src/enricher.js";
import { createDexScreenerClient } from "../src/indexer.js";
import { createLogger } from "../src/logger.js";
import { formatAlert } from "../src/notifier.js";
import { installWebSocketProxy } from "../src/proxy.js";
import { screen } from "../src/screener.js";
import { errorMessage } from "../src/util.js";

async function main(): Promise<void> {
  const signature = process.argv[2];
  if (!signature) {
    process.stderr.write(
      "usage: node --import tsx scripts/fetch-once.ts <signature> [configPath]\n",
    );
    process.exit(1);
  }

  const config = loadConfig({ configPath: process.argv[3] ?? "config/default.yaml" });
  const logger = createLogger(config.logLevel);
  installWebSocketProxy(logger);

  const connection = new Connection(config.rpcUrl, config.collector.fetchCommitment);
  const tx = await connection.getParsedTransaction(signature, {
    commitment: config.collector.fetchCommitment,
    maxSupportedTransactionVersion: config.collector.maxSupportedTransactionVersion,
  });

  if (!tx) {
    process.stderr.write("transaction not found (or not yet at this commitment)\n");
    process.exit(2);
  }

  const mints = extractMints(tx);
  process.stdout.write(`mints found in transaction: ${mints.length}\n`);
  if (mints.length === 0) {
    process.stdout.write("instruction summary:\n");
    for (const line of summarizeInstructions(tx)) process.stdout.write(`  ${line}\n`);
    return;
  }

  const indexer = createDexScreenerClient(logger, config.dexscreenerEnabled);
  const enricher = createEnricher(connection, indexer, config.enricher, logger);

  for (const mint of mints) {
    const token = await enricher({
      mint,
      signature,
      source: "manual",
      seenAt: new Date().toISOString(),
    });
    const result = screen(token, config.screening);
    process.stdout.write(`\n${formatAlert(token, result)}\n`);
    process.stdout.write(`${JSON.stringify({ enrichErrors: token.enrichErrors }, null, 2)}\n`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});
