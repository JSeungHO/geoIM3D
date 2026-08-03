/**
 * VWorld OpenAPI client: endpoints, request DTOs, response normalization, and
 * error classification.
 *
 * Endpoints and parameters follow the official reference
 * (https://www.vworld.kr/dev/v4apiRefer.do), version 2.0 where the service
 * offers one. Three rules the rest of the plugin depends on:
 *
 * - **The API key is module-private.** It arrives through
 *   {@link setVWorldApiKey}, a write-only setter the desktop shell calls from
 *   its credential store. There is no getter, the key is never placed on
 *   `window`, and it is never written into a layer record or the project file
 *   (see `vworld-protocol.ts`, which injects it per request instead).
 * - **Errors carry no key and no request URL.** A VWorld failure is reduced to
 *   a {@link VWorldErrorKind} so a message can be shown, logged, or exported in
 *   diagnostics without leaking the credential or the full query.
 * - **Coordinates are explicit about their CRS.** Every request asks for
 *   EPSG:4326 and every DTO states the CRS it carries, so nothing reaches the
 *   map store having silently assumed a projection.
 */

import maplibregl from "maplibre-gl";

const VWORLD_ORIGIN = "https://api.vworld.kr";

/** Requests that outlive this are treated as a timeout rather than hanging the UI. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The CRS every request asks for and every DTO below reports. */
export const VWORLD_CRS = "EPSG:4326";

let apiKey = "";

/**
 * The minimal response shape this module needs. Deliberately narrower than
 * `Response` so a host can satisfy it with a native HTTP call that never goes
 * through the browser's fetch stack.
 */
export interface VWorldResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type VWorldTransport = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<VWorldResponse>;

/**
 * How requests leave the app. Defaults to the browser's `fetch`.
 *
 * VWorld does not send CORS headers on its JSON or WMS endpoints — only WMTS
 * tiles carry `Access-Control-Allow-Origin`. A browser therefore cannot read a
 * search, geocode, or thematic-layer response even with a valid key: the request
 * succeeds and is billed, but the answer is blocked. The host swaps in a
 * transport that is not subject to that (a native HTTP call on the desktop, a
 * dev-server proxy in the browser).
 */
let transport: VWorldTransport = (url, init) => fetch(url, init);

/**
 * Replaces the request transport.
 *
 * @param next - The transport to use, or null to restore the browser default.
 */
export function setVWorldTransport(next: VWorldTransport | null): void {
  transport = next ?? ((url, init) => fetch(url, init));
}

const keyListeners = new Set<() => void>();

/**
 * Subscribes to key changes.
 *
 * The plugin's menu disables its entries when no key is configured, so it has to
 * rebuild when one is saved or deleted. Notifying from here keeps that a
 * plugin-internal concern: the host only ever calls {@link setVWorldApiKey} and
 * does not need to know who cares.
 *
 * @param listener - Called after the key changes. Receives no value.
 * @returns An unsubscribe function.
 */
export function onVWorldApiKeyChange(listener: () => void): () => void {
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
}

/**
 * Injects the VWorld API key. Write-only by design: the host reads the value
 * from its credential store and pushes it here, and nothing can read it back
 * out — consumers ask {@link hasVWorldApiKey} instead.
 *
 * @param key - The API key, or an empty string to clear it.
 */
export function setVWorldApiKey(key: string): void {
  const next = typeof key === "string" ? key.trim() : "";
  // Only notify on a real change: the host re-pushes on every credential-store
  // update, and rebuilding a menu on each one would close an open submenu.
  if (next === apiKey) return;
  apiKey = next;
  for (const listener of keyListeners) listener();
}

/**
 * Whether a key is currently configured.
 *
 * @returns True when requests can be attempted.
 */
export function hasVWorldApiKey(): boolean {
  return apiKey.length > 0;
}

/**
 * The key, for the request-time injection points only (the tile/WMS protocol
 * handler and the request builders in this module). Not exported from the
 * package index.
 *
 * @returns The configured key, or an empty string.
 */
export function internalVWorldApiKey(): string {
  return apiKey;
}

/**
 * Failure categories the UI distinguishes. Network, rate limit, invalid key,
 * and empty result are separate because each needs a different user action.
 */
