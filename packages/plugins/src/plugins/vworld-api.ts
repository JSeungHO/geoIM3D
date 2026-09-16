/**
 * VWorld OpenAPI client (endpoints follow https://www.vworld.kr/dev/v4apiRefer.do
 * v2.0). Key is module-private ({@link setVWorldApiKey}, no getter, never
 * persisted), errors reduce to {@link VWorldErrorKind}, coordinates are always EPSG:4326.
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
 * How requests leave the app. Defaults to `fetch`, but VWorld sends no CORS
 * headers on JSON/WMS (only WMTS tiles do), so the host swaps in a transport
 * that isn't subject to that (native HTTP on desktop, a dev-server proxy).
 */
let transport: VWorldTransport = (url, init) => fetch(url, init);

/** Replaces the request transport, or restores the browser default with null. */
export function setVWorldTransport(next: VWorldTransport | null): void {
  transport = next ?? ((url, init) => fetch(url, init));
}

const keyListeners = new Set<() => void>();

/** Subscribes to key changes, so the plugin menu can rebuild its disabled state. */
export function onVWorldApiKeyChange(listener: () => void): () => void {
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
}

/** Injects the VWorld API key; write-only, consumers ask {@link hasVWorldApiKey} instead. */
export function setVWorldApiKey(key: string): void {
  const next = typeof key === "string" ? key.trim() : "";
  // Only notify on a real change, since the host re-pushes on every credential update.
  if (next === apiKey) return;
  apiKey = next;
  for (const listener of keyListeners) listener();
}

/** Whether a key is currently configured. */
export function hasVWorldApiKey(): boolean {
  return apiKey.length > 0;
}

/** The key, for this module's own request-time injection points only. */
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

/** Maps a documented VWorld status/error code (official reference) to a {@link VWorldErrorKind}. */
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

/** Builds a VWorld request URL with the key appended. Never log or surface the result. */
export function buildVWorldUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path, VWORLD_ORIGIN);
  for (const [name, value] of Object.entries(params)) {
    if (value !== "") url.searchParams.set(name, value);
  }
  url.searchParams.set("key", apiKey);
  return url.href;
}

/**
 * Fetches and parses a VWorld response without unwrapping it — the OGC (WFS)
 * endpoints answer with plain GeoJSON and report failure as an XML
 * `ServiceExceptionReport`, not the usual `{ response: … }`/status envelope.
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

/** Runs a VWorld JSON request and classifies every failure mode. */
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

/** Checks the configured key with one cheap live request (a well-known place search). */
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
  /** The base map this entry (e.g. Hybrid's transparent labels) annotates, if it's an overlay. */
  overlayFor?: VWorldBaseMap["id"];
}

export const VWORLD_BASE_MAPS: readonly VWorldBaseMap[] = [
  { id: "Base", labelKey: "base", extension: "png", minzoom: 6, maxzoom: 19 },
  { id: "white", labelKey: "white", extension: "png", minzoom: 6, maxzoom: 18 },
  {
    id: "midnight",
    labelKey: "midnight",
    extension: "png",
    minzoom: 6,
    maxzoom: 18,
  },
  {
    id: "Satellite",
    labelKey: "satellite",
    extension: "jpeg",
    minzoom: 6,
    maxzoom: 19,
  },
  {
    id: "Hybrid",
    labelKey: "hybrid",
    extension: "png",
    minzoom: 6,
    maxzoom: 19,
    overlayFor: "Satellite",
  },
];

/** Approximate bounds of VWorld's Korean coverage, `[west, south, east, north]`. */
export const VWORLD_BOUNDS: [number, number, number, number] = [124.5, 33.0, 132.0, 38.7];

/** The lowest zoom at which any VWorld base map has tiles. */
export const VWORLD_MIN_ZOOM = 6;

/** Where to move the camera into VWorld's coverage, or null when the view already works. */
export function vworldCoverageView(view: {
  longitude: number;
  latitude: number;
  zoom: number;
}): { longitude: number; latitude: number; zoom: number } | null {
  const [west, south, east, north] = VWORLD_BOUNDS;
  const inside =
    view.longitude >= west &&
    view.longitude <= east &&
    view.latitude >= south &&
    view.latitude <= north;
  if (inside && view.zoom >= VWORLD_MIN_ZOOM) return null;
  return {
    longitude: (west + east) / 2,
    latitude: (south + north) / 2,
    // Just inside the coverage: enough to see the country, not so close that a
    // deliberate wide view becomes a street.
    zoom: Math.max(view.zoom, VWORLD_MIN_ZOOM + 1),
  };
}

