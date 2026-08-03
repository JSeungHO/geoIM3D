/**
 * VWorld (국토교통부 공간정보 오픈플랫폼) plugin.
 *
 * Covers the first-phase scope of the VWorld integration directive: the 2D base
 * maps, integrated search, address→coordinate and coordinate→address
 * conversion, and the cadastral / building / zoning WMS layers.
 *
 * The API client, DTOs, and error classification live in `vworld-api.ts`; this
 * file is the map adapter and the panel UI. Two things worth knowing before
 * editing:
 *
 * - **The API key never reaches a layer record.** VWorld puts the key in the
 *   request URL, and layer URLs are saved into the project file, so every layer
 *   this plugin adds carries a key-free `vworld://` URL that a MapLibre custom
 *   protocol rewrites at request time. A project shared with a colleague
 *   therefore contains the layers but not the credential, and renders as soon as
 *   they enter their own key.
 * - **No offline tile cache.** The directive holds that back pending a review of
 *   VWorld's redistribution terms, so nothing here persists tiles.
 */

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import {
  VWORLD_ATTRIBUTION,
  VWORLD_BASE_MAPS,
  VWORLD_BOUNDS,
  VWORLD_THEMATIC_LAYERS,
  VWorldError,
  hasVWorldApiKey,
  onVWorldApiKeyChange,
  vworldGeocode,
  vworldReverseGeocode,
  VWORLD_HEIGHT_PROPERTY,
  vworldBuildings,
  vworldFeatureInfo,
  vworldSearch,
  vworldTileTemplate,
  type VWorldAddressType,
  type VWorldErrorKind,
  type VWorldSearchResult,
  type VWorldFeatureInfo,
  type VWorldSearchType,
} from "./vworld-api";

export const VWORLD_PLUGIN_ID = "maplibre-gl-vworld";
const PANEL_ID = "geolibre-vworld-panel";
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

/**
 * Replaces the user-facing strings. The host calls this on every language
 * change; an open panel is rebuilt so it re-localizes live.
 *
 * @param next - Partial overrides merged over the current strings.
 */
export function setVWorldLabels(next: Partial<VWorldLabels>): void {
  labels = {
    ...labels,
    ...next,
    attributes: { ...labels.attributes, ...(next.attributes ?? {}) },
  };
  rerenderPanel();
}

/**
 * Maps an error to its user-facing message. Nothing here interpolates the
 * request URL or the key — the kind alone selects a fixed string.
 *
 * @param error - The thrown value.
 * @returns The message to show.
 */
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
  thematicLayers: Set<string>;
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
  thematicLayers: new Set<string>(),
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
    // The DTO states EPSG:4326, which is what the map expects, so the point
    // goes straight to the view with no conversion step.
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
 * Adds a VWorld base map as a WMTS layer.
 *
 * The URL is the key-free `vworld://` template: layer URLs are saved into the
 * project file, and the real request URL carries the API key as a path segment.
 * The protocol handler swaps the key in per request.
 *
 * @param app - The host API.
 * @param id - The base map id from `VWORLD_BASE_MAPS`.
 */
function addBaseMapLayer(app: GeoLibreAppAPI, id: string): void {
  const map = VWORLD_BASE_MAPS.find((entry) => entry.id === id);
  if (!map) return;
  app.addWmtsLayer?.(labelFor(map.labelKey), vworldTileTemplate(map), {
    attribution: VWORLD_ATTRIBUTION,
    bounds: VWORLD_BOUNDS,
    minzoom: map.minzoom,
    maxzoom: map.maxzoom,
    tileSize: 256,
  });
}

/**
 * Adds a VWorld thematic layer (cadastral, building, zoning) as WMS.
 *
 * @param app - The host API.
 * @param id - The thematic layer id from `VWORLD_THEMATIC_LAYERS`.
 */