export type VWorldErrorKind =
  | "no-key"
  | "network"
  | "timeout"
  | "invalid-key"
  | "rate-limit"
  | "invalid-request"
  | "not-found"
  | "server"
  | "unknown";

/** A VWorld failure. The message is a fixed code — never a key or a request URL. */
export class VWorldError extends Error {
  readonly kind: VWorldErrorKind;

  constructor(kind: VWorldErrorKind) {
    super(kind);
    this.name = "VWorldError";
    this.kind = kind;
  }
}

/**
 * Maps a documented VWorld status/error code to a {@link VWorldErrorKind}.
 *
 * Codes per the official reference: `INVALID_KEY`/`INCORRECT_KEY`/
 * `UNAVAILABLE_KEY` (level 2) mean the key is unusable — unregistered, issued
 * for a different domain, or suspended; `OVER_REQUEST_LIMIT` is the daily quota;
 * `PARAM_REQUIRED`/`INVALID_TYPE`/`INVALID_RANGE` (level 1) are our own request
 * bugs; `SYSTEM_ERROR`/`UNKNOWN_ERROR` (level 3) are server-side.
 *
 * @param code - The `status`/error code text from the response.
 * @returns The matching error kind.
 */
export function vworldErrorKind(code: string): VWorldErrorKind {
  switch (code.trim().toUpperCase()) {
    case "NOT_FOUND":
      return "not-found";
    case "INVALID_KEY":
    case "INCORRECT_KEY":
    case "UNAVAILABLE_KEY":
      return "invalid-key";
    case "OVER_REQUEST_LIMIT":
      return "rate-limit";
    case "PARAM_REQUIRED":
    case "INVALID_TYPE":
    case "INVALID_RANGE":
      return "invalid-request";
    case "SYSTEM_ERROR":
    case "UNKNOWN_ERROR":
      return "server";
    default:
      return "unknown";
  }
}

/**
 * Builds a VWorld request URL with the key appended.
 *
 * Exported for the protocol handler and the request functions below; callers
 * must not log or surface the result, since it carries the key.
 *
 * @param path - Path under the VWorld API origin, e.g. `/req/search`.
 * @param params - Query parameters, excluding `key`.
 * @returns The absolute request URL.
 */
export function buildVWorldUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path, VWORLD_ORIGIN);
  for (const [name, value] of Object.entries(params)) {
    if (value !== "") url.searchParams.set(name, value);
  }
  url.searchParams.set("key", apiKey);
  return url.href;
}

/**
 * Runs a VWorld JSON request and classifies every failure mode.
 *
 * @param path - Path under the VWorld API origin.
 * @param params - Query parameters, excluding `key`.
 * @returns The parsed `response` object.
 * @throws {VWorldError} When no key is set, the network fails or times out, or
 *   VWorld reports a non-OK status.
 */
/**
 * Fetches and parses a VWorld response without unwrapping it.
 *
 * The OGC endpoints (WFS) answer with plain GeoJSON, not the `{ response: … }`
 * envelope the JSON APIs use, and report failure as an XML
 * `ServiceExceptionReport` rather than a status field — so a parse failure
 * here is a service exception, most often the missing `domain` parameter.
 *
 * @param path - Path under the VWorld origin.
 * @param params - Query parameters, excluding `key`.
 * @returns The parsed body.
 * @throws {VWorldError} On transport failure or a service exception.
 */
async function requestRawJson(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (!hasVWorldApiKey()) throw new VWorldError("no-key");

  let text: string;
  try {
    const response = await transport(buildVWorldUrl(path, params), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new VWorldError(response.status >= 500 ? "server" : "network");
    text = await response.text();
  } catch (error) {
    if (error instanceof VWorldError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new VWorldError("timeout");
    }
    throw new VWorldError("network");
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // An XML ServiceExceptionReport. Pull the code out so a missing `domain`
    // (INCORRECT_KEY) is not reported as an unusable key.
    const code = /<ServiceException[^>]*code="([^"]+)"/.exec(text)?.[1] ?? "";
    throw new VWorldError(code ? vworldErrorKind(code) : "unknown");
  }
}

