/**
 * VWorld plugin: 2D basemaps, search, geocoding, cadastral/building/zoning
 * WMS layers. API client lives in `vworld-api.ts`; this is the map adapter
 * and panel UI. Layers carry a key-free `vworld://` URL — the protocol
 * handler injects the key per request, so it never reaches the project file.
 */

import {
  useAppStore,
  setCesiumBasemapSentinelResolver,
  type CesiumBasemapImagery,
} from "@geolibre/core";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  VWORLD_ATTRIBUTION,
  VWORLD_BASE_MAPS,
  VWORLD_BOUNDS,
  VWORLD_THEMATIC_LAYERS,
  VWORLD_PRIMARY_ATTRIBUTES,
  VWorldError,
  formatAttribute,
  hasVWorldApiKey,
  isSecondaryAttribute,
  onVWorldApiKeyChange,
  resolveVWorldProtocolUrl,
  vworldGeocode,
  vworldReverseGeocode,
  VWORLD_HEIGHT_PROPERTY,
  vworldBuildings,
  vworldFeatureInfo,
  vworldSearch,
  vworldTileTemplate,
  vworldCoverageView,
  type VWorldAddressType,
  type VWorldErrorKind,
  type VWorldSearchResult,
  type VWorldFeatureInfo,
  type VWorldSearchType,
} from "./vworld-api";

export const VWORLD_PLUGIN_ID = "maplibre-gl-vworld";
const PANEL_ID = "geolibre-vworld-panel";
/**
 * Id of the floating variant of this panel — mutually exclusive with the
 * docked one (`state.container` holds a single element).
 */
const FLOATING_PANEL_ID = `${PANEL_ID}-floating`;
const MENU_ID = "geolibre-vworld-menu";

/**
 * User-facing strings. This package is framework-agnostic and cannot call
 * react-i18next's `t()`, so the host pushes translations through
 * {@link setVWorldLabels}, as `maplibre-graticule` does. Defaults are English.
 */
export interface VWorldLabels {
  title: string;
  getTitle?: () => string;
  /** Label of the toolbar menu this plugin registers. */
  menuLabel: string;
  openPanel: string;
  /** Opens the same panel as a floating card, so two plugins can be up at once. */
  openPanelFloating: string;
  basemaps: string;
  thematicLayers: string;
  buildings3d: string;
  buildingsTruncated: string;
  search: string;
  searchPlaceholder: string;
  searchButton: string;
  geocode: string;
  geocodePlaceholder: string;
  geocodeButton: string;
  addressTypeRoad: string;
  addressTypeParcel: string;
  featureInfo: string;
  featureInfoHint: string;
  featureInfoActive: string;
  featureInfoEmpty: string;
  featureInfoNoLayers: string;
  addFeatureLayer: string;
  rawAttributes: string;
  /** Attribute labels, keyed by the WFS field name. */
  attributes: Record<string, string>;
  reverseGeocode: string;
  reverseGeocodeHint: string;
  reverseGeocodeActive: string;
  noKey: string;
  searchTypePlace: string;
  searchTypeAddress: string;
  searchTypeDistrict: string;
  searchTypeRoad: string;
  zipcode: string;
  base: string;
  white: string;
  midnight: string;
  satellite: string;
  hybrid: string;
  cadastral: string;
  cadastralBonbun: string;
  building: string;
  zoningUrban: string;
  zoningManagement: string;
  zoningAgriculture: string;
  zoningGreenbelt: string;
  errorNoKey: string;
  errorNetwork: string;
  errorTimeout: string;
  errorInvalidKey: string;
  errorRateLimit: string;
  errorInvalidRequest: string;
  errorNotFound: string;
  errorServer: string;
  errorUnknown: string;
}

