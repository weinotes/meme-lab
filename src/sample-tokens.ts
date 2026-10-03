// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type { EnrichedToken } from "./types.js";

/** Builds an EnrichedToken with conservative (all-unknown) defaults. */
export function makeToken(overrides: Partial<EnrichedToken> & { mint: string }): EnrichedToken {
  return {
    signature: "sample-signature",
    source: "sample",
    firstSeenAt: new Date().toISOString(),
    decimals: 6,
    supply: "1000000000000000",
    mintAuthorityRevoked: null,
    freezeAuthorityRevoked: null,
    holderCount: null,
    top10Pct: null,
    largestAccountPct: null,
    symbol: null,
    name: null,
    liquidityUsd: null,
    marketCapUsd: null,
    fdvUsd: null,
    priceUsd: null,
    pairAddress: null,
    pairUrl: null,
    buyTaxPct: null,
    sellTaxPct: null,
    lpLocked: null,
    enrichErrors: [],
    ...overrides,
  };
}

const CLEAN = {
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  lpLocked: true,
  buyTaxPct: 0,
  sellTaxPct: 0,
};

/** Offline sample set used by `npm run dry-run` and the test suite. */
export const SAMPLE_TOKENS: EnrichedToken[] = [
  makeToken({
    mint: "So11111111111111111111111111111111111111112",
    symbol: "CLEAN",
    source: "pumpfun",
    ...CLEAN,
    liquidityUsd: 60_000,
    marketCapUsd: 480_000,
    priceUsd: 0.00048,
    top10Pct: 22,
    largestAccountPct: 6.5,
    holderCount: 420,
    pairUrl: "https://dexscreener.com/solana/sample-clean",
  }),
  makeToken({
    mint: "Honeypot1111111111111111111111111111111111111",
    symbol: "HONEY",
    source: "pumpfun",
    ...CLEAN,
    mintAuthorityRevoked: false,
    liquidityUsd: 40_000,
    top10Pct: 30,
    holderCount: 300,
  }),
  makeToken({
    mint: "Concentrated111111111111111111111111111111111",
    symbol: "WHALE",
    source: "raydium-cpmm",
    ...CLEAN,
    liquidityUsd: 55_000,
    top10Pct: 85,
    largestAccountPct: 61,
    holderCount: 380,
  }),
  makeToken({
    mint: "Unknowns1111111111111111111111111111111111111",
    symbol: "MYST",
    source: "meteora-dlmm",
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    liquidityUsd: 40_000,
    top10Pct: 40,
    holderCount: 200,
  }),
  makeToken({
    mint: "ThinPool1111111111111111111111111111111111111",
    symbol: "THIN",
    source: "raydium-cpmm",
    ...CLEAN,
    liquidityUsd: 800,
    top10Pct: 35,
    holderCount: 120,
  }),
  makeToken({
    mint: "Midrange1111111111111111111111111111111111111",
    symbol: "MID",
    source: "pumpfun",
    ...CLEAN,
    liquidityUsd: 20_000,
    top10Pct: 60,
    largestAccountPct: 18,
    holderCount: 150,
  }),
];
