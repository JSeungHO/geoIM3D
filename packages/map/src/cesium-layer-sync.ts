import { resolveThreeDTilesRequestHeaders, type GeoLibreLayer } from "@geolibre/core";
import type { Cesium3DTileset, DataSource, ImageryLayer, Viewer } from "cesium";
import type { StyleSpecification } from "maplibre-gl";
import { readTilesetPlacement, tilesetPlacementMatrix } from "./geoim3d-tileset-placement";

// Reconciles the store's `GeoLibreLayer[]` onto a Cesium globe, mirroring what
// MapController.syncLayers does for MapLibre. M3 covers the layer kinds where
// Cesium is the natural renderer: GeoJSON (as a draped GeoJsonDataSource), XYZ /
// WMS / WMTS / raster tiles (as ImageryLayers), and 3D Tiles (as a
// Cesium3DTileset). Other kinds are skipped on the globe (they still render in
// the 2D panes); the exported `isCesiumSupportedLayerType` lets the UI flag them.
//
// The engine is injected (the `Cesium` namespace + a `Viewer`) so this module
// carries only type-only Cesium imports and never pulls the engine into the
// build graph itself.

type CesiumNs = typeof import("cesium");

/** Layer kinds this pass renders on the globe. */
const IMAGERY_TYPES = new Set(["raster", "xyz", "wms", "wmts"]);

type EntryKind = "imagery" | "geojson" | "3dtiles";

interface LayerEntry {
  kind: EntryKind;
  /** The layer as last applied, for change detection. */
  layer: GeoLibreLayer;
  /** The Cesium object, or null while an async create is in flight. */
  handle: ImageryLayer | DataSource | Cesium3DTileset | null;
  /** Set when the entry is removed mid-load so the resolved handle is discarded. */
  cancelled: boolean;
  /** Last opacity key applied in place (geojson entities, tileset style) — skips redundant restyles. */
  appliedAlpha?: string;
}

/**
 * Rewrites a tile URL the globe cannot fetch into one it can.
 *
 * MapLibre lets a host serve a custom scheme with `addProtocol`, and GeoLibre
 * uses that to keep an API key out of the URL a project file records. Cesium has
 * no such registry: it hands the URL straight to the browser, so a layer on a
 * custom scheme renders nothing on the globe and reports no error. A host that
 * registers a MapLibre protocol registers the matching resolver here, and the
 * same layer draws in both renderers.
 *
 * Synchronous by design: it stands in for building a request URL, not for making
 * the request.
 */
let tileUrlResolver: ((url: string) => string) | null = null;

/**
 * Installs the resolver, or clears it.
 *
 * @param resolve - Maps a URL to a fetchable one, returning it unchanged when
 *   the scheme is not its own. May throw; a throw leaves the URL as it was.
 */
export function setCesiumTileUrlResolver(resolve: ((url: string) => string) | null): void {
  tileUrlResolver = resolve;
}

/**
 * Applies the resolver, best-effort.
 *
 * @param url - The stored URL.
 * @returns The fetchable URL, or the original when nothing resolves it.
 */
