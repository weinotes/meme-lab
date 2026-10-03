// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { LogLevel } from "./logger.js";
import type { RuleConfig, ScreeningConfig, UnknownPolicy } from "./types.js";

export interface ProgramConfig {
  name: string;
  id: string;
}

export interface AppConfig {
  rpcUrl: string;
  programs: ProgramConfig[];
  collector: {
    commitment: "processed" | "confirmed" | "finalized";
    fetchCommitment: "confirmed" | "finalized";
    maxSupportedTransactionVersion: number;
    logIncludes: string[];
    txFetchRetries: number;
    queueLimit: number;
    dedupeWindowSec: number;
  };
  enricher: {
    countHolders: boolean;
    timeoutMs: number;
  };
  screening: ScreeningConfig;
  store: { path: string };
  pipeline: { notifyManual: boolean };
  telegram: { botToken: string | null; chatId: string | null };
  dexscreenerEnabled: boolean;
  logLevel: LogLevel;
}

function fail(path: string, expected: string): never {
  throw new Error(`Invalid config at "${path}": expected ${expected}`);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "an object");
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(path, "a non-empty string");
  return value as string;
}

function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "a finite number");
  return value as number;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean");
  return value as boolean;
}

function optStr(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return str(value, path);
}

const UNKNOWN_POLICIES: UnknownPolicy[] = ["pass", "manual", "reject"];

function rule(value: unknown, path: string): RuleConfig {
  const raw = obj(value, path);
  const policy = str(raw.unknown, `${path}.unknown`) as UnknownPolicy;
  if (!UNKNOWN_POLICIES.includes(policy)) {
    fail(`${path}.unknown`, `one of ${UNKNOWN_POLICIES.join(" | ")}`);
  }
  const out: RuleConfig = { enabled: bool(raw.enabled, `${path}.enabled`), unknown: policy };
  if (raw.value !== undefined) out.value = num(raw.value, `${path}.value`);
  return out;
}

function parseScreening(value: unknown): ScreeningConfig {
  const root = obj(value, "screening");
  const hard = obj(root.hardRules, "screening.hardRules");
  const scoreRaw = obj(root.score, "screening.score");
  const weightsRaw = obj(scoreRaw.weights, "screening.score.weights");

  const weights: Record<string, number> = {};
  for (const [key, w] of Object.entries(weightsRaw)) {
    weights[key] = num(w, `screening.score.weights.${key}`);
  }

  const liquidity = obj(scoreRaw.liquidity, "screening.score.liquidity");
  const top10 = obj(scoreRaw.top10, "screening.score.top10");
  const holders = obj(scoreRaw.holders, "screening.score.holders");
  const freshGraceSec =
    root.freshGraceSec === undefined ? 0 : num(root.freshGraceSec, "screening.freshGraceSec");

  return {
    hardRules: {
      requireMintAuthorityRevoked: rule(hard.requireMintAuthorityRevoked, "screening.hardRules.requireMintAuthorityRevoked"),
      requireFreezeAuthorityRevoked: rule(hard.requireFreezeAuthorityRevoked, "screening.hardRules.requireFreezeAuthorityRevoked"),
      minLiquidityUsd: rule(hard.minLiquidityUsd, "screening.hardRules.minLiquidityUsd"),
      maxTop10Pct: rule(hard.maxTop10Pct, "screening.hardRules.maxTop10Pct"),
      minHolderCount: rule(hard.minHolderCount, "screening.hardRules.minHolderCount"),
      maxBuyTaxPct: rule(hard.maxBuyTaxPct, "screening.hardRules.maxBuyTaxPct"),
      maxSellTaxPct: rule(hard.maxSellTaxPct, "screening.hardRules.maxSellTaxPct"),
      requireLpLocked: rule(hard.requireLpLocked, "screening.hardRules.requireLpLocked"),
    },
    freshGraceSec,
    score: {
      weights,
      passThreshold: num(scoreRaw.passThreshold, "screening.score.passThreshold"),
      manualThreshold: num(scoreRaw.manualThreshold, "screening.score.manualThreshold"),
      liquidity: {
        worstUsd: num(liquidity.worstUsd, "screening.score.liquidity.worstUsd"),
        bestUsd: num(liquidity.bestUsd, "screening.score.liquidity.bestUsd"),
      },
      top10: {
        bestPct: num(top10.bestPct, "screening.score.top10.bestPct"),
        worstPct: num(top10.worstPct, "screening.score.top10.worstPct"),
      },
      holders: {
        worstCount: num(holders.worstCount, "screening.score.holders.worstCount"),
        bestCount: num(holders.bestCount, "screening.score.holders.bestCount"),
      },
    },
  };
}

