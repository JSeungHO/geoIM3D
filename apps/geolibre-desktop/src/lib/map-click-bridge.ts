/**
 * One map-click subscription that works in either renderer.
 *
 * Plugins that ask the user to "click the map" — VWorld's feature inspection
 * and reverse geocoding, the KMA point forecast — used to attach to
 * `app.getMap()`, which is the MapLibre map. On the Cesium tab that map is
 * hidden and takes no pointer events, so those features silently did nothing on
 * the globe: the cursor changed, the click landed, and nothing happened.
 *
 * This routes a click from whichever renderer is showing to the same handler,
 * so a plugin never has to know which one that is.
 */

import type { Map as MapLibreMap } from "maplibre-gl";

/** A click position in EPSG:4326. */
export interface MapClickPosition {
  lng: number;
  lat: number;
}

export type MapClickHandler = (position: MapClickPosition) => void;

/**
 * Minimal shape of the Cesium viewer this module drives. Typed structurally so
 * the app never imports Cesium — it is a large, dynamically loaded dependency
 * that must stay out of the boot graph.
 */
interface CesiumViewerLike {
  scene: { globe: { ellipsoid: unknown }; pickPosition?: unknown };
  camera: { pickEllipsoid: (position: unknown, ellipsoid?: unknown) => unknown };
  screenSpaceEventHandler: {
    setInputAction: (action: (event: { position: unknown }) => void, type: number) => void;
    removeInputAction: (type: number) => void;
  };
  isDestroyed: () => boolean;
}

/** The Cesium namespace members needed to turn a screen point into lon/lat. */
interface CesiumNamespaceLike {
  ScreenSpaceEventType: { LEFT_CLICK: number };
  Cartographic: { fromCartesian: (cartesian: unknown) => { longitude: number; latitude: number } };
  Math: { toDegrees: (radians: number) => number };
}

const handlers = new Set<MapClickHandler>();

let cesiumViewer: CesiumViewerLike | null = null;
let cesiumNamespace: CesiumNamespaceLike | null = null;

/**
 * Registers the primary globe's viewer, or clears it on teardown.
 *
 * @param viewer - The Cesium viewer, or null.
 * @param namespace - The Cesium namespace the viewer was built with.
 */
export function setPrimaryCesiumViewer(viewer: unknown, namespace: unknown): void {
  detachCesium();
  cesiumViewer = (viewer as CesiumViewerLike | null) ?? null;
  cesiumNamespace = (namespace as CesiumNamespaceLike | null) ?? null;
  if (handlers.size > 0) attachCesium();
}

function attachCesium(): void {
  const viewer = cesiumViewer;
  const Cesium = cesiumNamespace;
  if (!viewer || !Cesium || viewer.isDestroyed()) return;
  viewer.screenSpaceEventHandler.setInputAction((event) => {
    // pickEllipsoid, not pickPosition: the latter needs depth testing against
    // terrain and returns undefined over the sky or with depth picking off,
    // which would drop clicks the user plainly made on the globe.
    const cartesian = viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    emit({
      lng: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    });
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function detachCesium(): void {
  const viewer = cesiumViewer;
  const Cesium = cesiumNamespace;
  if (!viewer || !Cesium || viewer.isDestroyed()) return;
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function emit(position: MapClickPosition): void {
  // Copied before iterating: a handler that unsubscribes itself while running
  // would otherwise mutate the set mid-iteration.
  for (const handler of [...handlers]) handler(position);
}

/**
 * Subscribes to clicks on whichever renderer is showing.
 *
 * @param handler - Called with the clicked coordinate.
 * @param getMapLibreMap - Resolves the live MapLibre map, if any.
 * @returns An unsubscribe function.
 */
export function subscribeMapClick(
  handler: MapClickHandler,
  getMapLibreMap: () => MapLibreMap | null,
): () => void {
  const first = handlers.size === 0;
  handlers.add(handler);

  const map = getMapLibreMap();
  const onMapLibreClick = (event: { lngLat: { lng: number; lat: number } }) =>
    handler({ lng: event.lngLat.lng, lat: event.lngLat.lat });
  map?.on("click", onMapLibreClick);

  // The globe handler is shared, so it is attached once for the first
  // subscriber and removed with the last.
  if (first) attachCesium();

  return () => {
    handlers.delete(handler);
    map?.off("click", onMapLibreClick);
    if (handlers.size === 0) detachCesium();
  };
}