function addThematicLayer(app: GeoLibreAppAPI, id: string): void {
  const layer = VWORLD_THEMATIC_LAYERS.find((entry) => entry.id === id);
  if (!layer) return;
  app.addWmsLayer?.(labelFor(layer.labelKey), {
    // The host appends the GetMap query to this endpoint; the protocol handler
    // then rewrites the whole URL and appends the key.
    url: "vworld://wms",
    layers: layer.typename,
    transparent: true,
    format: "image/png",
    // VWorld's WMS documents 1.3.0 as its default.
    version: "1.3.0",
    attribution: VWORLD_ATTRIBUTION,
    bounds: VWORLD_BOUNDS,
    minzoom: layer.minzoom,
  });
  // Remembered so a map click knows which typenames to query: the WMS tiles
  // themselves carry no features, so the click has to ask WFS instead.
  state.thematicLayers.add(layer.id);
  rerenderPanel();
}

/**
 * Resolves a label from the pushed translations by its key name.
 *
 * @param key - The {@link VWorldLabels} field name.
 * @returns The translated label, or the key itself when untranslated.
 */
function labelFor(key: string): string {
  return (labels as unknown as Record<string, string>)[key] ?? key;
}

/**
 * Adds a fetched building set as an extruded layer.
 *
 * Injected by the host because the plugin API has no way to set a layer's
 * style, and extrusion is the whole point of this layer — added flat it is
 * indistinguishable from the WMS overlay it replaces. Mirrors the existing
 * host-injection points (`setTimelapseVideoSaver`, `setLocalRasterPicker`).
 */
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

/**
 * Loads the buildings in the current view and adds them as a 3D layer.
 *
 * Scoped to the visible extent because WFS caps a response at 1000 features:
 * a nationwide request would return an arbitrary thousand rather than an error.
 *
 * @param app - The host API.
 */
