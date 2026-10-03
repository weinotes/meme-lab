// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type { IndexerClient } from "./indexer.js";
import type { Logger } from "./logger.js";
import type { Store } from "./store.js";
import type { MarketSnapshot, TrackedToken } from "./types.js";
import { errorMessage, round, sleep } from "./util.js";

export interface BackfillOptions {
  /** Skip a token whose newest snapshot is younger than this (rate control). */
  minIntervalSec: number;
  /** Stop tracking tokens first seen longer ago than this. */
  maxAgeHours: number;
  /** Max tokens to process per run. */
  limit: number;
  /** Politeness delay between indexer calls, in milliseconds. */
  throttleMs: number;
}

export const DEFAULT_BACKFILL_OPTIONS: BackfillOptions = {
  minIntervalSec: 600,
  maxAgeHours: 72,
  limit: 200,
  throttleMs: 250,
};

export interface BackfillResult {
  scanned: number;
  snapshotted: number;
  skipped: number;
  missing: number;
}

export interface Backfiller {
  runOnce(now?: Date): Promise<BackfillResult>;
}

/**
 * Periodically re-queries market data for previously screened tokens and stores
 * a timestamped snapshot. This is the M3 "backfill" stage: it lets the lab ask
 * "did the tokens we flagged actually go up or die?" without any write access
 * to the chain or any trading capability.
 */
export function createBackfiller(
  store: Store,
  indexer: IndexerClient,
  logger: Logger,
  options: BackfillOptions = DEFAULT_BACKFILL_OPTIONS,
): Backfiller {
  return {
    async runOnce(now: Date = new Date()): Promise<BackfillResult> {
      const tokens = store.listTokens(options.limit);
      const nowMs = now.getTime();
      const result: BackfillResult = { scanned: tokens.length, snapshotted: 0, skipped: 0, missing: 0 };

      for (const token of tokens) {
        const ageHours = (nowMs - Date.parse(token.firstSeenAt)) / 3_600_000;
        if (ageHours > options.maxAgeHours) {
          result.skipped += 1;
          continue;
        }
        const last = store.latestSnapshotAt(token.mint);
        if (last !== null && (nowMs - Date.parse(last)) / 1000 < options.minIntervalSec) {
          result.skipped += 1;
          continue;
        }

        let market;
        try {
          market = await indexer.lookup(token.mint);
        } catch (err) {
          logger.warn("backfill lookup failed", { mint: token.mint, error: errorMessage(err) });
          result.missing += 1;
          continue;
        }
        if (market === null) {
          result.missing += 1;
          continue;
        }

        store.insertSnapshot({
          mint: token.mint,
          observedAt: now.toISOString(),
          priceUsd: market.priceUsd,
          marketCapUsd: market.marketCapUsd,
          fdvUsd: market.fdvUsd,
          liquidityUsd: market.liquidityUsd,
          pairAddress: market.pairAddress,
          source: "dexscreener",
        });
        result.snapshotted += 1;
        if (options.throttleMs > 0) await sleep(options.throttleMs);
      }

      logger.info("backfill run complete", { ...result });
      return result;
    },
  };
}

export interface TokenBackfillStat {
  mint: string;
  symbol: string | null;
  snapshots: number;
  firstUsd: number | null;
  lastUsd: number | null;
  changePct: number;
}

export interface BackfillReport {
  tracked: number;
  withChange: number;
  winners: number;
  losers: number;
  zeros: number;
  meanChangePct: number | null;
  medianChangePct: number | null;
  best: TokenBackfillStat | null;
  worst: TokenBackfillStat | null;
  tokens: TokenBackfillStat[];
}

function pickUsd(snapshot: MarketSnapshot): number | null {
  if (snapshot.priceUsd !== null && snapshot.priceUsd > 0) return snapshot.priceUsd;
  if (snapshot.marketCapUsd !== null && snapshot.marketCapUsd > 0) return snapshot.marketCapUsd;
  return null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Builds per-token first→last change and aggregate statistics from snapshots. */
export function buildReport(tokens: TrackedToken[], snapshots: MarketSnapshot[]): BackfillReport {
  const byMint = new Map<string, { symbol: string | null; points: { at: string; usd: number }[] }>();
  const symbols = new Map(tokens.map((t) => [t.mint, t.symbol] as const));

  for (const snapshot of snapshots) {
    const usd = pickUsd(snapshot);
    if (usd === null) continue;
    let entry = byMint.get(snapshot.mint);
    if (!entry) {
      entry = { symbol: symbols.get(snapshot.mint) ?? null, points: [] };
      byMint.set(snapshot.mint, entry);
    }
    entry.points.push({ at: snapshot.observedAt, usd });
  }

  const stats: TokenBackfillStat[] = [];
  for (const [mint, entry] of byMint) {
    const points = entry.points.sort((a, b) => a.at.localeCompare(b.at));
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const changePct = round(((last.usd - first.usd) / first.usd) * 100, 2);
    stats.push({
      mint,
      symbol: entry.symbol,
      snapshots: points.length,
      firstUsd: first.usd,
      lastUsd: last.usd,
      changePct,
    });
  }

  const changes = stats.map((s) => s.changePct);
  const sorted = [...stats].sort((a, b) => b.changePct - a.changePct);
  return {
    tracked: stats.length,
    withChange: changes.length,
    winners: changes.filter((c) => c > 0).length,
    losers: changes.filter((c) => c < 0).length,
    zeros: changes.filter((c) => c <= -99).length,
    meanChangePct: changes.length === 0 ? null : round(changes.reduce((a, b) => a + b, 0) / changes.length, 2),
    medianChangePct: median(changes) === null ? null : round(median(changes)!, 2),
    best: sorted[0] ?? null,
    worst: sorted[sorted.length - 1] ?? null,
    tokens: sorted,
  };
}
