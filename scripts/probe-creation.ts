// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/**
 * Measures whether a candidate log substring actually identifies token
 * creation. Fetches a sample of matching transactions and reports how many
 * yield a new mint.
 *
 * Usage:
 *   NODE_USE_ENV_PROXY=1 node --import tsx scripts/probe-creation.ts "<substring>" [sampleSize] [configPath]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { extractMints } from "../src/collector.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { installWebSocketProxy } from "../src/proxy.js";
import { errorMessage } from "../src/util.js";

async function main(): Promise<void> {
  const needle = process.argv[2];
  if (!needle) {
    process.stderr.write('usage: ... probe-creation.ts "<substring>" [sampleSize] [configPath]\n');
    process.exit(1);
  }
  const sampleSize = Number(process.argv[3] ?? 12);
  const config = loadConfig({ configPath: process.argv[4] ?? "config/default.yaml" });
  const logger = createLogger(config.logLevel);
  installWebSocketProxy(logger);

  const connection = new Connection(config.rpcUrl, config.collector.commitment);
  const program = config.programs[0]!;
  const signatures: string[] = [];

  connection.onLogs(
    new PublicKey(program.id),
    (logs) => {
      if (logs.err) return;
      if (!logs.logs.some((line) => line.includes(needle))) return;
      if (signatures.length < sampleSize) signatures.push(logs.signature);
    },
    config.collector.commitment,
  );
  logger.info("sampling matching transactions", { program: program.name, needle, sampleSize });

  const deadline = Date.now() + 30_000;
  while (signatures.length < sampleSize && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  let withMint = 0;
  const mints: string[] = [];
  for (const signature of signatures) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: config.collector.fetchCommitment,
        maxSupportedTransactionVersion: config.collector.maxSupportedTransactionVersion,
      });
      const found = extractMints(tx);
      if (found.length > 0) {
        withMint += 1;
        mints.push(...found);
      }
    } catch (err) {
      logger.warn("fetch failed", { signature, error: errorMessage(err) });
    }
  }

  process.stdout.write(
    `\nneedle: "${needle}"\nsampled: ${signatures.length}\nwith new mint: ${withMint}\n` +
      `precision: ${signatures.length ? Math.round((withMint / signatures.length) * 100) : 0}%\n`,
  );
  for (const mint of mints.slice(0, 5)) process.stdout.write(`  mint: ${mint}\n`);
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${errorMessage(err)}\n`);
  process.exit(1);
});
