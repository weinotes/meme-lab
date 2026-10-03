// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import type { Logger } from "./logger.js";
import type { EnrichedToken, ScreeningResult } from "./types.js";
import { errorMessage } from "./util.js";

export interface Notifier {
  readonly name: string;
  send(text: string): Promise<boolean>;
}

export function formatAlert(token: EnrichedToken, result: ScreeningResult): string {
  const icon = result.verdict === "pass" ? "🟢" : result.verdict === "manual" ? "🟡" : "🔴";
  const short = `${token.mint.slice(0, 4)}…${token.mint.slice(-4)}`;
  const money = (v: number | null): string =>
    v === null ? "?" : v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
  const flag = (v: boolean | null, yes: string, no: string): string => (v === null ? "?" : v ? yes : no);

  const lines = [
    `${icon} 新候选 [${result.verdict.toUpperCase()}] 评分 ${result.score}/100`,
    `代币: ${token.symbol ?? "?"} (${short})`,
    `市值: ${money(token.marketCapUsd)} | 流动性: ${money(token.liquidityUsd)}`,
    `持币数: ${token.holderCount ?? "?"} | Top10: ${token.top10Pct === null ? "?" : `${token.top10Pct.toFixed(1)}%`} | 税: ${
      token.buyTaxPct === null && token.sellTaxPct === null
        ? "?"
        : `${token.buyTaxPct ?? "?"}/${token.sellTaxPct ?? "?"}%`
    }`,
    `权限: mint ${flag(token.mintAuthorityRevoked, "已放弃", "未放弃")} | freeze ${flag(
      token.freezeAuthorityRevoked,
      "已放弃",
      "未放弃",
    )} | LP ${flag(token.lpLocked, "已锁", "未锁")}`,
    `来源: ${token.source}`,
  ];

  if (result.reasons.length > 0) {
    lines.push(`原因: ${result.reasons.slice(0, 3).join("; ")}`);
  }
  if (token.pairUrl) lines.push(token.pairUrl);
  else lines.push(`https://solscan.io/token/${token.mint}`);

  return lines.join("\n");
}

export function createTelegramNotifier(botToken: string, chatId: string, logger: Logger): Notifier {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  return {
    name: "telegram",
    async send(text: string): Promise<boolean> {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        if (!res.ok) {
          logger.warn("telegram send failed", { status: res.status });
          return false;
        }
        return true;
      } catch (err) {
        logger.warn("telegram send error", { error: errorMessage(err) });
        return false;
      }
    },
  };
}

/** Fallback used when Telegram is not configured: alerts go to stdout. */
export function createConsoleNotifier(logger: Logger): Notifier {
  return {
    name: "console",
    async send(text: string): Promise<boolean> {
      logger.info("alert", { text });
      return true;
    },
  };
}

export function createNotifier(
  config: { botToken: string | null; chatId: string | null },
  logger: Logger,
): Notifier {
  if (config.botToken && config.chatId) {
    return createTelegramNotifier(config.botToken, config.chatId, logger);
  }
  logger.warn("telegram not configured, falling back to console notifier");
  return createConsoleNotifier(logger);
}
