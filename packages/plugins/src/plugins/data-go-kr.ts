/**
 * Shared plumbing for the Korean public-data portal (data.go.kr).
 *
 * The portal issues **one service key per account** and grants access to each
 * API separately, so every service the app talks to — weather, air quality,
 * building registers — shares a single credential and a single set of failure
 * modes. This module owns all of it; the per-service modules own only their
 * endpoints and DTOs.
 *
 * Three portal behaviours shaped this file, each found by testing the live
 * gateway rather than reading a document:
 *
 * - **A browser cannot call these services at all.** The identical request
 *   returns 200 with data when no `Origin` header is present and **403** when
 *   one is. See {@link setDataGoKrTransport}.
 * - **An unregistered key is answered with 403**, not 401, with
 *   `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` in the body.
 * - **Authentication faults come back as XML** even when JSON was requested, so
 *   a parse failure is usually a key problem rather than a malformed success.
 */

/** Failure categories the UI distinguishes. */
export type DataGoKrErrorKind =
  | "no-key"
  | "network"
  | "timeout"
  | "invalid-key"
  /**
   * The key is recognized but not approved for this API. Distinct from
   * `invalid-key` because the fix differs: apply for the specific service
   * rather than replace the key.
   */
  | "access-denied"
  | "rate-limit"
  | "invalid-request"
  | "no-data"
  | "server"
  | "unknown";

/** A portal failure. The message is a fixed code — never a key or a request URL. */
export class DataGoKrError extends Error {
  readonly kind: DataGoKrErrorKind;

