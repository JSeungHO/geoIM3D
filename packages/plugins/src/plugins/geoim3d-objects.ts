/**
 * geoIM3D 3D object upload: puts local files and plain-`http://` URLs on the
 * map via `maplibre-gl-splat` (which already renders/places them), plus the
 * two shells a webview can't reach itself — {@link setObjectFetcher} for
 * http, {@link setLocalObjectPicker} for local files. 3D Tiles aren't handled
 * here (own georeferencing) — the menu points at the 3D Tiles panel instead.
 */

import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin, GeoLibreToolbarMenuItem } from "../types";
import {
  basemapExtrusionLayerIds,
  BUNDLED_OBJECTS_MANIFEST,
  isBundledPreset,
  isDurableSource,
  loadPresets as loadUserPresets,
  parseBundledManifest,
  placementBounds,
  savePresets,
  upsertPreset,
  type ObjectPreset,
} from "./geoim3d-object-presets";
import { disposeLoadedObject, placeLoadedObject } from "./geoim3d-object-scene";
import { openThreeDTilesLayerPanel } from "./maplibre-3d-tiles";
import {
  acquireMercatorProjectionLock,
  releaseMercatorProjectionLock,
} from "./map-projection-utils";

export const GEOIM3D_OBJECTS_PLUGIN_ID = "geoim3d-objects";
const PANEL_ID = "geoim3d-objects-panel";
const FLOATING_PANEL_ID = `${PANEL_ID}-floating`;
const MENU_ID = "geoim3d-objects-menu";

// Shared with every other 3D overlay: MapLibre's adaptive globe projection
// breaks the splat renderer's mercator-based placement past a zoom threshold.
const PROJECTION_LOCK_KEY = "geoim3d-objects";

/* -------------------------------------------------------------------------- */
/* Formats                                                                      */
/* -------------------------------------------------------------------------- */

/** What the loader treats a file as — glTF/GLB vs splat, each with a different default rotation. */
export type ObjectKind = "splat" | "model";

/** Extensions the splat loader accepts, by kind. */
const SPLAT_EXTENSIONS = ["splat", "ply", "spz", "ksplat", "sog"];
const MODEL_EXTENSIONS = ["glb", "gltf"];

/** Every extension this plugin offers, for a file dialog's filter. */
export const OBJECT_EXTENSIONS: readonly string[] = [...SPLAT_EXTENSIONS, ...MODEL_EXTENSIONS];

