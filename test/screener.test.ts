// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { makeToken, SAMPLE_TOKENS } from "../src/sample-tokens.js";
import { computeScore, screen } from "../src/screener.js";
import type { ScreeningConfig } from "../src/types.js";

const config = loadConfig({ configPath: "config/default.yaml", env: {} });
const cfg: ScreeningConfig = config.screening;

test("clean token passes all hard rules and scores above the pass threshold", () => {
  const token = SAMPLE_TOKENS[0]!;
  const result = screen(token, cfg);
  assert.equal(result.verdict, "pass");
  assert.ok(result.score >= cfg.score.passThreshold, `score ${result.score} below pass threshold`);
  assert.equal(result.reasons.length, 0);
});

test("non-revoked mint authority is rejected", () => {
  const result = screen(SAMPLE_TOKENS[1]!, cfg);
  assert.equal(result.verdict, "reject");
  assert.ok(result.reasons.some((r) => r.includes("mint")));
});

test("high top-10 concentration is rejected", () => {
  const result = screen(SAMPLE_TOKENS[2]!, cfg);
  assert.equal(result.verdict, "reject");
  assert.ok(result.reasons.some((r) => r.includes("Top10")));
});

test("missing tax / LP data downgrades the verdict to manual, never to pass", () => {
  const result = screen(SAMPLE_TOKENS[3]!, cfg);
  assert.equal(result.verdict, "manual");
  assert.ok(result.reasons.some((r) => r.includes("数据缺失")));
});

test("thin liquidity is rejected", () => {
  const result = screen(SAMPLE_TOKENS[4]!, cfg);
  assert.equal(result.verdict, "reject");
  assert.ok(result.reasons.some((r) => r.includes("流动性")));
});

test("mediocre but safe token lands in manual range", () => {
  const result = screen(SAMPLE_TOKENS[5]!, cfg);
  assert.equal(result.verdict, "manual");
  assert.ok(result.score >= cfg.score.manualThreshold);
  assert.ok(result.score < cfg.score.passThreshold);
});

test("unknown liquidity is rejected rather than silently passing", () => {
  const token = makeToken({
    mint: "NoLiquidityData111111111111111111111111111111",
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    lpLocked: true,
    buyTaxPct: 0,
    sellTaxPct: 0,
  });
  const result = screen(token, cfg);
  assert.equal(result.verdict, "reject");
  assert.ok(result.reasons.some((r) => r.includes("min_liquidity")));
});

test("score never exceeds 100 and stays non-negative", () => {
  for (const token of SAMPLE_TOKENS) {
    const { total, breakdown } = computeScore(token, cfg);
    assert.ok(total >= 0 && total <= 100, `score out of range: ${total}`);
    for (const value of Object.values(breakdown)) {
      assert.ok(value >= 0 && value <= 5, `sub-score out of range: ${value}`);
    }
  }
});

test("missing data scores strictly lower than complete data", () => {
  const complete = screen(SAMPLE_TOKENS[0]!, cfg).score;
  const incomplete = screen(SAMPLE_TOKENS[3]!, cfg).score;
  assert.ok(incomplete < complete, `${incomplete} should be < ${complete}`);
});

test("fresh-token grace keeps an illiquid new token in manual, not reject", () => {
  // THIN (liquidity 800 < 5000) is a hard reject when judged as a mature token.
  const mature = screen(SAMPLE_TOKENS[4]!, cfg, { ageSec: cfg.freshGraceSec + 60 });
  assert.equal(mature.verdict, "reject");

  const fresh = screen(SAMPLE_TOKENS[4]!, cfg, { ageSec: 2 });
  assert.equal(fresh.verdict, "manual");
  assert.ok(fresh.reasons.some((r) => r.includes("宽限期")));
});

test("fresh-token grace never downgrades a safety failure", () => {
  // SAMPLE_TOKENS[1] has an unrevoked mint authority: must reject even at age 0.
  const result = screen(SAMPLE_TOKENS[1]!, cfg, { ageSec: 0 });
  assert.equal(result.verdict, "reject");
  assert.ok(result.reasons.some((r) => r.includes("mint")));
});

test("no grace window is applied when the caller omits the token age", () => {
  const result = screen(SAMPLE_TOKENS[4]!, cfg);
  assert.equal(result.verdict, "reject");
});