function resolveTileUrl(url: string): string {
  try {
    return tileUrlResolver?.(url) ?? url;
  } catch {
    // A resolver throws when it cannot serve the URL — a missing API key, most
    // often. The unresolved URL then fails to load, which is the same outcome as
    // before and leaves the rest of the sync pass alone.
    return url;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function firstTile(layer: GeoLibreLayer): string | undefined {
  const tiles = layer.source.tiles;
  const first = Array.isArray(tiles) ? str(tiles[0]) : undefined;
  return first === undefined ? undefined : resolveTileUrl(first);
}

function tilesetUrl(layer: GeoLibreLayer): string | undefined {
  return str(layer.source.url) ?? str(layer.sourcePath);
}

/**
 * Whether the globe can render this layer *kind* at all (regardless of whether
 * its data has loaded yet). Exported so the UI can flag "2D only" layers on a
 * globe pane. See the module header for the supported kinds.
 */
export function isCesiumSupportedLayerType(layer: GeoLibreLayer): boolean {
  return layer.type === "geojson" || layer.type === "3d-tiles" || IMAGERY_TYPES.has(layer.type);
}

/** Whether this layer can render on the globe now (kind supported + data ready). */
function isSupported(layer: GeoLibreLayer): boolean {
  if (!isCesiumSupportedLayerType(layer)) return false;
  if (layer.type === "geojson") return Boolean(layer.geojson?.features?.length);
  if (layer.type === "3d-tiles") return Boolean(tilesetUrl(layer));
  // Mirror createImagery's real capability: WMS builds from source.url, but
  // xyz/raster/wmts need a tile template — a url alone would render nothing.
  return layer.type === "wms" ? Boolean(str(layer.source.url)) : Boolean(firstTile(layer));
}

function entryKind(layer: GeoLibreLayer): EntryKind {
  if (layer.type === "geojson") return "geojson";
  if (layer.type === "3d-tiles") return "3dtiles";
  return "imagery";
}

// Fill/stroke *colours*, stroke width, and marker colour bake into the GeoJSON
// entities at load, so a change to any of them forces a rebuild. Opacity
// (layer.opacity × fill opacity) is deliberately excluded: it is re-applied in
// place by applyGeoJsonStyle, so dragging the opacity slider restyles the fill
// alpha instead of reloading the whole GeoJsonDataSource on every tick.
function styleSignature(layer: GeoLibreLayer): string {
  const style = layer.style ?? {};
  return [
    style.fillColor,
    style.strokeColor,
    style.strokeWidth,
    style.markerColor,
    // Extrusion is part of the signature because `clampToGround` is a *load*
    // option: a polygon draped on terrain cannot be lifted off it by restyling,
    // so turning extrusion on (or changing what drives its height) has to
    // rebuild the data source.
    style.extrusionEnabled,
    style.extrusionHeightProperty,
    style.extrusionHeightScale,
    style.extrusionBase,
    style.extrusionColor,
  ].join("|");
}

/**
 * Reads a feature's extrusion height in metres.
 *
 * @param properties - The entity's Cesium property bag.
 * @param style - The layer style driving the extrusion.
 * @returns The height, or 0 when the feature carries no usable value.
 */
export function extrusionHeightOf(
  properties: { getValue?: (time?: unknown) => Record<string, unknown> } | undefined,
  style: { extrusionHeightProperty?: string; extrusionHeightScale?: number },
): number {
  const bag = properties?.getValue?.();
  const raw = bag?.[style.extrusionHeightProperty ?? "height"];
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value * (style.extrusionHeightScale ?? 1);
}

/**
 * Whether the Cesium object must be rebuilt (vs. just re-styled) for the change
 * from `prev` to `next`. Live-settable appearance (visibility, imagery alpha) is
 * excluded; only source/data/geometry changes force a rebuild. The GeoJSON
 * FeatureCollection is compared by reference (the store swaps it on edit) and
 * its fill/stroke colours bake into the Cesium colours at load, so a colour
 * change rebuilds; opacity is restyled in place (see styleSignature).
 */
function needsRebuild(prev: GeoLibreLayer, next: GeoLibreLayer): boolean {
  if (prev.type !== next.type) return true;
  switch (entryKind(next)) {
    case "geojson":
      return prev.geojson !== next.geojson || styleSignature(prev) !== styleSignature(next);
    case "imagery":
      return (
        firstTile(prev) !== firstTile(next) ||
        // min/maxzoom bake into UrlTemplateImageryProvider's min/maximumLevel.
        prev.source.maxzoom !== next.source.maxzoom ||
        prev.source.minzoom !== next.source.minzoom ||
        str(prev.source.url) !== str(next.source.url) ||
        str(prev.source.layers) !== str(next.source.layers) ||
        // WMS GetMap params baked into the provider at creation; a change must
        // rebuild it so the globe doesn't keep the stale WebMapServiceImageryProvider.
        str(prev.source.styles) !== str(next.source.styles) ||
        str(prev.source.format) !== str(next.source.format) ||
        str(prev.source.version) !== str(next.source.version) ||
        prev.source.transparent !== next.source.transparent
      );
    case "3dtiles":
      return (
        tilesetUrl(prev) !== tilesetUrl(next) ||
        JSON.stringify(prev.source.requestHeaders ?? null) !==
          JSON.stringify(next.source.requestHeaders ?? null) ||
        prev.source.altitudeOffset !== next.source.altitudeOffset
      );
  }
}

/**
 * Stands a loaded data source's polygons up on the globe.
 *
 * Cesium extrudes between `polygon.height` (the base) and
 * `polygon.extrudedHeight`, both in metres above the ellipsoid — so each entity
 * gets its own value read from the feature property the style names. Entities
 * with no usable height are left flat rather than given an arbitrary one; a
 * building drawn at a made-up height reads as data.
 *
 * Colour is left to `applyGeoJsonStyle`, which owns the polygon material and
 * runs immediately after this — setting it here would be overwritten.
 *
 * @param dataSource - The freshly loaded GeoJsonDataSource.
 * @param style - The layer style driving the extrusion.
 */
function applyExtrusion(
  dataSource: { entities: { values: Array<Record<string, any>> } },
  style: Record<string, any>,
): void {
  const base = Number.isFinite(style.extrusionBase) ? Number(style.extrusionBase) : 0;

  for (const entity of dataSource.entities.values) {
    const polygon = entity.polygon;
    if (!polygon) continue;
    const height = extrusionHeightOf(entity.properties, style);
    if (height <= 0) continue;
    polygon.height = base;
    polygon.extrudedHeight = base + height;
    // The footprint's own vertices sit at ground level; letting each one keep
    // its terrain height would shear the walls on a slope.
    polygon.perPositionHeight = false;
    // Cesium clamps a *draped* polygon to terrain and ignores height; an
    // extruded one must opt out or it snaps back down.
    polygon.classificationType = undefined;
  }
}

/**
 * The 3D Tiles style expression that fades a tileset, or undefined to leave it
 * unstyled.
 *
 * Fully opaque returns nothing on purpose: a style costs a shader variant per
 * tile, and `color('#ffffff', 1)` buys none of it back. Values outside 0..1 are
 * clamped rather than passed through, since the expression language has no
 * opinion about them and a negative alpha renders as garbage.
 *
 * @param opacity - The layer's opacity.
 * @returns The expression, or undefined when the tileset should not be styled.
 */
export function tilesetOpacityExpression(opacity: number): string | undefined {
  if (!Number.isFinite(opacity)) return undefined;
  const alpha = Math.min(Math.max(opacity, 0), 1);
  if (alpha >= 1) return undefined;
  return `color('#ffffff', ${alpha})`;
}

/** One raster source of a basemap style, as an imagery provider's inputs. */
interface BasemapTiles {
  url: string;
  minzoom?: number;
  maxzoom?: number;
  /** `[west, south, east, north]` in degrees, when the source declares coverage. */
  bounds?: [number, number, number, number];
}

/**
 * Reads a basemap style's raster sources in draw order.
 *
 * Walks `style.layers`, not `style.sources`: a style may declare a source it
 * never draws, and the order layers are drawn in is the order the globe has to
 * stack them (a satellite basemap's labels overlay must stay on top of its
 * imagery). An empty result means the style is not replayable as imagery.
 *
 * @param style - The basemap style.
 * @returns The tile templates to stack, bottom first.
 */
function readBounds(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry)))
    return undefined;
  const [west, south, east, north] = value as number[];
  // A degenerate box would ask Cesium for an empty rectangle, which draws
  // nothing at all — worse than the unbounded default.
  if (west >= east || south >= north) return undefined;
  return [west, south, east, north];
}