async function requestJson(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (!hasVWorldApiKey()) throw new VWorldError("no-key");

  let payload: unknown;
  try {
    const response = await transport(buildVWorldUrl(path, params), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A transport-level failure is not a VWorld status code; VWorld reports its
    // own errors with HTTP 200 and a status field.
    if (!response.ok) throw new VWorldError(response.status >= 500 ? "server" : "network");
    // Parsed here rather than via `response.json()` so the transport only has to
    // provide text, which a native HTTP bridge can do without mimicking Response.
    payload = JSON.parse(await response.text());
  } catch (error) {
    if (error instanceof VWorldError) throw error;
    // AbortSignal.timeout rejects with a TimeoutError DOMException.
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new VWorldError("timeout");
    }
    throw new VWorldError("network");
  }

  const root = (payload as { response?: unknown })?.response;
  if (!root || typeof root !== "object") throw new VWorldError("unknown");
  const result = root as Record<string, unknown>;

  const status = typeof result.status === "string" ? result.status : "";
  if (status.toUpperCase() === "OK") return result;
  if (status.toUpperCase() === "NOT_FOUND") throw new VWorldError("not-found");

  // An ERROR status puts the specific code in `error.code`/`error.text`.
  const error = result.error as { code?: unknown } | undefined;
  const code = typeof error?.code === "string" ? error.code : status;
  throw new VWorldError(vworldErrorKind(code));
}

/** Outcome of a key check; mirrors the KMA one so the UI handles both alike. */
export type VWorldKeyCheck = { ok: true } | { ok: false; kind: VWorldErrorKind; readable: boolean };

/**
 * Checks the configured API key with one small live request.
 *
 * Searches for a well-known place, which is the cheapest call that exercises
 * authentication. Unlike the tile endpoints it returns JSON, so VWorld's own
 * status code is available to report.
 *
 * @returns Whether the key was accepted, and why not when it was not.
 */
export async function verifyVWorldApiKey(): Promise<VWorldKeyCheck> {
  if (!hasVWorldApiKey()) return { ok: false, kind: "no-key", readable: true };
  try {
    // PLACE takes no `category`, so this exercises authentication with the
    // fewest parameters that can be got wrong.
    await vworldSearch("서울시청", "PLACE", { size: 1 });
    return { ok: true };
  } catch (error) {
    const kind = error instanceof VWorldError ? error.kind : "unknown";
    // An empty result still means the key authenticated.
    if (kind === "not-found") return { ok: true };
    return { ok: false, kind, readable: kind !== "network" && kind !== "timeout" };
  }
}

/* -------------------------------------------------------------------------- */
/* 2D map tiles (WMTS)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A VWorld base map layer. Zoom ranges and image formats are the documented
 * per-layer values, not a shared guess: Satellite is JPEG, the rest PNG, and
 * white/midnight stop one level shallower than Base/Hybrid/Satellite.
 */
export interface VWorldBaseMap {
  /** The `{layer}` path segment in the WMTS template. */
  id: "Base" | "white" | "midnight" | "Hybrid" | "Satellite";
  labelKey: string;
  extension: "png" | "jpeg";
  minzoom: number;
  maxzoom: number;
  /** Hybrid is a transparent overlay meant to sit on top of Satellite. */
  overlay: boolean;
}

export const VWORLD_BASE_MAPS: readonly VWorldBaseMap[] = [
  { id: "Base", labelKey: "base", extension: "png", minzoom: 6, maxzoom: 19, overlay: false },
  { id: "white", labelKey: "white", extension: "png", minzoom: 6, maxzoom: 18, overlay: false },
  {
    id: "midnight",
    labelKey: "midnight",
    extension: "png",
    minzoom: 6,
    maxzoom: 18,
    overlay: false,
  },
  {
    id: "Satellite",
    labelKey: "satellite",
    extension: "jpeg",
    minzoom: 6,
    maxzoom: 19,
    overlay: false,
  },
  { id: "Hybrid", labelKey: "hybrid", extension: "png", minzoom: 6, maxzoom: 19, overlay: true },
];

/** Approximate bounds of VWorld's Korean coverage, `[west, south, east, north]`. */
export const VWORLD_BOUNDS: [number, number, number, number] = [124.5, 33.0, 132.0, 38.7];

