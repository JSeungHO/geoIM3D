/**
 * KMA (기상청) weather plugin.
 *
 * The interactive half of the KMA integration: click the map for current
 * conditions and the short-term forecast at that point, list the active weather
 * warnings, and plot typhoon positions. The observation-station *layers* are
 * added from Add Data → KMA instead, since they are data layers like any other.
 *
 * The API client, grid conversion, DTOs, and error classification live in
 * `kma-api.ts`; this file is the panel and the map interaction.
 */

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { airKoreaGeoJson, airKoreaReadings, airKoreaStations } from "./airkorea-api";
import {
  KMA_PTY_LABELS,
  KMA_SKY_LABELS,
  KMA_STATION_NETWORKS,
  KmaError,
  compassIndex,
  displayableValues,
  groupForecastSlots,
  hasKmaApiKey,
  isMissingValue,
  kmaCurrentConditions,
  kmaStations,
  kmaStationsToGeoJson,
  onKmaApiKeyChange,
  kmaTyphoons,
  kmaVillageForecast,
  kmaWarnings,
  type KmaErrorKind,
  type KmaPointConditions,
  type KmaTyphoonPosition,
  type KmaWarning,
} from "./kma-api";

export const KMA_PLUGIN_ID = "maplibre-gl-kma";
const PANEL_ID = "geolibre-kma-panel";
const MENU_ID = "geolibre-kma-menu";
const TYPHOON_LAYER_ID = "geolibre-kma-typhoons";

/**
 * User-facing strings, pushed by the host through {@link setKmaLabels} — this
 * package cannot call react-i18next's `t()`. Defaults are English.
 */
export interface KmaLabels {
  title: string;
  getTitle?: () => string;
  /** Label of the toolbar menu this plugin registers. */
  menuLabel: string;
  openPanel: string;
  stations: string;
  airQuality: string;
  /** Station-network labels, keyed by the labelKey in KMA_STATION_NETWORKS. */
  networks: Record<string, string>;
  noKey: string;
  pickPoint: string;
  pickPointActive: string;
  currentConditions: string;
  forecast: string;
  warnings: string;
  typhoons: string;
  refresh: string;
  addTyphoonLayer: string;
  removeTyphoonLayer: string;
  loading: string;
  gridCell: string;
  /** Row label for the combined wind direction + speed. */
  wind: string;
  /** 8-point compass names, starting at north. */
  compass: string[];
  /** Shown in place of the agency's ±900 missing-data sentinel. */
  missingValue: string;
  /** Category labels, keyed by KMA category code (T1H, PTY, …). */
  categories: Record<string, string>;
  /** Sky/precipitation condition labels, keyed by the code names in kma-api. */
  conditions: Record<string, string>;
  errorNoKey: string;
  errorNetwork: string;
  errorTimeout: string;
  errorInvalidKey: string;
  errorAccessDenied: string;
  errorRateLimit: string;
  errorInvalidRequest: string;
  errorNoData: string;
  errorServer: string;
  errorUnknown: string;
}

