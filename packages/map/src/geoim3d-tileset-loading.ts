/**
 * How much of a streaming 3D Tiles layer is still on its way. The Cesium
 * sync reports it here; the panel that opened the layer shows a progress bar.
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

/** Records a tileset's outstanding work, or clears it when there is none. */
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

/** What a layer still has outstanding, or null when it is not loading. */
export function getTilesetLoadProgress(layerId: string): TilesetLoadProgress | null {
  return progress.get(layerId) ?? null;
}

/** True while any tileset is still streaming. */
export function isAnyTilesetLoading(): boolean {
  return progress.size > 0;
}

/** Runs `listener` whenever a tileset's outstanding work changes. */
export function subscribeTilesetLoading(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