/** Classifies a source by extension, parsed off the path so a signed URL's query survives. */
export function objectKind(source: string): ObjectKind | null {
  const path = source.split(/[?#]/, 1)[0] ?? "";
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (MODEL_EXTENSIONS.includes(extension)) return "model";
  if (SPLAT_EXTENSIONS.includes(extension)) return "splat";
  return null;
}

/** The loader's own default orientation for a kind (splats and glTF use different axis conventions). */
export function defaultRotation(kind: ObjectKind): [number, number, number] {
  return kind === "model" ? [90, 0, 0] : [-90, 90, 0];
}

/** A readable name for a source: the final path segment, or the source itself. */
export function objectName(source: string): string {
  const path = source.split(/[?#]/, 1)[0] ?? source;
  const segment = path.split(/[/\\]/).pop();
  return segment && segment.length > 0 ? decodeURIComponent(segment) : source;
}

/* -------------------------------------------------------------------------- */
/* Host-provided shells                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fetches a URL the webview may not request itself and returns a URL it can.
 * The desktop app reads the bytes natively and hands back a `blob:` URL.
 */
export type ObjectFetcher = (url: string) => Promise<string>;

/** A file the user picked, already addressable by the loader. */
export interface PickedObject {
  /** A URL the loader can read: an `asset:` URL on the desktop, `blob:` in a browser. */
  url: string;
  /** What to show in the list — the file's own name, not the opaque URL. */
  name: string;
  /** True when `url` is a `blob:` URL this plugin has to revoke. */
  revocable: boolean;
  /** The absolute path behind `url`, so a preset can reopen it later (browser picks have none). */
  path?: string;
}

/** How the host reports a 3D Tiles layer's streaming progress (injected, like the fetcher, to avoid importing `@geolibre/map`). */
export interface TilesetLoadingSource {
  /** Outstanding tile requests and processing for a layer, or null when idle. */
  progressOf: (layerId: string) => { pending: number; processing: number } | null;
  /** Notifies on every change. */
  subscribe: (listener: () => void) => () => void;
}

let tilesetLoadingSource: TilesetLoadingSource | null = null;

/** Installs the progress source, or clears it. */
export function setTilesetLoadingSource(source: TilesetLoadingSource | null): void {
  tilesetLoadingSource = source;
}

/** Reopens a file a preset recorded by path. Null when it can no longer be read. */
export type LocalObjectResolver = (path: string) => Promise<PickedObject | null>;

/** Opens a file dialog and resolves what the user chose (empty when cancelled). */
export type LocalObjectPicker = () => Promise<PickedObject[]>;

/** Whether the globe (not the 2D map `maplibre-gl-splat` draws into) is the primary view. */
export interface PrimaryViewBridge {
  /** True when the 2D map is hidden behind a globe. */
  isGlobeActive: () => boolean;
  /** Notifies on every change, so the menu can follow the tab. */
  subscribe: (listener: () => void) => () => void;
}

let objectFetcher: ObjectFetcher | null = null;
let localObjectPicker: LocalObjectPicker | null = null;
let localObjectResolver: LocalObjectResolver | null = null;
let primaryViewBridge: PrimaryViewBridge | null = null;

/**
 * Registers (or clears) the host's primary-view bridge.
 *
 * @param bridge - The bridge, or null to unregister.
 */
export function setPrimaryViewBridge(bridge: PrimaryViewBridge | null): void {
  unsubscribePrimaryView?.();
  primaryViewBridge = bridge;
  // The menu is offered only where the objects can be seen, so it has to be
  // rebuilt whenever the view changes.
  unsubscribePrimaryView =
    bridge?.subscribe(() => {
      if (state.app) buildToolbarMenu(state.app);
      rerenderPanel();
    }) ?? null;
  if (state.app) buildToolbarMenu(state.app);
}

let unsubscribePrimaryView: (() => void) | null = null;

/**
 * Registers (or clears) the native fetcher used for plain-HTTP URLs.
 *
 * @param fetcher - The fetcher, or null to unregister.
 */
export function setObjectFetcher(fetcher: ObjectFetcher | null): void {
  objectFetcher = fetcher;
  rerenderPanel();
}

/**
 * Registers (or clears) the local file picker.
 *
 * @param picker - The picker, or null to unregister.
 */
export function setLocalObjectPicker(picker: LocalObjectPicker | null): void {
  localObjectPicker = picker;
  rerenderPanel();
}

/**
 * Registers (or clears) the resolver that reopens a preset's local file.
 *
 * @param resolver - The resolver, or null to unregister.
 */
export function setLocalObjectResolver(resolver: LocalObjectResolver | null): void {
  localObjectResolver = resolver;
  rerenderPanel();
}

/** Whether a source has to go through the native fetcher: only cross-origin plain HTTP does. */
export function needsNativeFetch(source: string, origin?: string): boolean {
  if (!/^http:\/\//i.test(source)) return false;
  const self = origin ?? (typeof location === "undefined" ? "" : location.origin);
  if (!self) return true;
  try {
    return new URL(source).origin.toLowerCase() !== self.toLowerCase();
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                       */
/* -------------------------------------------------------------------------- */

/** User-facing strings, pushed in via {@link setGeoim3dObjectLabels} like the other plugins. */
export interface Geoim3dObjectLabels {
  title: string;
  getTitle?: () => string;
  menuLabel: string;
  openPanel: string;
  openPanelFloating: string;
  addFromUrl: string;
  addFromFile: string;
  threeDTiles: string;
  urlPlaceholder: string;
  load: string;
  loading: string;
  browse: string;
  loaded: string;
  empty: string;
  longitude: string;
  latitude: string;
  altitude: string;
  scale: string;
  rotation: string;
  tilesetBadge: string;
  tilesetLoading: string;
  tilesetHint: string;
  apply: string;
  remove: string;
  hideBasemapBuildings: string;
  savePreset: string;
  presets: string;
  presetsEmpty: string;
  deletePreset: string;
  errorUnsupported: string;
  errorHttpUnavailable: string;
  errorPickerUnavailable: string;
  errorLoadFailed: string;
  errorRendererUnavailable: string;
  /** Shown when the globe is up and the 2D map could not be brought back. */
  errorGlobeActive: string;
  errorEmptyFile: string;
  errorTooLarge: string;
  errorPresetNotSavable: string;
  errorPresetUnavailable: string;
  errorPresetMissing: string;
}

let labels: Geoim3dObjectLabels = {
  title: "3D objects",
  menuLabel: "3D objects",
  openPanel: "Object upload…",
  openPanelFloating: "Object upload (detached)…",
  addFromUrl: "Add from URL…",
  addFromFile: "Add from a file…",
  threeDTiles: "3D Tiles…",
  urlPlaceholder: "https:// or http:// address of a .splat, .ply, .sog or .glb",
  load: "Load",
  loading: "Loading…",
  browse: "Choose a file…",
  loaded: "Loaded objects",
  empty: "Nothing loaded yet.",
  longitude: "Longitude",
  latitude: "Latitude",
  altitude: "Altitude (m)",
  scale: "Scale",
  rotation: "Rotation (°)",
  tilesetBadge: "3D Tiles",
  tilesetLoading: "Loading tiles",
  tilesetHint: "These values place the 3D Tiles version, not the splat.",
  apply: "Apply",
  remove: "Remove",
  hideBasemapBuildings: "Hide the basemap’s 3D buildings",
  savePreset: "Save as a sample",
  presets: "Saved samples",
  presetsEmpty: "Nothing saved yet.",
  deletePreset: "Delete",
  errorUnsupported:
    "Not a format this plugin loads (.splat, .ply, .spz, .ksplat, .sog, .glb, .gltf).",
  errorHttpUnavailable:
    "Plain http:// addresses can only be read by the desktop app. Use https, or a local file.",
  errorPickerUnavailable: "Choosing a file is not available in this build.",
  errorLoadFailed: "The object could not be loaded.",
  errorRendererUnavailable: "The 3D object renderer could not be loaded.",
  errorGlobeActive:
    "3D objects are drawn on the 2D map. Switch the view above the map from Cesium to OSM to see them.",
  errorPresetNotSavable:
    "A file chosen in a browser cannot be saved as a sample — its address only lives as long as this page. Use the desktop app, or load the object from a URL.",
  errorPresetUnavailable: "Reopening a saved local file is only available in the desktop app.",
  errorPresetMissing: "The saved file could not be opened. It may have been moved or deleted.",
  errorEmptyFile: "That file is empty.",
  errorTooLarge:
    "That file is too large to open in the app. Reduce the splat count or export it as .sog, which is far smaller.",
};

/** Replaces some or all of the user-facing strings and rebuilds the menu. */
export function setGeoim3dObjectLabels(next: Partial<Geoim3dObjectLabels>): void {
  labels = { ...labels, ...next };
  rerenderPanel();
  if (state.app) buildToolbarMenu(state.app);
}

/* -------------------------------------------------------------------------- */
/* State                                                                        */
/* -------------------------------------------------------------------------- */

/** Where an object sits and how it is oriented. */
export interface ObjectTransform {
  longitude: number;
  latitude: number;
  altitude: number;
  scale: number;
  rotation: [number, number, number];
}

interface LoadedObject {
  /** This object's id in the layer list, stable across reloads (unlike the loader's own id). */
  layerId: string;
  /** The loader's own id, which changes on every reload. */
  loaderId: string;
  name: string;
  kind: ObjectKind;
  /** Set on a tileset-only entry: its own layer id (the same as `layerId`). */
  tilesetLayerId?: string;
  /** Set when there is no splat behind this entry — a tileset added on its own. */
  tilesetOnly?: boolean;
  /** The tileset's own placement — separate from `transform`, since the two assets don't share one. */
  tilesetTransform?: ObjectTransform;
  /** What the loader is actually reading: the original URL, or a blob of it. */
  readableUrl: string;
  /** The URL or path the user gave, kept for the layer record and for reloads. */
  source: string;
  /** True when `readableUrl` must be revoked once the object is gone. */
  revocable: boolean;
  transform: ObjectTransform;
  /** Links back to the {@link ActiveObjectSession} this entry materializes, if any. */
  sessionKey?: string;
}

/**
 * What a preset (or an ad-hoc load) currently has on the map, kept outside
 * `state.objects` — which every engine switch wipes, since `PluginManager`
 * deactivates every active plugin (ours included, despite declaring
 * `engines: ["maplibre", "cesium"]`) on any `primaryRenderer` change and this
 * plugin's own `activate()` does not otherwise remember what was loaded.
 * `materializeSession` reads this to put back whichever single representation
 * — the splat on MapLibre, the tileset companion on the globe — the
 * now-current engine can actually draw, instead of the object just staying
 * gone or (for a preset's tileset, added straight to the store rather than
 * tracked here) an orphan neither engine renders.
 */
interface ActiveObjectSession {
  /** Stable across reloads: a preset's id, or its source otherwise. */
  key: string;
  source: string;
  name: string;
  transform: ObjectTransform;
  /** Set when this object has a 3D Tiles version only the globe can show. */
  tilesetUrl?: string;
  tilesetTransform?: ObjectTransform;
}

const activeSessions = new Map<string, ActiveObjectSession>();

interface PanelState {
  app: GeoLibreAppAPI | null;
  container: HTMLElement | null;
  /** The `maplibre-gl-splat` control, which does the actual rendering. */
  control: SplatControlLike | null;
  /** Drives visibility/opacity from the layer list. Null until the first load. */
  adapter: SplatAdapterLike | null;
  objects: LoadedObject[];
  urlDraft: string;
  busy: boolean;
  /** What is loading right now, for the progress line. */
  busyName: string;
  /** Whether the basemap's own 3D buildings are hidden. */
  hideBasemapBuildings: boolean;
  status: string;
}

const state: PanelState = {
  app: null,
  container: null,
  control: null,
  adapter: null,
  objects: [],
  urlDraft: "",
  busy: false,
  busyName: "",
  hideBasemapBuildings: false,
  status: "",
};

/** The part of `maplibre-gl-splat`'s control this plugin drives, typed structurally (dynamic import). */
interface SplatControlLike {
  load(
    url: string,
    options?: {
      longitude?: number;
      latitude?: number;
      altitude?: number;
      rotation?: [number, number, number];
      scale?: number;
    },
  ): Promise<string>;
  removeSplat(layerId: string): void;
  removeModel(layerId: string): void;
  collapse(): void;
}

/** The adapter's visibility/opacity surface, keyed by the loader's own ids. */
interface SplatAdapterLike {
  setVisibility(layerId: string, visible: boolean): void;
  setOpacity(layerId: string, opacity: number): void;
  destroy(): void;
}

/** Builds the layer-list record for an object, as the `gaussian-splat` type the Components plugin uses too. */
function createObjectStoreLayer(object: LoadedObject): GeoLibreLayer {
  return {
    id: object.layerId,
    name: object.name,
    type: "gaussian-splat",
    source: {
      assetType: object.kind,
      // Needed for the layer panel's zoom-to-bounds button.
      bounds: placementBounds(object.transform.longitude, object.transform.latitude),
      sourceId: object.layerId,
      type: "gaussian-splat",
      // The original source, not the blob (dead on the next run).
      url: object.source,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      assetType: object.kind,
      customLayerType: "gaussian-splat",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: object.layerId,
      sourceKind: GEOIM3D_OBJECT_SOURCE_KIND,
    },
    sourcePath: object.source,
  };
}

/** Marks the layers this plugin owns, so the store watcher ignores everyone else's. */
const GEOIM3D_OBJECT_SOURCE_KIND = "geoim3d-object";

/** Marks a preset's 3D Tiles companion; distinct from {@link GEOIM3D_OBJECT_SOURCE_KIND} since the watcher must skip it. */
const GEOIM3D_TILESET_SOURCE_KIND = "geoim3d-object-tileset";

/**
 * Whether opening a preset also puts its 3D Tiles version on the map.
 * Was off while the globe had no reachable tab; back on with `primaryRenderer`.
 */
const TILESET_COMPANION_ENABLED = true;

/** The placement a tileset takes from the panel's transform, field for field, absolute not relative. */
function tilesetPlacementFor(transform: ObjectTransform): Record<string, unknown> {
  return {
    longitude: transform.longitude,
    latitude: transform.latitude,
    height: transform.altitude,
    rotation: [...transform.rotation],
    scale: transform.scale,
  };
}

/** The tileset's starting placement: the manifest's own value, or the splat's coordinates at ground/scale 1. */
function initialTilesetTransform(preset: ObjectPreset): ObjectTransform {
  return (
    preset.tilesetTransform ?? {
      longitude: preset.transform.longitude,
      latitude: preset.transform.latitude,
      altitude: 0,
      scale: 1,
      rotation: [0, preset.transform.rotation[1], 0],
    }
  );
}

/** Writes a placement onto the object's tileset layer; the Cesium sync applies it live, no reload. */
function applyTilesetTransform(object: LoadedObject, transform: ObjectTransform): void {
  const { tilesetLayerId } = object;
  if (!tilesetLayerId) return;
  const store = useAppStore.getState();
  const layer = store.layers.find((entry) => entry.id === tilesetLayerId);
  if (!layer) return;
  store.updateLayer(tilesetLayerId, {
    source: {
      ...layer.source,
      // The zoom button reads these, so a moved tileset needs its box moved too.
      bounds: placementBounds(transform.longitude, transform.latitude),
      placement: tilesetPlacementFor(transform),
    },
  });
}

/** The layer record for a preset's tileset — only what `cesium-layer-sync` needs, none of the 3D Tiles plugin's own metadata. */
function createTilesetStoreLayer(
  id: string,
  name: string,
  url: string,
  transform: ObjectTransform,
): GeoLibreLayer {
  return {
    id,
    name,
    type: "3d-tiles",
    source: {
      bounds: placementBounds(transform.longitude, transform.latitude),
      // Follows the panel, like the splat: a tileset built from a scan that was
      // never georeferenced sits wherever the tiler's default origin was.
      placement: tilesetPlacementFor(transform),
      sourceId: id,
      type: "3d-tiles",
      url,
    },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {
      customLayerType: "3d-tiles",
      externalNativeLayer: true,
      identifiable: false,
      sourceId: id,
      sourceKind: GEOIM3D_TILESET_SOURCE_KIND,
    },
    sourcePath: url,
  };
}

/**
 * Puts a session's tileset companion on the map (idempotent) and lists it in
 * the panel so its placement can still be edited while it's the only thing
 * standing in for the object.
 */
function materializeTilesetSession(session: ActiveObjectSession): void {
  if (!session.tilesetUrl) return;
  const layerId = `${session.key}-tileset`;
  const store = useAppStore.getState();
  if (!store.layers.some((layer) => layer.id === layerId)) {
    store.addLayer(
      createTilesetStoreLayer(
        layerId,
        session.name,
        session.tilesetUrl,
        session.tilesetTransform ?? session.transform,
      ),
    );
  }
  if (!state.objects.some((entry) => entry.layerId === layerId)) {
    state.objects.push({
      layerId,
      loaderId: "",
      name: session.name,
      kind: objectKind(session.source) ?? "splat",
      source: session.source,
      readableUrl: session.tilesetUrl,
      revocable: false,
      transform: session.transform,
      tilesetLayerId: layerId,
      tilesetTransform: session.tilesetTransform ?? session.transform,
      tilesetOnly: true,
      sessionKey: session.key,
    });
  }
  watchTilesetLoading();
  rerenderPanel();
}

/**
 * Loads exactly the representation the current engine can draw for a
 * remembered session — the splat on MapLibre, the tileset companion on the
 * globe. Called for the initial load and again from `activate()` on every
 * engine switch, which is the only way a session survives one (see
 * {@link ActiveObjectSession}). Idempotent: a session already materialized
 * for the current engine is left alone.
 */
async function materializeSession(app: GeoLibreAppAPI, key: string): Promise<void> {
  const session = activeSessions.get(key);
  if (!session) return;

  if (primaryViewBridge?.isGlobeActive()) {
    materializeTilesetSession(session);
    return;
  }

  if (state.objects.some((entry) => entry.sessionKey === key)) return;
  let prepared: { url: string; revocable: boolean } | undefined;
  if (!/^https?:\/\//i.test(session.source)) {
    if (!localObjectResolver) {
      setStatus(labels.errorPresetUnavailable);
      rerenderPanel();
      return;
    }
    const picked = await localObjectResolver(session.source);
    if (!picked) {
      setStatus(labels.errorPresetMissing);
      rerenderPanel();
      return;
    }
    prepared = { url: picked.url, revocable: picked.revocable };
  }
  await loadObject(app, session.source, session.name, prepared, session.transform, key);
}

/** Re-materializes every remembered session for the engine that's current now. */
async function restoreActiveSessions(app: GeoLibreAppAPI): Promise<void> {
  // Sequential: loadObject shares `state.busy`, which a parallel batch would race.
  for (const key of [...activeSessions.keys()]) {
    await materializeSession(app, key);
  }
}

/** Whether a source names a 3D Tiles tileset rather than a splat or a model. */
export function isTilesetSource(source: string): boolean {
  return /(^|\/)[^/?#]*\.json(?:[?#]|$)/i.test(source.split(/[?#]/, 1)[0] ?? source);
}

/** Puts a tileset on the map as our own layer (not the 3D Tiles panel's, which wipes placement on sync). */
function loadTileset(app: GeoLibreAppAPI, url: string, name: string): void {
  const center = app.getMap?.()?.getCenter();
  const transform: ObjectTransform = {
    longitude: center?.lng ?? 0,
    latitude: center?.lat ?? 0,
    altitude: 0,
    scale: 1,
    rotation: [0, 0, 0],
  };
  const layerId = `${GEOIM3D_TILESET_SOURCE_KIND}-${nextObjectSequence++}`;
  useAppStore.getState().addLayer(createTilesetStoreLayer(layerId, name, url, transform));
  watchTilesetLoading();
  state.objects.push({
    layerId,
    loaderId: "",
    name,
    kind: "splat",
    source: url,
    readableUrl: url,
    revocable: false,
    transform,
    tilesetLayerId: layerId,
    tilesetTransform: transform,
    tilesetOnly: true,
  });
  state.urlDraft = "";
  setStatus("");
  rerenderPanel();
}

/** The one object the panel edits: follows the layer-list selection, or the most recent load. */
function panelObject(): LoadedObject | null {
  const { selectedLayerId } = useAppStore.getState();
  const selected = selectedLayerId
    ? state.objects.find(
        (object) => object.layerId === selectedLayerId || object.tilesetLayerId === selectedLayerId,
      )
    : undefined;
  return selected ?? state.objects.at(-1) ?? null;
}

/**
 * True when the panel's fields are pointed at the tileset rather than the
 * splat. The two are mutually exclusive now (MapLibre shows the splat, the
 * globe its tileset companion — see ActiveObjectSession), so a tileset-only
 * entry is the only case left.
 */
function isEditingTileset(object: LoadedObject): boolean {
  return object.tilesetOnly === true;
}

function isObjectLayer(layer: GeoLibreLayer): boolean {
  return layer.metadata.sourceKind === GEOIM3D_OBJECT_SOURCE_KIND;
}

let unsubscribeStore: (() => void) | null = null;
let unsubscribeTilesetLoading: (() => void) | null = null;
let detachPitchSync: (() => void) | null = null;

/**
 * Whether the panel was open the moment `deactivate()` ran, so the matching
 * `activate()` — called right back on an engine switch — can reopen it
 * instead of leaving it silently closed. Deliberately not in `state`, which
 * `deactivate()` otherwise resets.
 */
let wasRightPanelOpen = false;
let wasFloatingPanelOpen = false;

/** Counter behind the stable layer ids. Uniqueness within a session is enough. */
let nextObjectSequence = 1;

/** Samples from {@link BUNDLED_OBJECTS_MANIFEST}. Empty until read, or for good if unreachable. */
let bundledPresets: ObjectPreset[] = [];

/** Reads the shipped object manifest and rebuilds the menu once the list is known. */
async function loadBundledPresets(app: GeoLibreAppAPI): Promise<void> {
  const base = typeof document === "undefined" ? "" : document.baseURI;
  if (!base) return;
  try {
    const manifestUrl = new URL(BUNDLED_OBJECTS_MANIFEST, base).href;
    bundledPresets = parseBundledManifest(await fetchManifestText(manifestUrl), base);
  } catch {
    // No manifest is the normal case, not a fault worth reporting.
    return;
  }
  if (bundledPresets.length === 0) return;
  buildToolbarMenu(app);
  rerenderPanel();
}

/** Every sample offered, shipped ones first. Both the menu and the panel must call this, never `loadUserPresets`. */
function allPresets(): ObjectPreset[] {
  return [...bundledPresets, ...loadUserPresets()];
}

/** The one MapLibre layer `maplibre-gl-splat` renders every object into (fixed id, one shared scene). */
const SPLAT_SCENE_LAYER_ID = "map_scene_layer";

// ponytail: keeps objects above everything added after them (e.g. a basemap
// switch), rather than following layer-panel order — the store record isn't a
// native layer yet. Give it real nativeLayerIds if per-layer order is wanted.
function raiseSplatScene(): void {
  const map = state.app?.getMap?.() as
    | { getLayer: (id: string) => unknown; moveLayer: (id: string) => void }
    | null
    | undefined;
  if (!map?.getLayer(SPLAT_SCENE_LAYER_ID)) return;
  map.moveLayer(SPLAT_SCENE_LAYER_ID);
}

/** Shows or hides the basemap's 3D buildings; re-applied on `styledata` too, since a fresh style forgets it. */
function applyBasemapBuildingVisibility(): void {
  const map = state.app?.getMap?.() as
    | {
        getStyle: () => { layers?: Array<{ id: string; type: string }> } | undefined;
        setLayoutProperty: (id: string, name: string, value: string) => void;
      }
    | null
    | undefined;
  if (!map) return;

  // `metadata` is a loose record, so the native ids arrive untyped.
  const owned = new Set<string>();
  for (const layer of useAppStore.getState().layers) {
    const ids = layer.metadata.nativeLayerIds;
    if (Array.isArray(ids)) for (const id of ids) owned.add(String(id));
  }

  const visibility = state.hideBasemapBuildings ? "none" : "visible";
  for (const id of basemapExtrusionLayerIds(map.getStyle()?.layers ?? [], owned)) {
    try {
      map.setLayoutProperty(id, "visibility", visibility);
    } catch {
      // A style can be swapped mid-iteration; the styledata handler re-runs.
    }
  }
}

let detachStyleWatch: (() => void) | null = null;

// ponytail: `SplatMesh` isn't a `THREE.Mesh` (no `material`), so the shipped
// adapter's opacity setter silently no-ops on it. Reaches into the control's
// private `_splatLayers` instead, defensively — drop once the library adds a
// real setter.
function applyObjectOpacity(object: LoadedObject, opacity: number): void {
  state.adapter?.setOpacity(object.loaderId, opacity);

  const splatLayers = (
    state.control as unknown as {
      _splatLayers?: Map<string, { mesh?: { opacity?: number } }>;
    } | null
  )?._splatLayers;
  const mesh = splatLayers?.get(object.loaderId)?.mesh;
  if (mesh && typeof mesh.opacity === "number") {
    mesh.opacity = opacity;
    // The scene redraws with the map, so force one for a change made while still.
    state.app?.getMap?.()?.triggerRepaint();
  }
}

/** Whether layers were added or removed (identity alone can't tell, since Zustand always hands back a new array). */
function layerIdsChanged(
  before: ReadonlyArray<{ id: string }>,
  after: ReadonlyArray<{ id: string }>,
): boolean {
  if (before.length !== after.length) return true;
  return before.some((layer, index) => layer.id !== after[index].id);
}

/** Repaints the panel as tiles arrive, so the bar tracks the stream. */
function watchTilesetLoading(): void {
  if (!tilesetLoadingSource) return;
  unsubscribeTilesetLoading ??= tilesetLoadingSource.subscribe(() => rerenderPanel());
}

/** Follows the layer list: a delete there removes the object; eye/opacity drive the renderer. */
function watchLayerList(): void {
  unsubscribeStore ??= useAppStore.subscribe((store, previous) => {
    // Only on add/remove: moveLayer is too expensive to run on every opacity tick.
    if (state.objects.length > 0 && layerIdsChanged(previous.layers, store.layers)) {
      raiseSplatScene();
    }

    // Which object the panel edits follows the layer list's selection.
    if (store.selectedLayerId !== previous.selectedLayerId) rerenderPanel();

    const currentById = new Map(store.layers.map((layer) => [layer.id, layer]));
    for (const before of previous.layers) {
      if (!isObjectLayer(before)) continue;
      const object = state.objects.find((entry) => entry.layerId === before.id);
      if (!object) continue;

      const after = currentById.get(before.id);
      if (!after) {
        removeObject(object, { alreadyRemovedFromStore: true });
        continue;
      }
      if (after.visible !== before.visible) {
        state.adapter?.setVisibility(object.loaderId, after.visible);
      }
      if (after.opacity !== before.opacity) {
        applyObjectOpacity(object, after.opacity);
      }
    }
  });
}

function setStatus(message: string): void {
  state.status = message;
}

function rerenderPanel(): void {
  if (state.container) renderPanel(state.container);
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                      */
/* -------------------------------------------------------------------------- */

// Re-emits `resize` on `moveend` (only if pitch changed) since that's the only
// public way to make maplibre-gl-splat rebuild its far plane for the new
// pitch — otherwise the scene clips at the far edge past a certain tilt.
// ponytail: stays stale mid-drag, corrects on release; move to the continuous
// `pitch` event if that lag matters, at the cost of firing resize every frame.
function syncSplatCameraOnPitch(map: {
  getPitch: () => number;
  on: (event: string, handler: () => void) => void;
  off: (event: string, handler: () => void) => void;
  fire: (event: string) => void;
}): () => void {
  let lastPitch = map.getPitch();
  const onMoveEnd = () => {
    const pitch = map.getPitch();
    if (Math.abs(pitch - lastPitch) < 0.5) return;
    lastPitch = pitch;
    map.fire("resize");
  };
  map.on("moveend", onMoveEnd);
  return () => map.off("moveend", onMoveEnd);
}

/** Waits for the map style to finish loading (else the scene layer's add throws mid-basemap-change). */
function whenStyleReady(map: unknown): Promise<void> {
  const target = map as
    | { isStyleLoaded?: () => boolean; once?: (event: string, handler: () => void) => void }
    | null
    | undefined;
  if (!target?.once || target.isStyleLoaded?.() !== false) return Promise.resolve();
  return new Promise((resolve) => target.once?.("idle", () => resolve()));
}

/** Resolves the renderer, loading it on first use; a failure is reported, not thrown. */
async function ensureControl(app: GeoLibreAppAPI): Promise<SplatControlLike | null> {
  if (state.control) return state.control;
  try {
    const module = (await import("maplibre-gl-splat")) as unknown as {
      GaussianSplatControl: new (options?: Record<string, unknown>) => SplatControlLike;
      GaussianSplatLayerAdapter: new (control: SplatControlLike) => SplatAdapterLike;
    };
    const control = new module.GaussianSplatControl();
    app.addMapControl(control as never, "top-left");
    control.collapse();
    state.control = control;
    // The control has no visibility/opacity; the shipped layer adapter does.
    state.adapter = new module.GaussianSplatLayerAdapter(control);
    const map = app.getMap?.();
    if (map) detachPitchSync = syncSplatCameraOnPitch(map as never);
    watchLayerList();
    return control;
  } catch (error) {
    console.warn("geoim3d-objects: the splat renderer failed to load", error);
    return null;
  }
}

/** Turns a source into something the webview is allowed to read (native fetch, or plain http on a non-https page). */
async function resolveReadableUrl(source: string): Promise<{ url: string; revocable: boolean }> {
  if (!needsNativeFetch(source)) return { url: source, revocable: false };
  // Native fetch also keeps the webview's CSP out of it.
  if (objectFetcher) return { url: await objectFetcher(source), revocable: true };
  // No fetcher (browser): mixed content is the only rule a non-https page has none of.
  if (typeof location !== "undefined" && location.protocol !== "https:") {
    return { url: source, revocable: false };
  }
  throw new Error("http-unavailable");
}

/** Fetches the manifest as text, via {@link resolveReadableUrl} for cross-origin hosts. */
async function fetchManifestText(url: string): Promise<string> {
  const readable = await resolveReadableUrl(url);
  try {
    const response = await fetch(readable.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    if (readable.revocable) URL.revokeObjectURL(readable.url);
  }
}

/**
 * Waits for a just-loaded splat to finish streaming (`loadSplat` returns as
 * soon as the mesh exists; `loadModel` already awaits its own fetch). Reaches
 * into the control's private registry, best-effort — any failure just resolves.
 */
async function whenObjectRendered(control: SplatControlLike, loaderId: string): Promise<void> {
  const registry = (
    control as unknown as {
      _splatLayers?: Map<string, { mesh?: { initialized?: Promise<unknown> } }>;
    }
  )._splatLayers;
  const ready = registry?.get(loaderId)?.mesh?.initialized;
  if (ready) await ready.catch(() => {});
}

/**
 * Loads an object and adds it to the panel's list.
 *
 * @param sessionKey - Correlates this load with an {@link ActiveObjectSession}
 *   so an engine switch (which forces this object out and back in) can find
 *   its way back to the same session. Defaults to `source`, which is enough
 *   to key a plain URL/file load; a preset passes its own stable id instead,
 *   since a preset's source URL is not otherwise guaranteed unique across
 *   reopens the way an ad-hoc load's is.
 */
async function loadObject(
  app: GeoLibreAppAPI,
  source: string,
  name: string,
  prepared?: { url: string; revocable: boolean },
  placement?: ObjectTransform,
  sessionKey: string = source,
): Promise<void> {
  const kind = objectKind(source);
  if (!kind) {
    setStatus(labels.errorUnsupported);
    rerenderPanel();
    return;
  }

  state.busy = true;
  state.busyName = name;
  setStatus("");
  rerenderPanel();

  let readable: { url: string; revocable: boolean } | null = null;
  try {
    const control = await ensureControl(app);
    if (!control) throw new Error("renderer-unavailable");

    readable = prepared ?? (await resolveReadableUrl(source));

    // The splat renderer draws into the 2D map; nothing shows for it on the
    // globe (its tileset companion, if any, is what materializeSession shows
    // there instead — see ActiveObjectSession).
    if (primaryViewBridge?.isGlobeActive()) throw new Error("globe-active");

    await whenStyleReady(app.getMap?.());

    // Start where the user is looking, or land at (0, 0) in the Atlantic.
    const center = app.getMap?.()?.getCenter();
    const transform: ObjectTransform = placement ?? {
      longitude: center?.lng ?? 0,
      latitude: center?.lat ?? 0,
      altitude: 0,
      scale: 1,
      rotation: defaultRotation(kind),
    };
    const loaderId = await control.load(readable.url, {
      longitude: transform.longitude,
      latitude: transform.latitude,
      altitude: transform.altitude,
      rotation: transform.rotation,
      scale: transform.scale,
    });
    const object: LoadedObject = {
      layerId: `${GEOIM3D_OBJECT_SOURCE_KIND}-${nextObjectSequence++}`,
      loaderId,
      name,
      kind,
      source,
      readableUrl: readable.url,
      revocable: readable.revocable,
      transform,
      sessionKey,
    };
    state.objects.push(object);
    // Keep any tileset URL a preset already recorded for this session (set
    // before this call, in loadPreset) — this call only ever materializes the
    // splat side.
    const existingSession = activeSessions.get(sessionKey);
    activeSessions.set(sessionKey, {
      key: sessionKey,
      source,
      name,
      transform,
      tilesetUrl: existingSession?.tilesetUrl,
      tilesetTransform: existingSession?.tilesetTransform,
    });
    acquireMercatorProjectionLock(PROJECTION_LOCK_KEY, app, app.getMap?.());
    // A jump, not a flight: the projection switch above ends any animation in
    // progress anyway. Only on load, not on every transform edit.
    app.getMap?.()?.jumpTo({
      center: [transform.longitude, transform.latitude],
      zoom: 18, // Fills the view for a site-scale scan, per the splat library's own default.
    });
    // The scene layer is created on the first render after a load, so raise it
    // once that has happened rather than in this tick.
    app.getMap?.()?.once("idle", raiseSplatScene);
    useAppStore.getState().addLayer(createObjectStoreLayer(object));
    state.urlDraft = "";
    // The layer is listed above at once; hold `busy` (and its progress bar)
    // until the splat has actually streamed in, not just been queued.
    await whenObjectRendered(control, loaderId);
  } catch (error) {
    // A blob made for a load that then failed would otherwise be held until
    // the tab closes, and these are hundreds of megabytes.
    if (readable?.revocable) URL.revokeObjectURL(readable.url);
    setStatus(loadErrorMessage(error));
  } finally {
    state.busy = false;
    state.busyName = "";
    rerenderPanel();
  }
}

/** Maps a load failure to a message that says what to do about it. */
function loadErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "http-unavailable") return labels.errorHttpUnavailable;
  if (reason === "renderer-unavailable") return labels.errorRendererUnavailable;
  if (reason === "globe-active") return labels.errorGlobeActive;
  return labels.errorLoadFailed;
}

/** Removes an object from the map, the panel and the layer list, whichever side started it. */
function removeObject(object: LoadedObject, options?: { alreadyRemovedFromStore?: boolean }): void {
  removeFromRenderer(object);
  if (object.revocable) URL.revokeObjectURL(object.readableUrl);
  state.objects = state.objects.filter((entry) => entry !== object);
  if (state.objects.length === 0 && state.app) {
    releaseMercatorProjectionLock(PROJECTION_LOCK_KEY, state.app);
  }
  if (!options?.alreadyRemovedFromStore) useAppStore.getState().removeLayer(object.layerId);
  // A tileset-only entry's own layer, if this is one (idempotent alongside the
  // removeLayer above when they're the same id).
  if (object.tilesetLayerId) useAppStore.getState().removeLayer(object.tilesetLayerId);
  // Otherwise an engine switch would bring this object straight back.
  if (object.sessionKey) activeSessions.delete(object.sessionKey);
  rerenderPanel();
}

function removeFromRenderer(object: LoadedObject): void {
  const control = state.control;
  // A tileset-only entry was never handed to the splat renderer.
  if (!control || object.tilesetOnly) return;
  // The library disposes nothing on remove, so free buffers first.
  disposeLoadedObject(control, object.loaderId);
  if (object.kind === "model") control.removeModel(object.loaderId);
  else control.removeSplat(object.loaderId);
}

/**
 * Re-places an object with an edited transform, writing straight onto the
 * three.js group instead of reload-per-Apply (which used to OOM the SOG
 * worker after enough nudges). Reload is kept as the fallback for when the
 * scene graph can't be reached, reusing the readable URL rather than re-fetching.
 */
async function applyTransform(object: LoadedObject, transform: ObjectTransform): Promise<void> {
  // On the globe, an Apply moves the tileset instead, leaving the splat alone.
  if (isEditingTileset(object)) {
    object.tilesetTransform = transform;
    applyTilesetTransform(object, transform);
    if (object.sessionKey) {
      const session = activeSessions.get(object.sessionKey);
      if (session) session.tilesetTransform = transform;
    }
    rerenderPanel();
    return;
  }

  const control = state.control;
  if (!control) return;

  state.busy = true;
  setStatus("");
  rerenderPanel();
  try {
    if (placeLoadedObject(control, object.loaderId, object.kind, transform)) {
      // Force a repaint since the scene only redraws with the map.
      state.app?.getMap?.()?.triggerRepaint();
    } else {
      removeFromRenderer(object);
      // The loader mints a new id per load.
      object.loaderId = await control.load(object.readableUrl, {
        longitude: transform.longitude,
        latitude: transform.latitude,
        altitude: transform.altitude,
        rotation: transform.rotation,
        scale: transform.scale,
      });
      await whenObjectRendered(control, object.loaderId);
    }
    object.transform = transform;
    if (object.sessionKey) {
      const session = activeSessions.get(object.sessionKey);
      if (session) session.transform = transform;
    }
    // Move the bounds too, or the zoom button keeps pointing at the old spot.
    const store = useAppStore.getState();
    const existing = store.layers.find((entry) => entry.id === object.layerId);
    if (existing) {
      store.updateLayer(object.layerId, {
        source: {
          ...existing.source,
          bounds: placementBounds(transform.longitude, transform.latitude),
        },
      });
    }

    // A reload starts visible/opaque, so re-apply what the layer already has.
    const layer = useAppStore.getState().layers.find((entry) => entry.id === object.layerId);
    if (layer) {
      state.adapter?.setVisibility(object.loaderId, layer.visible);
      applyObjectOpacity(object, layer.opacity);
    }
  } catch (error) {
    setStatus(loadErrorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

async function pickAndLoad(app: GeoLibreAppAPI): Promise<void> {
  if (!localObjectPicker) {
    setStatus(labels.errorPickerUnavailable);
    rerenderPanel();
    return;
  }
  const picked = await localObjectPicker();
  for (const file of picked) {
    // The path (not the display name): what a preset needs to reopen the file.
    await loadObject(app, file.path ?? file.name, file.name, {
      url: file.url,
      revocable: file.revocable,
    });
  }
}

/** The largest local file this will try to load, past which parsing fails partway with no clear error. */
export const MAX_LOCAL_OBJECT_BYTES = 2 * 1024 * 1024 * 1024;

/** Rejects a local file the loader cannot be expected to read: wrong format, empty, or too big. */
export function validateLocalObjectFile(file: Pick<File, "name" | "size">): void {
  if (!objectKind(file.name)) throw new Error(labels.errorUnsupported);
  if (file.size === 0) throw new Error(labels.errorEmptyFile);
  if (file.size > MAX_LOCAL_OBJECT_BYTES) throw new Error(labels.errorTooLarge);
}

/**
 * Loads a file the user dropped on the map, through this plugin's own entry
 * point (not a separate copy of the renderer) so a dropped scan gets the same
 * transform editor and opacity slider a panel-loaded one does.
 */
export async function addDroppedObject(
  app: GeoLibreAppAPI,
  file: File,
  placement?: { longitude: number; latitude: number },
): Promise<string> {
  validateLocalObjectFile(file);
  if (!state.app) await app.activatePlugin?.(GEOIM3D_OBJECTS_PLUGIN_ID);
  const host = state.app ?? app;

  // A dropped file has no path; the blob is revoked with the object, like a browser pick.
  const url = URL.createObjectURL(file);
  const before = new Set(state.objects.map((entry) => entry.layerId));
  await loadObject(
    host,
    file.name,
    file.name,
    { url, revocable: true },
    placementTransform(placement, objectKind(file.name) ?? "splat"),
  );

  const added = state.objects.find((entry) => !before.has(entry.layerId));
  if (!added) throw new Error(state.status || labels.errorLoadFailed);
  return added.layerId;
}

/** A full transform from a bare coordinate, or undefined to use the map centre. */
function placementTransform(
  placement: { longitude: number; latitude: number } | undefined,
  kind: ObjectKind,
): ObjectTransform | undefined {
  if (!placement) return undefined;
  return {
    longitude: placement.longitude,
    latitude: placement.latitude,
    altitude: 0,
    scale: 1,
    // Read from the file, not assumed: splats and glTF models are authored in
    // different axis conventions, so a dropped .glb given a splat's rotation
    // arrives on its side.
    rotation: defaultRotation(kind),
  };
}

/* -------------------------------------------------------------------------- */
/* Presets                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Saves an object's file and placement so it can be re-added later.
 *
 * @param object - The object to remember.
 */
function savePreset(object: LoadedObject): void {
  if (!isDurableSource(object.source)) {
    setStatus(labels.errorPresetNotSavable);
    rerenderPanel();
    return;
  }
  const preset: ObjectPreset = {
    id: `${GEOIM3D_OBJECT_SOURCE_KIND}-preset-${nextObjectSequence++}`,
    name: object.name,
    source: object.source,
    kind: object.kind,
    transform: { ...object.transform, rotation: [...object.transform.rotation] },
    // Saved alongside, so reopening the preset restores the globe's placement
    // too rather than starting from the defaults again.
    tilesetTransform: object.tilesetTransform
      ? { ...object.tilesetTransform, rotation: [...object.tilesetTransform.rotation] }
      : undefined,
  };
  savePresets(upsertPreset(loadUserPresets(), preset));
  if (state.app) buildToolbarMenu(state.app);
  setStatus("");
  rerenderPanel();
}

/**
 * Deletes a saved preset.
 *
 * @param id - The preset's id.
 */
function deletePreset(id: string): void {
  savePresets(loadUserPresets().filter((entry) => entry.id !== id));
  if (state.app) buildToolbarMenu(state.app);
  rerenderPanel();
}

/** Loads a preset back onto the map at the placement it was saved with. */
async function loadPreset(app: GeoLibreAppAPI, preset: ObjectPreset): Promise<void> {
  const tilesetUrl = TILESET_COMPANION_ENABLED ? preset.tileset : undefined;
  // Remembered by key so an engine switch (which tears this plugin down and
  // back up) can put back whichever side the now-current engine draws — see
  // ActiveObjectSession. materializeSession does the actual loading below.
  activeSessions.set(preset.id, {
    key: preset.id,
    source: preset.source,
    name: preset.name,
    transform: preset.transform,
    tilesetUrl,
    tilesetTransform: tilesetUrl ? initialTilesetTransform(preset) : undefined,
  });
  await materializeSession(app, preset.id);
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                        */
/* -------------------------------------------------------------------------- */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  return element("h3", "geolibre-plugin-panel__section-title", text);
}

/** A labelled number box for one transform field. */
function numberField(
  labelText: string,
  value: number,
  step: number,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = element("label", "geoim3d-object__field");
  row.appendChild(element("span", "geoim3d-object__field-label", labelText));
  const input = element("input", "geolibre-plugin-panel__input");
  input.type = "number";
  input.step = String(step);
  input.value = String(value);
  row.appendChild(input);
  return { row, input };
}

/** One loaded object: what it is, where it sits, and the controls to change it. */
function objectBlock(object: LoadedObject): HTMLElement {
  const wrapper = element("div", "geoim3d-object");
  wrapper.appendChild(element("p", "geoim3d-object__name", object.name));

  // The same fields drive two assets; say which one they're currently pointed at.
  const editingTileset = isEditingTileset(object);
  if (editingTileset) {
    wrapper.appendChild(element("span", "geoim3d-object__badge", labels.tilesetBadge));
    wrapper.appendChild(element("p", "geoim3d-object__hint", labels.tilesetHint));
  }

  const transform =
    editingTileset && object.tilesetTransform ? object.tilesetTransform : object.transform;
  const lon = numberField(labels.longitude, transform.longitude, 0.0001);
  const lat = numberField(labels.latitude, transform.latitude, 0.0001);
  const alt = numberField(labels.altitude, transform.altitude, 1);
  const scale = numberField(labels.scale, transform.scale, 0.1);
  for (const field of [lon, lat, alt, scale]) wrapper.appendChild(field.row);

  // Opacity is deliberately absent: the layer panel's slider owns it, and the
  // store watcher passes a change straight to the renderer. A second control
  // for one value is two places to disagree.

  wrapper.appendChild(element("span", "geoim3d-object__field-label", labels.rotation));
  const rotationRow = element("div", "geoim3d-object__rotation");
  const rotationInputs = (["x", "y", "z"] as const).map((axis, index) => {
    const input = element("input", "geolibre-plugin-panel__input");
    input.type = "number";
    input.step = "1";
    input.value = String(transform.rotation[index]);
    input.setAttribute("aria-label", `${labels.rotation} ${axis.toUpperCase()}`);
    rotationRow.appendChild(input);
    return input;
  });
  wrapper.appendChild(rotationRow);

  const actions = element("div", "geoim3d-object__actions");
  const apply = element("button", "geolibre-plugin-panel__button", labels.apply);
  apply.type = "button";
  apply.disabled = state.busy;
  // Applied on the button, not on input: a reload re-parses the whole file, so
  // reacting to every keystroke would stall the map on a large object.
  apply.addEventListener("click", () => {
    void applyTransform(object, {
      longitude: Number(lon.input.value),
      latitude: Number(lat.input.value),
      altitude: Number(alt.input.value),
      scale: Number(scale.input.value),
      rotation: rotationInputs.map((input) => Number(input.value)) as [number, number, number],
    });
  });
  actions.appendChild(apply);

  const remove = element("button", "geolibre-plugin-panel__button", labels.remove);
  remove.type = "button";
  remove.addEventListener("click", () => removeObject(object));
  actions.appendChild(remove);
  wrapper.appendChild(actions);

  const save = element(
    "button",
    "geolibre-plugin-panel__button geolibre-plugin-panel__button--wide",
    labels.savePreset,
  );
  save.type = "button";
  // A browser pick has only a blob: URL, which dies with the page, so there is
  // nothing durable to save. Disabled rather than hidden so the reason can be
  // read from the tooltip instead of the option simply not being there.
  save.disabled = !isDurableSource(object.source);
  if (save.disabled) save.title = labels.errorPresetNotSavable;
  save.addEventListener("click", () => savePreset(object));
  wrapper.appendChild(save);

  return wrapper;
}

function renderPanel(container: HTMLElement): void {
  const app = state.app;
  if (!app) return;
  container.textContent = "";
  container.className = "geolibre-plugin-panel";

  // A tileset streams after its layer is listed, so the panel keeps showing
  // progress once the object itself has finished loading.
  const streaming = state.objects
    .map((object) =>
      object.tilesetLayerId
        ? (tilesetLoadingSource?.progressOf(object.tilesetLayerId) ?? null)
        : null,
    )
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (!state.busy && streaming.length > 0) {
    const outstanding = streaming.reduce((sum, one) => sum + one.pending + one.processing, 0);
    const progress = element("div", "geoim3d-progress");
    progress.setAttribute("role", "status");
    progress.appendChild(
      element("p", "geoim3d-progress__label", `${labels.tilesetLoading} (${outstanding})`),
    );
    const track = element("div", "geoim3d-progress__track");
    track.appendChild(element("div", "geoim3d-progress__bar"));
    progress.appendChild(track);
    container.appendChild(progress);
  }

  if (state.busy) {
    // Indeterminate: the renderer reports no byte count and it isn't worth measuring first.
    const progress = element("div", "geoim3d-progress");
    progress.setAttribute("role", "status");
    progress.appendChild(
      element("p", "geoim3d-progress__label", `${labels.loading} ${state.busyName}`.trim()),
    );
    const track = element("div", "geoim3d-progress__track");
    track.appendChild(element("div", "geoim3d-progress__bar"));
    progress.appendChild(track);
    container.appendChild(progress);
  }

  // Add from a URL.
  container.appendChild(sectionTitle(labels.addFromUrl));
  const form = element("form", "geolibre-plugin-panel__form");
  const urlInput = element("input", "geolibre-plugin-panel__input");
  urlInput.type = "text";
  urlInput.placeholder = labels.urlPlaceholder;
  urlInput.value = state.urlDraft;
  urlInput.addEventListener("input", () => {
    state.urlDraft = urlInput.value;
  });
  form.appendChild(urlInput);
  const submit = element(
    "button",
    "geolibre-plugin-panel__button",
    state.busy ? labels.loading : labels.load,
  );
  submit.type = "submit";
  submit.disabled = state.busy;
  form.appendChild(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const source = state.urlDraft.trim();
    if (!source) return;
    if (isTilesetSource(source)) loadTileset(app, source, objectName(source));
    else void loadObject(app, source, objectName(source));
  });
  container.appendChild(form);

  // Add from a file.
  const browse = element(
    "button",
    "geolibre-plugin-panel__button geolibre-plugin-panel__button--wide",
    labels.browse,
  );
  browse.type = "button";
  browse.disabled = state.busy || !localObjectPicker;
  browse.addEventListener("click", () => void pickAndLoad(app));
  container.appendChild(browse);

  if (state.status) {
    container.appendChild(element("p", "geolibre-plugin-panel__notice", state.status));
  }

  // What is on the map.
  container.appendChild(sectionTitle(labels.loaded));
  if (state.objects.length === 0) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", labels.empty));
    return;
  }
  const shown = panelObject();
  if (shown) container.appendChild(objectBlock(shown));

  buildingToggle(container);
  presetSection(app, container);
}

/** The switch for the basemap's own 3D buildings, which stand in front of a scan at street level. */
function buildingToggle(container: HTMLElement): void {
  const row = element("label", "geoim3d-object__field geoim3d-object__toggle");
  const input = element("input", "");
  input.type = "checkbox";
  input.checked = state.hideBasemapBuildings;
  input.addEventListener("change", () => {
    state.hideBasemapBuildings = input.checked;
    applyBasemapBuildingVisibility();
  });
  row.appendChild(input);
  row.appendChild(element("span", "geoim3d-object__field-label", labels.hideBasemapBuildings));
  container.appendChild(row);
}

/** Lists the saved samples, with a way to load or (unlike the toolbar menu) forget each one. */
function presetSection(app: GeoLibreAppAPI, container: HTMLElement): void {
  container.appendChild(sectionTitle(labels.presets));
  const presets = allPresets();
  if (presets.length === 0) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", labels.presetsEmpty));
    return;
  }
  for (const preset of presets) {
    const row = element("div", "geoim3d-object__actions");
    const load = element("button", "geolibre-plugin-panel__button", preset.name);
    load.type = "button";
    load.disabled = state.busy;
    load.addEventListener("click", () => void loadPreset(app, preset));
    row.appendChild(load);
    // A shipped sample has nothing in this browser's storage to delete.
    if (!isBundledPreset(preset)) {
      const drop = element("button", "geolibre-plugin-panel__button", labels.deletePreset);
      drop.type = "button";
      drop.addEventListener("click", () => deletePreset(preset.id));
      row.appendChild(drop);
    }
    container.appendChild(row);
  }
}

/** Mounts the panel body into whichever shell asked for it — docked or floating. */
function mountPanel(container: HTMLElement): () => void {
  state.container = container;
  renderPanel(container);
  return () => {
    if (state.container === container) state.container = null;
  };
}

/**
 * Shows the panel docked in the right sidebar, closing the detached card.
 *
 * @param app - The host API.
 */
function showDockedPanel(app: GeoLibreAppAPI): void {
  app.closeFloatingPanel?.(FLOATING_PANEL_ID);
  app.openRightPanel?.(PANEL_ID);
}

/**
 * Shows the panel as a floating card, closing the docked one.
 *
 * @param app - The host API.
 */
function showFloatingPanel(app: GeoLibreAppAPI): void {
  app.closeRightPanel?.(PANEL_ID);
  app.openFloatingPanel?.(FLOATING_PANEL_ID);
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                         */
/* -------------------------------------------------------------------------- */

let unregisterMenu: (() => void) | null = null;

function buildToolbarMenu(app: GeoLibreAppAPI): void {
  unregisterMenu?.();
  unregisterMenu = null;
  const onGlobe = Boolean(primaryViewBridge?.isGlobeActive());
  // On the globe, only presets with a tileset render, so those are all the menu offers.
  const presets = allPresets().filter((preset) => !onGlobe || preset.tileset);
  if (onGlobe && presets.length === 0) return;
  const uploadItems: GeoLibreToolbarMenuItem[] = onGlobe
    ? []
    : [
        {
          id: `${MENU_ID}-url`,
          label: labels.addFromUrl,
          onSelect: () => showDockedPanel(app),
        },
        {
          id: `${MENU_ID}-file`,
          label: labels.addFromFile,
          disabled: !localObjectPicker,
          onSelect: () => {
            showDockedPanel(app);
            void pickAndLoad(app);
          },
        },
      ];
  unregisterMenu =
    app.registerToolbarMenu?.({
      id: MENU_ID,
      label: labels.menuLabel,
      items: [
        ...uploadItems,
        {
          type: "submenu",
          id: `${MENU_ID}-presets`,
          label: labels.presets,
          // An empty submenu opens onto nothing, so say so instead.
          items:
            presets.length > 0
              ? presets.map((preset) => ({
                  id: `${MENU_ID}-preset-${preset.id}`,
                  label: preset.name,
                  onSelect: () => {
                    // Opened first so the progress bar/any error is visible.
                    showDockedPanel(app);
                    void loadPreset(app, preset);
                  },
                }))
              : [
                  {
                    id: `${MENU_ID}-preset-empty`,
                    label: labels.presetsEmpty,
                    disabled: true,
                    onSelect: () => {},
                  },
                ],
        },
        { type: "separator" },
        {
          // A tileset is georeferenced, so the transform editor above does not
          // apply to it; the existing 3D Tiles panel owns that flow.
          id: `${MENU_ID}-3d-tiles`,
          label: labels.threeDTiles,
          onSelect: () => openThreeDTilesLayerPanel(app),
        },
        { type: "separator" },
        {
          id: `${MENU_ID}-panel`,
          label: labels.openPanel,
          onSelect: () => showDockedPanel(app),
        },
        {
          id: `${MENU_ID}-panel-floating`,
          label: labels.openPanelFloating,
          onSelect: () => showFloatingPanel(app),
        },
      ],
    }) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                       */
/* -------------------------------------------------------------------------- */

export const geoim3dObjectsPlugin: GeoLibrePlugin = {
  id: GEOIM3D_OBJECTS_PLUGIN_ID,
  name: "3D objects",
  version: "0.1.0",
  // Tilesets render on both engines; only splats are MapLibre-only,
  // which PrimaryViewBridge above already accounts for.
  engines: ["maplibre", "cesium"],
  // Without this, restoreProjectState's project-restore sweep collapses any
  // right panel this plugin (re)opens from activate() -- including our own
  // wasRightPanelOpen restore below, which runs through that same restore
  // path on every engine switch, not just an actual project load. The panel
  // looked like it vanished; it had just been collapsed to its rail the
  // instant it opened.
  restoresPanelCollapseState: true,

  activate(app: GeoLibreAppAPI) {
    state.app = app;
    buildToolbarMenu(app);
    void loadBundledPresets(app);
    const map = app.getMap?.() as
      | { on: (e: string, h: () => void) => void; off: (e: string, h: () => void) => void }
      | null
      | undefined;
    if (map) {
      const onStyle = () => applyBasemapBuildingVisibility();
      map.on("styledata", onStyle);
      detachStyleWatch = () => map.off("styledata", onStyle);
    }
    app.registerRightPanel?.({
      id: PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      defaultWidth: 340,
      render: mountPanel,
    });
    app.registerFloatingPanel?.({
      id: FLOATING_PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      defaultWidth: 340,
      render: mountPanel,
    });
    // An engine switch closes both panels below (PluginManager deactivates
    // every active plugin on a primaryRenderer change, ours included); reopen
    // whichever one was actually open rather than leaving the user's open
    // panel silently gone.
    if (wasRightPanelOpen) app.openRightPanel?.(PANEL_ID);
    if (wasFloatingPanelOpen) app.openFloatingPanel?.(FLOATING_PANEL_ID);
    // Put back whichever representation — splat or tileset companion — the
    // engine that's current now can actually draw. See ActiveObjectSession.
    void restoreActiveSessions(app);
  },

  deactivate(app: GeoLibreAppAPI) {
    // Recorded before closing below, so activate() (called right back on an
    // engine switch) knows whether to reopen.
    wasRightPanelOpen = app.getActiveRightPanel?.() === PANEL_ID;
    wasFloatingPanelOpen = app.getOpenFloatingPanels?.().includes(FLOATING_PANEL_ID) ?? false;
    unsubscribePrimaryView?.();
    unsubscribePrimaryView = null;
    unregisterMenu?.();
    unregisterMenu = null;
    app.closeRightPanel?.(PANEL_ID);
    app.unregisterRightPanel?.(PANEL_ID);
    app.closeFloatingPanel?.(FLOATING_PANEL_ID);
    app.unregisterFloatingPanel?.(FLOATING_PANEL_ID);

    // Every object goes with the plugin, and every blob made for one is
    // released — they are the largest thing this plugin holds.
    detachStyleWatch?.();
    detachStyleWatch = null;
    // Leave the map as it was found; a hidden basemap layer must not outlive
    // the panel that hid it.
    state.hideBasemapBuildings = false;
    applyBasemapBuildingVisibility();
    unsubscribeTilesetLoading?.();
    unsubscribeTilesetLoading = null;
    unsubscribeStore?.();
    unsubscribeStore = null;
    const store = useAppStore.getState();
    for (const object of state.objects) {
      removeFromRenderer(object);
      if (object.revocable) URL.revokeObjectURL(object.readableUrl);
      store.removeLayer(object.layerId);
    }
    state.objects = [];
    releaseMercatorProjectionLock(PROJECTION_LOCK_KEY, app);
    detachPitchSync?.();
    detachPitchSync = null;
    state.adapter?.destroy();
    state.adapter = null;
    if (state.control) {
      app.removeMapControl(state.control as never);
      state.control = null;
    }
    state.container = null;
    state.app = null;
    state.urlDraft = "";
    state.status = "";
  },
};