export const DEFAULT_KMA_LABELS: KmaLabels = {
  title: "Weather (KMA)",
  menuLabel: "Weather (KMA)",
  openPanel: "Weather lookup\u2026",
  stations: "Observation networks",
  airQuality: "Air quality (AirKorea)",
  networks: {
    stationsAws: "AWS observation stations",
    stationsRadar: "Radar sites",
    stationsBuoy: "Ocean buoys",
    stationsWaveBuoy: "Wave buoys",
    stationsPm10: "PM10 monitoring sites",
  },
  noKey: "Set a KMA service key in Settings to use this plugin.",
  pickPoint: "Click the map for weather at a point.",
  pickPointActive: "Click the map… (click here to stop)",
  currentConditions: "Current conditions",
  forecast: "Short-term forecast",
  warnings: "Weather warnings",
  typhoons: "Typhoons",
  refresh: "Refresh",
  addTyphoonLayer: "Add as layer",
  removeTyphoonLayer: "Remove layer",
  loading: "Loading…",
  gridCell: "Grid cell",
  wind: "Wind (m/s)",
  compass: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"],
  missingValue: "No data",
  categories: {
    T1H: "Temperature (°C)",
    TMP: "Temperature (°C)",
    RN1: "Precipitation (mm)",
    PCP: "Precipitation (mm)",
    PTY: "Precipitation type",
    SKY: "Sky",
    REH: "Humidity (%)",
    WSD: "Wind speed (m/s)",
    VEC: "Wind direction (°)",
    POP: "Chance of precipitation (%)",
    SNO: "Snowfall (cm)",
    TMN: "Daily low (°C)",
    TMX: "Daily high (°C)",
    WAV: "Wave height (m)",
  },
  conditions: {
    clear: "Clear",
    partlyCloudy: "Partly cloudy",
    cloudy: "Cloudy",
    none: "None",
    rain: "Rain",
    rainSnow: "Rain/snow",
    snow: "Snow",
    shower: "Showers",
    drizzle: "Drizzle",
    drizzleSnow: "Drizzle/snow",
    snowFlurry: "Snow flurries",
  },
  errorNoKey: "No KMA service key is configured.",
  // The portal omits CORS headers on its error responses, so a browser cannot
  // read them: a rejected service key arrives here as an unreadable network
  // failure. The message therefore has to name the likely causes rather than
  // claim the network is down.
  errorNetwork:
    "Could not reach the weather service. The same error appears when the service key is not registered, has not activated yet (this can take up to an hour after signing up), or this particular API has not been requested for it.",
  errorTimeout: "The weather service did not respond in time.",
  errorInvalidKey: "The KMA service key was rejected. Check the key and its registered caller IP.",
  errorAccessDenied:
    "Your key is not approved for this service yet. Each KMA API on the public-data portal needs its own request — apply for this one, then try again.",
  errorRateLimit: "The daily request limit for this key has been reached.",
  errorInvalidRequest: "The weather service rejected the request.",
  errorNoData: "No data for this point or time.",
  errorServer: "The weather service reported an error.",
  errorUnknown: "The weather request failed.",
};

let labels: KmaLabels = { ...DEFAULT_KMA_LABELS };

/**
 * Replaces the user-facing strings. Rebuilds an open panel so it re-localizes
 * live on a language change.
 *
 * @param next - Partial overrides merged over the current strings.
 */
export function setKmaLabels(next: Partial<KmaLabels>): void {
  labels = {
    ...labels,
    ...next,
    categories: { ...labels.categories, ...(next.categories ?? {}) },
    conditions: { ...labels.conditions, ...(next.conditions ?? {}) },
    compass: next.compass ?? labels.compass,
    networks: { ...labels.networks, ...(next.networks ?? {}) },
  };
  rerenderPanel();
  // The menu carries translated labels, so a language change has to rebuild it.
  if (state.app) buildToolbarMenu(state.app);
}

/**
 * Maps an error to its user-facing message — the kind alone selects a fixed
 * string, so no key or request URL can reach the UI.
 *
 * @param error - The thrown value.
 * @returns The message to show.
 */
function errorMessage(error: unknown): string {
  const kind: KmaErrorKind = error instanceof KmaError ? error.kind : "unknown";
  const messages: Record<KmaErrorKind, string> = {
    "no-key": labels.errorNoKey,
    network: labels.errorNetwork,
    timeout: labels.errorTimeout,
    "invalid-key": labels.errorInvalidKey,
    "access-denied": labels.errorAccessDenied,
    "rate-limit": labels.errorRateLimit,
    "invalid-request": labels.errorInvalidRequest,
    "no-data": labels.errorNoData,
    server: labels.errorServer,
    unknown: labels.errorUnknown,
  };
  return messages[kind];
}

/* -------------------------------------------------------------------------- */
/* State                                                                        */
/* -------------------------------------------------------------------------- */

interface PanelState {
  app: GeoLibreAppAPI | null;
  container: HTMLElement | null;
  pickActive: boolean;
  conditions: KmaPointConditions | null;
  forecast: KmaPointConditions | null;
  warnings: KmaWarning[];
  typhoons: KmaTyphoonPosition[];
  typhoonLayerId: string | null;
  status: string;
  busy: boolean;
}

const state: PanelState = {
  app: null,
  container: null,
  pickActive: false,
  conditions: null,
  forecast: null,
  warnings: [],
  typhoons: [],
  typhoonLayerId: null,
  status: "",
  busy: false,
};

