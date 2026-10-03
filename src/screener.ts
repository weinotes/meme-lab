// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type {
  EnrichedToken,
  RuleConfig,
  RuleOutcome,
  ScreeningConfig,
  ScreeningResult,
  Verdict,
} from "./types.js";
import { clamp, round, scoreHigherIsBetter, scoreLowerIsBetter } from "./util.js";

type Known = number | boolean;

/**
 * Rules that cannot be judged on a just-launched token (no liquidity, no holder
 * distribution yet). During the fresh-token grace window their failures are
 * downgraded to manual review. Safety rules are never in this set.
 */
const DISCOVERY_FRAGILE_RULES: ReadonlySet<string> = new Set([
  "min_liquidity",
  "max_top10",
  "min_holders",
]);

export interface ScreenOptions {
  /** Age of the token in seconds. When omitted, no grace window is applied. */
  ageSec?: number;
}

/**
 * Evaluates one hard rule.
 * A missing value (`null`) never silently passes: it is mapped through
 * `cfg.unknown`, which defaults to `manual` or `reject` in the shipped config.
 */
function evaluateRule(
  id: string,
  cfg: RuleConfig,
  value: Known | null,
  check: (known: Known) => { status: "pass" | "fail"; detail: string },
): RuleOutcome | null {
  if (!cfg.enabled) return null;
  if (value === null || value === undefined) {
    return {
      id,
      status: "unknown",
      policy: cfg.unknown,
      detail: `${id}: 数据缺失 → ${cfg.unknown}`,
    };
  }
  const result = check(value);
  return { id, status: result.status, detail: result.detail };
}

function contractSafety(token: EnrichedToken): number {
  let score = 5;
  if (token.mintAuthorityRevoked === false) score = 0;
  if (token.freezeAuthorityRevoked === false) score = 0;
  if (token.lpLocked === false) score -= 2;
  else if (token.lpLocked === null) score -= 1;

  const taxes = [token.buyTaxPct, token.sellTaxPct].filter((t): t is number => t !== null);
  const maxTax = taxes.length > 0 ? Math.max(...taxes) : null;
  if (maxTax !== null) {
    if (maxTax > 10) score -= 2;
    else if (maxTax > 5) score -= 1;
  } else {
    score -= 0.5;
  }
  return clamp(score, 0, 5);
}

function liquidityQuality(token: EnrichedToken, cfg: ScreeningConfig): number {
  if (token.liquidityUsd === null) return 0;
  return scoreHigherIsBetter(token.liquidityUsd, cfg.score.liquidity.worstUsd, cfg.score.liquidity.bestUsd);
}

function holderDistribution(token: EnrichedToken, cfg: ScreeningConfig): number {
  if (token.top10Pct === null) return 0;
  return scoreLowerIsBetter(token.top10Pct, cfg.score.top10.bestPct, cfg.score.top10.worstPct);
}

function tradingActivity(token: EnrichedToken, cfg: ScreeningConfig): number {
  if (token.holderCount === null) return 0;
  return scoreHigherIsBetter(token.holderCount, cfg.score.holders.worstCount, cfg.score.holders.bestCount);
}

/**
 * Weighted scorecard normalised to 0–100.
 *
 * Dimensions with weight > 0 but missing data score 0 instead of being dropped,
 * so missing data pulls the score down (never up). That keeps "unknown" on the
 * conservative side of the verdict.
 */
export function computeScore(
  token: EnrichedToken,
  cfg: ScreeningConfig,
): { total: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {
    contractSafety: contractSafety(token),
    liquidityQuality: liquidityQuality(token, cfg),
    holderDistribution: holderDistribution(token, cfg),
    tradingActivity: tradingActivity(token, cfg),
    socialHeat: 0,
    narrative: 0,
  };

  let weighted = 0;
  let totalWeight = 0;
  for (const [dim, weight] of Object.entries(cfg.score.weights)) {
    if (weight <= 0) continue;
    totalWeight += weight;
    weighted += weight * (breakdown[dim] ?? 0);
  }

  const total = totalWeight === 0 ? 0 : round((weighted / totalWeight / 5) * 100, 2);
  const rounded: Record<string, number> = {};
  for (const [dim, value] of Object.entries(breakdown)) rounded[dim] = round(value, 2);
  return { total, breakdown: rounded };
}

