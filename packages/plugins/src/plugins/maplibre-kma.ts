/**
 * KMA (기상청) weather plugin: click-to-query conditions/forecast, warnings,
 * typhoon positions. API client and DTOs live in `kma-api.ts`.
 */

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { DataGoKrError } from "./data-go-kr";
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
/**
 * Id of the floating variant of this panel — mutually exclusive with the
 * docked one (`state.container` holds a single element).
 */
const FLOATING_PANEL_ID = `${PANEL_ID}-floating`;
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
  /** Opens the same panel as a floating card, so two plugins can be up at once. */
  openPanelFloating: string;
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
  openPanelFloating: "Weather lookup (detached)\u2026",
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
  // No CORS on error responses, so a rejected key looks like a network failure.
  errorNetwork:
    "Could not reach the weather service. The same error appears when the service key is not registered, has not activated yet (this can take up to an hour after signing up), or this particular API has not been requested for it.",
  errorTimeout: "The weather service did not respond in time.",
  errorInvalidKey: "The KMA service key was rejected. Check the key and its registered caller IP.",
  errorAccessDenied:
    "Your key is not approved for this service yet. Each KMA API on the public-data portal needs its own request, and an approval can take up to an hour to take effect — check this API in 활용신청 현황, then try again.",
  errorRateLimit: "The daily request limit for this key has been reached.",
  errorInvalidRequest: "The weather service rejected the request.",
  errorNoData: "No data for this point or time.",
  errorServer: "The weather service reported an error.",
  errorUnknown: "The weather request failed.",
};

let labels: KmaLabels = { ...DEFAULT_KMA_LABELS };

/** Replaces the user-facing strings and rebuilds an open panel to re-localize live. */
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

/** Maps an error to its user-facing message; the kind alone selects a fixed string. */
function errorMessage(error: unknown): string {
  // Both KmaError (weather) and DataGoKrError (AirKorea) share one kind vocabulary.
  const kind: KmaErrorKind =
    error instanceof KmaError || error instanceof DataGoKrError
      ? (error.kind as KmaErrorKind)
      : "unknown";
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
  /** Why the forecast is missing, when the nowcast succeeded without it. */
  forecastStatus: string;
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
  forecastStatus: "",
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
  state.forecastStatus = "";
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
  } else if (forecast.status === "rejected") {
    // Reported next to the forecast heading rather than left silently absent.
    state.forecastStatus = errorMessage(forecast.reason);
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
          geometry: {
            type: "Point" as const,
            coordinates: [position.lon, position.lat],
          },
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

/** Turns click-to-query on or off, via `onMapClick` so it works on either engine. */
function setPickActive(app: GeoLibreAppAPI, active: boolean): void {
  state.pickActive = active;
  unsubscribePick?.();
  unsubscribePick = null;
  // Style whichever engine's canvas is live.
  const map = app.getMap?.();
  if (map) map.getCanvas().style.cursor = active ? "crosshair" : "";
  const cesiumCanvas = app.getCesiumScene?.()?.canvas;
  if (cesiumCanvas) cesiumCanvas.style.cursor = active ? "crosshair" : "";
  if (active) {
    unsubscribePick = app.onMapClick?.(({ lng, lat }) => void loadPoint(lng, lat)) ?? null;
  }
  rerenderPanel();
}

/* -------------------------------------------------------------------------- */
/* Station layers and the toolbar menu                                          */
/* -------------------------------------------------------------------------- */

/** Fetches a station network and adds it as a GeoJSON layer (keeps the key out of the project). */
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
    state.status = `${name}: ${errorMessage(error)}`;
    app.openRightPanel?.(PANEL_ID);
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

/** Fetches the air-quality network, joined by station name, as one point layer. */
async function addAirQualityLayer(app: GeoLibreAppAPI): Promise<void> {
  state.busy = true;
  state.status = "";
  rerenderPanel();
  try {
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

/** Registers (or rebuilds) the KMA toolbar menu; rebuilt since disabled state follows the key. */
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

/** Renders a raw KMA value, decoding SKY/PTY's integer codes into words. */
function displayValue(category: string, value: string): string {
  // ±900+ is the agency's "no data" sentinel, not a reading.
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

/** The observation block: temperature/sky headline, then supporting values. */
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
      entry.category === "WSD"
        ? labels.wind
        : (labels.categories[entry.category] ?? entry.category);
    const text =
      entry.category === "WSD" ? windSummary(values) : displayValue(entry.category, entry.value);
    if (!text) continue;
    list.appendChild(element("dt", "geolibre-plugin-panel__address-term", label));
    list.appendChild(element("dd", "geolibre-plugin-panel__address-value", text));
  }
  wrapper.appendChild(list);
  return wrapper;
}

/** The forecast block: pivots the service's flat category list into hourly rows under a day header. */
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
      element("span", "kma-forecast__sky", pty && pty !== labels.conditions.none ? pty : sky),
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

  if (state.forecast || state.forecastStatus) {
    container.appendChild(sectionTitle(labels.forecast));
    if (state.forecast) {
      // A run covers three days at hourly resolution; the next 24 hours is what
      // a panel this size can show without becoming a scroll of its own.
      container.appendChild(forecastBlock(state.forecast, 24));
    } else {
      container.appendChild(element("p", "geolibre-plugin-panel__status", state.forecastStatus));
    }
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
      body.appendChild(element("span", "geolibre-plugin-panel__result-subtitle", warning.issuedAt));
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
      actionButton(state.typhoonLayerId ? labels.removeTyphoonLayer : labels.addTyphoonLayer, () =>
        toggleTyphoonLayer(app),
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
      button.appendChild(element("span", "geolibre-plugin-panel__result-subtitle", position.time));
      button.addEventListener("click", () => {
        const map = app.getMap?.();
        map?.flyTo({
          center: [position.lon, position.lat],
          zoom: Math.max(map.getZoom(), 5),
        });
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
  // Only GeoJSON markers, which the globe already draws the same as 2D.
  engines: ["maplibre", "cesium"],

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
      render: mountPanel,
    });
    app.registerFloatingPanel?.({
      id: FLOATING_PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      defaultWidth: 340,
      render: mountPanel,
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
    app.closeFloatingPanel?.(FLOATING_PANEL_ID);
    app.unregisterFloatingPanel?.(FLOATING_PANEL_ID);
    state.container = null;
    state.app = null;
    state.conditions = null;
    state.forecast = null;
    state.forecastStatus = "";
    state.warnings = [];
    state.typhoons = [];
    state.status = "";
    // The typhoon layer is left on the map deliberately: it is a data layer the
    // user added, and the Layers panel owns removing it.
    state.typhoonLayerId = null;
  },
};