function rerenderPanel(): void {
  if (state.container) renderPanel(state.container);
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                      */
/* -------------------------------------------------------------------------- */

async function loadPoint(lon: number, lat: number): Promise<void> {
  state.busy = true;
  state.status = "";
  state.conditions = null;
  state.forecast = null;
  rerenderPanel();
  // The two products are independent: a nowcast gap must not hide an available
  // forecast, so each is settled and reported on its own.
  const [conditions, forecast] = await Promise.allSettled([
    kmaCurrentConditions(lon, lat),
    kmaVillageForecast(lon, lat),
  ]);
  if (conditions.status === "fulfilled") state.conditions = conditions.value;
  if (forecast.status === "fulfilled") state.forecast = forecast.value;
  if (conditions.status === "rejected" && forecast.status === "rejected") {
    state.status = errorMessage(conditions.reason);
  }
  state.busy = false;
  rerenderPanel();
}

async function loadWarnings(): Promise<void> {
  state.busy = true;
  state.status = "";
  rerenderPanel();
  try {
    state.warnings = await kmaWarnings();
  } catch (error) {
    state.warnings = [];
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

async function loadTyphoons(): Promise<void> {
  state.busy = true;
  state.status = "";
  rerenderPanel();
  try {
    state.typhoons = await kmaTyphoons();
  } catch (error) {
    state.typhoons = [];
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

/**
 * Adds (or removes) the loaded typhoon positions as a point layer.
 *
 * @param app - The host API.
 */
function toggleTyphoonLayer(app: GeoLibreAppAPI): void {
  if (state.typhoonLayerId) {
    const map = app.getMap?.();
    if (map?.getLayer(state.typhoonLayerId)) map.removeLayer(state.typhoonLayerId);
    app.unregisterExternalNativeLayer?.(state.typhoonLayerId);
    state.typhoonLayerId = null;
    rerenderPanel();
    return;
  }
  if (state.typhoons.length === 0) return;
  state.typhoonLayerId =
    app.addGeoJsonLayer(
      labels.typhoons,
      {
        type: "FeatureCollection",
        features: state.typhoons.map((position) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [position.lon, position.lat] },
          properties: {
            name: position.name,
            time: position.time,
            pressureHpa: position.pressure,
            windSpeedMs: position.windSpeed,
          },
        })),
      },
      `kma://typhoons/${TYPHOON_LAYER_ID}`,
    ) || null;
  rerenderPanel();
}

let unsubscribePick: (() => void) | null = null;

/**
 * Turns click-to-query on or off.
 *
 * Subscribes through `onMapClick` rather than `getMap().on("click")`: the 2D map
 * is hidden and takes no pointer events while the globe is showing, so a
 * handler attached to it would silently stop working on the Cesium tab.
 *
 * @param app - The host API.
 * @param active - Whether clicks should fetch the point forecast.
 */
function setPickActive(app: GeoLibreAppAPI, active: boolean): void {
  state.pickActive = active;
  unsubscribePick?.();
  unsubscribePick = null;
  // Only the MapLibre canvas is styled: Cesium draws its own cursor.
  const map = app.getMap?.();
  if (map) map.getCanvas().style.cursor = active ? "crosshair" : "";
  if (active) {
    unsubscribePick = app.onMapClick?.(({ lng, lat }) => void loadPoint(lng, lat)) ?? null;
  }
  rerenderPanel();
}

/* -------------------------------------------------------------------------- */
/* Station layers and the toolbar menu                                          */
/* -------------------------------------------------------------------------- */

/**
 * Fetches a station network and adds it as a point layer.
 *
 * Stored as GeoJSON rather than as a live service URL: a station roster is a
 * small, slowly-changing list, so the layer keeps working offline, and no
 * request URL — which would carry the service key — reaches the project file.
 *
 * @param app - The host API.
 * @param networkId - The network id from `KMA_STATION_NETWORKS`.
 */
async function addStationLayer(app: GeoLibreAppAPI, networkId: string): Promise<void> {
  const network = KMA_STATION_NETWORKS.find((entry) => entry.id === networkId);
  if (!network) return;
  const name = labels.networks[network.labelKey] ?? network.labelKey;
  state.busy = true;
  state.status = "";
  rerenderPanel();
  try {
    const stations = await kmaStations(networkId);
    app.addGeoJsonLayer(name, kmaStationsToGeoJson(stations), `kma://stations/${networkId}`);
  } catch (error) {
    // The panel is this plugin's own error surface; a menu click that fails
    // would otherwise look like it did nothing at all.
    state.status = `${name}: ${errorMessage(error)}`;
    app.openRightPanel?.(PANEL_ID);
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

/**
 * Fetches the air-quality network and adds it as a point layer.
 *
 * Station positions and readings come from two services and are joined by
 * station name, so the features carry concentrations the Style panel can shade
 * by — a station layer without values would only be dots.
 *
 * @param app - The host API.
 */
async function addAirQualityLayer(app: GeoLibreAppAPI): Promise<void> {
  state.busy = true;
  state.status = "";
  rerenderPanel();
  try {
    // Issued together: the station list does not change hour to hour, but
    // fetching it in sequence would double the wait for no benefit.
    const [stations, readings] = await Promise.all([airKoreaStations(), airKoreaReadings()]);
    app.addGeoJsonLayer(
      labels.airQuality,
      airKoreaGeoJson(stations, readings),
      "airkorea://stations",
    );
  } catch (error) {
    state.status = `${labels.airQuality}: ${errorMessage(error)}`;
    app.openRightPanel?.(PANEL_ID);
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

let unregisterMenu: (() => void) | null = null;

/**
 * Registers (or rebuilds) the KMA toolbar menu. Rebuilt rather than mutated,
 * since the entries' disabled state follows the configured key.
 *
 * @param app - The host API.
 */
function buildToolbarMenu(app: GeoLibreAppAPI): void {
  const ready = hasKmaApiKey();
  unregisterMenu?.();
  unregisterMenu =
    app.registerToolbarMenu?.({
      id: MENU_ID,
      label: labels.menuLabel,
      items: [
        {
          type: "submenu",
          id: `${MENU_ID}-stations`,
          label: labels.stations,
          items: KMA_STATION_NETWORKS.map((network) => ({
            id: `${MENU_ID}-station-${network.id}`,
            label: labels.networks[network.labelKey] ?? network.labelKey,
            disabled: !ready,
            onSelect: () => void addStationLayer(app, network.id),
          })),
        },
        {
          id: `${MENU_ID}-air-quality`,
          label: labels.airQuality,
          disabled: !ready,
          onSelect: () => void addAirQualityLayer(app),
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
/* Rendering                                                                    */
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

/**
 * Renders a raw KMA value for display, decoding the coded categories.
 *
 * SKY and PTY are integer codes, not measurements — showing "1" instead of
 * "Clear" is the difference between a reading and a puzzle.
 *
 * @param category - The KMA category code.
 * @param value - The raw value.
 * @returns The display string.
 */
function displayValue(category: string, value: string): string {
  // ±900 and beyond is the agency's "no data" sentinel, not a reading — an
  // ocean cell with no instrument, or an outage. Showing it raw puts "-999" in
  // the panel as if it were a temperature.
  if (isMissingValue(value)) return labels.missingValue;
  if (category === "SKY") {
    const name = KMA_SKY_LABELS[value.trim()];
    return name ? (labels.conditions[name] ?? name) : value;
  }
  if (category === "PTY") {
    const name = KMA_PTY_LABELS[value.trim()];
    return name ? (labels.conditions[name] ?? name) : value;
  }
  return value;
}

/** `HHmm` → `HH:00`, the forecast's own resolution. */
function formatTime(time: string): string {
  return `${time.slice(0, 2)}:${time.slice(2, 4) || "00"}`;
}

/** `YYYYMMDD` → `MM-DD`, locale-neutral so no date library is needed. */
function formatDate(date: string): string {
  return `${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

/** Renders the wind as a compass point plus speed, e.g. "南 1.5 m/s". */
function windSummary(values: Record<string, string>): string {
  const speed = values.WSD;
  if (!speed || isMissingValue(speed)) return "";
  const index = values.VEC ? compassIndex(values.VEC) : null;
  const point = index === null ? "" : (labels.compass[index] ?? "");
  return point ? `${point} ${speed}` : speed;
}

/**
 * The observation block: a headline reading plus the supporting values.
 *
 * The temperature and sky/precipitation state answer "what is it like there",
 * so they lead; everything else is detail below.
 */
function conditionsBlock(conditions: KmaPointConditions): HTMLElement {
  const wrapper = element("div", "kma-conditions");
  const values: Record<string, string> = {};
  for (const entry of conditions.values) values[entry.category] = entry.value;

  const temperature = values.T1H ?? values.TMP;
  if (temperature && !isMissingValue(temperature)) {
    wrapper.appendChild(element("div", "kma-conditions__temp", `${temperature}°`));
  }
  const sky = values.SKY ? displayValue("SKY", values.SKY) : "";
  const precipitation = values.PTY ? displayValue("PTY", values.PTY) : "";
  // "없음" as a headline reads as a failure; the sky state is the useful word
  // when there is no precipitation.
  const headline = [sky, precipitation !== labels.conditions.none ? precipitation : ""]
    .filter(Boolean)
    .join(" · ");
  if (headline) wrapper.appendChild(element("div", "kma-conditions__headline", headline));

  const list = element("dl", "geolibre-plugin-panel__address");
  for (const entry of displayableValues(conditions.values)) {
    // Already in the headline.
    if (entry.category === "T1H" || entry.category === "SKY" || entry.category === "PTY") continue;
    if (entry.category === "VEC") continue; // folded into the wind row
    const label =
      entry.category === "WSD" ? labels.wind : (labels.categories[entry.category] ?? entry.category);
    const text =
      entry.category === "WSD" ? windSummary(values) : displayValue(entry.category, entry.value);
    if (!text) continue;
    list.appendChild(element("dt", "geolibre-plugin-panel__address-term", label));
    list.appendChild(element("dd", "geolibre-plugin-panel__address-value", text));
  }
  wrapper.appendChild(list);
  return wrapper;
}

/**
 * The forecast block: one row per forecast hour, grouped under a day header.
 *
 * The service answers with a flat list of every category repeated for every
 * hour. Rendered in that order it is unreadable — the same labels over and over
 * with no time attached — so it is pivoted into time slots first.
 */
function forecastBlock(forecast: KmaPointConditions, hours: number): HTMLElement {
  const wrapper = element("div", "kma-forecast");
  const slots = groupForecastSlots(forecast.values).slice(0, hours);

  let renderedDate = "";
  for (const slot of slots) {
    if (slot.date !== renderedDate) {
      renderedDate = slot.date;
      wrapper.appendChild(element("div", "kma-forecast__day", formatDate(slot.date)));
    }
    const row = element("div", "kma-forecast__row");
    row.appendChild(element("span", "kma-forecast__time", formatTime(slot.time)));

    const sky = slot.values.SKY ? displayValue("SKY", slot.values.SKY) : "";
    const pty = slot.values.PTY ? displayValue("PTY", slot.values.PTY) : "";
    row.appendChild(
      element(
        "span",
        "kma-forecast__sky",
        pty && pty !== labels.conditions.none ? pty : sky,
      ),
    );

    const temperature = slot.values.TMP;
    row.appendChild(
      element(
        "span",
        "kma-forecast__temp",
        temperature && !isMissingValue(temperature) ? `${temperature}°` : "",
      ),
    );

    // Chance of precipitation only earns its column when there is some.
    const pop = Number.parseFloat(slot.values.POP ?? "");
    row.appendChild(
      element(
        "span",
        "kma-forecast__pop",
        Number.isFinite(pop) && pop > 0 ? `${slot.values.POP}%` : "",
      ),
    );
    wrapper.appendChild(row);
  }
  return wrapper;
}

function actionButton(text: string, onClick: () => void, wide = false): HTMLButtonElement {
  const button = element(
    "button",
    `geolibre-plugin-panel__button${wide ? " geolibre-plugin-panel__button--wide" : ""}`,
    text,
  );
  button.type = "button";
  button.disabled = state.busy;
  button.addEventListener("click", onClick);
  return button;
}

function renderPanel(container: HTMLElement): void {
  const app = state.app;
  if (!app) return;
  container.textContent = "";
  container.className = "geolibre-plugin-panel";

  if (!hasKmaApiKey()) {
    container.appendChild(element("p", "geolibre-plugin-panel__notice", labels.noKey));
    return;
  }

  // Point weather.
  container.appendChild(sectionTitle(labels.currentConditions));
  const pickButton = element(
    "button",
    `geolibre-plugin-panel__button geolibre-plugin-panel__button--wide${
      state.pickActive ? " geolibre-plugin-panel__button--active" : ""
    }`,
    state.pickActive ? labels.pickPointActive : labels.pickPoint,
  );
  pickButton.type = "button";
  pickButton.addEventListener("click", () => setPickActive(app, !state.pickActive));
  container.appendChild(pickButton);

  if (state.busy) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", labels.loading));
  }

  if (state.conditions) {
    container.appendChild(
      element(
        "p",
        "geolibre-plugin-panel__status",
        `${labels.gridCell}: ${state.conditions.grid.nx}, ${state.conditions.grid.ny}`,
      ),
    );
    container.appendChild(conditionsBlock(state.conditions));
  }

  if (state.forecast) {
    container.appendChild(sectionTitle(labels.forecast));
    // A run covers three days at hourly resolution; the next 24 hours is what a
    // panel this size can show without becoming a scroll of its own.
    container.appendChild(forecastBlock(state.forecast, 24));
  }

  // Warnings.
  container.appendChild(sectionTitle(labels.warnings));
  container.appendChild(actionButton(labels.refresh, () => void loadWarnings(), true));
  if (state.warnings.length > 0) {
    const list = element("ul", "geolibre-plugin-panel__results");
    for (const warning of state.warnings) {
      const item = element("li", "geolibre-plugin-panel__result");
      const body = element("div", "geolibre-plugin-panel__result-button");
      body.appendChild(
        element("span", "geolibre-plugin-panel__result-title", warning.title || warning.regions),
      );
      body.appendChild(
        element("span", "geolibre-plugin-panel__result-subtitle", warning.issuedAt),
      );
      item.appendChild(body);
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  // Typhoons.
  container.appendChild(sectionTitle(labels.typhoons));
  const typhoonActions = element("div", "geolibre-plugin-panel__form");
  typhoonActions.appendChild(actionButton(labels.refresh, () => void loadTyphoons()));
  if (state.typhoons.length > 0) {
    typhoonActions.appendChild(
      actionButton(
        state.typhoonLayerId ? labels.removeTyphoonLayer : labels.addTyphoonLayer,
        () => toggleTyphoonLayer(app),
      ),
    );
  }
  container.appendChild(typhoonActions);
  if (state.typhoons.length > 0) {
    const list = element("ul", "geolibre-plugin-panel__results");
    for (const position of state.typhoons) {
      const item = element("li", "geolibre-plugin-panel__result");
      const button = element("button", "geolibre-plugin-panel__result-button");
      button.type = "button";
      button.appendChild(
        element("span", "geolibre-plugin-panel__result-title", position.name || position.time),
      );
      button.appendChild(
        element("span", "geolibre-plugin-panel__result-subtitle", position.time),
      );
      button.addEventListener("click", () => {
        const map = app.getMap?.();
        map?.flyTo({ center: [position.lon, position.lat], zoom: Math.max(map.getZoom(), 5) });
      });
      item.appendChild(button);
      list.appendChild(item);
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

export const maplibreKmaPlugin: GeoLibrePlugin = {
  id: KMA_PLUGIN_ID,
  name: "Weather (KMA)",
  version: "0.1.0",

  activate(app: GeoLibreAppAPI) {
    state.app = app;
    buildToolbarMenu(app);
    unsubscribeKey = onKmaApiKeyChange(() => {
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
  },

  deactivate(app: GeoLibreAppAPI) {
    setPickActive(app, false);
    unsubscribeKey?.();
    unsubscribeKey = null;
    unregisterMenu?.();
    unregisterMenu = null;
    app.closeRightPanel?.(PANEL_ID);
    app.unregisterRightPanel?.(PANEL_ID);
    state.container = null;
    state.app = null;
    state.conditions = null;
    state.forecast = null;
    state.warnings = [];
    state.typhoons = [];
    state.status = "";
    // The typhoon layer is left on the map deliberately: it is a data layer the
    // user added, and the Layers panel owns removing it.
    state.typhoonLayerId = null;
  },
};