export const VWORLD_ATTRIBUTION =
  '<a href="https://www.vworld.kr/" target="_blank" rel="noreferrer">국토교통부 공간정보 오픈플랫폼(V-World)</a>';

/**
 * Builds the key-free tile template for a base map.
 *
 * The `vworld://` scheme is deliberate: the real request URL carries the API
 * key, so it must not be what gets stored on the layer and saved into the
 * project file. The protocol handler swaps in the key per request.
 *
 * Path order follows the WMTS template `{tileMatrix}/{tileRow}/{tileCol}` —
 * z/y/x, not the z/x/y most XYZ services use.
 *
 * @param map - The base map definition.
 * @returns The tile URL template.
 */
export function vworldTileTemplate(map: VWorldBaseMap): string {
  return `vworld://wmts/${map.id}/{z}/{y}/{x}.${map.extension}`;
}

/**
 * Resolves a `vworld://` URL to the real VWorld request URL, injecting the key.
 * Used only by the protocol handler at request time.
 *
 * @param url - A `vworld://wmts/...` or `vworld://wms?...` URL.
 * @returns The absolute VWorld URL.
 * @throws {VWorldError} When no key is configured or the URL is not recognized.
 */
export function resolveVWorldProtocolUrl(url: string): string {
  if (!hasVWorldApiKey()) throw new VWorldError("no-key");

  const wmts = /^vworld:\/\/wmts\/(.+)$/.exec(url);
  if (wmts) {
    // The key is a path segment in the WMTS template, not a query parameter.
    return `${VWORLD_ORIGIN}/req/wmts/1.0.0/${encodeURIComponent(apiKey)}/${wmts[1]}`;
  }

  const wms = /^vworld:\/\/(wms|wfs)(\?.*)?$/.exec(url);
  if (wms) {
    const params = new URLSearchParams(wms[2] ?? "");
    params.set("key", apiKey);
    return `${VWORLD_ORIGIN}/req/${wms[1]}?${params.toString()}`;
  }

  throw new VWorldError("invalid-request");
}

let protocolRegistered = false;

/**
 * Registers the `vworld://` MapLibre protocol that injects the API key into
 * every tile request.
 *
 * Registered once at app startup rather than on plugin activation: VWorld
 * layers are added from the Add Data menu and restored from saved projects, so
 * their tiles must resolve whether or not the VWorld panel is open. Idempotent,
 * since MapLibre's protocol registry is global.
 */
export function registerVWorldProtocol(): void {
  if (protocolRegistered) return;
  maplibregl.addProtocol("vworld", async (params, abortController) => {
    const response = await transport(resolveVWorldProtocolUrl(params.url), {
      signal: abortController.signal,
    });
    if (!response.ok) throw new VWorldError(response.status >= 500 ? "server" : "network");
    return { data: await response.arrayBuffer() };
  });
  protocolRegistered = true;
}

/* -------------------------------------------------------------------------- */
/* WMS thematic layers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A VWorld WMS layer offered in the plugin panel. The `typename` values are the
 * documented layer identifiers; a typo here yields an empty tile rather than an
 * error, so they are kept in one place and covered by a test.
 */
export interface VWorldThematicLayer {
  id: string;
  labelKey: string;
  /** WMS `layers` value. */
  typename: string;
  /** Cadastral layers are only legible when zoomed in. */
  minzoom: number;
}

export const VWORLD_THEMATIC_LAYERS: readonly VWorldThematicLayer[] = [
  // 지적도 — parcel boundaries (본번/부번).
  { id: "cadastral", labelKey: "cadastral", typename: "lp_pa_cbnd_bubun", minzoom: 14 },
  { id: "cadastral-bonbun", labelKey: "cadastralBonbun", typename: "lp_pa_cbnd_bonbun", minzoom: 14 },
  // 건물 정보.
  { id: "building", labelKey: "building", typename: "lt_c_bldginfo", minzoom: 13 },
  // 용도지역 — urban / management / agricultural-forestry, plus green belt.
  { id: "zoning-urban", labelKey: "zoningUrban", typename: "lt_c_uq111", minzoom: 10 },
  { id: "zoning-management", labelKey: "zoningManagement", typename: "lt_c_uq112", minzoom: 10 },
  { id: "zoning-agriculture", labelKey: "zoningAgriculture", typename: "lt_c_uq113", minzoom: 10 },
  { id: "zoning-greenbelt", labelKey: "zoningGreenbelt", typename: "lt_c_ud801", minzoom: 10 },
];