/** Runs the hard-rule gate, the scorecard, and combines them into a verdict. */
export function screen(
  token: EnrichedToken,
  cfg: ScreeningConfig,
  opts: ScreenOptions = {},
): ScreeningResult {
  const rules: (RuleOutcome | null)[] = [
    evaluateRule(
      "mint_authority",
      cfg.hardRules.requireMintAuthorityRevoked,
      token.mintAuthorityRevoked,
      (v) =>
        v === true
          ? { status: "pass", detail: "mint 权限已放弃" }
          : { status: "fail", detail: "mint 权限未放弃（可增发）" },
    ),
    evaluateRule(
      "freeze_authority",
      cfg.hardRules.requireFreezeAuthorityRevoked,
      token.freezeAuthorityRevoked,
      (v) =>
        v === true
          ? { status: "pass", detail: "freeze 权限已放弃" }
          : { status: "fail", detail: "freeze 权限未放弃（可冻结持仓）" },
    ),
    evaluateRule("min_liquidity", cfg.hardRules.minLiquidityUsd, token.liquidityUsd, (v) => {
      const min = cfg.hardRules.minLiquidityUsd.value ?? 0;
      return Number(v) >= min
        ? { status: "pass", detail: `流动性 ${v} ≥ ${min}` }
        : { status: "fail", detail: `流动性 ${v} < ${min}` };
    }),
    evaluateRule("max_top10", cfg.hardRules.maxTop10Pct, token.top10Pct, (v) => {
      const max = cfg.hardRules.maxTop10Pct.value ?? 100;
      return Number(v) <= max
        ? { status: "pass", detail: `Top10 占比 ${v}% ≤ ${max}%` }
        : { status: "fail", detail: `Top10 占比 ${v}% > ${max}%` };
    }),
    evaluateRule("min_holders", cfg.hardRules.minHolderCount, token.holderCount, (v) => {
      const min = cfg.hardRules.minHolderCount.value ?? 0;
      return Number(v) >= min
        ? { status: "pass", detail: `持币地址 ${v} ≥ ${min}` }
        : { status: "fail", detail: `持币地址 ${v} < ${min}` };
    }),
    evaluateRule("max_buy_tax", cfg.hardRules.maxBuyTaxPct, token.buyTaxPct, (v) => {
      const max = cfg.hardRules.maxBuyTaxPct.value ?? 100;
      return Number(v) <= max
        ? { status: "pass", detail: `买入税 ${v}% ≤ ${max}%` }
        : { status: "fail", detail: `买入税 ${v}% > ${max}%` };
    }),
    evaluateRule("max_sell_tax", cfg.hardRules.maxSellTaxPct, token.sellTaxPct, (v) => {
      const max = cfg.hardRules.maxSellTaxPct.value ?? 100;
      return Number(v) <= max
        ? { status: "pass", detail: `卖出税 ${v}% ≤ ${max}%` }
        : { status: "fail", detail: `卖出税 ${v}% > ${max}%` };
    }),
    evaluateRule("lp_locked", cfg.hardRules.requireLpLocked, token.lpLocked, (v) =>
      v === true
        ? { status: "pass", detail: "LP 已锁/已烧" }
        : { status: "fail", detail: "LP 未锁" },
    ),
  ];

  const evaluated = rules.filter((r): r is RuleOutcome => r !== null);

  const { ageSec } = opts;
  const inGraceWindow =
    cfg.freshGraceSec > 0 && ageSec !== undefined && ageSec <= cfg.freshGraceSec;
  if (inGraceWindow) {
    for (const rule of evaluated) {
      if (!DISCOVERY_FRAGILE_RULES.has(rule.id)) continue;
      if (rule.status === "fail" || (rule.status === "unknown" && rule.policy === "reject")) {
        rule.status = "unknown";
        rule.policy = "manual";
        rule.detail = `${rule.detail}（新币宽限期 ${cfg.freshGraceSec}s，降级为人工复核）`;
      }
    }
  }

  const fails = evaluated.filter((r) => r.status === "fail");
  const unknownReject = evaluated.filter((r) => r.status === "unknown" && r.policy === "reject");
  const unknownManual = evaluated.filter((r) => r.status === "unknown" && r.policy === "manual");
  const { total, breakdown } = computeScore(token, cfg);

  const reasons: string[] = [];
  let verdict: Verdict;

  if (fails.length > 0) {
    verdict = "reject";
    reasons.push(...fails.map((r) => r.detail));
  } else if (unknownReject.length > 0) {
    verdict = "reject";
    reasons.push(...unknownReject.map((r) => r.detail));
  } else if (unknownManual.length > 0) {
    verdict = "manual";
    reasons.push(...unknownManual.map((r) => r.detail));
    reasons.push("存在数据缺失项，需人工复核后再决定");
  } else if (total >= cfg.score.passThreshold) {
    verdict = "pass";
  } else if (total >= cfg.score.manualThreshold) {
    verdict = "manual";
    reasons.push(`评分 ${total} 低于 pass 阈值 ${cfg.score.passThreshold}`);
  } else {
    verdict = "reject";
    reasons.push(`评分 ${total} 低于 manual 阈值 ${cfg.score.manualThreshold}`);
  }

  return { mint: token.mint, verdict, score: total, rules: evaluated, reasons, breakdown };
}