export function rasterBasemapTiles(style: StyleSpecification): BasemapTiles[] {
  const tiles: BasemapTiles[] = [];
  for (const layer of style.layers ?? []) {
    if (layer.type !== "raster" || !("source" in layer) || typeof layer.source !== "string") {
      continue;
    }
    const source = style.sources?.[layer.source];
    if (!source || source.type !== "raster") continue;
    const url = Array.isArray(source.tiles) ? str(source.tiles[0]) : undefined;
    if (!url) continue;
    const bounds = readBounds(source.bounds);
    tiles.push({
      url: resolveTileUrl(url),
      minzoom: typeof source.minzoom === "number" ? source.minzoom : undefined,
      maxzoom: typeof source.maxzoom === "number" ? source.maxzoom : undefined,
      // Spread rather than a plain `undefined`: a source with no coverage keeps
      // the shape it had before this field existed.
      ...(bounds ? { bounds } : {}),
    });
  }
  return tiles;
}

export class CesiumLayerSync {
  private readonly entries = new Map<string, LayerEntry>();
  /** Imagery id order last asserted on the globe, to skip redundant reorders. */
  private lastImageryOrder = "";
  /** The basemap style replayed as imagery, bottom-most and below every layer. */
  private basemapImagery: ImageryLayer[] = [];
  /** The basemap tiles last applied, so an unrelated store change rebuilds nothing. */
  private basemapSignature = "";

