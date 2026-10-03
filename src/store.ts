// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EnrichedToken, MarketSnapshot, ScreeningResult, TrackedToken } from "./types.js";

export interface Store {
  upsertToken(token: EnrichedToken, result: ScreeningResult): void;
  markNotified(mint: string): void;
  countTokens(): number;
  countByVerdict(): Record<string, number>;
  listTokens(limit: number): TrackedToken[];
  insertSnapshot(snapshot: MarketSnapshot): void;
  latestSnapshotAt(mint: string): string | null;
  listSnapshots(): MarketSnapshot[];
  countSnapshots(): number;
  close(): void;
}

function toInt(value: boolean | null): number | null {
  if (value === null) return null;
  return value ? 1 : 0;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint                      TEXT PRIMARY KEY,
  signature                 TEXT,
  source                    TEXT,
  first_seen_at             TEXT NOT NULL,
  symbol                    TEXT,
  name                      TEXT,
  decimals                  INTEGER,
  supply                    TEXT,
  mint_authority_revoked    INTEGER,
  freeze_authority_revoked  INTEGER,
  holder_count              INTEGER,
  top10_pct                 REAL,
  largest_pct               REAL,
  liquidity_usd             REAL,
  market_cap_usd            REAL,
  fdv_usd                   REAL,
  price_usd                 REAL,
  pair_address              TEXT,
  pair_url                  TEXT,
  buy_tax_pct               REAL,
  sell_tax_pct              REAL,
  lp_locked                 INTEGER,
  verdict                   TEXT NOT NULL,
  score                     REAL NOT NULL,
  reasons                   TEXT,
  rules                     TEXT,
  breakdown                 TEXT,
  enrich_errors             TEXT,
  notified                  INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_verdict ON tokens(verdict);
CREATE INDEX IF NOT EXISTS idx_tokens_first_seen ON tokens(first_seen_at);

CREATE TABLE IF NOT EXISTS market_snapshots (
  mint            TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  price_usd       REAL,
  market_cap_usd  REAL,
  fdv_usd         REAL,
  liquidity_usd   REAL,
  pair_address    TEXT,
  source          TEXT,
  PRIMARY KEY (mint, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_observed ON market_snapshots(mint, observed_at);
`;

/** SQLite-backed persistence for candidate tokens and their screening results. */
export function createStore(dbPath: string): Store {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);

  const upsert = db.prepare(`
    INSERT INTO tokens (
      mint, signature, source, first_seen_at, symbol, name, decimals, supply,
      mint_authority_revoked, freeze_authority_revoked, holder_count, top10_pct, largest_pct,
      liquidity_usd, market_cap_usd, fdv_usd, price_usd, pair_address, pair_url,
      buy_tax_pct, sell_tax_pct, lp_locked, verdict, score, reasons, rules, breakdown,
      enrich_errors, notified, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?
    )
    ON CONFLICT(mint) DO UPDATE SET
      signature = excluded.signature,
      source = excluded.source,
      symbol = excluded.symbol,
      name = excluded.name,
      decimals = excluded.decimals,
      supply = excluded.supply,
      mint_authority_revoked = excluded.mint_authority_revoked,
      freeze_authority_revoked = excluded.freeze_authority_revoked,
      holder_count = excluded.holder_count,
      top10_pct = excluded.top10_pct,
      largest_pct = excluded.largest_pct,
      liquidity_usd = excluded.liquidity_usd,
      market_cap_usd = excluded.market_cap_usd,
      fdv_usd = excluded.fdv_usd,
      price_usd = excluded.price_usd,
      pair_address = excluded.pair_address,
      pair_url = excluded.pair_url,
      buy_tax_pct = excluded.buy_tax_pct,
      sell_tax_pct = excluded.sell_tax_pct,
      lp_locked = excluded.lp_locked,
      verdict = excluded.verdict,
      score = excluded.score,
      reasons = excluded.reasons,
      rules = excluded.rules,
      breakdown = excluded.breakdown,
      enrich_errors = excluded.enrich_errors,
      updated_at = excluded.updated_at
  `);

  const markNotifiedStmt = db.prepare(`UPDATE tokens SET notified = 1, updated_at = ? WHERE mint = ?`);
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM tokens`);
  const verdictStmt = db.prepare(`SELECT verdict, COUNT(*) AS n FROM tokens GROUP BY verdict`);
  const listTokensStmt = db.prepare(`
    SELECT mint, symbol, first_seen_at, verdict, score, liquidity_usd, market_cap_usd, price_usd, holder_count
    FROM tokens
    ORDER BY first_seen_at DESC
    LIMIT ?
  `);
  const insertSnapshotStmt = db.prepare(`
    INSERT INTO market_snapshots
      (mint, observed_at, price_usd, market_cap_usd, fdv_usd, liquidity_usd, pair_address, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mint, observed_at) DO UPDATE SET
      price_usd = excluded.price_usd,
      market_cap_usd = excluded.market_cap_usd,
      fdv_usd = excluded.fdv_usd,
      liquidity_usd = excluded.liquidity_usd,
      pair_address = excluded.pair_address,
      source = excluded.source
  `);
  const latestSnapshotStmt = db.prepare(
    `SELECT MAX(observed_at) AS at FROM market_snapshots WHERE mint = ?`,
  );
  const listSnapshotsStmt = db.prepare(`
    SELECT mint, observed_at, price_usd, market_cap_usd, fdv_usd, liquidity_usd, pair_address, source
    FROM market_snapshots
    ORDER BY mint, observed_at
  `);
  const countSnapshotsStmt = db.prepare(`SELECT COUNT(*) AS n FROM market_snapshots`);

  return {
    upsertToken(token: EnrichedToken, result: ScreeningResult): void {
      const now = new Date().toISOString();
      upsert.run(
        token.mint,
        token.signature,
        token.source,
        token.firstSeenAt,
        token.symbol,
        token.name,
        token.decimals,
        token.supply,
        toInt(token.mintAuthorityRevoked),
        toInt(token.freezeAuthorityRevoked),
        token.holderCount,
        token.top10Pct,
        token.largestAccountPct,
        token.liquidityUsd,
        token.marketCapUsd,
        token.fdvUsd,
        token.priceUsd,
        token.pairAddress,
        token.pairUrl,
        token.buyTaxPct,
        token.sellTaxPct,
        toInt(token.lpLocked),
        result.verdict,
        result.score,
        JSON.stringify(result.reasons),
        JSON.stringify(result.rules),
        JSON.stringify(result.breakdown),
        JSON.stringify(token.enrichErrors),
        now,
        now,
      );
    },

    markNotified(mint: string): void {
      markNotifiedStmt.run(new Date().toISOString(), mint);
    },

    countTokens(): number {
      const row = countStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },

    countByVerdict(): Record<string, number> {
      const rows = verdictStmt.all() as { verdict: string; n: number }[];
      const out: Record<string, number> = {};
      for (const row of rows) out[row.verdict] = row.n;
      return out;
    },

    listTokens(limit: number): TrackedToken[] {
      const rows = listTokensStmt.all(limit) as {
        mint: string;
        symbol: string | null;
        first_seen_at: string;
        verdict: string;
        score: number;
        liquidity_usd: number | null;
        market_cap_usd: number | null;
        price_usd: number | null;
        holder_count: number | null;
      }[];
      return rows.map((row) => ({
        mint: row.mint,
        symbol: row.symbol,
        firstSeenAt: row.first_seen_at,
        verdict: row.verdict as TrackedToken["verdict"],
        score: row.score,
        liquidityUsd: row.liquidity_usd,
        marketCapUsd: row.market_cap_usd,
        priceUsd: row.price_usd,
        holderCount: row.holder_count,
      }));
    },

    insertSnapshot(snapshot: MarketSnapshot): void {
      insertSnapshotStmt.run(
        snapshot.mint,
        snapshot.observedAt,
        snapshot.priceUsd,
        snapshot.marketCapUsd,
        snapshot.fdvUsd,
        snapshot.liquidityUsd,
        snapshot.pairAddress,
        snapshot.source,
      );
    },

    latestSnapshotAt(mint: string): string | null {
      const row = latestSnapshotStmt.get(mint) as { at: string | null } | undefined;
      return row?.at ?? null;
    },

    listSnapshots(): MarketSnapshot[] {
      const rows = listSnapshotsStmt.all() as {
        mint: string;
        observed_at: string;
        price_usd: number | null;
        market_cap_usd: number | null;
        fdv_usd: number | null;
        liquidity_usd: number | null;
        pair_address: string | null;
        source: string | null;
      }[];
      return rows.map((row) => ({
        mint: row.mint,
        observedAt: row.observed_at,
        priceUsd: row.price_usd,
        marketCapUsd: row.market_cap_usd,
        fdvUsd: row.fdv_usd,
        liquidityUsd: row.liquidity_usd,
        pairAddress: row.pair_address,
        source: row.source ?? "unknown",
      }));
    },

    countSnapshots(): number {
      const row = countSnapshotsStmt.get() as { n: number } | undefined;
      return row?.n ?? 0;
    },

    close(): void {
      db.close();
    },
  };
}