export const VWORLD_ATTRIBUTION =
  '<a href="https://www.vworld.kr/" target="_blank" rel="noreferrer">국토교통부 공간정보 오픈플랫폼(V-World)</a>';

/** Builds the key-free `vworld://` tile template; z/y/x order, per the WMTS spec. */
export function vworldTileTemplate(map: VWorldBaseMap): string {
  return `vworld://wmts/${map.id}/{z}/{y}/{x}.${map.extension}`;
}

/** Resolves a `vworld://` URL to the real, key-bearing request URL. Protocol-handler use only. */
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

/** Registers the `vworld://` protocol at app startup, independent of plugin activation. Idempotent. */
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

/** A VWorld WMS layer; `typename` is the documented identifier, kept here and tested. */
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

/** The domain the key is registered against; WFS otherwise rejects with `INCORRECT_KEY`. */
let registeredDomain = "";

/** Sets the domain the VWorld key was registered with, e.g. `http://localhost:5173`. */
export function setVWorldDomain(domain: string): void {
  registeredDomain = typeof domain === "string" ? domain.trim() : "";
}

// Half-width of a click's WFS query box, in degrees (~11m at Korean latitudes).
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

/** Looks up thematic features at a point: WMS serves images, so this queries the WFS twin instead. */
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

/** VWorld caps a GetFeature response at this many; callers are told when a view was truncated. */
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

/** Assumed metres per storey when a building reports floors but no measured height. */
export const ASSUMED_STOREY_HEIGHT_M = 3;

/** The property extruded layers read, written by {@link vworldBuildings}. */
export const VWORLD_HEIGHT_PROPERTY = "extrude_height_m";

/**
 * Fetches building footprints (via WFS, since the WMS thematic layer is a
 * flat image) ready to extrude, filling in {@link VWORLD_HEIGHT_PROPERTY}
 * from measured height or storeys × {@link ASSUMED_STOREY_HEIGHT_M}.
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

/** Resolves a building's extrusion height: measured, storey estimate, or one storey as a floor. */
export function buildingHeight(properties: Record<string, unknown>): number {
  const measured = Number.parseFloat(String(properties.height ?? ""));
  if (Number.isFinite(measured) && measured > 0) return measured;
  const storeys = Number.parseFloat(String(properties.grnd_flr ?? ""));
  if (Number.isFinite(storeys) && storeys > 0) return storeys * ASSUMED_STOREY_HEIGHT_M;
  return ASSUMED_STOREY_HEIGHT_M;
}

/** How one WFS attribute should be presented (the schema has 26 columns, most internal ids). */
export type AttributeFormat = "text" | "number" | "area" | "ratio" | "date";

export interface AttributeSpec {
  field: string;
  format: AttributeFormat;
}

/** The attributes worth showing, in reading order; the rest sit behind the raw disclosure. */
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

/** Whether a field belongs in the collapsed raw section (not one of the primary attributes). */
export function isSecondaryAttribute(field: string): boolean {
  return !PRIMARY_FIELDS.has(field);
}

/** Formats one attribute; "" for anything meaning "not recorded" (VWorld uses bare `0` for that). */
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

/** Whether a point lies inside a ring, by ray casting. */
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

/** Whether a point lies inside a GeoJSON Polygon/MultiPolygon; holes are honoured. */
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
 * Narrows bbox hits (a coarse filter, per layer) to the feature actually
 * clicked by containment, or the single nearest hit when none contains it.
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

/** Squared distance (degrees) to a geometry's nearest vertex — only used to rank candidates. */
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

/** The `category` a search type needs: PARCEL for address, L4 for district, else none. */
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

/** Runs an integrated search (통합 검색): place, address, district, or road name. */
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
    // ADDRESS/DISTRICT require it (PARAM_REQUIRED without); PLACE/ROAD don't.
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

/** Converts an address (parcel or road) to coordinates (주소 → 좌표). */
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

/** Converts coordinates to an address (좌표 → 주소); either road or parcel may come back empty. */
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
