// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { Connection, PublicKey } from "@solana/web3.js";
import type { IndexerClient } from "./indexer.js";
import type { Logger } from "./logger.js";
import type { EnrichedToken, RawEvent } from "./types.js";
import { errorMessage, isoNow, round, withTimeout } from "./util.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_ACCOUNT_SIZE = 165; // classic SPL token account

export interface EnricherOptions {
  countHolders: boolean;
  timeoutMs: number;
}

export type Enricher = (event: RawEvent) => Promise<EnrichedToken>;

function pct(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  return round(Number((part * 10_000n) / whole) / 100, 2);
}

/** Parses a stringified u64 supply; returns null when it is missing or malformed. */
function parseSupply(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/**
 * Builds an enricher that fills a RawEvent with on-chain data plus optional
 * indexer market data.
 *
 * Fields that cannot be derived on-chain (taxes, LP lock state) stay `null` on
 * purpose: the screener maps unknown values to manual review instead of letting
 * them pass. `holderCount` is an approximation (it counts token accounts, not
 * unique owners) and is documented as such.
 */
export function createEnricher(
  conn: Connection,
  indexer: IndexerClient,
  opts: EnricherOptions,
  logger: Logger,
): Enricher {
  return async function enrich(event: RawEvent): Promise<EnrichedToken> {
    const token: EnrichedToken = {
      mint: event.mint,
      signature: event.signature,
      source: event.source,
      firstSeenAt: event.seenAt,
      decimals: null,
      supply: null,
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
    };

    let mintPk: PublicKey;
    try {
      mintPk = new PublicKey(event.mint);
    } catch {
      token.enrichErrors.push(`invalid mint address: ${event.mint}`);
      return token;
    }

    // --- mint account: authorities, supply, decimals ---
    try {
      const info = await withTimeout(
        () => conn.getParsedAccountInfo(mintPk),
        opts.timeoutMs,
        "getParsedAccountInfo",
      );
      const parsed = info.value?.data;
      if (parsed && typeof parsed === "object" && "parsed" in parsed) {
        const mintInfo =
          (parsed as { parsed?: { info?: Record<string, unknown> } }).parsed?.info ?? {};
        token.mintAuthorityRevoked = (mintInfo.mintAuthority ?? null) === null;
        token.freezeAuthorityRevoked = (mintInfo.freezeAuthority ?? null) === null;
        token.supply = typeof mintInfo.supply === "string" ? mintInfo.supply : null;
        token.decimals = typeof mintInfo.decimals === "number" ? mintInfo.decimals : null;
      } else {
        token.enrichErrors.push("mint account not parseable (not a classic SPL mint?)");
      }
    } catch (err) {
      token.enrichErrors.push(`mint account: ${errorMessage(err)}`);
    }

    // --- holder concentration ---
    if (token.supply !== null) {
      try {
        const supply = BigInt(token.supply);
        const largest = await withTimeout(
          () => conn.getTokenLargestAccounts(mintPk),
          opts.timeoutMs,
          "getTokenLargestAccounts",
        );
        const accounts = largest.value ?? [];
        if (accounts.length > 0) {
          const top10 = accounts
            .slice(0, 10)
            .reduce((acc, account) => acc + BigInt(account.amount), 0n);
          token.top10Pct = pct(top10, supply);
          token.largestAccountPct = pct(BigInt(accounts[0]!.amount), supply);
        }
      } catch (err) {
        token.enrichErrors.push(`largest accounts: ${errorMessage(err)}`);
      }
    }

    // --- holder count (approximate, heavy) ---
    if (opts.countHolders) {
      try {
        const accounts = await withTimeout(
          () =>
            conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
              filters: [
                { dataSize: TOKEN_ACCOUNT_SIZE },
                { memcmp: { offset: 0, bytes: event.mint } },
              ],
              dataSlice: { offset: 0, length: 0 },
            }),
          opts.timeoutMs,
          "getProgramAccounts",
        );
        // A mint with positive supply must hold its tokens in at least one SPL
        // token account, so a zero-account result cannot be real: it means the
        // RPC silently returned an empty/incomplete set (common on public
        // endpoints that do not support getProgramAccounts). Treat that as
        // unknown (null) so the screener routes it to manual review instead of
        // hard-rejecting on a fabricated "0 holders".
        const supply = parseSupply(token.supply);
        // Only a confirmed zero supply makes a zero-account result trustworthy.
        if (accounts.length === 0 && (supply === null || supply > 0n)) {
          token.holderCount = null;
          token.enrichErrors.push(
            "holder count unreliable: 0 accounts for a positive-supply mint " +
              "(RPC likely does not support getProgramAccounts)",
          );
        } else {
          token.holderCount = accounts.length;
        }
      } catch (err) {
        token.holderCount = null;
        token.enrichErrors.push(`holder count unavailable: ${errorMessage(err)}`);
      }
    }

    // --- indexer market data (optional) ---
    try {
      const market = await indexer.lookup(event.mint);
      if (market) {
        token.symbol = market.symbol;
        token.name = market.name;
        token.liquidityUsd = market.liquidityUsd;
        token.marketCapUsd = market.marketCapUsd;
        token.fdvUsd = market.fdvUsd;
        token.priceUsd = market.priceUsd;
        token.pairAddress = market.pairAddress;
        token.pairUrl = market.pairUrl;
      }
    } catch (err) {
      token.enrichErrors.push(`indexer: ${errorMessage(err)}`);
    }

    if (token.enrichErrors.length > 0) {
      logger.debug("enrich completed with errors", { mint: event.mint, errors: token.enrichErrors });
    }
    logger.debug("enriched", { mint: event.mint, at: isoNow() });
    return token;
  };
}