  constructor(
    private readonly Cesium: CesiumNs,
    private readonly viewer: Viewer,
  ) {}

  /** Reconcile the globe to `layers` (order preserved for imagery stacking). */
  sync(layers: GeoLibreLayer[]): void {
    const nextIds = new Set(layers.map((l) => l.id));
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this.destroyEntry(entry);
        this.entries.delete(id);
      }
    }

    // Tracks a create/rebuild of an imagery layer this pass (which re-appends it
    // to the top), so the reorder pass below runs even when the store id order
    // is unchanged.
    let imageryRebuilt = false;
    for (const layer of layers) {
      if (!isSupported(layer)) {
        // A previously-supported layer that became unrenderable (e.g. its data
        // was cleared) is torn down.
        const stale = this.entries.get(layer.id);
        if (stale) {
          this.destroyEntry(stale);
          this.entries.delete(layer.id);
        }
        continue;
      }

      const existing = this.entries.get(layer.id);
      if (!existing) {
        this.createEntry(layer);
        if (entryKind(layer) === "imagery") imageryRebuilt = true;
      } else if (needsRebuild(existing.layer, layer)) {
        this.destroyEntry(existing);
        this.entries.delete(layer.id);
        this.createEntry(layer);
        if (entryKind(layer) === "imagery") imageryRebuilt = true;
      } else {
        existing.layer = layer;
        this.applyAppearance(existing);
      }
    }

    // addImageryProvider always appends to the top, so a rebuild/create re-adds
    // imagery above its store neighbours, and a panel reorder (which doesn't
    // rebuild) changes the intended order without touching the globe. Re-assert
    // store order by raising each imagery layer to the top in turn (the base
    // imagery, never raised, stays at the bottom) — but only when the order
    // could actually have changed. sync() also runs on unrelated changes (e.g.
    // an opacity drag), and each raiseToTop is O(n), so reordering every time
    // would be a needless O(n²) on that hot path.
    const imageryOrder = layers
      .filter((l) => this.entries.get(l.id)?.kind === "imagery")
      .map((l) => l.id)
      .join("\n");
    if (imageryRebuilt || imageryOrder !== this.lastImageryOrder) {
      for (const layer of layers) {
        const entry = this.entries.get(layer.id);
        if (entry?.kind === "imagery" && entry.handle) {
          this.viewer.imageryLayers.raiseToTop(entry.handle as ImageryLayer);
        }
      }
      this.lastImageryOrder = imageryOrder;
    }
  }

  /**
   * Draws a raster basemap style as the globe's background imagery.
   *
   * The 2D map takes its background from a MapLibre style, which the globe
   * cannot read: picking a basemap moved the map and left the globe on Ion (or
   * OpenStreetMap) imagery, so the two panes showed different worlds. A raster
   * style is just tiles with an order, which is exactly what an imagery layer
   * is, so it is replayed onto the globe source by source.
   *
   * Only raster styles are replayed. A vector basemap has no tile images to
   * hand Cesium, and half-drawing one would be worse than leaving the default
   * imagery in place, so those fall back to it.
   *
   * The tiles sit directly above the viewer's own base imagery and below every
   * store layer, which is where a background belongs.
   *
   * @param style - The basemap style, or null to restore the default imagery.
   * @param options - The basemap's visibility and opacity, as the 2D map applies them.
   */
  syncBasemap(
    style: StyleSpecification | null,
    options: { visible: boolean; opacity: number },
  ): void {
    const tiles = style ? rasterBasemapTiles(style) : [];
    const signature = JSON.stringify(tiles);
    if (signature !== this.basemapSignature) {
      this.basemapSignature = signature;
      for (const imagery of this.basemapImagery) this.viewer.imageryLayers.remove(imagery, true);
      this.basemapImagery = [];
      // Index 1 and up: the viewer's own base imagery stays at 0 underneath, so
      // a basemap with transparent gaps (or bounds narrower than the globe) has
      // something behind it rather than black space.
      tiles.forEach((tile, index) => {
        try {
          const provider = new this.Cesium.UrlTemplateImageryProvider({
            url: tile.url,
            minimumLevel: tile.minzoom,
            maximumLevel: tile.maxzoom,
            // Without the source's own coverage a regional basemap is treated
            // as global: Cesium requests its `minimumLevel` across the whole
            // globe, the service errors on everything outside its area, and the
            // provider fails as a whole — the globe keeps its default imagery
            // and the basemap looks like it did not apply at all (VWorld:
            // minzoom 6, Korea only).
            rectangle: tile.bounds ? this.Cesium.Rectangle.fromDegrees(...tile.bounds) : undefined,
          });
          this.basemapImagery.push(
            this.viewer.imageryLayers.addImageryProvider(provider, index + 1),
          );
        } catch {
          // Mirror createImagery: a provider that throws must not abort the pass.
        }
      });
      // Inserting below them does not move the store layers, but a *removal*
      // shifts every index above it down; re-assert the stored order rather
      // than reason about which case happened.
      this.raiseStoreImagery();
    }
    for (const imagery of this.basemapImagery) {
      imagery.show = options.visible;
      imagery.alpha = options.opacity;
    }
  }

  /** Puts every store imagery layer back above the basemap, in store order. */
  private raiseStoreImagery(): void {
    for (const entry of this.entries.values()) {
      if (entry.kind === "imagery" && entry.handle) {
        this.viewer.imageryLayers.raiseToTop(entry.handle as ImageryLayer);
      }
    }
    // The pass above walks insertion order, not store order, so the next sync
    // must redo it properly.
    this.lastImageryOrder = "";
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.destroyEntry(entry);
    this.entries.clear();
    for (const imagery of this.basemapImagery) this.viewer.imageryLayers.remove(imagery, true);
    this.basemapImagery = [];
  }

  private createEntry(layer: GeoLibreLayer): void {
    const kind = entryKind(layer);
    const entry: LayerEntry = { kind, layer, handle: null, cancelled: false };
    this.entries.set(layer.id, entry);
    if (kind === "imagery") this.createImagery(entry);
    else if (kind === "geojson") void this.createGeoJson(entry);
    else void this.createTileset(entry);
  }

  private createImagery(entry: LayerEntry): void {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    try {
      let provider;
      if (layer.type === "wms" && str(layer.source.url)) {
        // Pass through the same GetMap params the 2D path records on the layer
        // (WmsSource.tsx), so a non-default style/format/version or an opaque
        // (transparent:false) overlay renders the same on the globe as on the map.
        provider = new Cesium.WebMapServiceImageryProvider({
          url: resolveTileUrl(String(layer.source.url)),
          layers: String(layer.source.layers ?? ""),
          parameters: {
            transparent: layer.source.transparent !== false,
            format: str(layer.source.format) ?? "image/png",
            styles: str(layer.source.styles) ?? "",
            version: str(layer.source.version) ?? "1.1.1",
          },
        });
      } else {
        const url = firstTile(layer);
        if (!url) return;
        const maxLevel = Number(layer.source.maxzoom);
        const minLevel = Number(layer.source.minzoom);
        provider = new Cesium.UrlTemplateImageryProvider({
          url,
          maximumLevel: Number.isFinite(maxLevel) ? maxLevel : undefined,
          // Honour the service's min-zoom floor so the globe doesn't request
          // (and 404 on) tiles below the levels the service actually serves.
          minimumLevel: Number.isFinite(minLevel) ? minLevel : undefined,
        });
      }
      // addImageryProvider appends above the base imagery (and earlier store
      // layers), so store order maps to Cesium's bottom-to-top stacking.
      const imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      entry.handle = imageryLayer;
      this.applyAppearance(entry);
    } catch {
      // A provider that throws synchronously (e.g. malformed WMS params) should
      // not abort the sync pass; mirror createGeoJson/createTileset's best-effort.
    }
  }

  private async createGeoJson(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    if (!layer.geojson) return;
    const style = layer.style ?? {};
    const fill = Cesium.Color.fromCssColorString(style.fillColor ?? "#3b82f6");
    const stroke = Cesium.Color.fromCssColorString(style.strokeColor ?? "#1e40af");
    // Fold the layer + fill opacity into the fill colour (a GeoJsonDataSource has
    // no global alpha). A later opacity change re-applies this alpha in place
    // (applyGeoJsonStyle) rather than reloading the whole data source.
    const fillAlpha = (style.fillOpacity ?? 0.6) * layer.opacity;
    try {
      // A draped polygon is painted onto the terrain and has no height of its
      // own, so extrusion requires loading it unclamped.
      const extruded = Boolean(style.extrusionEnabled);
      const dataSource = await Cesium.GeoJsonDataSource.load(layer.geojson, {
        stroke,
        strokeWidth: style.strokeWidth ?? 2,
        fill: fill.withAlpha(fillAlpha),
        markerColor: Cesium.Color.fromCssColorString(style.markerColor ?? "#3b82f6"),
        clampToGround: !extruded,
      });
      if (entry.cancelled) return;
      await viewer.dataSources.add(dataSource);
      if (entry.cancelled) {
        viewer.dataSources.remove(dataSource, true);
        return;
      }
      entry.handle = dataSource;
      if (extruded) applyExtrusion(dataSource, style);
      // applyAppearance → applyGeoJsonStyle fades every entity kind (fill,
      // stroke, marker) by the layer opacity right after load, so points/lines
      // match the 2D map instead of rendering fully opaque.
      this.applyAppearance(entry);
    } catch {
      // A malformed FeatureCollection should not break the whole sync.
    }
  }

  private async createTileset(entry: LayerEntry): Promise<void> {
    const { Cesium, viewer } = this;
    const layer = entry.layer;
    const url = tilesetUrl(layer);
    if (!url) return;
    // Google Photorealistic tiles strip their X-GOOG-API-KEY from the store, so
    // resolve it back (from runtime env) exactly as the 2D render path does —
    // otherwise the tileset would silently 401/403 and never render on the globe.
    const headers = resolveThreeDTilesRequestHeaders(
      url,
      layer.source.requestHeaders as Record<string, string> | undefined,
    );
    const resource =
      headers && Object.keys(headers).length ? new Cesium.Resource({ url, headers }) : url;
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {});
      if (entry.cancelled) {
        tileset.destroy();
        return;
      }
      viewer.scene.primitives.add(tileset);
      entry.handle = tileset;
      if (!this.applyTilesetPlacement(entry)) {
        this.applyTilesetAltitude(tileset, Number(layer.source.altitudeOffset));
      }
      this.applyAppearance(entry);
    } catch {
      // A tileset that fails to load should not break the whole sync.
    }
  }

  /** Raise/lower a tileset by an altitude offset (metres) at its centre. */
  private applyTilesetAltitude(tileset: Cesium3DTileset, offset: number): void {
    if (!Number.isFinite(offset) || offset === 0) return;
    const { Cesium } = this;
    const carto = Cesium.Cartographic.fromCartesian(tileset.boundingSphere.center);
    const surface = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, 0);
    const target = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, offset);
    const translation = Cesium.Cartesian3.subtract(target, surface, new Cesium.Cartesian3());
    tileset.modelMatrix = Cesium.Matrix4.fromTranslation(translation);
  }

  /**
   * Move, turn and resize a tileset whose layer overrides its placement.
   *
   * A tileset built from a scan that was never georeferenced comes out at the
   * tiler's default origin, and re-tiling to move it is minutes of work for a
   * number still being found by eye. `modelMatrix` is a live property, so this
   * runs on every appearance pass rather than through a rebuild. The tileset's
   * own `root.transform` is divided out, so the placement is absolute rather
   * than relative to wherever the tiler put it.
   *
   * Applied instead of {@link applyTilesetAltitude}, not on top of it: both
   * write `modelMatrix`.
   */
  private applyTilesetPlacement(entry: LayerEntry): boolean {
    const tileset = entry.handle as Cesium3DTileset | null;
    if (!tileset) return false;
    const placement = readTilesetPlacement(entry.layer.source as Record<string, unknown>);
    if (!placement) return false;
    const { Cesium } = this;
    const root = tileset.root?.transform;
    if (!root) return false;
    const desired = Cesium.Matrix4.fromColumnMajorArray(tilesetPlacementMatrix(placement));
    const inverseRoot = Cesium.Matrix4.inverse(root, new Cesium.Matrix4());
    tileset.modelMatrix = Cesium.Matrix4.multiply(desired, inverseRoot, new Cesium.Matrix4());
    return true;
  }

  private applyAppearance(entry: LayerEntry): void {
    const { handle, layer } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      const imagery = handle as ImageryLayer;
      imagery.show = layer.visible;
      imagery.alpha = layer.opacity;
    } else if (entry.kind === "geojson") {
      (handle as DataSource).show = layer.visible;
      this.applyGeoJsonStyle(entry);
    } else {
      (handle as Cesium3DTileset).show = layer.visible;
      // Live: dragging a placement field re-writes modelMatrix, no reload.
      this.applyTilesetPlacement(entry);
      this.applyTilesetOpacity(entry);
    }
  }

  /**
   * Re-apply a GeoJSON layer's opacity in place, so dragging the opacity slider
   * restyles the entities instead of reloading the whole GeoJsonDataSource.
   * Polygon fill uses layer opacity × fill opacity; polyline stroke and point
   * markers use the layer opacity alone (matching the 2D map, where opacity
   * fades lines and points too). Colours themselves bake in at load, so a colour
   * change still rebuilds; the `appliedAlpha` guard makes a no-op call cheap on
   * unrelated syncs.
   */
  /**
   * Fade a tileset to the layer's opacity.
   *
   * A tileset has no `alpha` of its own the way an imagery layer does; the
   * documented way to fade one is a style that multiplies every tile's colour,
   * so the layer panel's slider is replayed as one. Rebuilt only when the value
   * actually changes — the slider fires on every tick of a drag, and compiling
   * a style per tick for a tileset of millions of points is not free.
   */
  private applyTilesetOpacity(entry: LayerEntry): void {
    const tileset = entry.handle as Cesium3DTileset | null;
    if (!tileset) return;
    const expression = tilesetOpacityExpression(entry.layer.opacity);
    const key = `alpha:${expression ?? "opaque"}`;
    if (entry.appliedAlpha === key) return;
    entry.appliedAlpha = key;
    tileset.style = expression
      ? new this.Cesium.Cesium3DTileStyle({ color: expression })
      : undefined;
  }

  private applyGeoJsonStyle(entry: LayerEntry): void {
    const dataSource = entry.handle as DataSource | null;
    if (!dataSource) return;
    const style = entry.layer.style ?? {};
    const opacity = entry.layer.opacity;
    const fillAlpha = (style.fillOpacity ?? 0.6) * opacity;
    // Key on both alphas so any opacity change is picked up (e.g. a lines-only
    // layer whose fill alpha never varies).
    const key = `${fillAlpha}|${opacity}|${style.extrusionEnabled}|${style.extrusionOpacity}|${style.extrusionColor}`;
    if (entry.appliedAlpha === key) return;
    entry.appliedAlpha = key;
    const { Cesium } = this;
    // An extruded polygon is painted with the extrusion colour, not the flat
    // fill: this runs right after load and on every opacity change, so reading
    // the wrong one here would overwrite the extrusion colour immediately.
    const extruded = Boolean(style.extrusionEnabled);
    const polygonAlpha = extruded ? (style.extrusionOpacity ?? 1) * opacity : fillAlpha;
    const fill = Cesium.Color.fromCssColorString(
      (extruded ? style.extrusionColor : style.fillColor) ?? style.fillColor ?? "#3b82f6",
    ).withAlpha(polygonAlpha);
    const stroke = Cesium.Color.fromCssColorString(style.strokeColor ?? "#1e40af").withAlpha(
      opacity,
    );
    // Point pins keep their baked-in colour; multiplying by white+alpha only
    // fades them.
    const marker = Cesium.Color.WHITE.withAlpha(opacity);
    for (const feature of dataSource.entities.values) {
      if (feature.polygon) {
        feature.polygon.material = new Cesium.ColorMaterialProperty(fill);
      }
      if (feature.polyline) {
        feature.polyline.material = new Cesium.ColorMaterialProperty(stroke);
      }
      if (feature.billboard) {
        feature.billboard.color = new Cesium.ConstantProperty(marker);
      }
    }
  }

  private destroyEntry(entry: LayerEntry): void {
    entry.cancelled = true;
    const { handle } = entry;
    if (!handle) return;
    if (entry.kind === "imagery") {
      this.viewer.imageryLayers.remove(handle as ImageryLayer, true);
    } else if (entry.kind === "geojson") {
      this.viewer.dataSources.remove(handle as DataSource, true);
    } else {
      this.viewer.scene.primitives.remove(handle as Cesium3DTileset);
    }
  }
}