async function addBuildingsInView(app: GeoLibreAppAPI): Promise<void> {
  const map = app.getMap?.();
  if (!map || !buildingLayerAdder) return;
  const bounds = map.getBounds();

  state.busy = true;
  setStatus("");
  try {
    const result = await vworldBuildings([
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ]);
    buildingLayerAdder({
      name: labels.buildings3d,
      geojson: result.geojson,
      heightProperty: VWORLD_HEIGHT_PROPERTY,
    });
    // Saying so matters: a truncated view looks like a complete one, and the
    // user would read the missing blocks as gaps in the source data.
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

/**
 * Registers (or rebuilds) the VWorld toolbar menu.
 *
 * Rebuilt rather than mutated: `registerToolbarMenu` replaces a menu with the
 * same id, and the entries' disabled state depends on whether a key is
 * configured, which changes at runtime.
 *
 * @param app - The host API.
 */
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
          items: VWORLD_BASE_MAPS.map((map) => ({
            id: `${MENU_ID}-basemap-${map.id}`,
            label: labelFor(map.labelKey),
            disabled: !ready,
            onSelect: () => addBaseMapLayer(app, map.id),
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
          onSelect: () => app.openRightPanel?.(PANEL_ID),
        },
      ],
    }) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Thematic feature inspection                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Looks up the thematic features under a clicked point.
 *
 * The thematic layers render as WMS images, which carry no features, so a click
 * cannot hit anything on the map itself. The same data is served as WFS, so the
 * click becomes a small bbox query against whichever thematic layers are on.
 *
 * @param lon - Longitude in EPSG:4326.
 * @param lat - Latitude in EPSG:4326.
 */
async function runFeatureInfo(lon: number, lat: number): Promise<void> {
  const typenames = VWORLD_THEMATIC_LAYERS.filter((layer) =>
    state.thematicLayers.has(layer.id),
  ).map((layer) => ({ id: layer.id, typename: layer.typename }));
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

/**
 * Turns click-to-inspect on or off.
 *
 * Subscribes through `onMapClick` rather than `getMap().on("click")`: the 2D map
 * is hidden and takes no pointer events while the globe is showing, so a
 * handler attached to it would silently stop working on the Cesium tab.
 *
 * @param app - The host API.
 * @param active - Whether clicks should query the thematic layers.
 */
function setInspectActive(app: GeoLibreAppAPI, active: boolean): void {
  state.inspectActive = active;
  unsubscribeInspect?.();
  unsubscribeInspect = null;
  setMapCursor(app, false);
  if (active) {
    // Mutually exclusive with reverse geocoding: both consume a map click, and
    // leaving both on would run two lookups per click.
    if (state.reverseActive) setReverseActive(app, false);
    unsubscribeInspect =
      app.onMapClick?.(({ lng, lat }) => void runFeatureInfo(lng, lat)) ?? null;
    setMapCursor(app, true);
  }
  rerenderPanel();
}

/**
 * Shows the picking cursor on the 2D map.
 *
 * Only the MapLibre canvas is styled: Cesium draws its own cursor, and the
 * globe's canvas is not the host's to restyle.
 *
 * @param app - The host API.
 * @param picking - Whether a click tool is armed.
 */
function setMapCursor(app: GeoLibreAppAPI, picking: boolean): void {
  const map = app.getMap?.();
  if (map) map.getCanvas().style.cursor = picking ? "crosshair" : "";
}

/**
 * Adds one inspected feature to the map as its own vector layer.
 *
 * The WMS overlay cannot be styled, measured, or exported; the WFS geometry
 * behind it can, which is what makes a single clicked parcel or building useful
 * beyond reading its numbers.
 *
 * @param app - The host API.
 * @param info - The feature to add.
 */
function addFeatureAsLayer(app: GeoLibreAppAPI, info: VWorldFeatureInfo): void {
  if (!info.geometry) return;
  const layer = VWORLD_THEMATIC_LAYERS.find((entry) => entry.id === info.layerId);
  const name = layer ? labelFor(layer.labelKey) : info.layerId;
  app.addGeoJsonLayer(
    `${name} · ${info.featureId || ""}`.trim(),
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

/** Renders one attribute value, hiding the service's empty placeholders. */
function attributeText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  // VWorld returns unset fields as null, "None", or a zero that means "not
  // recorded" for the area/ratio columns; showing 0 m² as a fact is worse than
  // showing nothing.
  if (text === "" || text === "None" || text === "null") return "";
  return text;
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
    container.appendChild(
      element("p", "geolibre-plugin-panel__status", labels.featureInfoEmpty),
    );
  }
  for (const info of state.featureInfo) {
    const layer = VWORLD_THEMATIC_LAYERS.find((entry) => entry.id === info.layerId);
    container.appendChild(
      element(
        "div",
        "geolibre-plugin-panel__section-title",
        layer ? labelFor(layer.labelKey) : info.layerId,
      ),
    );
    const list = element("dl", "geolibre-plugin-panel__address");
    for (const [field, raw] of Object.entries(info.properties)) {
      const text = attributeText(raw);
      if (!text) continue;
      // Unlabelled fields are shown under their raw name rather than dropped:
      // the schema carries more columns than are worth translating, and a
      // hidden value is worse than an untranslated one.
      const label = labels.attributes[field] ?? field;
      list.appendChild(element("dt", "geolibre-plugin-panel__address-term", label));
      list.appendChild(element("dd", "geolibre-plugin-panel__address-value", text));
    }
    container.appendChild(list);
    if (info.geometry) {
      const addButton = element(
        "button",
        "geolibre-plugin-panel__button",
        labels.addFeatureLayer,
      );
      addButton.type = "button";
      addButton.addEventListener("click", () => addFeatureAsLayer(app, info));
      container.appendChild(addButton);
    }
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
        button.appendChild(element("span", "geolibre-plugin-panel__result-subtitle", result.subtitle));
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
  // Deliberately *not* activeByDefault: the user asked for it off, so the
  // plugin (and its toolbar menu) appear only once switched on from the Plugins
  // menu, like every other optional plugin. Note this diverges from
  // docs-internal/directives/04_FEATURE_PROFILE.md, which specifies the VWorld
  // plugin as default-on with a guidance state when no key is set.

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
      render(container) {
        state.container = container;
        renderPanel(container);
        return () => {
          state.container = null;
        };
      },
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