/* -------------------------------------------------------------------------- */
/* Thematic feature lookup (WFS)                                                */
/* -------------------------------------------------------------------------- */

/**
 * The domain the key is registered against, sent as VWorld's `domain`
 * parameter.
 *
 * WFS — unlike the tile and search endpoints — refuses a request that carries
 * no registered domain with `INCORRECT_KEY` ("인증키 정보가 올바르지 않습니다"),
 * which reads as a bad key rather than a missing parameter. A browser can pass
 * its own `Referer`, but this app's requests go through a native HTTP call or a
 * proxy, so neither carries one and the parameter has to be explicit.
 */
let registeredDomain = "";

/**
 * Sets the domain the VWorld key was registered with.
 *
 * @param domain - The registered origin, e.g. `http://localhost:5173`.
 */
export function setVWorldDomain(domain: string): void {
  registeredDomain = typeof domain === "string" ? domain.trim() : "";
}

/**
 * Half-width of the bounding box used to turn a click into a WFS query, in
 * degrees — roughly 11 m at Korean latitudes.
 *
 * Small enough that a click inside one building rarely catches its neighbour,
 * large enough to tolerate the pointer being a few pixels off the polygon at
 * typical inspection zooms.
 */
const CLICK_TOLERANCE_DEG = 0.0001;

/** A thematic feature returned by a click lookup. */
export interface VWorldFeatureInfo {
  /** The thematic layer id from {@link VWORLD_THEMATIC_LAYERS}. */
  layerId: string;
  /** VWorld's own feature id, e.g. `lt_c_bldginfo.13734085`. */
  featureId: string;
  /** Raw attributes, unmapped. */
  properties: Record<string, unknown>;
  /** The feature's geometry, for adding it to the map as a layer. */
  geometry: unknown;
}

/**
 * Looks up the thematic features at a point.
 *
 * The thematic layers are added as WMS, which serves images and so answers no
 * click. The same data is available as WFS, so a click becomes a small bbox
 * query against the layers that are actually on the map.
 *
 * @param typenames - WFS typenames to query, from {@link VWORLD_THEMATIC_LAYERS}.
 * @param lon - Longitude in {@link VWORLD_CRS}.
 * @param lat - Latitude in {@link VWORLD_CRS}.
 * @returns One entry per matched feature, in the order the typenames were given.
 * @throws {VWorldError} When no key is set or every query failed.
 */
export async function vworldFeatureInfo(
  typenames: ReadonlyArray<{ id: string; typename: string }>,
  lon: number,
  lat: number,
): Promise<VWorldFeatureInfo[]> {
  if (!hasVWorldApiKey()) throw new VWorldError("no-key");
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new VWorldError("invalid-request");
  if (typenames.length === 0) return [];

  const west = lon - CLICK_TOLERANCE_DEG;
  const south = lat - CLICK_TOLERANCE_DEG;
  const east = lon + CLICK_TOLERANCE_DEG;
  const north = lat + CLICK_TOLERANCE_DEG;

  // One request per layer, settled together: a layer the key is not approved
  // for must not hide the answer from the layers it is.
  const responses = await Promise.allSettled(
    typenames.map((entry) =>
      requestRawJson("/req/wfs", {
        SERVICE: "WFS",
        REQUEST: "GetFeature",
        VERSION: "1.1.0",
        TYPENAME: entry.typename,
        // WFS 1.1.0 with an EPSG:4326 SRS expects lat/lon order in BBOX.
        BBOX: `${south},${west},${north},${east}`,
        SRSNAME: VWORLD_CRS,
        MAXFEATURES: "5",
        OUTPUT: "application/json",
        domain: registeredDomain,
      }),
    ),
  );

  const found: VWorldFeatureInfo[] = [];
  let firstError: unknown = null;
  for (const [index, response] of responses.entries()) {
    if (response.status === "rejected") {
      firstError ??= response.reason;
      continue;
    }
    const features = (response.value as { features?: unknown }).features;
    if (!Array.isArray(features)) continue;
    for (const raw of features) {
      const feature = raw as {
        id?: unknown;
        properties?: Record<string, unknown>;
        geometry?: unknown;
      };
      found.push({
        layerId: typenames[index].id,
        featureId: typeof feature.id === "string" ? feature.id : "",
        properties: feature.properties ?? {},
        geometry: feature.geometry ?? null,
      });
    }
  }

  // Nothing found is not a failure — the user may simply have clicked a road.
  // A failure with nothing found is, and its reason is worth reporting.
  if (found.length === 0 && firstError instanceof VWorldError) throw firstError;
  return found;
}