export interface LoadOptions {
  configPath: string;
  env?: NodeJS.ProcessEnv;
}

/** Loads YAML config and overlays environment variables (env wins for secrets/paths). */
export function loadConfig({ configPath, env = process.env }: LoadOptions): AppConfig {
  const raw = parseYaml(readFileSync(configPath, "utf8")) as unknown;
  const root = obj(raw, "root");

  const programsRaw = root.programs;
  if (!Array.isArray(programsRaw) || programsRaw.length === 0) {
    fail("programs", "a non-empty array");
  }
  const programs: ProgramConfig[] = programsRaw.map((p, i) => {
    const entry = obj(p, `programs[${i}]`);
    return { name: str(entry.name, `programs[${i}].name`), id: str(entry.id, `programs[${i}].id`) };
  });

  const collectorRaw = obj(root.collector, "collector");
  const commitment = str(collectorRaw.commitment, "collector.commitment");
  if (!["processed", "confirmed", "finalized"].includes(commitment)) {
    fail("collector.commitment", "processed | confirmed | finalized");
  }
  const fetchCommitment = str(collectorRaw.fetchCommitment, "collector.fetchCommitment");
  if (!["confirmed", "finalized"].includes(fetchCommitment)) {
    fail("collector.fetchCommitment", "confirmed | finalized");
  }
  const logIncludesRaw = collectorRaw.logIncludes ?? [];
  if (!Array.isArray(logIncludesRaw)) fail("collector.logIncludes", "an array of strings");
  const logIncludes = logIncludesRaw.map((entry, i) =>
    str(entry, `collector.logIncludes[${i}]`),
  );

  const enricherRaw = obj(root.enricher, "enricher");
  const storeRaw = obj(root.store, "store");
  const pipelineRaw = obj(root.pipeline, "pipeline");

  const logLevel = (env.LOG_LEVEL ?? "info") as LogLevel;
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    fail("LOG_LEVEL", "debug | info | warn | error");
  }

  const rpcUrl = env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

  return {
    rpcUrl,
    programs,
    collector: {
      commitment: commitment as AppConfig["collector"]["commitment"],
      fetchCommitment: fetchCommitment as AppConfig["collector"]["fetchCommitment"],
      maxSupportedTransactionVersion: num(
        collectorRaw.maxSupportedTransactionVersion,
        "collector.maxSupportedTransactionVersion",
      ),
      logIncludes,
      txFetchRetries: num(collectorRaw.txFetchRetries, "collector.txFetchRetries"),
      queueLimit: num(collectorRaw.queueLimit, "collector.queueLimit"),
      dedupeWindowSec: num(collectorRaw.dedupeWindowSec, "collector.dedupeWindowSec"),
    },
    enricher: {
      countHolders: bool(enricherRaw.countHolders, "enricher.countHolders"),
      timeoutMs: num(enricherRaw.timeoutMs, "enricher.timeoutMs"),
    },
    screening: parseScreening(root.screening),
    store: { path: env.MEMELAB_DB_PATH ?? str(storeRaw.path, "store.path") },
    pipeline: { notifyManual: bool(pipelineRaw.notifyManual, "pipeline.notifyManual") },
    telegram: {
      botToken: optStr(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),
      chatId: optStr(env.TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID"),
    },
    dexscreenerEnabled: (env.DEXSCREENER_ENABLED ?? "true") !== "false",
    logLevel,
  };
}