export const DEFAULT_VWORLD_LABELS: VWorldLabels = {
  title: "VWorld",
  menuLabel: "VWorld",
  openPanel: "Search and geocoding\u2026",
  openPanelFloating: "Search and geocoding (detached)\u2026",
  basemaps: "Base maps",
  thematicLayers: "Thematic layers",
  buildings3d: "3D buildings (current view)",
  buildingsTruncated:
    "Only the first 1,000 buildings in view were returned. Zoom in for a complete set.",
  search: "Search",
  searchPlaceholder: "Place, address, or district",
  searchButton: "Search",
  geocode: "Address to coordinates",
  geocodePlaceholder: "Address",
  geocodeButton: "Locate",
  addressTypeRoad: "Road name",
  addressTypeParcel: "Parcel (jibun)",
  featureInfo: "Feature info",
  featureInfoHint: "Click a thematic layer to inspect it.",
  featureInfoActive: "Click the map\u2026 (click here to stop)",
  featureInfoEmpty: "Nothing here.",
  featureInfoNoLayers: "Add a thematic layer first \u2014 they are what this inspects.",
  addFeatureLayer: "Add as layer",
  rawAttributes: "All source fields",
  attributes: {
    pnu: "Parcel id (PNU)",
    bld_nm: "Building name",
    dong_nm: "Block",
    grnd_flr: "Floors above ground",
    ugrnd_flr: "Floors below ground",
    archarea: "Building area (m\u00b2)",
    totalarea: "Gross floor area (m\u00b2)",
    platarea: "Plot area (m\u00b2)",
    height: "Height (m)",
    bc_rat: "Building coverage (%)",
    vl_rat: "Floor area ratio (%)",
    useapr_day: "Approved for use",
    regist_day: "Registered",
    bd_mgt_sn: "Building register no.",
    jibun: "Lot number",
    addr: "Address",
    sido_nm: "Province",
    sgg_nm: "City/county",
    emd_nm: "Town",
    ri_nm: "Village",
  },
  reverseGeocode: "Coordinates to address",
  reverseGeocodeHint: "Click the map to look up an address.",
  reverseGeocodeActive: "Click the map… (click here to stop)",
  noKey: "Set a VWorld API key in Settings to use this plugin.",
  searchTypePlace: "Place",
  searchTypeAddress: "Address",
  searchTypeDistrict: "District",
  searchTypeRoad: "Road",
  zipcode: "Postal code",
  base: "Base",
  white: "White",
  midnight: "Midnight",
  satellite: "Satellite",
  hybrid: "Hybrid (labels)",
  cadastral: "Cadastral (subdivision)",
  cadastralBonbun: "Cadastral (main lot)",
  building: "Buildings",
  zoningUrban: "Zoning — urban",
  zoningManagement: "Zoning — management",
  zoningAgriculture: "Zoning — agricultural/forest",
  zoningGreenbelt: "Zoning — green belt",
  errorNoKey: "No VWorld API key is configured.",
  errorNetwork: "Could not reach VWorld.",
  errorTimeout: "VWorld did not respond in time.",
  errorInvalidKey: "The VWorld API key was rejected. Check the key and its registered domain.",
  errorRateLimit: "The VWorld daily request limit has been reached.",
  errorInvalidRequest: "VWorld rejected the request.",
  errorNotFound: "No results.",
  errorServer: "VWorld reported a server error.",
  errorUnknown: "The VWorld request failed.",
};

let labels: VWorldLabels = { ...DEFAULT_VWORLD_LABELS };

/** Replaces the user-facing strings and rebuilds an open panel/menu to re-localize live. */
export function setVWorldLabels(next: Partial<VWorldLabels>): void {
  labels = {
    ...labels,
    ...next,
    attributes: { ...labels.attributes, ...(next.attributes ?? {}) },
  };
  rerenderPanel();
  // The menu's label is a plain string copied at build time, unlike the panel's getter.
  if (state.app) buildToolbarMenu(state.app);
}

/** Maps an error to its user-facing message; the kind alone selects a fixed string. */
function errorMessage(error: unknown): string {
  const kind: VWorldErrorKind = error instanceof VWorldError ? error.kind : "unknown";
  const messages: Record<VWorldErrorKind, string> = {
    "no-key": labels.errorNoKey,
    network: labels.errorNetwork,
    timeout: labels.errorTimeout,
    "invalid-key": labels.errorInvalidKey,
    "rate-limit": labels.errorRateLimit,
    "invalid-request": labels.errorInvalidRequest,
    "not-found": labels.errorNotFound,
    server: labels.errorServer,
    unknown: labels.errorUnknown,
  };
  return messages[kind];
}

/* -------------------------------------------------------------------------- */
/* Panel state                                                                  */
/* -------------------------------------------------------------------------- */

