/**
 * Layer Swipe on the globe.
 *
 * The swipe control is a MapLibre control: it compares by clipping style layers
 * and mirroring deck.gl rasters onto a second map, none of which the globe has.
 * Cesium compares natively instead — one split position on the scene and a
 * direction per imagery layer or tileset — so the globe does not need any of
 * that machinery, only the answer to "which side is this layer on".
 *
 * The swipe plugin publishes that answer here and the Cesium sync reads it. The
 * two never import each other: the plugin owns a MapLibre control and the sync
 * owns a Cesium viewer, and neither belongs in the other's module graph.
 */

import type { GeoLibreLayer } from "@geolibre/core";

/** Which side of the swipe a layer belongs to, as the swipe control words it. */
export type CesiumSwipeSide = "left" | "right" | "both" | "none";

/** What the globe needs to reproduce a swipe. */
export interface CesiumSwipeState {
  /** Slider position, 0 (all right) to 1 (all left). */
  position: number;
  /** Side per store layer id. A layer that is absent is shown on both sides. */
  sides: ReadonlyMap<string, CesiumSwipeSide>;
}

let current: CesiumSwipeState | null = null;
const listeners = new Set<() => void>();

/**
 * Publishes the swipe, or clears it when the control goes away.
 *
 * @param state - The swipe to mirror onto the globe, or null for none.
 */
export function setCesiumSwipeState(state: CesiumSwipeState | null): void {
  current = state;
  for (const listener of [...listeners]) listener();
}

/** The swipe the globe should be showing, or null when there is none. */
export function getCesiumSwipeState(): CesiumSwipeState | null {
  return current;
}

/**
 * Runs `listener` whenever the swipe changes.
 *
 * @param listener - Called after every publish.
 * @returns Unsubscribes.
 */
export function subscribeCesiumSwipe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The side a layer is on, as Cesium's `SplitDirection` values.
 *
 * `both` and an unlisted layer are -1/0/1's "none": Cesium's NONE means "not
 * split", which is what draws a layer on both sides.
 *
 * @param layerId - The store layer's id.
 * @returns -1 for left, 1 for right, 0 for both sides.
 */
export function cesiumSplitDirectionFor(layerId: string): -1 | 0 | 1 {
  const side = current?.sides.get(layerId);
  if (side === "left") return -1;
  if (side === "right") return 1;
  return 0;
}

/**
 * Whether a swipe-panel row names this store layer.
 *
 * The panel lists two kinds of id: a store layer id, for the deck.gl rasters the
 * provider contributes, and a MapLibre style layer id for everything the control
 * reads out of the style itself. One store layer usually draws as several of the
 * latter (`<id>-fill`, `<id>-line`), so a prefix match catches them without the
 * plugin having to know each renderer's naming.
 *
 * @param layer - The store layer.
 * @param swipeId - An id from the swipe control's side lists.
 * @returns True when the row belongs to this layer.
 */
function swipeRowMatchesLayer(layer: GeoLibreLayer, swipeId: string): boolean {
  if (swipeId === layer.id) return true;
  const native = layer.metadata.nativeLayerIds;
  if (Array.isArray(native) && native.includes(swipeId)) return true;
  return swipeId.startsWith(`${layer.id}-`);
}

/**
 * Which side of the swipe each store layer is on.
 *
 * Exported for its own test: the mapping from the control's rows to store
 * layers is the whole of what the globe needs, and it cannot be checked through
 * a MapLibre control and a Cesium viewer.
 *
 * @param layers - The store's layers.
 * @param leftLayers - Swipe rows assigned left.
 * @param rightLayers - Swipe rows assigned right.
 * @returns Side per store layer id; a layer on neither list is left out.
 */
export function cesiumSwipeSides(
  layers: readonly GeoLibreLayer[],
  leftLayers: readonly string[],
  rightLayers: readonly string[],
): Map<string, CesiumSwipeSide> {
  const sides = new Map<string, CesiumSwipeSide>();
  const assign = (rows: readonly string[], side: CesiumSwipeSide) => {
    for (const row of rows) {
      for (const layer of layers) {
        if (swipeRowMatchesLayer(layer, row)) sides.set(layer.id, side);
      }
    }
  };
  assign(leftLayers, "left");
  // Right wins a layer listed on both, matching the control, which draws the
  // later assignment.
  assign(rightLayers, "right");
  return sides;
}
