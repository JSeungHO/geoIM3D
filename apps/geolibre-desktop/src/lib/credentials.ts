/**
 * Device-local credential storage for API keys the app manages on the user's
 * behalf.
 *
 * Ported from the geoIM3D credential architecture. Two rules shape everything
 * here:
 *
 * 1. **A credential never leaves the device.** It is not written to the project
 *    file, `localStorage`, `sessionStorage`, IndexedDB, a URL, or the public
 *    `window.__GEOLIBRE_RUNTIME_ENV__` map that plugins can read. The desktop
 *    build keeps it in the OS credential manager; the web build keeps it in
 *    module memory only, so a reload discards it.
 * 2. **A stored value is never read back out to the UI.** Callers can ask
 *    whether an id is configured, not what it holds — no value, length, prefix,
 *    or fingerprint. Settings inputs are write-only replacement drafts.
 *
 * The id allowlist is fixed and mirrored in `src-tauri/src/credential_store.rs`;
 * `tests/credentials.test.ts` asserts the two stay in sync so a new id cannot be
 * added on one side only.
 */

import { isTauri } from "./is-tauri";

// ponytail: only the credentials the app manages today. Adding one is a
// two-line change — here and ALLOWED_CREDENTIAL_IDS in credential_store.rs.
export const CREDENTIAL_IDS = ["vworld:api-key", "data-go-kr:service-key"] as const;

export type CredentialId = (typeof CREDENTIAL_IDS)[number];
export type CredentialValues = Partial<Record<CredentialId, string>>;
export type CredentialBackendKind = "memory" | "os";

/**
 * Failure codes surfaced to the UI. Deliberately coarse and value-free: an
 * error message must never carry the credential or a fragment of it.
 */
export type CredentialErrorCode =
  | "credential_backend_unavailable"
  | "credential_invalid_id"
  | "credential_invalid_value"
  | "credential_read_failed"
  | "credential_write_failed"
  | "credential_delete_failed";

const CREDENTIAL_ID_SET = new Set<string>(CREDENTIAL_IDS);

export function isCredentialId(value: string): value is CredentialId {
  return CREDENTIAL_ID_SET.has(value);
}

/** A load that succeeded in part: the values read, plus a code if any entry failed. */
export interface CredentialLoadResult {
  values: CredentialValues;
  errorCode: CredentialErrorCode | null;
}

export interface CredentialBackend {
  readonly kind: CredentialBackendKind;
  load(): Promise<CredentialLoadResult>;
  set(id: CredentialId, value: string): Promise<void>;
  delete(id: CredentialId): Promise<void>;
  clear(): Promise<void>;
}

export interface CredentialInvoke {
  <T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

export interface CredentialBackendOptions {
  /** True for the desktop shell, where the OS credential manager is reachable. */
  desktop: boolean;
  invoke: CredentialInvoke;
}

function normalizeCredentialValues(value: unknown): CredentialValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: CredentialValues = {};
  for (const [id, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (!isCredentialId(id) || typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized) result[id] = normalized;
  }
  return result;
}

/**
 * Accepts both the `{ values, errorCode }` shape the Rust command returns and a
 * bare value map, so a backend that only has values to report stays valid.
 */
function normalizeCredentialLoadResult(value: unknown): CredentialLoadResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("values" in record) {
      return {
        values: normalizeCredentialValues(record.values),
        errorCode: record.errorCode === "credential_read_failed" ? "credential_read_failed" : null,
      };
    }
  }
  return { values: normalizeCredentialValues(value), errorCode: null };
}

/**
 * Builds the backend for the current shell: the OS credential manager on the
 * desktop, module memory in the browser.
 *
 * @param options - Shell kind and the Tauri invoke function (injectable for testing).
 * @returns The credential backend.
 */
export function createCredentialBackend(options: CredentialBackendOptions): CredentialBackend {
  if (!options.desktop) {
    // Web/PWA: memory only, so a reload or a closed tab discards the value.
    let values: CredentialValues = {};
    return {
      kind: "memory",
      async load() {
        return { values: { ...values }, errorCode: null };
      },
      async set(id, value) {
        const normalized = value.trim();
        // An empty write is rejected, not treated as a delete: deletion is an
        // explicit user action, and a blank Settings draft means "unchanged".
        if (!normalized) throw new Error("credential_invalid_value");
        values = { ...values, [id]: normalized };
      },
      async delete(id) {
        const next = { ...values };
        delete next[id];
        values = next;
      },
      async clear() {
        values = {};
      },
    };
  }

  return {
    kind: "os",
    async load() {
      return normalizeCredentialLoadResult(await options.invoke<unknown>("credential_load"));
    },
    async set(id, value) {
      const normalized = value.trim();
      if (!normalized) throw new Error("credential_invalid_value");
      await options.invoke<void>("credential_set", { credentialId: id, value: normalized });
    },
    async delete(id) {
      await options.invoke<void>("credential_delete", { credentialId: id });
    },
    async clear() {
      await options.invoke<void>("credential_clear");
    },
  };
}

/**
 * The default backend for the running shell. Imported lazily by the store so a
 * unit test can build its own backend with an injected invoke instead.
 *
 * @returns The credential backend for this shell.
 */
export async function createDefaultCredentialBackend(): Promise<CredentialBackend> {
  const desktop = isTauri();
  if (!desktop) {
    return createCredentialBackend({
      desktop: false,
      invoke: () => Promise.reject(new Error("credential_backend_unavailable")),
    });
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return createCredentialBackend({
    desktop: true,
    invoke: (command, args) => invoke(command, args),
  });
}

/**
 * Maps a thrown backend error to a non-sensitive code. Anything unrecognized
 * collapses to the supplied fallback rather than surfacing the raw message,
 * which could otherwise echo an argument back into the UI.
 *
 * @param error - The thrown value.
 * @param fallback - The code to use when the error is not a known one.
 * @returns The credential error code.
 */
export function credentialErrorCode(
  error: unknown,
  fallback: CredentialErrorCode,
): CredentialErrorCode {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const known: CredentialErrorCode[] = [
    "credential_backend_unavailable",
    "credential_invalid_id",
    "credential_invalid_value",
    "credential_read_failed",
    "credential_write_failed",
    "credential_delete_failed",
  ];
  return known.find((code) => code === message) ?? fallback;
}

export interface CredentialDiagnosticReport {
  backend: CredentialBackendKind;
  loaded: boolean;
  /** Which ids are set — never the values themselves. */
  configuredIds: CredentialId[];
  errorCode: CredentialErrorCode | null;
}

/**
 * Builds the diagnostics view of the credential state. Reports which ids are
 * configured, never a value or anything derived from one, so a diagnostics
 * export stays safe to attach to a bug report.
 *
 * @param input - Backend kind, load state, values, and the last error code.
 * @returns The redacted diagnostic report.
 */
export function credentialDiagnostics(input: {
  backend: CredentialBackendKind;
  loaded: boolean;
  values: CredentialValues;
  errorCode: CredentialErrorCode | null;
}): CredentialDiagnosticReport {
  return {
    backend: input.backend,
    loaded: input.loaded,
    configuredIds: (Object.keys(input.values).filter(isCredentialId) as CredentialId[]).sort(),
    errorCode: input.errorCode,
  };
}
