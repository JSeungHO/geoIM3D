/**
 * KMA (기상청, Korea Meteorological Administration) OpenAPI client.
 *
 * Talks to the public-data portal services under `apis.data.go.kr/1360000`,
 * which — unlike the KMA's own API Hub — send `Access-Control-Allow-Origin: *`
 * and so work in the browser build as well as the desktop shell.
 *
 * Mirrors the conventions of `vworld-api.ts`:
 *
 * - The service key is module-private, injected through {@link setKmaApiKey},
 *   with no getter. It is never placed on `window` or written into a layer.
 * - Errors are reduced to a {@link KmaErrorKind}; no message carries the key or
 *   the request URL.
 * - Coordinates are explicit about their CRS. The forecast services are indexed
 *   by the KMA's own 5 km Lambert grid, so the conversion lives here (see
 *   {@link latLonToGrid}) and callers pass plain WGS84.
 */

const KMA_ORIGIN = "https://apis.data.go.kr";
const REQUEST_TIMEOUT_MS = 15_000;

/** The CRS every coordinate crossing this module's boundary is expressed in. */
export const KMA_CRS = "EPSG:4326";

let apiKey = "";

/** The minimal response shape this module needs; see `VWorldResponse`. */
export interface KmaResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type KmaTransport = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<KmaResponse>;

/**
 * How requests leave the app. Defaults to the browser's `fetch`.
 *
 * The public-data portal does not merely omit CORS headers — it answers **403
 * to any request carrying an `Origin` header**. The identical request without
 * one returns 200 and data. A browser always sends `Origin` cross-origin, so
 * these services are unreachable from a web page no matter how valid the key
 * is; the host swaps in a transport that is not a browser request (a native
 * HTTP call on the desktop, a same-origin dev proxy in the browser).
 */
let transport: KmaTransport = (url, init) => fetch(url, init);

/**
 * Replaces the request transport.
 *
 * @param next - The transport to use, or null to restore the browser default.
 */
export function setKmaTransport(next: KmaTransport | null): void {
  transport = next ?? ((url, init) => fetch(url, init));
}

const keyListeners = new Set<() => void>();

/**
 * Subscribes to key changes, so the plugin menu can rebuild its disabled state
 * when a key is saved or deleted. See `onVWorldApiKeyChange` for the rationale.
 *
 * @param listener - Called after the key changes. Receives no value.
 * @returns An unsubscribe function.
 */
export function onKmaApiKeyChange(listener: () => void): () => void {
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
}

/**
 * Injects the data.go.kr service key. Write-only: the host reads it from the
 * credential store and pushes it here.
 *
 * @param key - The service key, or an empty string to clear it.
 */
export function setKmaApiKey(key: string): void {
  const next = normalizeServiceKey(typeof key === "string" ? key : "");
  if (next === apiKey) return;
  apiKey = next;
  for (const listener of keyListeners) listener();
}

/**
 * Normalizes a data.go.kr service key to its decoded form.
 *
 * The portal issues two spellings of the same key: a decoded one (base64, so
 * `+`, `/`, and `=` appear literally) and an "Encoding" one where those are
 * already percent-escaped. Users copy either. The request builder percent-encodes
 * whatever it is given, so an already-encoded key becomes double-encoded
 * (`%2F` → `%252F`) and the gateway never sees the real key.
 *
 * Decoding is safe to do unconditionally: a base64 key never contains `%`, so a
 * `%` is proof the value is the encoded spelling.
 *
 * @param key - The key as the user pasted it.
 * @returns The decoded key, trimmed.
 */
export function normalizeServiceKey(key: string): string {
  let value = key.trim();
  // A bounded loop rather than a single pass: a value pasted through two
  // encode steps needs two decodes, and the guard stops at a fixed point.
  for (let pass = 0; pass < 3 && value.includes("%"); pass += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Not valid percent-encoding (a stray `%` in an otherwise literal key):
      // leave it alone rather than mangling it.
      return value;
    }
    if (decoded === value) break;
    value = decoded;
  }
  return value;
}

