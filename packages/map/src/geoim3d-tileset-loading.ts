/**
 * How much of a 3D Tiles layer is still on its way.
 *
 * A tileset streams: the layer appears in the list at once and the model
 * arrives over the following seconds, which reads as nothing happening. The
 * Cesium sync reports each tileset's outstanding work here and the panel that
 * opened it shows a progress bar, the same one a splat load already shows.
 *
 * A separate module for the same reason as the swipe bridge: the sync owns a
 * Cesium viewer and the panel is a plugin, and neither belongs in the other's
 * module graph.
 */

/** Outstanding work for one tileset, as Cesium counts it. */
export interface TilesetLoadProgress {
  /** Tile requests in flight. */
  pending: number;
  /** Tiles downloaded and still being turned into geometry. */
  processing: number;
}

const progress = new Map<string, TilesetLoadProgress>();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Records a tileset's outstanding work, or clears it when there is none.
 *
 * @param layerId - The store layer the tileset belongs to.
 * @param next - The counts, or null once the tileset is done or gone.
 */
export function setTilesetLoadProgress(layerId: string, next: TilesetLoadProgress | null): void {
  const previous = progress.get(layerId);
  if (!next || (next.pending === 0 && next.processing === 0)) {
    if (!previous) return;
    progress.delete(layerId);
    announce();
    return;
  }
  if (previous && previous.pending === next.pending && previous.processing === next.processing) {
    return;
  }
  progress.set(layerId, next);
  announce();
}

/**
 * What a layer still has outstanding.
 *
 * @param layerId - The store layer id.
 * @returns The counts, or null when it is not loading.
 */
export function getTilesetLoadProgress(layerId: string): TilesetLoadProgress | null {
  return progress.get(layerId) ?? null;
}

/** True while any tileset is still streaming. */
export function isAnyTilesetLoading(): boolean {
  return progress.size > 0;
}

/**
 * Runs `listener` whenever a tileset's outstanding work changes.
 *
 * @param listener - Called after every change.
 * @returns Unsubscribes.
 */
export function subscribeTilesetLoading(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
