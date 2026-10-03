// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

export function isoNow(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps a "lower is better" metric onto 0..maxScore.
 * value <= best -> maxScore, value >= worst -> 0, linear in between.
 */
export function scoreLowerIsBetter(
  value: number,
  best: number,
  worst: number,
  maxScore = 5,
): number {
  if (worst === best) return maxScore;
  const ratio = (worst - value) / (worst - best);
  return clamp(ratio, 0, 1) * maxScore;
}

/**
 * Maps a "higher is better" metric onto 0..maxScore.
 * value >= best -> maxScore, value <= worst -> 0, linear in between.
 */
export function scoreHigherIsBetter(
  value: number,
  worst: number,
  best: number,
  maxScore = 5,
): number {
  if (best === worst) return maxScore;
  const ratio = (value - worst) / (best - worst);
  return clamp(ratio, 0, 1) * maxScore;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Retry an async operation with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  baseDelayMs = 400,
  onError?: (err: unknown, attempt: number) => void,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      onError?.(err, attempt);
      if (attempt < attempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/** Promise-based timeout wrapper. */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