interface PanelState {
  app: GeoLibreAppAPI | null;
  container: HTMLElement | null;
  searchType: VWorldSearchType;
  searchResults: VWorldSearchResult[];
  addressType: VWorldAddressType;
  reverseActive: boolean;
  /** Thematic layer ids currently on the map, in the order they were added. */
  thematicLayers: Map<string, string>;
  inspectActive: boolean;
  featureInfo: VWorldFeatureInfo[];
  featureInfoEmpty: boolean;
  reverseResult: { road: string; parcel: string; zipcode: string } | null;
  status: string;
  busy: boolean;
}

const state: PanelState = {
  app: null,
  container: null,
  searchType: "PLACE",
  searchResults: [],
  addressType: "ROAD",
  reverseActive: false,
  thematicLayers: new Map<string, string>(),
  inspectActive: false,
  featureInfo: [],
  featureInfoEmpty: false,
  reverseResult: null,
  status: "",
  busy: false,
};

function rerenderPanel(): void {
  if (state.container) renderPanel(state.container);
}

function setStatus(message: string): void {
  state.status = message;
  rerenderPanel();
}

/* -------------------------------------------------------------------------- */
/* Search / geocoding actions                                                   */
/* -------------------------------------------------------------------------- */

async function runSearch(app: GeoLibreAppAPI, query: string): Promise<void> {
  state.busy = true;
  state.searchResults = [];
  setStatus("");
  try {
    const response = await vworldSearch(query, state.searchType, { size: 20 });
    state.searchResults = response.results;
    if (response.results.length === 0) setStatus(labels.errorNotFound);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
  void app;
}

async function runGeocode(app: GeoLibreAppAPI, address: string): Promise<void> {
  state.busy = true;
  setStatus("");
  try {
    const result = await vworldGeocode(address, state.addressType);
    flyTo(app, result.lng, result.lat);
    setStatus(result.matchedAddress);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

async function runReverseGeocode(lng: number, lat: number): Promise<void> {
  state.busy = true;
  state.reverseResult = null;
  setStatus("");
  try {
    state.reverseResult = await vworldReverseGeocode(lng, lat);
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

function flyTo(app: GeoLibreAppAPI, lng: number, lat: number): void {
  const map = app.getMap?.();
  if (!map) return;
  map.flyTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 15) });
}

let unsubscribeReverse: (() => void) | null = null;

function setReverseActive(app: GeoLibreAppAPI, active: boolean): void {
  state.reverseActive = active;
  unsubscribeReverse?.();
  unsubscribeReverse = null;
  setMapCursor(app, false);
  if (active) {
    if (state.inspectActive) setInspectActive(app, false);
    unsubscribeReverse =
      app.onMapClick?.(({ lng, lat }) => void runReverseGeocode(lng, lat)) ?? null;
    setMapCursor(app, true);
  }
  rerenderPanel();
}

/* -------------------------------------------------------------------------- */
/* Layers and the toolbar menu                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Registers a VWorld base map as a map style (set as the basemap, not
 * stacked as a layer) and returns its sentinel. Exported so Change Basemap
 * offers the same maps as this plugin's own menu, off one definition.
 */
export async function registerVWorldBasemapStyle(id: string): Promise<string | null> {
  const map = VWORLD_BASE_MAPS.find((entry) => entry.id === id);
  // An overlay is not a basemap on its own (Hybrid needs Satellite behind it).
  if (!map || map.overlayFor) return null;
  const overlays = VWORLD_BASE_MAPS.filter((entry) => entry.overlayFor === map.id);

  // Imported here, not at the top: `@geolibre/map` pulls in MapLibre's CSS,
  // a hard error under the Node test runner that loads this file.
  const { registerOfflineBasemapStyle } = await import("@geolibre/map");
  const sentinel = registerOfflineBasemapStyle(`${VWORLD_BASEMAP_STYLE_PREFIX}${map.id}`, {
    version: 8,
    // No glyphs/sprite: this style is raster tiles only.
    sources: Object.fromEntries(
      [map, ...overlays].map((entry) => [
        `vworld-${entry.id}`,
        {
          type: "raster",
          // The key-free template: the protocol handler swaps the key in per
          // request, so nothing is written into a project file.
          tiles: [vworldTileTemplate(entry)],
          tileSize: 256,
          attribution: VWORLD_ATTRIBUTION,
          bounds: VWORLD_BOUNDS,
          minzoom: entry.minzoom,
          maxzoom: entry.maxzoom,
        },
      ]),
    ),
    // Order matters: the overlays follow the base map, so the annotation is
    // drawn over the imagery rather than under it.
    layers: [map, ...overlays].map((entry) => ({
      id: `vworld-${entry.id}`,
      type: "raster" as const,
      source: `vworld-${entry.id}`,
    })),
  });
  appliedSentinels.set(sentinel, map.id);
  return sentinel;
}

/** The sentinels this session has registered — a sentinel from a past session never resolves. */
const appliedSentinels = new Map<string, string>();

/** The base map a style URL refers to, if this session applied it. */
export function vworldBasemapIdFor(styleUrl: string | undefined): string | null {
  return (styleUrl && appliedSentinels.get(styleUrl)) || null;
}

/** Style-id prefix for a VWorld basemap, so the picker can tell which is active. */
export const VWORLD_BASEMAP_STYLE_PREFIX = "vworld-";

/**
 * geoIM3D's {@link CesiumBasemapSentinelResolver}: draws a VWorld basemap
 * sentinel on the Cesium globe (the core catalog doesn't know it). Resolves
 * the key into the template directly since this descriptor is never saved.
 */
export function vworldCesiumBasemapImagery(styleUrl: string): CesiumBasemapImagery | undefined {
  const id = vworldBasemapIdFor(styleUrl);
  const map = id ? VWORLD_BASE_MAPS.find((entry) => entry.id === id) : undefined;
  if (!map) return undefined;
  const overlay = VWORLD_BASE_MAPS.find((entry) => entry.overlayFor === map.id);
  try {
    return {
      kind: "xyz",
      template: resolveVWorldProtocolUrl(vworldTileTemplate(map)),
      attribution: VWORLD_ATTRIBUTION,
      maximumLevel: map.maxzoom,
      ...(overlay
        ? { overlayTemplate: resolveVWorldProtocolUrl(vworldTileTemplate(overlay)) }
        : {}),
    };
  } catch {
    // No VWorld key configured — same case the 2D map's own WMS calls refuse.
    return undefined;
  }
}

/** Registers {@link vworldCesiumBasemapImagery}, independent of plugin activation. */
export function registerVWorldCesiumBasemap(): void {
  setCesiumBasemapSentinelResolver(vworldCesiumBasemapImagery);
}

/** Applies a VWorld base map as the map's basemap, moving the view into its coverage. */
async function addBaseMapLayer(app: GeoLibreAppAPI, id: string): Promise<void> {
  const sentinel = await registerVWorldBasemapStyle(id);
  if (!sentinel) return;

  // VWorld only covers Korea from zoom 6 down; jump there if needed.
  const map = app.getMap?.();
  const centre = map?.getCenter();
  if (map && centre) {
    const view = vworldCoverageView({
      longitude: centre.lng,
      latitude: centre.lat,
      zoom: map.getZoom(),
    });
    if (view) map.jumpTo({ center: [view.longitude, view.latitude], zoom: view.zoom });
  }
  app.setBasemap(sentinel);
}

/** Adds a VWorld thematic layer (cadastral, building, zoning) as WMS. */
function addThematicLayer(app: GeoLibreAppAPI, id: string): void {
  const layer = VWORLD_THEMATIC_LAYERS.find((entry) => entry.id === id);
  if (!layer) return;
  const layerId = app.addWmsLayer?.(labelFor(layer.labelKey), {
    url: "vworld://wms",
    layers: layer.typename,
    transparent: true,
    format: "image/png",
    version: "1.3.0",
    attribution: VWORLD_ATTRIBUTION,
    bounds: VWORLD_BOUNDS,
    minzoom: layer.minzoom,
  });
  // WMS tiles carry no features, so a click needs the layer id to query WFS instead.
  if (layerId) state.thematicLayers.set(layer.id, layerId);
  rerenderPanel();
}

/** Resolves a label from the pushed translations, or the key itself when untranslated. */
function labelFor(key: string): string {
  return (labels as unknown as Record<string, string>)[key] ?? key;
}

/** Adds a fetched building set as an extruded layer; injected since the plugin API can't style layers. */
export type VWorldBuildingLayerAdder = (input: {
  name: string;
  geojson: unknown;
  /** Feature property holding the height in metres. */
  heightProperty: string;
}) => void;

let buildingLayerAdder: VWorldBuildingLayerAdder | null = null;

/**
 * Registers how extruded building layers are added.
 *
 * @param adder - The host's implementation, or null to disable the entry.
 */
export function setVWorldBuildingLayerAdder(adder: VWorldBuildingLayerAdder | null): void {
  buildingLayerAdder = adder;
}

/** Loads the buildings in the current view (WFS caps at 1000) and adds them as a 3D layer. */
async function addBuildingsInView(app: GeoLibreAppAPI): Promise<void> {
  // Not `app.getMap()?.getBounds()`: that map is MapLibre-only and null while
  // the globe is primary (issue #2217), which would silently disable this on
  // Cesium. `getViewBounds()` reads whichever engine is live.
  const bounds = app.getViewBounds?.();
  if (!bounds || !buildingLayerAdder) return;

  state.busy = true;
  setStatus("");
  try {
    const result = await vworldBuildings(bounds);
    buildingLayerAdder({
      name: labels.buildings3d,
      geojson: result.geojson,
      heightProperty: VWORLD_HEIGHT_PROPERTY,
    });
    if (result.truncated) setStatus(labels.buildingsTruncated);
  } catch (error) {
    setStatus(errorMessage(error));
    app.openRightPanel?.(PANEL_ID);
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

let unregisterMenu: (() => void) | null = null;

/** Mounts the panel body into whichever shell asked for it — docked or floating. */
function mountPanel(container: HTMLElement): () => void {
  state.container = container;
  renderPanel(container);
  return () => {
    // Only clear if still mounted: closing after detaching would blank the new one.
    if (state.container === container) state.container = null;
  };
}

/** Shows the panel docked in the right sidebar, closing the detached card. */
function showDockedPanel(app: GeoLibreAppAPI): void {
  app.closeFloatingPanel?.(FLOATING_PANEL_ID);
  app.openRightPanel?.(PANEL_ID);
}

/** Shows the panel as a floating card, closing the docked one. */
function showFloatingPanel(app: GeoLibreAppAPI): void {
  app.closeRightPanel?.(PANEL_ID);
  app.openFloatingPanel?.(FLOATING_PANEL_ID);
}

/** Registers (or rebuilds) the VWorld toolbar menu; rebuilt since disabled state follows the key. */
function buildToolbarMenu(app: GeoLibreAppAPI): void {
  const ready = hasVWorldApiKey();
  unregisterMenu?.();
  unregisterMenu =
    app.registerToolbarMenu?.({
      id: MENU_ID,
      label: labels.menuLabel,
      items: [
        {
          type: "submenu",
          id: `${MENU_ID}-basemaps`,
          label: labels.basemaps,
          // Overlays are folded into the base map they annotate, so they are
          // not offered on their own.
          items: VWORLD_BASE_MAPS.filter((map) => !map.overlayFor).map((map) => ({
            id: `${MENU_ID}-basemap-${map.id}`,
            label: labelFor(map.labelKey),
            disabled: !ready,
            onSelect: () => void addBaseMapLayer(app, map.id),
          })),
        },
        {
          type: "submenu",
          id: `${MENU_ID}-thematic`,
          label: labels.thematicLayers,
          items: VWORLD_THEMATIC_LAYERS.map((layer) => ({
            id: `${MENU_ID}-thematic-${layer.id}`,
            label: labelFor(layer.labelKey),
            disabled: !ready,
            onSelect: () => addThematicLayer(app, layer.id),
          })),
        },
        {
          id: `${MENU_ID}-buildings-3d`,
          label: labels.buildings3d,
          disabled: !ready,
          onSelect: () => void addBuildingsInView(app),
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
/* Thematic feature inspection                                                  */
/* -------------------------------------------------------------------------- */

/** The thematic layers still on the map (checked against the store, not this plugin's own record). */
function activeThematicTypenames(): Array<{ id: string; typename: string }> {
  const live = new Set(useAppStore.getState().layers.map((layer) => layer.id));
  for (const [thematicId, layerId] of state.thematicLayers) {
    if (!live.has(layerId)) state.thematicLayers.delete(thematicId);
  }
  return VWORLD_THEMATIC_LAYERS.filter((layer) => state.thematicLayers.has(layer.id)).map(
    (layer) => ({ id: layer.id, typename: layer.typename }),
  );
}

/** Looks up thematic features at a point: WMS serves images, so this queries the WFS twin instead. */
async function runFeatureInfo(lon: number, lat: number): Promise<void> {
  const typenames = activeThematicTypenames();
  if (typenames.length === 0) {
    setStatus(labels.featureInfoNoLayers);
    return;
  }

  state.busy = true;
  state.featureInfo = [];
  state.featureInfoEmpty = false;
  setStatus("");
  try {
    const found = await vworldFeatureInfo(typenames, lon, lat);
    state.featureInfo = found;
    state.featureInfoEmpty = found.length === 0;
  } catch (error) {
    setStatus(errorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

let unsubscribeInspect: (() => void) | null = null;

/** Turns click-to-inspect on or off, via `onMapClick` so it works on either engine. */
function setInspectActive(app: GeoLibreAppAPI, active: boolean): void {
  state.inspectActive = active;
  unsubscribeInspect?.();
  unsubscribeInspect = null;
  setMapCursor(app, false);
  if (active) {
    // Mutually exclusive with reverse geocoding: both consume a map click, and
    // leaving both on would run two lookups per click.
    if (state.reverseActive) setReverseActive(app, false);
    unsubscribeInspect = app.onMapClick?.(({ lng, lat }) => void runFeatureInfo(lng, lat)) ?? null;
    setMapCursor(app, true);
  }
  rerenderPanel();
}

/** Shows the picking cursor on whichever engine's canvas is live. */
function setMapCursor(app: GeoLibreAppAPI, picking: boolean): void {
  const map = app.getMap?.();
  if (map) map.getCanvas().style.cursor = picking ? "crosshair" : "";
  const cesiumCanvas = app.getCesiumScene?.()?.canvas;
  if (cesiumCanvas) cesiumCanvas.style.cursor = picking ? "crosshair" : "";
}

/** Adds one inspected feature as its own vector layer, styleable/measurable unlike the WMS overlay. */
function addFeatureAsLayer(app: GeoLibreAppAPI, info: VWorldFeatureInfo): void {
  if (!info.geometry) return;
  const layer = VWORLD_THEMATIC_LAYERS.find((entry) => entry.id === info.layerId);
  const name = layer ? labelFor(layer.labelKey) : info.layerId;
  // Prefer the building's own name over the service's opaque feature id.
  const subject = formatAttribute(info.properties.bld_nm) || formatAttribute(info.properties.pnu);
  app.addGeoJsonLayer(
    subject ? `${name} · ${subject}` : name,
    {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: info.geometry as never,
          properties: info.properties as Record<string, unknown>,
        },
      ],
    },
    `vworld://wfs/${info.featureId}`,
  );
}

/** Renders one inspected feature: readable attributes first, opaque schema ids behind a disclosure. */
function featureInfoBlock(app: GeoLibreAppAPI, info: VWorldFeatureInfo): HTMLElement {
  const wrapper = element("div", "vworld-feature");
  const layer = VWORLD_THEMATIC_LAYERS.find((entry) => entry.id === info.layerId);
  wrapper.appendChild(
    element(
      "div",
      "geolibre-plugin-panel__section-title",
      layer ? labelFor(layer.labelKey) : info.layerId,
    ),
  );

  const primary = element("dl", "geolibre-plugin-panel__address");
  for (const spec of VWORLD_PRIMARY_ATTRIBUTES) {
    if (!(spec.field in info.properties)) continue;
    const text = formatAttribute(info.properties[spec.field], spec.format);
    if (!text) continue;
    primary.appendChild(
      element(
        "dt",
        "geolibre-plugin-panel__address-term",
        labels.attributes[spec.field] ?? spec.field,
      ),
    );
    primary.appendChild(element("dd", "geolibre-plugin-panel__address-value", text));
  }
  wrapper.appendChild(primary);

  const rest = Object.entries(info.properties).filter(
    ([field, value]) => isSecondaryAttribute(field) && formatAttribute(value),
  );
  if (rest.length > 0) {
    const details = element("details", "vworld-feature__raw");
    details.appendChild(element("summary", "vworld-feature__raw-summary", labels.rawAttributes));
    const list = element("dl", "geolibre-plugin-panel__address");
    for (const [field, value] of rest) {
      list.appendChild(element("dt", "geolibre-plugin-panel__address-term", field));
      list.appendChild(
        element("dd", "geolibre-plugin-panel__address-value", formatAttribute(value)),
      );
    }
    details.appendChild(list);
    wrapper.appendChild(details);
  }

  if (info.geometry) {
    const addButton = element(
      "button",
      "geolibre-plugin-panel__button geolibre-plugin-panel__button--wide",
      labels.addFeatureLayer,
    );
    addButton.type = "button";
    addButton.addEventListener("click", () => addFeatureAsLayer(app, info));
    wrapper.appendChild(addButton);
  }
  return wrapper;
}

/* -------------------------------------------------------------------------- */
/* Panel DOM                                                                    */
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

function renderPanel(container: HTMLElement): void {
  const app = state.app;
  if (!app) return;
  container.textContent = "";
  container.className = "geolibre-plugin-panel";

  if (!hasVWorldApiKey()) {
    container.appendChild(element("p", "geolibre-plugin-panel__notice", labels.noKey));
    return;
  }

  // Base maps and the cadastral/building/zoning layers are added from the
  // VWorld toolbar menu, which the plugin registers itself. This panel is the
  // interactive tooling, which has no place in a menu.

  // Thematic feature inspection.
  container.appendChild(sectionTitle(labels.featureInfo));
  const inspectButton = element(
    "button",
    `geolibre-plugin-panel__button geolibre-plugin-panel__button--wide${
      state.inspectActive ? " geolibre-plugin-panel__button--active" : ""
    }`,
    state.inspectActive ? labels.featureInfoActive : labels.featureInfoHint,
  );
  inspectButton.type = "button";
  inspectButton.addEventListener("click", () => setInspectActive(app, !state.inspectActive));
  container.appendChild(inspectButton);

  if (state.featureInfoEmpty) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", labels.featureInfoEmpty));
  }
  for (const info of state.featureInfo) {
    container.appendChild(featureInfoBlock(app, info));
  }

  // Integrated search.
  container.appendChild(sectionTitle(labels.search));
  const searchForm = element("form", "geolibre-plugin-panel__form");
  const searchInput = element("input", "geolibre-plugin-panel__input");
  searchInput.type = "search";
  searchInput.placeholder = labels.searchPlaceholder;
  const typeSelect = element("select", "geolibre-plugin-panel__select");
  const searchTypes: ReadonlyArray<[VWorldSearchType, string]> = [
    ["PLACE", labels.searchTypePlace],
    ["ADDRESS", labels.searchTypeAddress],
    ["DISTRICT", labels.searchTypeDistrict],
    ["ROAD", labels.searchTypeRoad],
  ];
  for (const [value, text] of searchTypes) {
    const option = element("option", "", text);
    option.value = value;
    option.selected = value === state.searchType;
    typeSelect.appendChild(option);
  }
  typeSelect.addEventListener("change", () => {
    state.searchType = typeSelect.value as VWorldSearchType;
  });
  const searchSubmit = element("button", "geolibre-plugin-panel__button", labels.searchButton);
  searchSubmit.type = "submit";
  searchSubmit.disabled = state.busy;
  searchForm.append(typeSelect, searchInput, searchSubmit);
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void runSearch(app, searchInput.value);
  });
  container.appendChild(searchForm);

  if (state.searchResults.length > 0) {
    const list = element("ul", "geolibre-plugin-panel__results");
    for (const result of state.searchResults) {
      const item = element("li", "geolibre-plugin-panel__result");
      const button = element("button", "geolibre-plugin-panel__result-button");
      button.type = "button";
      button.appendChild(element("span", "geolibre-plugin-panel__result-title", result.title));
      if (result.subtitle) {
        button.appendChild(
          element("span", "geolibre-plugin-panel__result-subtitle", result.subtitle),
        );
      }
      button.addEventListener("click", () => flyTo(app, result.lng, result.lat));
      item.appendChild(button);
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  // Address → coordinates.
  container.appendChild(sectionTitle(labels.geocode));
  const geocodeForm = element("form", "geolibre-plugin-panel__form");
  const addressTypeSelect = element("select", "geolibre-plugin-panel__select");
  const addressTypes: ReadonlyArray<[VWorldAddressType, string]> = [
    ["ROAD", labels.addressTypeRoad],
    ["PARCEL", labels.addressTypeParcel],
  ];
  for (const [value, text] of addressTypes) {
    const option = element("option", "", text);
    option.value = value;
    option.selected = value === state.addressType;
    addressTypeSelect.appendChild(option);
  }
  addressTypeSelect.addEventListener("change", () => {
    state.addressType = addressTypeSelect.value as VWorldAddressType;
  });
  const addressInput = element("input", "geolibre-plugin-panel__input");
  addressInput.type = "text";
  addressInput.placeholder = labels.geocodePlaceholder;
  const geocodeSubmit = element("button", "geolibre-plugin-panel__button", labels.geocodeButton);
  geocodeSubmit.type = "submit";
  geocodeSubmit.disabled = state.busy;
  geocodeForm.append(addressTypeSelect, addressInput, geocodeSubmit);
  geocodeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void runGeocode(app, addressInput.value);
  });
  container.appendChild(geocodeForm);

  // Coordinates → address.
  container.appendChild(sectionTitle(labels.reverseGeocode));
  const reverseButton = element(
    "button",
    `geolibre-plugin-panel__button geolibre-plugin-panel__button--wide${
      state.reverseActive ? " geolibre-plugin-panel__button--active" : ""
    }`,
    state.reverseActive ? labels.reverseGeocodeActive : labels.reverseGeocodeHint,
  );
  reverseButton.type = "button";
  reverseButton.addEventListener("click", () => setReverseActive(app, !state.reverseActive));
  container.appendChild(reverseButton);

  if (state.reverseResult) {
    const list = element("dl", "geolibre-plugin-panel__address");
    const rows: ReadonlyArray<[string, string]> = [
      [labels.addressTypeRoad, state.reverseResult.road],
      [labels.addressTypeParcel, state.reverseResult.parcel],
      [labels.zipcode, state.reverseResult.zipcode],
    ];
    for (const [term, value] of rows) {
      if (!value) continue;
      list.appendChild(element("dt", "geolibre-plugin-panel__address-term", term));
      list.appendChild(element("dd", "geolibre-plugin-panel__address-value", value));
    }
    container.appendChild(list);
  }

  if (state.status) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", state.status));
  }
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                       */
/* -------------------------------------------------------------------------- */

let unsubscribeKey: (() => void) | null = null;

export const maplibreVWorldPlugin: GeoLibrePlugin = {
  id: VWORLD_PLUGIN_ID,
  name: "VWorld",
  version: "0.1.0",
  // Its vworld:// tiles already render on the globe via the shared
  // MapLibre protocol handler (cesium-protocol-imagery.ts).
  engines: ["maplibre", "cesium"],
  // Deliberately not activeByDefault, diverging from
  // docs-internal/directives/04_FEATURE_PROFILE.md (default-on).

  activate(app: GeoLibreAppAPI) {
    state.app = app;
    buildToolbarMenu(app);
    // Rebuild when a key is saved or deleted so the entries stop being disabled
    // without the user having to reactivate the plugin.
    unsubscribeKey = onVWorldApiKeyChange(() => {
      if (state.app) buildToolbarMenu(state.app);
      rerenderPanel();
    });
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
    app.openRightPanel?.(PANEL_ID);
  },

  deactivate(app: GeoLibreAppAPI) {
    setReverseActive(app, false);
    setInspectActive(app, false);
    unsubscribeKey?.();
    unsubscribeKey = null;
    unregisterMenu?.();
    unregisterMenu = null;
    app.closeRightPanel?.(PANEL_ID);
    app.unregisterRightPanel?.(PANEL_ID);
    app.closeFloatingPanel?.(FLOATING_PANEL_ID);
    app.unregisterFloatingPanel?.(FLOATING_PANEL_ID);
    // The vworld:// protocol is registered by the app at startup, not here:
    // layers added from Add Data must keep resolving after this panel closes.
    state.container = null;
    state.app = null;
    state.searchResults = [];
    state.reverseResult = null;
    state.featureInfo = [];
    state.thematicLayers.clear();
    state.status = "";
  },
};
