import { useAppStore } from "@geolibre/core";
import { getTilesetLoadProgress, subscribeTilesetLoading } from "@geolibre/map";
import {
  setLocalObjectPicker,
  setLocalObjectResolver,
  setObjectFetcher,
  setPrimaryViewBridge,
  setTilesetLoadingSource,
} from "@geolibre/plugins";
import { useEffect } from "react";
import { isTauri } from "../../lib/tauri-io";
import {
  fetchObjectAsBlobUrl,
  pickLocalObjects,
  resolveLocalObject,
} from "../../lib/object-source";

/**
 * geoIM3D: registers the 3D object plugin's host shells.
 *
 * The file picker registers everywhere — it falls back to a file input in the
 * browser — but the native fetcher only on the desktop: it exists to read
 * plain-http:// URLs the webview's CSP refuses, and a browser's mixed-content
 * rule is not ours to lift. Left unregistered, the panel says so instead of
 * failing at load time.
 */
export function useObjectPluginShells(): void {
  useEffect(() => {
    setLocalObjectPicker(pickLocalObjects);
    setLocalObjectResolver(resolveLocalObject);
    if (isTauri()) setObjectFetcher(fetchObjectAsBlobUrl);
    // A tileset streams after its layer is listed; the panel shows a bar while
    // it does. Wired here because the counts come from the Cesium sync and the
    // panel is a plugin, and neither imports the other.
    setTilesetLoadingSource({
      progressOf: getTilesetLoadProgress,
      subscribe: subscribeTilesetLoading,
    });
    // The objects are drawn by a MapLibre control, so they are invisible while
    // the globe tab is up. This lets the plugin withdraw its menu there rather
    // than offer actions whose result cannot be seen.
    setPrimaryViewBridge({
      isGlobeActive: () => useAppStore.getState().primaryRenderer === "cesium",
      subscribe: (listener) =>
        useAppStore.subscribe((state, prev) => {
          if (state.primaryRenderer !== prev.primaryRenderer) listener();
        }),
    });
    return () => {
      setLocalObjectPicker(null);
      setLocalObjectResolver(null);
      setObjectFetcher(null);
      setPrimaryViewBridge(null);
    };
  }, []);
}
