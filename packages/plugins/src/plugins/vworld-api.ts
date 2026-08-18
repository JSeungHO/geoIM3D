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

import { addProtocol } from "maplibre-gl";

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
  addProtocol("vworld", async (params, abortController) => {
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
  {
    id: "cadastral-bonbun",
    labelKey: "cadastralBonbun",
    typename: "lp_pa_cbnd_bonbun",
    minzoom: 14,
  },
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
  return narrowToClicked(found, lon, lat);
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

/**
 * How one WFS attribute should be presented.
 *
 * The building schema carries 26 columns, most of them internal identifiers
 * (`ufid`, `geoidn`, `sgg_oid`, `col_adm_se`). Listing them all buries the six
 * a person actually reads — floors, areas, height, approval date — in a wall of
 * opaque numbers, so the panel shows the useful ones first and folds the rest
 * away.
 */
export type AttributeFormat = "text" | "number" | "area" | "ratio" | "date";

export interface AttributeSpec {
  field: string;
  format: AttributeFormat;
}

/**
 * The attributes worth showing, in reading order. Anything not listed is still
 * available, just collapsed behind the raw-attribute disclosure.
 */
export const VWORLD_PRIMARY_ATTRIBUTES: readonly AttributeSpec[] = [
  { field: "bld_nm", format: "text" }, // 건물명
  { field: "dong_nm", format: "text" }, // 동명
  { field: "grnd_flr", format: "number" }, // 지상층수
  { field: "ugrnd_flr", format: "number" }, // 지하층수
  { field: "height", format: "number" }, // 높이(m)
  { field: "archarea", format: "area" }, // 건축면적
  { field: "totalarea", format: "area" }, // 연면적
  { field: "platarea", format: "area" }, // 대지면적
  { field: "bc_rat", format: "ratio" }, // 건폐율
  { field: "vl_rat", format: "ratio" }, // 용적률
  { field: "useapr_day", format: "date" }, // 사용승인일
  { field: "regist_day", format: "date" }, // 등록일
  { field: "jibun", format: "text" },
  { field: "addr", format: "text" },
  { field: "sido_nm", format: "text" },
  { field: "sgg_nm", format: "text" },
  { field: "emd_nm", format: "text" },
  { field: "ri_nm", format: "text" },
  { field: "pnu", format: "text" }, // 필지고유번호
  { field: "bd_mgt_sn", format: "text" }, // 건축물대장 관리번호
];

const PRIMARY_FIELDS = new Set(VWORLD_PRIMARY_ATTRIBUTES.map((spec) => spec.field));

/**
 * Whether a field belongs in the collapsed raw section.
 *
 * @param field - The WFS column name.
 * @returns True when the field is not one of the primary attributes.
 */
export function isSecondaryAttribute(field: string): boolean {
  return !PRIMARY_FIELDS.has(field);
}

/**
 * Formats one attribute for display.
 *
 * Returns an empty string for values that mean "not recorded" — including a
 * bare `0` in an area or ratio column, which VWorld uses for an unmeasured
 * figure. Showing "0 ㎡" states a fact the record does not contain.
 *
 * @param value - The raw attribute value.
 * @param format - How to present it.
 * @returns The display string, or "" when there is nothing to show.
 */
export function formatAttribute(value: unknown, format: AttributeFormat = "text"): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  // VWorld writes an unset field as null or the literal string "None".
  if (text === "" || text === "None" || text === "null") return "";

  if (format === "date") {
    // `YYYYMMDD`; anything else is passed through rather than mangled.
    const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : text;
  }

  const numeric = Number.parseFloat(text);
  if (format === "number" || format === "area" || format === "ratio") {
    if (!Number.isFinite(numeric)) return text;
    // An area or ratio of zero is "not measured", not a measurement. Floor
    // counts legitimately reach zero (a building with no basement), so only the
    // measured columns are blanked.
    if (numeric === 0 && format !== "number") return "";
    return numeric.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return text;
}

/**
 * Whether a point lies inside a ring, by ray casting.
 *
 * @param lon - Longitude of the test point.
 * @param lat - Latitude of the test point.
 * @param ring - A linear ring as `[lon, lat]` pairs.
 * @returns True when the point is inside.
 */
function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    // Count crossings of a ray cast east from the point. The half-open
    // comparison on latitude keeps a vertex exactly on the ray from being
    // counted twice.
    const straddles = yi > lat !== yj > lat;
    if (!straddles) continue;
    if (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Whether a point lies inside a GeoJSON Polygon or MultiPolygon.
 *
 * Holes are honoured: a point in a courtyard is outside the building.
 *
 * @param lon - Longitude of the test point.
 * @param lat - Latitude of the test point.
 * @param geometry - The feature geometry.
 * @returns True when the point is inside the shape.
 */
export function pointInGeometry(lon: number, lat: number, geometry: unknown): boolean {
  const shape = geometry as { type?: string; coordinates?: unknown } | null;
  if (!shape?.coordinates) return false;
  const polygons =
    shape.type === "MultiPolygon"
      ? (shape.coordinates as number[][][][])
      : shape.type === "Polygon"
        ? [shape.coordinates as number[][][]]
        : [];
  for (const rings of polygons) {
    if (rings.length === 0) continue;
    if (!pointInRing(lon, lat, rings[0])) continue;
    // Inside the outer ring — unless it falls in one of the holes.
    if (rings.slice(1).some((hole) => pointInRing(lon, lat, hole))) continue;
    return true;
  }
  return false;
}

/**
 * Narrows bbox hits to the feature the user actually clicked.
 *
 * The WFS query uses a small box around the pointer because a click is not a
 * coordinate the service can match exactly. In dense blocks that box spans
 * several buildings, so every one of them came back and the panel listed four
 * "건물정보" cards for one click. The box is only a coarse filter; containment
 * decides.
 *
 * When nothing contains the point — a click that landed a couple of metres off
 * the footprint, or in a gap between buildings — the single nearest hit is kept
 * rather than reporting nothing, since the user plainly meant something.
 *
 * @param found - Features returned for the query box.
 * @param lon - Longitude clicked.
 * @param lat - Latitude clicked.
 * @returns The features to show.
 */
export function narrowToClicked(
  found: readonly VWorldFeatureInfo[],
  lon: number,
  lat: number,
): VWorldFeatureInfo[] {
  if (found.length <= 1) return [...found];

  // One hit per layer: a click can legitimately match a parcel *and* the
  // building standing on it, and both are worth showing.
  const byLayer = new Map<string, VWorldFeatureInfo[]>();
  for (const info of found) {
    const list = byLayer.get(info.layerId);
    if (list) list.push(info);
    else byLayer.set(info.layerId, [info]);
  }

  const narrowed: VWorldFeatureInfo[] = [];
  for (const candidates of byLayer.values()) {
    const containing = candidates.filter((info) => pointInGeometry(lon, lat, info.geometry));
    if (containing.length > 0) {
      narrowed.push(...containing);
      continue;
    }
    const nearest = candidates.reduce((best, info) =>
      geometryDistance(lon, lat, info.geometry) < geometryDistance(lon, lat, best.geometry)
        ? info
        : best,
    );
    narrowed.push(nearest);
  }
  return narrowed;
}

/**
 * Squared distance from a point to a geometry's nearest vertex.
 *
 * Squared and in degrees: only used to rank candidates against each other, so
 * the square root and a proper projection would change nothing.
 *
 * @param lon - Longitude of the test point.
 * @param lat - Latitude of the test point.
 * @param geometry - The feature geometry.
 * @returns The squared distance, or Infinity when there are no coordinates.
 */
function geometryDistance(lon: number, lat: number, geometry: unknown): number {
  let best = Number.POSITIVE_INFINITY;
  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      const dx = (node[0] as number) - lon;
      const dy = (node[1] as number) - lat;
      best = Math.min(best, dx * dx + dy * dy);
      return;
    }
    for (const child of node) visit(child);
  };
  visit((geometry as { coordinates?: unknown } | null)?.coordinates);
  return best;
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
