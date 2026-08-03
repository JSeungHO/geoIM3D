/**
 * Chooses how the Korean public-data services (VWorld, KMA) are called.
 *
 * Both are unusable from a browser, for two different reasons found by testing
 * the live services:
 *
 * - **VWorld** sends no `Access-Control-Allow-Origin` on its JSON (search,
 *   geocoder) and WMS endpoints. The request goes out and is billed; the browser
 *   then discards the answer. Only WMTS tiles carry CORS headers.
 * - **data.go.kr (KMA)** goes further: the same request answers 200 with data
 *   when no `Origin` header is present and **403** when one is. A browser always
 *   sends `Origin` cross-origin, so no key can ever work from a web page.
 *
 * Neither is a key problem, and both look like a network outage from inside the
 * app — which is why this module exists rather than a retry or a better message.
 *
 * Two ways around it, picked per shell:
 *
 * - **Desktop:** the Tauri `fetch_url_bytes` command performs the request in
 *   Rust, outside the webview. No `Origin`, no CORS. This is the product path.
 * - **Browser dev server:** Vite proxies from the same origin (see
 *   `KR_API_PROXY_PATH` in `vite.config.ts`), matching the WMS/WFS/raster
 *   proxies already there. The proxy forwards no `Origin`, which is what makes
 *   the portal answer normally.
 *
 * A production web deployment needs the same proxy in front of it before these
 * features work in a browser; until then they are desktop-only.
 */

import {
  setDataGoKrTransport,
  setKmaTransport,
  setVWorldTransport,
  type VWorldResponse,
} from "@geolibre/plugins";
import { isTauri } from "./is-tauri";
import { fetchUrlBytes } from "./native-http";

/** Dev-server proxy path; mirrors the constant in `vite.config.ts`. */
export const KR_API_PROXY_PATH = "/__geolibre_kr_api_proxy";

/** Endpoints that answer browsers correctly and so need no detour. */
function isDirectlyReachable(url: string): boolean {
  // VWorld's WMTS tiles are the one family served with CORS headers.
  return /^https:\/\/api\.vworld\.kr\/req\/wmts\//.test(url);
}

/** Wraps bytes from the native command in the response shape the plugins expect. */
function nativeResponse(bytes: number[] | Uint8Array): VWorldResponse {
  const buffer = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return {
    ok: true,
    status: 200,
    // The native command resolves only on a successful transfer, so reaching
    // here means the bytes are the body. Both services report their own errors
    // inside that body, which the callers already parse.
    text: async () => new TextDecoder().decode(buffer),
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  };
}

function proxied(url: string, init?: { signal?: AbortSignal }): Promise<VWorldResponse> {
  return fetch(`${KR_API_PROXY_PATH}?url=${encodeURIComponent(url)}`, init);
}

/**
 * Installs the transports for the current shell. Call once at startup.
 *
 * @param options - Injectable shell detection, for testing.
 */
export function installKoreanApiTransports(options?: { desktop?: boolean; dev?: boolean }): void {
  const desktop = options?.desktop ?? isTauri();
  const dev = options?.dev ?? import.meta.env.DEV;

  if (desktop) {
    const native = async (url: string) =>
      nativeResponse(await fetchUrlBytes(url, { context: "KR public data" }));
    setVWorldTransport(native);
    setKmaTransport(native);
    setDataGoKrTransport(native);
    return;
  }

  if (dev) {
    setVWorldTransport((url, init) =>
      // Tiles already work directly; proxying them too would push every tile
      // through the dev server for no reason.
      isDirectlyReachable(url) ? fetch(url, init) : proxied(url, init),
    );
    setKmaTransport((url: string, init?: { signal?: AbortSignal }) => proxied(url, init));
    setDataGoKrTransport((url: string, init?: { signal?: AbortSignal }) => proxied(url, init));
    return;
  }

  // Production web build: no proxy is guaranteed to exist, so leave the browser
  // default. VWorld tiles work; everything else reports a network failure until
  // a deployment puts a proxy in front of these hosts.
  setVWorldTransport(null);
  setKmaTransport(null);
  setDataGoKrTransport(null);
}
