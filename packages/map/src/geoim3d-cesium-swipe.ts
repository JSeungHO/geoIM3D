/**
 * Layer Swipe on the globe: Cesium compares natively (one split position, a
 * side per layer), so the swipe plugin publishes the answer here and the
 * Cesium sync reads it — neither imports the other.
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

/** Publishes the swipe, or clears it when the control goes away. */
export function setCesiumSwipeState(state: CesiumSwipeState | null): void {
  current = state;
  for (const listener of [...listeners]) listener();
}

/** The swipe the globe should be showing, or null when there is none. */
export function getCesiumSwipeState(): CesiumSwipeState | null {
  return current;
}

/** Runs `listener` whenever the swipe changes; returns an unsubscribe. */
export function subscribeCesiumSwipe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The side a layer is on, as Cesium's `SplitDirection` values (-1/0/1). */
export function cesiumSplitDirectionFor(layerId: string): -1 | 0 | 1 {
  const side = current?.sides.get(layerId);
  if (side === "left") return -1;
  if (side === "right") return 1;
  return 0;
}

/**
 * Whether a swipe-panel row names this store layer — a store id, a mirrored
 * native layer id, or a `<id>-fill`/`<id>-line`-style prefix match.
 */
function swipeRowMatchesLayer(layer: GeoLibreLayer, swipeId: string): boolean {
  if (swipeId === layer.id) return true;
  const native = layer.metadata.nativeLayerIds;
  if (Array.isArray(native) && native.includes(swipeId)) return true;
  return swipeId.startsWith(`${layer.id}-`);
}

/** Which side of the swipe each store layer is on; a layer on neither list is left out. */
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
  // Right wins a layer listed on both, matching the control.
  assign(rightLayers, "right");
  return sides;
}
