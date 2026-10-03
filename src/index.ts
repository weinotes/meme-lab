// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Connection } from "@solana/web3.js";
import { createBackfiller, DEFAULT_BACKFILL_OPTIONS } from "./backfill.js";
import { createLogsCollector } from "./collector.js";
import { loadConfig } from "./config.js";
import { createEnricher } from "./enricher.js";
import { createDexScreenerClient } from "./indexer.js";
import { createLogger } from "./logger.js";
import { createNotifier, formatAlert } from "./notifier.js";
import { installWebSocketProxy } from "./proxy.js";
import { screen } from "./screener.js";
import { createStore } from "./store.js";
import { errorMessage } from "./util.js";

const HEARTBEAT_MS = 5 * 60 * 1000;
const BACKFILL_MS = 10 * 60 * 1000;

async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "config/default.yaml";
  const config = loadConfig({ configPath });
  const logger = createLogger(config.logLevel);

  logger.info("meme-lab starting", {
    configPath,
    programs: config.programs.map((p) => p.name),
    storage: config.store.path,
  });
  logger.warn("READ-ONLY MODE: this process never signs or submits transactions");

  installWebSocketProxy(logger);

  const connection = new Connection(config.rpcUrl, config.collector.commitment);
  try {
    await connection.getLatestBlockhash(config.collector.commitment);
    logger.info("rpc connection ok");
  } catch (err) {
    logger.error("rpc connection failed", { error: errorMessage(err) });
    process.exitCode = 1;
    return;
  }

  const indexer = createDexScreenerClient(logger, config.dexscreenerEnabled);
  const enricher = createEnricher(connection, indexer, config.enricher, logger);
  const store = createStore(config.store.path);
  const notifier = createNotifier(config.telegram, logger);
  const backfiller = createBackfiller(store, indexer, logger, DEFAULT_BACKFILL_OPTIONS);

  let notified = 0;

  const collector = createLogsCollector(
    connection,
    config.programs,
    config.collector,
    logger,
    async (event) => {
      const token = await enricher(event);
      // Fresh tokens have no liquidity/holder signal yet; screen() uses the age
      // to keep such candidates in manual review instead of hard-rejecting.
      const ageSec = Math.max(0, (Date.now() - Date.parse(token.firstSeenAt)) / 1000);
      const result = screen(token, config.screening, { ageSec });
      store.upsertToken(token, result);

      const shouldNotify =
        result.verdict === "pass" || (result.verdict === "manual" && config.pipeline.notifyManual);

      logger.info("screened", {
        mint: token.mint,
        symbol: token.symbol,
        verdict: result.verdict,
        score: result.score,
      });

      if (shouldNotify) {
        const ok = await notifier.send(formatAlert(token, result));
        if (ok) {
          store.markNotified(token.mint);
          notified += 1;
        }
      }
    },
  );

  await collector.start();
  logger.info("watching for new tokens", { notifier: notifier.name });

  const heartbeat = setInterval(() => {
    logger.info("heartbeat", {
      tokensSeen: store.countTokens(),
      byVerdict: store.countByVerdict(),
      alertsSent: notified,
    });
  }, HEARTBEAT_MS);

  // M3 backfill: re-snapshot market data for tracked tokens so we can later
  // answer "did the flagged tokens actually go up or die?".
  const backfillTimer = setInterval(() => {
    backfiller.runOnce().catch((err: unknown) => {
      logger.warn("backfill run failed", { error: errorMessage(err) });
    });
  }, BACKFILL_MS);

  const shutdown = (signal: string): void => {
    logger.info("shutting down", { signal });
    clearInterval(heartbeat);
    clearInterval(backfillTimer);
    collector.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise<void>(() => {
    // Keep the process alive; shutdown happens via signals.
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});
