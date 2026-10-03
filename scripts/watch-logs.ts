// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovers the real log signatures emitted by a program, so the collector's
 * `logIncludes` filter can be set to something accurate instead of guessed.
 *
 * Prints unique log lines (with counts) observed during a sampling window.
 *
 * Usage:
 *   NODE_USE_ENV_PROXY=1 node --import tsx scripts/watch-logs.ts [seconds] [configPath]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { installWebSocketProxy } from "../src/proxy.js";
import { errorMessage } from "../src/util.js";

async function main(): Promise<void> {
  const seconds = Number(process.argv[2] ?? 20);
  const config = loadConfig({ configPath: process.argv[3] ?? "config/default.yaml" });
  const logger = createLogger(config.logLevel);
  installWebSocketProxy(logger);

  const connection = new Connection(config.rpcUrl, config.collector.commitment);
  const counts = new Map<string, number>();

  for (const program of config.programs) {
    connection.onLogs(
      new PublicKey(program.id),
      (logs) => {
        for (const line of logs.logs) {
          // Collapse variable data (addresses, numbers) so the shapes group up.
          const shape = line
            .replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<ADDR>")
            .replace(/\b\d+\b/g, "<N>");
          counts.set(`[${program.name}] ${shape}`, (counts.get(`[${program.name}] ${shape}`) ?? 0) + 1);
        }
      },
      config.collector.commitment,
    );
    logger.info("sampling logs", { program: program.name, seconds });
  }

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  process.stdout.write(`\nunique log shapes: ${sorted.length}\n`);
  for (const [shape, count] of sorted.slice(0, 40)) {
    process.stdout.write(`${String(count).padStart(6)}  ${shape}\n`);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});