/**
 * Whether a service key is configured.
 *
 * @returns True when requests can be attempted.
 */
export function hasKmaApiKey(): boolean {
  return apiKey.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type KmaErrorKind =
  | "no-key"
  | "network"
  | "timeout"
  | "invalid-key"
  /**
   * The key is recognized but not authorized for the requested service. The
   * portal licenses each OpenAPI separately, so a key approved for the forecast
   * service is still refused by the station-info service until that one is
   * requested too. Kept apart from `invalid-key` because the fix is different:
   * apply for the specific service rather than replace the key.
   */
  | "access-denied"
  | "rate-limit"
  | "invalid-request"
  | "no-data"
  | "server"
  | "unknown";

/** A KMA failure. The message is a fixed code — never a key or a request URL. */
export class KmaError extends Error {
  readonly kind: KmaErrorKind;

  constructor(kind: KmaErrorKind) {
    super(kind);
    this.name = "KmaError";
    this.kind = kind;
  }
}

/**
 * Maps a data.go.kr `resultCode` to a {@link KmaErrorKind}.
 *
 * The portal shares one result-code table across every agency's services. The
 * distinctions that matter to a user: a key that was never registered or has
 * expired (`30`/`31`) needs a new key; `20` means the key is fine but this
 * service was never requested for it; an unregistered caller IP (`32`) needs a
 * portal settings change; the daily quota (`22`) just needs waiting; and
 * `03` (NODATA) is an empty result, not a fault.
 *
 * @param code - The `resultCode` from the response header.
 * @returns The matching error kind.
 */
export function kmaErrorKind(code: string): KmaErrorKind {
  switch (code.trim()) {
    case "00":
      return "unknown"; // Success is not an error; callers check for "00" first.
    case "03":
      return "no-data";
    case "01":
    case "02":
      return "server";
    case "04":
    case "05":
      return "network";
    case "10":
    case "11":
    case "12":
      return "invalid-request";
    // SERVICE_ACCESS_DENIED: the key exists but is not licensed for this API.
    case "20":
      return "access-denied";
    case "21":
    case "30":
    case "31":
    case "32":
    case "33":
      return "invalid-key";
    case "22":
      return "rate-limit";
    default:
      return "unknown";
  }
}

/**
 * Maps a transport-level HTTP status to a {@link KmaErrorKind}.
 *
 * @param status - The HTTP status code.
 * @returns The matching error kind.
 */
export function httpErrorKind(status: number): KmaErrorKind {
  // Observed against the live gateway: an unregistered or unrecognized key is
  // answered with 403 and a body of `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`
  // (returnReasonCode 30) — not 401, which is what the status alone suggests.
  //
  // A browser rarely reaches this function for those statuses: the portal omits
  // CORS headers on its error responses, so `fetch` rejects before a status is
  // available and the failure surfaces as `network`. See the note on
  // `errorNetwork` in the plugin's labels.
  if (status === 401 || status === 403) return "invalid-key";
  if (status === 429) return "rate-limit";
  return status >= 500 ? "server" : "network";
}

/* -------------------------------------------------------------------------- */
/* Grid conversion                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The KMA forecast grid: a Lambert Conformal Conic projection covering the
 * Korean peninsula at 5 km resolution, 149 × 253 cells. These are the agency's
 * published projection constants, not a fitted approximation.
 */
const GRID = {
  earthRadiusKm: 6371.00877,
  spacingKm: 5.0,
  standardParallel1: 30.0,
  standardParallel2: 60.0,
  originLon: 126.0,
  originLat: 38.0,
  originX: 43,
  originY: 136,
  width: 149,
  height: 253,
} as const;

const DEG_TO_RAD = Math.PI / 180.0;

export interface KmaGridPoint {
  nx: number;
  ny: number;
}

/**
 * Converts WGS84 coordinates to the KMA forecast grid cell that contains them.
 *
 * The forecast services are addressed by grid cell, not by coordinate, so every
 * forecast call goes through here. Seoul City Hall (126.9780, 37.5665) must land
 * on nx 60 / ny 127 — the agency's own worked example, and what
 * `tests/kma-api.test.ts` pins.
 *
 * @param lon - Longitude in {@link KMA_CRS}.
 * @param lat - Latitude in {@link KMA_CRS}.
 * @returns The grid cell.
 * @throws {KmaError} When the coordinates are not finite.
 */
export function latLonToGrid(lon: number, lat: number): KmaGridPoint {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new KmaError("invalid-request");

  const re = GRID.earthRadiusKm / GRID.spacingKm;
  const slat1 = GRID.standardParallel1 * DEG_TO_RAD;
  const slat2 = GRID.standardParallel2 * DEG_TO_RAD;
  const olon = GRID.originLon * DEG_TO_RAD;
  const olat = GRID.originLat * DEG_TO_RAD;

  let sn =
    Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(Math.PI * 0.25 + slat1 * 0.5);
  sf = (Math.pow(sf, sn) * Math.cos(slat1)) / sn;
  let ro = Math.tan(Math.PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  let ra = Math.tan(Math.PI * 0.25 + lat * DEG_TO_RAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEG_TO_RAD - olon;
  // Keep the meridian difference in (-pi, pi] so a point on the far side of the
  // antimeridian does not wrap into a mirrored cell.
  if (theta > Math.PI) theta -= 2.0 * Math.PI;
  if (theta < -Math.PI) theta += 2.0 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + GRID.originX + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + GRID.originY + 0.5),
  };
}

/**
 * Whether a grid cell is inside the forecast domain. Outside it the services
 * return an empty result, so callers can refuse before spending a request.
 *
 * @param point - The grid cell.
 * @returns True when the cell is within the published 149 × 253 domain.
 */
export function isWithinKmaGrid(point: KmaGridPoint): boolean {
  return (
    point.nx >= 1 && point.nx <= GRID.width && point.ny >= 1 && point.ny <= GRID.height
  );
}

/* -------------------------------------------------------------------------- */
/* Request plumbing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Runs a data.go.kr JSON request and classifies every failure mode.
 *
 * @param path - Path under the portal origin, e.g. `/1360000/…/getVilageFcst`.
 * @param params - Query parameters, excluding the service key.
 * @returns The response `body` object.
 * @throws {KmaError} On any failure, including an empty result (`no-data`).
 */
async function requestJson(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  if (!hasKmaApiKey()) throw new KmaError("no-key");

  const url = new URL(path, KMA_ORIGIN);
  for (const [name, value] of Object.entries(params)) {
    if (value !== "") url.searchParams.set(name, value);
  }
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("serviceKey", apiKey);

  let text: string;
  try {
    const response = await transport(url.href, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // The portal's gateway answers before the service does, and its two auth
    // statuses mean different things: 401 is a key it does not recognize, 403 is
    // a key that is recognized but not licensed for this particular API. Folding
    // either into a generic transport failure hides the only actionable part.
    if (!response.ok) throw new KmaError(httpErrorKind(response.status));
    text = await response.text();
  } catch (error) {
    if (error instanceof KmaError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new KmaError("timeout");
    }
    throw new KmaError("network");
  }

  // The portal answers an authentication failure with an XML or plain-text
  // fault even when dataType=JSON was requested, so a parse failure here is a
  // rejected key far more often than it is a malformed success.
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new KmaError(/SERVICE.?KEY|UNREGISTERED|DENIED/i.test(text) ? "invalid-key" : "unknown");
  }

  const response = (payload as { response?: unknown })?.response;
  if (!response || typeof response !== "object") throw new KmaError("unknown");
  const header = (response as { header?: Record<string, unknown> }).header;
  const resultCode = typeof header?.resultCode === "string" ? header.resultCode : "";
  if (resultCode !== "00") throw new KmaError(kmaErrorKind(resultCode));

  const body = (response as { body?: unknown }).body;
  if (!body || typeof body !== "object") throw new KmaError("no-data");
  return body as Record<string, unknown>;
}

/**
 * Reads the `items.item` array out of a portal response body.
 *
 * The portal collapses a single-element list into a bare object, so a caller
 * that assumed an array would silently drop the only result.
 *
 * @param body - The response body.
 * @returns The items, always as an array.
 */
function itemsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const items = (body.items as { item?: unknown } | undefined)?.item;
  if (Array.isArray(items)) return items as Array<Record<string, unknown>>;
  if (items && typeof items === "object") return [items as Record<string, unknown>];
  return [];
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Formats a Date as the `YYYYMMDD` / `HHmm` pair the forecast services take,
 * in KST — the services' own time zone, which is not necessarily the user's.
 *
 * @param date - The moment to format.
 * @returns The base date and time strings.
 */
export function kmaBaseDateTime(date: Date): { baseDate: string; baseTime: string } {
  // KST is UTC+9 year-round (no DST), so a fixed offset is exact here.
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return {
    baseDate: `${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1, 2)}${pad(kst.getUTCDate(), 2)}`,
    baseTime: `${pad(kst.getUTCHours(), 2)}${pad(kst.getUTCMinutes(), 2)}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Forecast / current conditions                                                */
/* -------------------------------------------------------------------------- */

/** Sky condition codes (SKY) as published by the KMA. */
export const KMA_SKY_LABELS: Record<string, string> = {
  "1": "clear",
  "3": "partlyCloudy",
  "4": "cloudy",
};

/**
 * Precipitation-type codes (PTY). The 5-7 values only appear in the
 * ultra-short-term products; the village forecast stops at 4.
 */
export const KMA_PTY_LABELS: Record<string, string> = {
  "0": "none",
  "1": "rain",
  "2": "rainSnow",
  "3": "snow",
  "4": "shower",
  "5": "drizzle",
  "6": "drizzleSnow",
  "7": "snowFlurry",
};

/** One observed or forecast value, already resolved to a category and time. */
export interface KmaObservationValue {
  /** Category code, e.g. `T1H` (temperature) or `PTY` (precipitation type). */
  category: string;
  value: string;
  /** Forecast valid time as `YYYYMMDD` / `HHmm`; the observation time for a nowcast. */
  date: string;
  time: string;
}

export interface KmaPointConditions {
  lon: number;
  lat: number;
  crs: typeof KMA_CRS;
  grid: KmaGridPoint;
  /** Base (issue) time of the product, as reported in the request. */
  baseDate: string;
  baseTime: string;
  values: KmaObservationValue[];
}

/**
 * Chooses the most recent nowcast base time.
 *
 * Per the agency's guide (§2 예보 발표시각): the observation is generated on the
 * hour and served from **10 minutes past** it. Requesting the current hour any
 * earlier returns no data, so those requests fall back an hour.
 *
 * @param now - The current moment.
 * @returns The base date and time to request.
 */
export function ultraShortNowcastBase(now: Date): { baseDate: string; baseTime: string } {
  const { baseDate, baseTime } = kmaBaseDateTime(now);
  const hour = Number(baseTime.slice(0, 2));
  const minute = Number(baseTime.slice(2));
  if (minute >= NOWCAST_PUBLISH_MINUTE) {
    return { baseDate, baseTime: `${String(hour).padStart(2, "0")}00` };
  }
  // Step back one hour, crossing midnight into the previous KST day if needed.
  const previous = new Date(now.getTime() - 60 * 60 * 1000);
  const stepped = kmaBaseDateTime(previous);
  return { baseDate: stepped.baseDate, baseTime: `${stepped.baseTime.slice(0, 2)}00` };
}

/**
 * Fetches the current conditions (초단기실황) at a point.
 *
 * @param lon - Longitude in {@link KMA_CRS}.
 * @param lat - Latitude in {@link KMA_CRS}.
 * @param now - The current moment (injectable for testing).
 * @returns The observed values for the containing grid cell.
 * @throws {KmaError} On any failure, including a point outside the grid.
 */
export async function kmaCurrentConditions(
  lon: number,
  lat: number,
  now: Date = new Date(),
): Promise<KmaPointConditions> {
  const grid = latLonToGrid(lon, lat);
  if (!isWithinKmaGrid(grid)) throw new KmaError("no-data");
  const { baseDate, baseTime } = ultraShortNowcastBase(now);

  const body = await requestJson("/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst", {
    pageNo: "1",
    numOfRows: "100",
    base_date: baseDate,
    base_time: baseTime,
    nx: String(grid.nx),
    ny: String(grid.ny),
  });

  const values = itemsOf(body).map((item) => ({
    category: String(item.category ?? ""),
    value: String(item.obsrValue ?? ""),
    date: String(item.baseDate ?? baseDate),
    time: String(item.baseTime ?? baseTime),
  }));
  if (values.length === 0) throw new KmaError("no-data");
  return { lon, lat, crs: KMA_CRS, grid, baseDate, baseTime, values };
}

/**
 * Fetches the short-term village forecast (단기예보) at a point.
 *
 * The service publishes at 02/05/08/11/14/17/20/23 KST; requesting a base time
 * it did not publish returns no data, so the most recent published slot at or
 * before `now` is used.
 *
 * @param lon - Longitude in {@link KMA_CRS}.
 * @param lat - Latitude in {@link KMA_CRS}.
 * @param now - The current moment (injectable for testing).
 * @returns The forecast values for the containing grid cell.
 * @throws {KmaError} On any failure.
 */
export async function kmaVillageForecast(
  lon: number,
  lat: number,
  now: Date = new Date(),
): Promise<KmaPointConditions> {
  const grid = latLonToGrid(lon, lat);
  if (!isWithinKmaGrid(grid)) throw new KmaError("no-data");
  const { baseDate, baseTime } = villageForecastBase(now);

  const body = await requestJson("/1360000/VilageFcstInfoService_2.0/getVilageFcst", {
    pageNo: "1",
    // A full run is 600-900 rows; 1000 is the documented maximum per page.
    numOfRows: "1000",
    base_date: baseDate,
    base_time: baseTime,
    nx: String(grid.nx),
    ny: String(grid.ny),
  });

  const values = itemsOf(body).map((item) => ({
    category: String(item.category ?? ""),
    value: String(item.fcstValue ?? ""),
    date: String(item.fcstDate ?? ""),
    time: String(item.fcstTime ?? ""),
  }));
  if (values.length === 0) throw new KmaError("no-data");
  return { lon, lat, crs: KMA_CRS, grid, baseDate, baseTime, values };
}

/** The hours (KST) at which the village forecast is published (guide §2, 1일 8회). */
const VILLAGE_FORECAST_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];

/**
 * Minutes past the hour at which a run becomes fetchable. The guide gives the
 * same offset for both products: the nowcast is served from HH:10, and each
 * village-forecast run from HH:10 of its publication hour.
 */
const NOWCAST_PUBLISH_MINUTE = 10;
const VILLAGE_PUBLISH_MINUTE = 10;

/**
 * Sentinel bound for missing values. The guide states that readings at or beyond
 * ±900 mark "no data" — an ocean cell with no instrument, or an outage — rather
 * than a real measurement. Rendering one would show a temperature of -999 °C.
 */
const MISSING_VALUE_BOUND = 900;

/**
 * Whether a raw category value is the agency's missing-data sentinel.
 *
 * @param value - The raw `obsrValue`/`fcstValue`.
 * @returns True when the value means "no data".
 */
export function isMissingValue(value: string): boolean {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && Math.abs(parsed) >= MISSING_VALUE_BOUND;
}

/**
 * Categories worth showing, in display order.
 *
 * The services return more than a reader can use: `UUU`/`VVV` are the wind's
 * east-west and north-south components, which `VEC`/`WSD` already express as a
 * direction and a speed. Listing every code turns a forecast into a wall of
 * numbers, so the panel renders this subset and drops the rest.
 */
export const KMA_DISPLAY_CATEGORIES: readonly string[] = [
  "T1H", // 기온 (실황)
  "TMP", // 기온 (예보)
  "TMN", // 일 최저기온
  "TMX", // 일 최고기온
  "SKY", // 하늘상태
  "PTY", // 강수형태
  "POP", // 강수확률
  "RN1", // 1시간 강수량 (실황)
  "PCP", // 1시간 강수량 (예보)
  "SNO", // 신적설
  "REH", // 습도
  "WSD", // 풍속
  "VEC", // 풍향
  "WAV", // 파고
];

const DISPLAY_ORDER = new Map(KMA_DISPLAY_CATEGORIES.map((code, index) => [code, index]));

/**
 * Filters and orders values for display.
 *
 * @param values - Raw values from a nowcast or forecast.
 * @returns Only the categories worth showing, in {@link KMA_DISPLAY_CATEGORIES} order.
 */
export function displayableValues(values: readonly KmaObservationValue[]): KmaObservationValue[] {
  return values
    .filter((entry) => DISPLAY_ORDER.has(entry.category))
    .sort((a, b) => (DISPLAY_ORDER.get(a.category) ?? 0) - (DISPLAY_ORDER.get(b.category) ?? 0));
}

/** One forecast time step, with its categories collapsed into a single record. */
export interface KmaForecastSlot {
  /** `YYYYMMDD` of the forecast time. */
  date: string;
  /** `HHmm` of the forecast time. */
  time: string;
  values: Record<string, string>;
}

/**
 * Pivots a flat forecast into one entry per forecast time.
 *
 * The service returns a long flat list — every category repeated for every hour
 * — so rendering it in order produces the same labels again and again with no
 * indication of which hour each belongs to. A forecast is a time series and has
 * to be grouped by its valid time before it can be read at all.
 *
 * @param values - Raw forecast values.
 * @returns Slots in chronological order.
 */
export function groupForecastSlots(values: readonly KmaObservationValue[]): KmaForecastSlot[] {
  const slots = new Map<string, KmaForecastSlot>();
  for (const entry of values) {
    if (!entry.date || !entry.time) continue;
    const key = `${entry.date}${entry.time}`;
    let slot = slots.get(key);
    if (!slot) {
      slot = { date: entry.date, time: entry.time, values: {} };
      slots.set(key, slot);
    }
    slot.values[entry.category] = entry.value;
  }
  return [...slots.values()].sort((a, b) =>
    `${a.date}${a.time}`.localeCompare(`${b.date}${b.time}`),
  );
}

/**
 * Renders a wind bearing as an 8-point compass index.
 *
 * @param degrees - Bearing in degrees (`VEC`).
 * @returns Index 0-7 starting at north, or null when unusable.
 */
export function compassIndex(degrees: string): number | null {
  const value = Number.parseFloat(degrees);
  if (!Number.isFinite(value) || isMissingValue(degrees)) return null;
  return Math.round((((value % 360) + 360) % 360) / 45) % 8;
}

/**
 * Chooses the most recent published village-forecast base time. Each run
 * becomes available about 10 minutes past its hour, so a request inside that
 * window uses the previous run.
 *
 * @param now - The current moment.
 * @returns The base date and time to request.
 */
export function villageForecastBase(now: Date): { baseDate: string; baseTime: string } {
  const { baseDate, baseTime } = kmaBaseDateTime(now);
  const hour = Number(baseTime.slice(0, 2));
  const minute = Number(baseTime.slice(2));
  const available = VILLAGE_FORECAST_HOURS.filter(
    (slot) => slot < hour || (slot === hour && minute >= VILLAGE_PUBLISH_MINUTE),
  );
  if (available.length > 0) {
    const slot = available[available.length - 1];
    return { baseDate, baseTime: `${String(slot).padStart(2, "0")}00` };
  }
  // Before 02:10 KST the newest run is 23:00 of the previous day.
  const previous = kmaBaseDateTime(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return { baseDate: previous.baseDate, baseTime: "2300" };
}

/** Outcome of a key check. */
export type KmaKeyCheck =
  | { ok: true }
  | {
      ok: false;
      kind: KmaErrorKind;
      /**
       * Whether the agency's answer could actually be read. The portal omits
       * CORS headers on error responses, so in a browser a rejected key is
       * indistinguishable from an unreachable server — the UI has to say so
       * rather than assert a cause it does not have.
       */
      readable: boolean;
    };

/**
 * Checks the configured service key with one small live request.
 *
 * Uses the nowcast at Seoul (nx 60 / ny 127) with a single row: the cheapest
 * call that still exercises authentication end to end. A successful read is
 * proof the key works; a readable error carries the agency's own reason.
 *
 * @param now - The current moment (injectable for testing).
 * @returns Whether the key was accepted, and why not when it was not.
 */
export async function verifyKmaApiKey(now: Date = new Date()): Promise<KmaKeyCheck> {
  if (!hasKmaApiKey()) return { ok: false, kind: "no-key", readable: true };
  const { baseDate, baseTime } = ultraShortNowcastBase(now);
  try {
    await requestJson("/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst", {
      pageNo: "1",
      numOfRows: "1",
      base_date: baseDate,
      base_time: baseTime,
      nx: "60",
      ny: "127",
    });
    return { ok: true };
  } catch (error) {
    const kind = error instanceof KmaError ? error.kind : "unknown";
    // `no-data` means the request authenticated and the service answered; the
    // key is fine, this cell/time just has nothing. Treat it as a pass.
    if (kind === "no-data") return { ok: true };
    return { ok: false, kind, readable: kind !== "network" && kind !== "timeout" };
  }
}

/* -------------------------------------------------------------------------- */
/* Weather warnings and typhoons                                                */
/* -------------------------------------------------------------------------- */

export interface KmaWarning {
  /** Issue time as reported by the service (`YYYYMMDDHHmm`). */
  issuedAt: string;
  /** Free-text region list the warning applies to. */
  regions: string;
  /** Warning title/summary text. */
  title: string;
  /** Station that issued it. */
  stationId: string;
}

/**
 * Lists the currently published weather warnings (기상특보).
 *
 * @param options - Optional issue-time window as `YYYYMMDD` strings.
 * @returns The warnings, newest first as the service returns them.
 * @throws {KmaError} On any failure, including an empty list (`no-data`).
 */
export async function kmaWarnings(
  options: { fromDate?: string; toDate?: string } = {},
): Promise<KmaWarning[]> {
  const today = kmaBaseDateTime(new Date()).baseDate;
  const body = await requestJson("/1360000/WthrWrnInfoService/getWthrWrnList", {
    pageNo: "1",
    numOfRows: "100",
    fromTmFc: options.fromDate ?? today,
    toTmFc: options.toDate ?? today,
  });

  const warnings = itemsOf(body).map((item) => ({
    issuedAt: String(item.tmFc ?? ""),
    regions: String(item.t6 ?? item.other ?? ""),
    title: String(item.title ?? item.t7 ?? ""),
    stationId: String(item.stnId ?? ""),
  }));
  if (warnings.length === 0) throw new KmaError("no-data");
  return warnings;
}

/** One typhoon position or forecast position, in {@link KMA_CRS}. */
export interface KmaTyphoonPosition {
  name: string;
  /** Observation/forecast time as reported (`YYYYMMDDHHmm`). */
  time: string;
  lon: number;
  lat: number;
  crs: typeof KMA_CRS;
  /** Central pressure in hPa, when reported. */
  pressure: number | null;
  /** Maximum sustained wind in m/s, when reported. */
  windSpeed: number | null;
}

/**
 * Lists current typhoon positions (태풍정보).
 *
 * @param options - Optional time window as `YYYYMMDD` strings.
 * @returns The reported positions.
 * @throws {KmaError} On any failure, including no active typhoon (`no-data`).
 */
export async function kmaTyphoons(
  options: { fromDate?: string; toDate?: string } = {},
): Promise<KmaTyphoonPosition[]> {
  const today = kmaBaseDateTime(new Date()).baseDate;
  const body = await requestJson("/1360000/TyphoonInfoService/getTyphoonInfo", {
    pageNo: "1",
    numOfRows: "100",
    fromTmFc: options.fromDate ?? today,
    toTmFc: options.toDate ?? today,
  });

  const positions: KmaTyphoonPosition[] = [];
  for (const item of itemsOf(body)) {
    const lon = numeric(item.typLon);
    const lat = numeric(item.typLat);
    if (lon === null || lat === null) continue;
    positions.push({
      name: String(item.typName ?? item.typEn ?? ""),
      time: String(item.typTm ?? item.tmFc ?? ""),
      lon,
      lat,
      crs: KMA_CRS,
      pressure: numeric(item.typPs),
      windSpeed: numeric(item.typWs),
    });
  }
  if (positions.length === 0) throw new KmaError("no-data");
  return positions;
}

/* -------------------------------------------------------------------------- */
/* Observation stations                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A station network offered as a point layer. Operation names are the ones the
 * portal actually serves — each was confirmed against the live service, since
 * an unknown operation answers 404 while a real one answers 401 without a key.
 */
export interface KmaStationNetwork {
  id: string;
  labelKey: string;
  operation: string;
}

export const KMA_STATION_NETWORKS: readonly KmaStationNetwork[] = [
  // 방재기상관측(AWS) — ~500 automatic stations nationwide.
  { id: "aws", labelKey: "stationsAws", operation: "getAwsObsStn" },
  { id: "buoy", labelKey: "stationsBuoy", operation: "getBuoyObsStn" },
  { id: "wave-buoy", labelKey: "stationsWaveBuoy", operation: "getWhbuoyObsStn" },
  { id: "pm10", labelKey: "stationsPm10", operation: "getPm10ObsStn" },
];
// `getRadarObsStn` is a real operation but is deliberately not offered: a radar
// site is a tower location, and without the composite imagery (API Hub only,
// desktop-only) the layer is a handful of dots with nothing to read. Restore it
// alongside that imagery rather than on its own.

export interface KmaStation {
  id: string;
  name: string;
  lon: number;
  lat: number;
  crs: typeof KMA_CRS;
}

/**
 * Fetches every station in a network as points.
 *
 * @param networkId - The network id from {@link KMA_STATION_NETWORKS}.
 * @returns The stations that carry usable coordinates.
 * @throws {KmaError} On any failure, including an unknown network id.
 */
export async function kmaStations(networkId: string): Promise<KmaStation[]> {
  const network = KMA_STATION_NETWORKS.find((entry) => entry.id === networkId);
  if (!network) throw new KmaError("invalid-request");

  const body = await requestJson(`/1360000/WethrBasicInfoService/${network.operation}`, {
    pageNo: "1",
    // Comfortably above the largest network (AWS, ~500 stations) so the layer
    // is complete without paging.
    numOfRows: "1000",
  });

  const stations: KmaStation[] = [];
  for (const item of itemsOf(body)) {
    const lon = numeric(item.lon);
    const lat = numeric(item.lat);
    // A station with no usable position is dropped rather than placed at 0,0.
    if (lon === null || lat === null) continue;
    stations.push({
      id: String(item.stnId ?? ""),
      name: String(item.stnKo ?? item.stnEn ?? item.stnId ?? ""),
      lon,
      lat,
      crs: KMA_CRS,
    });
  }
  if (stations.length === 0) throw new KmaError("no-data");
  return stations;
}

/**
 * Converts stations to a GeoJSON FeatureCollection for the map store.
 *
 * @param stations - The stations to convert.
 * @returns A point FeatureCollection in {@link KMA_CRS}.
 */
export function kmaStationsToGeoJson(stations: readonly KmaStation[]): {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: { stationId: string; name: string };
  }>;
} {
  return {
    type: "FeatureCollection",
    features: stations.map((station) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [station.lon, station.lat] },
      properties: { stationId: station.id, name: station.name },
    })),
  };
}
