// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type { Logger } from "./logger.js";
import type { EnrichedToken } from "./types.js";
import { errorMessage } from "./util.js";

export type IndexerData = Pick<
  EnrichedToken,
  | "symbol"
  | "name"
  | "liquidityUsd"
  | "marketCapUsd"
  | "fdvUsd"
  | "priceUsd"
  | "pairAddress"
  | "pairUrl"
>;

export interface IndexerClient {
  lookup(mint: string): Promise<IndexerData | null>;
}

interface DexScreenerPair {
  chainId?: string;
  pairAddress?: string;
  url?: string;
  baseToken?: { symbol?: string; name?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * DexScreener public API client (no key required).
 * Used only for market data (liquidity / market cap / pair link).
 * Verify current terms of use and rate limits before running at volume.
 */
export function createDexScreenerClient(logger: Logger, enabled: boolean): IndexerClient {
  return {
    async lookup(mint: string): Promise<IndexerData | null> {
      if (!enabled) return null;
      const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        let payload: { pairs?: DexScreenerPair[] | null };
        try {
          const res = await fetch(url, { signal: controller.signal });
          if (!res.ok) {
            logger.warn("indexer request failed", { mint, status: res.status });
            return null;
          }
          payload = (await res.json()) as { pairs?: DexScreenerPair[] | null };
        } finally {
          clearTimeout(timer);
        }

        const pairs = (payload.pairs ?? []).filter((p) => p.chainId === "solana");
        if (pairs.length === 0) return null;

        const best = pairs.reduce((acc, p) => {
          const accLiq = acc.liquidity?.usd ?? 0;
          const liq = p.liquidity?.usd ?? 0;
          return liq > accLiq ? p : acc;
        });

        return {
          symbol: best.baseToken?.symbol ?? null,
          name: best.baseToken?.name ?? null,
          liquidityUsd: toNumber(best.liquidity?.usd),
          marketCapUsd: toNumber(best.marketCap),
          fdvUsd: toNumber(best.fdv),
          priceUsd: toNumber(best.priceUsd),
          pairAddress: best.pairAddress ?? null,
          pairUrl: best.url ?? null,
        };
      } catch (err) {
        logger.warn("indexer lookup error", { mint, error: errorMessage(err) });
        return null;
      }
    },
  };
}
