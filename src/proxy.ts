// Copyright 2026 Davey <wgwcko@gmail.com>
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Logger } from "./logger.js";
import { errorMessage } from "./util.js";

const require = createRequire(import.meta.url);

function pickProxyUrl(): string | null {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    null
  );
}

function createAgent(proxyUrl: string): HttpsProxyAgent<string> | SocksProxyAgent {
  const { protocol } = new URL(proxyUrl);
  if (protocol.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

/**
 * Routes the subscription WebSocket through an HTTP/SOCKS proxy.
 *
 * Why this is needed: `@solana/web3.js` builds its subscription socket via
 * `rpc-websockets` and never exposes the `agent` option, so a plain Connection
 * cannot tunnel `wss://` through a local proxy — HTTP calls work (Node's fetch
 * honours NODE_USE_ENV_PROXY) while subscriptions silently time out.
 *
 * `rpc-websockets` looks `WebSocket` up on its module object at call time, so
 * wrapping that factory once at startup is enough. No-op when no proxy is set.
 */
export function installWebSocketProxy(logger: Logger): boolean {
  const proxyUrl = pickProxyUrl();
  if (!proxyUrl) return false;

  try {
    const agent = createAgent(proxyUrl);
    const rpcws = require("rpc-websockets") as {
      WebSocket: ((url: string, options?: Record<string, unknown>) => unknown) & {
        __memelabPatched?: boolean;
      };
    };
    if (rpcws.WebSocket.__memelabPatched) return true;

    const original = rpcws.WebSocket;
    const patched = ((url: string, options: Record<string, unknown> = {}) =>
      original(url, { ...options, agent })) as typeof rpcws.WebSocket;
    patched.__memelabPatched = true;
    rpcws.WebSocket = patched;

    logger.info("websocket proxy enabled", { proxy: new URL(proxyUrl).origin });
    return true;
  } catch (err) {
    logger.warn("failed to install websocket proxy", { error: errorMessage(err) });
    return false;
  }
}