/**
 * The most features one WFS request will return.
 *
 * VWorld caps a GetFeature response at 1000; asking for more silently returns
 * that many, so the limit is stated here and the caller is told when a view was
 * truncated rather than being shown a partial city as if it were complete.
 */
export const VWORLD_WFS_MAX_FEATURES = 1000;

/** A building footprint with the height fields needed to extrude it. */
export interface VWorldBuildings {
  geojson: {
    type: "FeatureCollection";
    features: Array<{
      type: "Feature";
      geometry: unknown;
      properties: Record<string, unknown>;
    }>;
  };
  /** True when the response hit {@link VWORLD_WFS_MAX_FEATURES}. */
  truncated: boolean;
}

/**
 * Height in metres assumed per storey when a building reports floors but no
 * measured height. A rough national average for mixed residential/commercial
 * stock — enough to make a skyline read correctly, not a survey figure.
 */
export const ASSUMED_STOREY_HEIGHT_M = 3;

/** The property extruded layers read, written by {@link vworldBuildings}. */
export const VWORLD_HEIGHT_PROPERTY = "extrude_height_m";

/**
 * Fetches building footprints in a bounding box, ready to extrude.
 *
 * The thematic building layer is WMS — a flat image — so it can never be
 * extruded. The same data as WFS gives real polygons plus `grnd_flr` (storeys),
 * which is what turns them into a 3D city without any Cesium Ion asset.
 *
 * Each feature gains {@link VWORLD_HEIGHT_PROPERTY}: the measured `height` when
 * the record has one, otherwise storeys times {@link ASSUMED_STOREY_HEIGHT_M}.
 * Doing it here rather than in a style expression keeps the fallback in one
 * place and leaves the value visible in the attribute table.
 *
 * @param bbox - `[west, south, east, north]` in {@link VWORLD_CRS}.
 * @returns The footprints and whether the response was truncated.
 * @throws {VWorldError} On any failure.
 */
export async function vworldBuildings(
  bbox: [number, number, number, number],
): Promise<VWorldBuildings> {
  if (!hasVWorldApiKey()) throw new VWorldError("no-key");
  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every((value) => Number.isFinite(value))) {
    throw new VWorldError("invalid-request");
  }

  const body = await requestRawJson("/req/wfs", {
    SERVICE: "WFS",
    REQUEST: "GetFeature",
    VERSION: "1.1.0",
    TYPENAME: "lt_c_bldginfo",
    // WFS 1.1.0 with an EPSG:4326 SRS expects lat/lon order.
    BBOX: `${south},${west},${north},${east}`,
    SRSNAME: VWORLD_CRS,
    MAXFEATURES: String(VWORLD_WFS_MAX_FEATURES),
    OUTPUT: "application/json",
    domain: registeredDomain,
  });

  const raw = Array.isArray((body as { features?: unknown }).features)
    ? ((body as { features: unknown[] }).features as Array<Record<string, unknown>>)
    : [];

  const features = raw
    .filter((feature) => feature.geometry)
    .map((feature) => {
      const properties = (feature.properties ?? {}) as Record<string, unknown>;
      return {
        type: "Feature" as const,
        geometry: feature.geometry,
        properties: {
          ...properties,
          [VWORLD_HEIGHT_PROPERTY]: buildingHeight(properties),
        },
      };
    });

  if (features.length === 0) throw new VWorldError("not-found");
  return {
    geojson: { type: "FeatureCollection", features },
    truncated: raw.length >= VWORLD_WFS_MAX_FEATURES,
  };
}

