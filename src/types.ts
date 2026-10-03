// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

/** A raw observation of a newly created token, emitted by the collector. */
export interface RawEvent {
  mint: string;
  signature: string;
  /** Which configured program produced this event. */
  source: string;
  /** ISO-8601 UTC timestamp of first observation. */
  seenAt: string;
}

/**
 * A candidate token after on-chain and (optional) indexer enrichment.
 * Every field is nullable: unknown is never treated as "safe".
 */
export interface EnrichedToken {
  mint: string;
  signature: string;
  source: string;
  firstSeenAt: string;

  // on-chain
  decimals: number | null;
  supply: string | null;
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  holderCount: number | null;
  top10Pct: number | null;
  largestAccountPct: number | null;

  // indexer (optional)
  symbol: string | null;
  name: string | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  priceUsd: number | null;
  pairAddress: string | null;
  pairUrl: string | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  lpLocked: boolean | null;

  // diagnostics
  enrichErrors: string[];
}

export type Verdict = "pass" | "manual" | "reject";

export type RuleStatus = "pass" | "fail" | "unknown";

export interface RuleOutcome {
  id: string;
  status: RuleStatus;
  /** When status is "unknown", how the missing data should be treated. */
  policy?: UnknownPolicy;
  detail: string;
}

export interface ScreeningResult {
  mint: string;
  verdict: Verdict;
  /** Normalised 0–100 score. */
  score: number;
  rules: RuleOutcome[];
  /** Human-readable reasons for reject / manual verdicts. */
  reasons: string[];
  /** Per-dimension sub-scores (0–5) used for the weighted total. */
  breakdown: Record<string, number>;
}

export type UnknownPolicy = "pass" | "manual" | "reject";

export interface RuleConfig {
  enabled: boolean;
  value?: number;
  unknown: UnknownPolicy;
}

export interface ScreeningConfig {
  hardRules: {
    requireMintAuthorityRevoked: RuleConfig;
    requireFreezeAuthorityRevoked: RuleConfig;
    minLiquidityUsd: RuleConfig;
    maxTop10Pct: RuleConfig;
    minHolderCount: RuleConfig;
    maxBuyTaxPct: RuleConfig;
    maxSellTaxPct: RuleConfig;
    requireLpLocked: RuleConfig;
  };
  /**
   * 新币宽限期（秒）。刚发现的代币缺少流动性/持币/分布数据，这些维度此时
   * 不具判别力；在宽限期内，这类"质量/活跃度"规则未达标会降级为 manual
   * （人工复核），而不是直接 reject。安全类规则（权限）不受影响。
   * 设为 0 关闭该行为（恢复"新币全部 reject"的旧逻辑）。
   */
  freshGraceSec: number;
  score: {
    weights: Record<string, number>;
    passThreshold: number;
    manualThreshold: number;
    liquidity: { worstUsd: number; bestUsd: number };
    top10: { bestPct: number; worstPct: number };
    holders: { worstCount: number; bestCount: number };
  };
}

/** One point-in-time market observation, persisted for later backfill/report. */
export interface MarketSnapshot {
  mint: string;
  observedAt: string;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  pairAddress: string | null;
  source: string;
}

/** A screened token as needed by the backfill job / report. */
export interface TrackedToken {
  mint: string;
  symbol: string | null;
  firstSeenAt: string;
  verdict: Verdict;
  score: number;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  holderCount: number | null;
}
