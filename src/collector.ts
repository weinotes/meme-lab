// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { ProgramConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { RawEvent } from "./types.js";
import { errorMessage, isoNow, withRetry } from "./util.js";

const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // token-2022
]);

/** Throttle for queue-overflow warnings so a firehose cannot spam the log. */
const QUEUE_WARN_INTERVAL_MS = 10_000;

export interface CollectorOptions {
  commitment: "processed" | "confirmed" | "finalized";
  fetchCommitment: "confirmed" | "finalized";
  maxSupportedTransactionVersion: number;
  logIncludes: string[];
  txFetchRetries: number;
  queueLimit: number;
  dedupeWindowSec: number;
}

export interface Collector {
  start(): Promise<void>;
  stop(): void;
}

/**
 * Extracts newly initialised mint addresses from a parsed transaction.
 *
 * A brand new SPL token always contains an `initializeMint` instruction.
 * Reading it from the parsed instruction tree is program-agnostic, so it works
 * across launchpads without hardcoding each one's account layout.
 */
export function extractMints(tx: ParsedTransactionWithMeta | null): string[] {
  if (!tx) return [];
  const mints = new Set<string>();

  const visit = (instruction: unknown): void => {
    const ix = instruction as {
      programId?: string | { toBase58?: () => string };
      parsed?: { type?: string; info?: { mint?: unknown } };
    };
    // `programId` is a PublicKey for top-level instructions but RPCs have been
    // observed returning plain base58 strings inside inner instructions.
    const programId = programIdOf(ix?.programId);
    const type = ix?.parsed?.type;
    if (!programId || !TOKEN_PROGRAM_IDS.has(programId) || !type) return;
    if (type !== "initializeMint" && type !== "initializeMint2") return;
    const mint = ix.parsed?.info?.mint;
    if (typeof mint === "string") mints.add(mint);
  };

  for (const ix of allInstructions(tx)) visit(ix);
  return [...mints];
}

function programIdOf(programId: unknown): string | null {
  if (typeof programId === "string") return programId;
  const asPublicKey = programId as { toBase58?: () => string } | undefined;
  return asPublicKey?.toBase58?.() ?? null;
}

function allInstructions(tx: ParsedTransactionWithMeta): unknown[] {
  const out: unknown[] = [...tx.transaction.message.instructions];
  for (const inner of tx.meta?.innerInstructions ?? []) {
    out.push(...inner.instructions);
  }
  return out;
}

/** Debug helper: unique `programId:instructionType` pairs found in a transaction. */
export function summarizeInstructions(tx: ParsedTransactionWithMeta): string[] {
  const seen = new Set<string>();
  for (const instruction of allInstructions(tx)) {
    const ix = instruction as {
      programId?: string | { toBase58?: () => string };
      parsed?: { type?: string };
    };
    const programId = programIdOf(ix?.programId) ?? "?";
    const type = ix?.parsed?.type ?? "<unparsed>";
    seen.add(`${programId}:${type}`);
  }
  return [...seen];
}

/**
 * Subscribes to configured programs via `logsSubscribe` and emits one RawEvent
 * per newly created mint.
 *
 * Handlers are processed through a single sequential queue so an RPC burst
 * cannot spawn unbounded concurrent transaction fetches.
 */
export function createLogsCollector(
  conn: Connection,
  programs: ProgramConfig[],
  opts: CollectorOptions,
  logger: Logger,
  onEvent: (event: RawEvent) => Promise<void>,
): Collector {
  const subscriptionIds: number[] = [];
  const seenSignatures = new Set<string>();
  const seenMints = new Map<string, number>();
  const queue: { signature: string; source: string }[] = [];
  let draining = false;
  let stopped = false;

  const isDuplicateMint = (mint: string): boolean => {
    const now = Date.now();
    const last = seenMints.get(mint);
    if (last !== undefined && now - last < opts.dedupeWindowSec * 1000) return true;
    seenMints.set(mint, now);
    return false;
  };

  const processSignature = async (signature: string, source: string): Promise<void> => {
    try {
      const tx = await withRetry(
        () =>
          conn.getParsedTransaction(signature, {
            commitment: opts.fetchCommitment,
            maxSupportedTransactionVersion: opts.maxSupportedTransactionVersion,
          }),
        opts.txFetchRetries,
        300,
        (err, attempt) =>
          logger.debug("tx fetch retry", { signature, attempt, error: errorMessage(err) }),
      );

      for (const mint of extractMints(tx)) {
        if (isDuplicateMint(mint)) continue;
        await onEvent({ mint, signature, source, seenAt: isoNow() });
      }
    } catch (err) {
      logger.warn("failed to process signature", { signature, error: errorMessage(err) });
    }
  };

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !stopped) {
        const next = queue.shift();
        if (!next) break;
        await processSignature(next.signature, next.source);
      }
    } finally {
      draining = false;
    }
  };

  let lastQueueWarnAt = 0;
  let droppedSinceWarn = 0;

  const enqueue = (signature: string, source: string): void => {
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);
    if (seenSignatures.size > 50_000) seenSignatures.clear();

    if (queue.length >= opts.queueLimit) {
      queue.shift();
      droppedSinceWarn += 1;
      const now = Date.now();
      if (now - lastQueueWarnAt > QUEUE_WARN_INTERVAL_MS) {
        logger.warn("collector queue full, dropping oldest events", {
          queueLimit: opts.queueLimit,
          droppedInWindow: droppedSinceWarn,
          hint: "public RPC cannot keep up with this event rate; use a dedicated RPC or fewer programs",
        });
        lastQueueWarnAt = now;
        droppedSinceWarn = 0;
      }
    }
    queue.push({ signature, source });
    void drain();
  };

  /** Pre-filter on log text so we only pay for transactions worth fetching. */
  const matchesLogFilter = (logs: string[]): boolean => {
    if (opts.logIncludes.length === 0) return true;
    return logs.some((line) => opts.logIncludes.some((needle) => line.includes(needle)));
  };

  return {
    async start(): Promise<void> {
      for (const program of programs) {
        let publicKey: PublicKey;
        try {
          publicKey = new PublicKey(program.id);
        } catch {
          logger.error("invalid program id, skipping", { name: program.name, id: program.id });
          continue;
        }
        const id = conn.onLogs(
          publicKey,
          (logs) => {
            if (stopped) return;
            if (logs.err) {
              logger.debug("skipping failed transaction", { signature: logs.signature });
              return;
            }
            if (!matchesLogFilter(logs.logs)) return;
            enqueue(logs.signature, program.name);
          },
          opts.commitment,
        );
        subscriptionIds.push(id);
        logger.info("subscribed to program", {
          name: program.name,
          id: program.id,
          subscriptionId: id,
        });
      }

      if (subscriptionIds.length === 0) {
        throw new Error("no valid program subscriptions could be created");
      }
    },

    stop(): void {
      stopped = true;
      queue.length = 0;
      for (const id of subscriptionIds) {
        void conn.removeOnLogsListener(id).catch((err: unknown) => {
          logger.debug("failed to remove listener", { id, error: errorMessage(err) });
        });
      }
      subscriptionIds.length = 0;
    },
  };
}