/**
 * Resolves a building's extrusion height in metres.
 *
 * @param properties - The WFS attributes.
 * @returns The measured height, the storey estimate, or one storey as a floor.
 */
export function buildingHeight(properties: Record<string, unknown>): number {
  const measured = Number.parseFloat(String(properties.height ?? ""));
  if (Number.isFinite(measured) && measured > 0) return measured;
  const storeys = Number.parseFloat(String(properties.grnd_flr ?? ""));
  if (Number.isFinite(storeys) && storeys > 0) return storeys * ASSUMED_STOREY_HEIGHT_M;
  // Records with neither still need to be visible, or a whole block silently
  // flattens into the ground plane.
  return ASSUMED_STOREY_HEIGHT_M;
}

/* -------------------------------------------------------------------------- */
/* Search                                                                       */
/* -------------------------------------------------------------------------- */

export type VWorldSearchType = "PLACE" | "ADDRESS" | "DISTRICT" | "ROAD";

/**
 * The `category` each search type needs, or an empty string when it takes none.
 *
 * - `ADDRESS` → `PARCEL` (지번). Road addresses are served by the geocoder's own
 *   ROAD mode, which the panel exposes separately.
 * - `DISTRICT` → `L4` (읍면동), the most specific administrative level, so a
 *   query matches the smallest named area rather than only provinces.
 *
 * @param type - The search type.
 * @returns The category value, or an empty string to omit the parameter.
 */
export function defaultSearchCategory(type: VWorldSearchType): string {
  if (type === "ADDRESS") return "PARCEL";
  if (type === "DISTRICT") return "L4";
  return "";
}

/** One search hit, in {@link VWORLD_CRS}. */
export interface VWorldSearchResult {
  id: string;
  title: string;
  /** Address or district text, when the hit carries one. */
  subtitle: string;
  lng: number;
  lat: number;
  crs: typeof VWORLD_CRS;
}