  constructor(kind: DataGoKrErrorKind) {
    super(kind);
    this.name = "DataGoKrError";
    this.kind = kind;
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

let serviceKey = "";
const keyListeners = new Set<() => void>();

/**
 * Normalizes a service key to its decoded form.
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
 * Injects the portal service key. Write-only by design: the host reads it from
 * its credential store and pushes it here, and nothing reads it back out.
 *
 * @param key - The service key, or an empty string to clear it.
 */
export function setDataGoKrServiceKey(key: string): void {
  const next = normalizeServiceKey(typeof key === "string" ? key : "");
  // Only notify on a real change: the host re-pushes on every credential-store
  // update, and rebuilding a menu on each one would close an open submenu.
  if (next === serviceKey) return;
  serviceKey = next;
  for (const listener of keyListeners) listener();
}

/**
 * Whether a service key is configured.
 *
 * @returns True when requests can be attempted.
 */
export function hasDataGoKrServiceKey(): boolean {
  return serviceKey.length > 0;
}

/**
 * Subscribes to key changes, so a plugin menu can rebuild its disabled state.
 *
 * @param listener - Called after the key changes. Receives no value.
 * @returns An unsubscribe function.
 */
export function onDataGoKrServiceKeyChange(listener: () => void): () => void {
  keyListeners.add(listener);
  return () => keyListeners.delete(listener);
}

/** The minimal response shape this module needs. */
export interface DataGoKrResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type DataGoKrTransport = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<DataGoKrResponse>;

/**
 * How requests leave the app. Defaults to the browser's `fetch`.
 *
 * The portal answers **403 to any request carrying an `Origin` header** — the
 * identical request without one returns data. A browser always sends `Origin`
 * cross-origin, so these services are unreachable from a web page no matter how
 * valid the key is. The host swaps in a transport that is not a browser request:
 * a native HTTP call on the desktop, a same-origin proxy in the dev server.
 */
let transport: DataGoKrTransport = (url, init) => fetch(url, init);

/**
 * Replaces the request transport.
 *
 * @param next - The transport to use, or null to restore the browser default.
 */
export function setDataGoKrTransport(next: DataGoKrTransport | null): void {
  transport = next ?? ((url, init) => fetch(url, init));
}

/**
 * Maps a portal `resultCode` to a {@link DataGoKrErrorKind}.
 *
 * The portal shares one result-code table across every agency's services. The
 * distinctions that matter: a key never registered or expired (`30`/`31`) needs
 * a new key; `20` means the key is fine but this service was never requested for
 * it; an unregistered caller IP (`32`) needs a portal settings change; the daily
 * quota (`22`) just needs waiting; and `03` (NODATA) is an empty result, not a
 * fault.
 *
 * @param code - The `resultCode` from the response header.
 * @returns The matching error kind.
 */
export function resultCodeKind(code: string): DataGoKrErrorKind {
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
 * Maps a gateway fault to a {@link DataGoKrErrorKind}.
 *
 * The portal's gateway answers before the service does, with an envelope of its
 * own (`OpenAPI_ServiceResponse.cmmMsgHeader`) rather than the usual
 * `response.header`. It carries the actual reason, and reading it is the only
 * way to tell "this key does not exist" from "this key exists but this API was
 * never approved for it" — both of which arrive as a bare 403.
 *
 * `30` is reported for either, so it maps to `access-denied`: the app checks a
 * key when it is entered, so by the time one specific service refuses it, an
 * unapproved or not-yet-propagated 활용신청 is the likelier of the two. The
 * message names both.
 *
 * @param text - The raw response body.
 * @returns The matching kind, or null when this is not a gateway fault.
 */
export function gatewayErrorKind(text: string): DataGoKrErrorKind | null {
  const code = /<?returnReasonCode>?"?\s*[:>]\s*"?(\d+)/.exec(text)?.[1];
  if (!code) return null;
  switch (code) {
    case "30": // SERVICE_KEY_IS_NOT_REGISTERED
    case "20": // SERVICE_ACCESS_DENIED
      return "access-denied";
    case "31": // DEADLINE_HAS_EXPIRED
    case "32": // UNREGISTERED_IP
      return "invalid-key";
    case "22": // LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS
      return "rate-limit";
    case "12": // NO_OPENAPI_SERVICE — a path this client got wrong, not the user.
    case "10":
      return "invalid-request";
    default:
      return null;
  }
}

/**
 * Maps a transport-level HTTP status to a {@link DataGoKrErrorKind}.
 *
 * Verified against the live gateway: an unregistered key is answered with 403
 * and `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` (returnReasonCode 30), not the 401
 * the status alone would suggest.
 *
 * @param status - The HTTP status code.
 * @returns The matching error kind.
 */
export function httpErrorKind(status: number): DataGoKrErrorKind {
  if (status === 401 || status === 403) return "invalid-key";
  if (status === 429) return "rate-limit";
  return status >= 500 ? "server" : "network";
}

/** Which query parameter a service uses to ask for JSON. */
export type FormatParam = "dataType" | "returnType";

/**
 * Runs a portal JSON request and classifies every failure mode.
 *
 * @param path - Path under the portal origin, e.g. `/1360000/…/getVilageFcst`.
 * @param params - Query parameters, excluding the key and the format.
 * @param formatParam - The service's JSON switch: the weather services call it
 *   `dataType`, AirKorea calls it `returnType`. Sending the wrong one yields XML.
 * @returns The response `body` object.
 * @throws {DataGoKrError} On any failure, including an empty result (`no-data`).
 */
export async function requestDataGoKrJson(
  path: string,
  params: Record<string, string>,
  formatParam: FormatParam = "dataType"
): Promise<Record<string, unknown>> {
  if (!hasDataGoKrServiceKey()) throw new DataGoKrError("no-key");

  const url = new URL(path, "https://apis.data.go.kr");
  for (const [name, value] of Object.entries(params)) {
    if (value !== "") url.searchParams.set(name, value);
  }
  url.searchParams.set(formatParam, "JSON");
  url.searchParams.set("serviceKey", serviceKey);

  let text: string;
  try {
    const response = await transport(url.href, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
    // Read before classifying: the gateway states the reason in the body, and
    // throwing on the status alone discarded it — every rejection became
    // "check the key" even when the real answer was that this one API had not
    // been approved for an otherwise working key.
    if (!response.ok) {
      throw new DataGoKrError(
        gatewayErrorKind(text) ?? httpErrorKind(response.status)
      );
    }
  } catch (error) {
    if (error instanceof DataGoKrError) throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new DataGoKrError("timeout");
    }
    throw new DataGoKrError("network");
  }

  // The portal answers an authentication failure with an XML or plain-text
  // fault even when JSON was requested, so a parse failure here is a rejected
  // key far more often than it is a malformed success.
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new DataGoKrError(
      gatewayErrorKind(text) ??
        (/SERVICE.?KEY|UNREGISTERED|DENIED/i.test(text)
          ? "invalid-key"
          : "unknown")
    );
  }

  const response = (payload as { response?: unknown })?.response;
  if (!response || typeof response !== "object") {
    throw new DataGoKrError(gatewayErrorKind(text) ?? "unknown");
  }
  const header = (response as { header?: Record<string, unknown> }).header;
  const resultCode =
    typeof header?.resultCode === "string" ? header.resultCode : "";
  if (resultCode !== "00") throw new DataGoKrError(resultCodeKind(resultCode));

  const body = (response as { body?: unknown }).body;
  if (!body || typeof body !== "object") throw new DataGoKrError("no-data");
  return body as Record<string, unknown>;
}

/**
 * Reads the `items` array out of a portal response body.
 *
 * The portal collapses a single-element list into a bare object, and some
 * services nest under `items.item` while others put the array directly on
 * `items`. Both shapes are normalized here so a caller that assumed one would
 * not silently drop every result.
 *
 * @param body - The response body.
 * @returns The items, always as an array.
 */
export function itemsOf(
  body: Record<string, unknown>
): Array<Record<string, unknown>> {
  const container = body.items;
  const raw =
    container && typeof container === "object" && !Array.isArray(container)
      ? (container as { item?: unknown }).item
      : container;
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (raw && typeof raw === "object") return [raw as Record<string, unknown>];
  return [];
}

/**
 * Parses a numeric field, treating the portal's placeholders as absent.
 *
 * Air-quality readings use `-` for a station that is offline and `"-999"` for a
 * missing value; a bare `Number.parseFloat` turns the first into NaN and the
 * second into a plausible-looking measurement.
 *
 * @param value - The raw field.
 * @returns The number, or null when it is absent or a placeholder.
 */
export function numericField(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "" || text === "-") return null;
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed)) return null;
  return Math.abs(parsed) >= 900 ? null : parsed;
}
