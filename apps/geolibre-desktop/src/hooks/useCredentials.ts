import {
  registerVWorldProtocol,
  resolveVWorldProtocolUrl,
  setDataGoKrServiceKey,
  setKmaApiKey,
  setVWorldApiKey,
  setVWorldDomain,
} from "@geolibre/plugins";
import { setCesiumTileUrlResolver } from "@geolibre/map";
import { installKoreanApiTransports } from "../lib/kr-api-transport";
import { useEffect } from "react";
import { create } from "zustand";
import {
  createDefaultCredentialBackend,
  credentialErrorCode,
  type CredentialBackend,
  type CredentialBackendKind,
  type CredentialErrorCode,
  type CredentialId,
  type CredentialValues,
} from "../lib/credentials";

/**
 * In-memory holder for the device-local credentials described in
 * `lib/credentials.ts`.
 *
 * The values live here and nowhere else in the frontend: not in the project
 * store, not in the persisted desktop settings, not on `window`. Components read
 * `isConfigured(id)` to render state; only the app-private injection points
 * (see `useCredentialInjection`) read an actual value, and they write it
 * straight into the consumer that needs it.
 */
interface CredentialState {
  backend: CredentialBackendKind;
  /**
   * False until the first load resolves. The shell gates plugin startup on this
   * so a plugin cannot initialize against a key that has not arrived yet and
   * then sit inert once it does.
   */
  loaded: boolean;
  errorCode: CredentialErrorCode | null;
  values: CredentialValues;
  load: () => Promise<void>;
  setCredential: (id: CredentialId, value: string) => Promise<boolean>;
  deleteCredential: (id: CredentialId) => Promise<boolean>;
  clearCredentials: () => Promise<boolean>;
  isConfigured: (id: CredentialId) => boolean;
}

let backendPromise: Promise<CredentialBackend> | null = null;

function backend(): Promise<CredentialBackend> {
  backendPromise ??= createDefaultCredentialBackend();
  return backendPromise;
}

/**
 * Replaces the backend factory. Test-only seam: production code always goes
 * through {@link createDefaultCredentialBackend}.
 *
 * @param next - The backend to use, or null to restore the default.
 */
export function setCredentialBackendForTesting(next: CredentialBackend | null): void {
  backendPromise = next ? Promise.resolve(next) : null;
}

export const useCredentialStore = create<CredentialState>((set, get) => ({
  backend: "memory",
  loaded: false,
  errorCode: null,
  values: {},

  async load() {
    try {
      const store = await backend();
      const result = await store.load();
      set({
        backend: store.kind,
        loaded: true,
        values: result.values,
        errorCode: result.errorCode,
      });
    } catch (error) {
      // A backend that cannot be reached is not fatal: the app runs with no
      // credentials configured, and the UI shows the code.
      set({
        loaded: true,
        values: {},
        errorCode: credentialErrorCode(error, "credential_backend_unavailable"),
      });
    }
  },

  async setCredential(id, value) {
    const normalized = value.trim();
    // A blank draft means "leave the stored credential alone", never "delete".
    if (!normalized) return false;
    try {
      const store = await backend();
      await store.set(id, normalized);
      set((state) => ({
        values: { ...state.values, [id]: normalized },
        errorCode: null,
      }));
      return true;
    } catch (error) {
      set({ errorCode: credentialErrorCode(error, "credential_write_failed") });
      return false;
    }
  },

  async deleteCredential(id) {
    try {
      const store = await backend();
      await store.delete(id);
      set((state) => {
        const values = { ...state.values };
        delete values[id];
        return { values, errorCode: null };
      });
      return true;
    } catch (error) {
      set({ errorCode: credentialErrorCode(error, "credential_delete_failed") });
      return false;
    }
  },

  async clearCredentials() {
    try {
      const store = await backend();
      await store.clear();
      set({ values: {}, errorCode: null });
      return true;
    } catch (error) {
      // A partial sweep may still have removed some entries, so re-read rather
      // than assuming the previous values are all intact.
      set({ errorCode: credentialErrorCode(error, "credential_delete_failed") });
      await get().load();
      return false;
    }
  },

  isConfigured(id) {
    return Boolean(get().values[id]?.trim());
  },
}));

/**
 * Loads the device credentials once at startup and keeps the consumers that
 * need an actual value supplied.
 *
 * This is the app-private injection point the credential architecture calls
 * for: the value goes straight from the store into the consumer's write-only
 * setter. It is never placed on `window.__GEOLIBRE_RUNTIME_ENV__`, which
 * external plugins can read, and no getter is exposed alongside the setter.
 *
 * Clearing matters as much as setting: when the user deletes a credential the
 * empty string is pushed too, so a consumer holding the old value drops it
 * immediately rather than at the next restart.
 *
 * @returns True once the load has resolved (successfully or not).
 */
export function useCredentials(): boolean {
  const loaded = useCredentialStore((s) => s.loaded);
  const load = useCredentialStore((s) => s.load);
  const vworldApiKey = useCredentialStore((s) => s.values["vworld:api-key"] ?? "");
  const dataGoKrKey = useCredentialStore((s) => s.values["data-go-kr:service-key"] ?? "");

  useEffect(() => {
    void load();
    // VWorld layers are added from the plugin's toolbar menu and restored from
    // saved projects, so the protocol that injects the key must be live from
    // startup — not only while the VWorld panel is open. The transport has to
    // be installed first: the protocol handler uses it for every tile request.
    installKoreanApiTransports();
    registerVWorldProtocol();
    // The globe has no protocol registry of its own, so it is given the same
    // resolver the MapLibre protocol uses. Without it a VWorld basemap or
    // thematic layer draws on the 2D map and shows nothing on the Cesium pane.
    setCesiumTileUrlResolver(resolveVWorldProtocolUrl);
  }, [load]);

  useEffect(() => {
    setVWorldApiKey(vworldApiKey);
    // VWorld's WFS endpoint refuses a request that names no registered
    // domain, with INCORRECT_KEY — which reads as a bad key rather than a
    // missing parameter. A browser could pass its own Referer, but these
    // requests go through native HTTP or a proxy and carry none, so the
    // app's origin is sent explicitly. It matches what a user registers for
    // a browser build; a desktop build needs a key issued without a domain
    // restriction (VWorld's "기타" service type).
    if (typeof window !== "undefined") setVWorldDomain(window.location.origin);
  }, [vworldApiKey]);

  useEffect(() => {
    // One portal account, one key: every data.go.kr service the app talks to
    // (weather, air quality) reads from the same credential.
    setKmaApiKey(dataGoKrKey);
    setDataGoKrServiceKey(dataGoKrKey);
  }, [dataGoKrKey]);

  return loaded;
}