export interface VWorldSearchResponse {
  results: VWorldSearchResult[];
  /** Total matches, which may exceed the page returned. */
  total: number;
  page: number;
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Runs an integrated search (통합 검색).
 *
 * @param query - The search keyword.
 * @param type - What to search: place, address, district, or road name.
 * @param options - Paging and an optional bbox in {@link VWORLD_CRS}.
 * @returns The page of results, in {@link VWORLD_CRS}.
 * @throws {VWorldError} On any failure, including an empty result (`not-found`).
 */
export async function vworldSearch(
  query: string,
  type: VWorldSearchType = "PLACE",
  options: {
    page?: number;
    size?: number;
    bbox?: [number, number, number, number];
    /** Overrides {@link defaultSearchCategory} (e.g. `L2` for provinces only). */
    category?: string;
  } = {},
): Promise<VWorldSearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) throw new VWorldError("invalid-request");

  const result = await requestJson("/req/search", {
    service: "search",
    request: "search",
    version: "2.0",
    format: "json",
    errorFormat: "json",
    crs: VWORLD_CRS,
    query: trimmed,
    type,
    // `category` is required for some types and rejected as unnecessary for
    // none, so it is derived per type rather than sent blindly. Verified against
    // the live service: ADDRESS and DISTRICT fail with PARAM_REQUIRED without
    // it, while PLACE and ROAD do not need it.
    category: options.category ?? defaultSearchCategory(type),
    size: String(Math.min(Math.max(options.size ?? 20, 1), 1000)),
    page: String(Math.max(options.page ?? 1, 1)),
    bbox: options.bbox ? options.bbox.join(",") : "",
  });

  const container = result.result as { items?: unknown } | undefined;
  const items = Array.isArray(container?.items) ? container.items : [];
  const results: VWorldSearchResult[] = [];
  for (const [index, entry] of items.entries()) {
    const item = entry as Record<string, unknown>;
    const point = item.point as Record<string, unknown> | undefined;
    const lng = numeric(point?.x);
    const lat = numeric(point?.y);
    if (lng === null || lat === null) continue;
    const address = item.address as Record<string, unknown> | undefined;
    results.push({
      id: typeof item.id === "string" ? item.id : `vworld-${index}`,
      title: String(item.title ?? address?.road ?? address?.parcel ?? trimmed),
      subtitle: String(address?.road ?? address?.parcel ?? item.district ?? ""),
      lng,
      lat,
      crs: VWORLD_CRS,
    });
  }

  const record = result.record as Record<string, unknown> | undefined;
  const page = result.page as Record<string, unknown> | undefined;
  return {
    results,
    total: numeric(record?.total) ?? results.length,
    page: numeric(page?.current) ?? 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Geocoding                                                                    */
/* -------------------------------------------------------------------------- */

export type VWorldAddressType = "PARCEL" | "ROAD";

/** A geocoded point, in {@link VWORLD_CRS}. */
export interface VWorldGeocodeResult {
  lng: number;
  lat: number;
  crs: typeof VWORLD_CRS;
  /** The address VWorld matched, which may be a refined form of the input. */
  matchedAddress: string;
}

/**
 * Converts an address to coordinates (주소 → 좌표).
 *
 * @param address - A parcel (지번) or road (도로명) address.
 * @param type - Which address form `address` is.
 * @returns The matched point in {@link VWORLD_CRS}.
 * @throws {VWorldError} On any failure, including no match (`not-found`).
 */
export async function vworldGeocode(
  address: string,
  type: VWorldAddressType = "ROAD",
): Promise<VWorldGeocodeResult> {
  const trimmed = address.trim();
  if (!trimmed) throw new VWorldError("invalid-request");

  const result = await requestJson("/req/address", {
    service: "address",
    request: "GetCoord",
    version: "2.0",
    format: "json",
    errorFormat: "json",
    crs: VWORLD_CRS,
    type,
    address: trimmed,
  });

  const point = (result.result as { point?: Record<string, unknown> } | undefined)?.point;
  const lng = numeric(point?.x);
  const lat = numeric(point?.y);
  if (lng === null || lat === null) throw new VWorldError("not-found");

  const refined = result.refined as { text?: unknown } | undefined;
  return {
    lng,
    lat,
    crs: VWORLD_CRS,
    matchedAddress: typeof refined?.text === "string" ? refined.text : trimmed,
  };
}

/** A reverse-geocoded address. */
export interface VWorldReverseGeocodeResult {
  /** Road-name address, when one exists for the point. */
  road: string;
  /** Parcel (지번) address, when one exists for the point. */
  parcel: string;
  zipcode: string;
}

/**
 * Converts coordinates to an address (좌표 → 주소).
 *
 * @param lng - Longitude in {@link VWORLD_CRS}.
 * @param lat - Latitude in {@link VWORLD_CRS}.
 * @returns Road and parcel addresses for the point (either may be empty).
 * @throws {VWorldError} On any failure, including no address at the point.
 */
export async function vworldReverseGeocode(
  lng: number,
  lat: number,
): Promise<VWorldReverseGeocodeResult> {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new VWorldError("invalid-request");

  const result = await requestJson("/req/address", {
    service: "address",
    request: "getAddress",
    version: "2.0",
    format: "json",
    errorFormat: "json",
    crs: VWORLD_CRS,
    // BOTH returns the road and parcel forms in one call.
    type: "BOTH",
    zipcode: "true",
    simple: "false",
    point: `${lng},${lat}`,
  });

  const items = Array.isArray(result.result) ? result.result : [];
  const resolved: VWorldReverseGeocodeResult = { road: "", parcel: "", zipcode: "" };
  for (const entry of items) {
    const item = entry as Record<string, unknown>;
    const text = typeof item.text === "string" ? item.text : "";
    const kind = String(item.type ?? "").toLowerCase();
    if (kind === "road" && !resolved.road) resolved.road = text;
    if (kind === "parcel" && !resolved.parcel) resolved.parcel = text;
    if (!resolved.zipcode && typeof item.zipcode === "string") resolved.zipcode = item.zipcode;
  }
  if (!resolved.road && !resolved.parcel) throw new VWorldError("not-found");
  return resolved;
}
