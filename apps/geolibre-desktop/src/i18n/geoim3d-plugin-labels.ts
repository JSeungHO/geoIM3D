import i18n from "../i18n";
import { setGeoim3dObjectLabels, setKmaLabels, setVWorldLabels } from "@geolibre/plugins";

/**
 * Pushes this fork's plugin strings into the plugins that own them
 * (framework-agnostic, can't call react-i18next). Call
 * {@link startGeoim3dLabelSync} once at startup.
 */

/** A translator bound to the active language; generic for `returnObjects` keys. */
type Translate = <T = string>(key: string, options?: Record<string, unknown>) => T;

/** Pushes every label for the current language. */
function pushLabels(t: Translate): void {
  setVWorldLabels({
    title: t("vworld.title"),
    getTitle: () => i18n.t("vworld.title"),
    menuLabel: t("vworld.menuLabel"),
    openPanel: t("vworld.openPanel"),
    openPanelFloating: t("vworld.openPanelFloating"),
    basemaps: t("vworld.basemaps"),
    thematicLayers: t("vworld.thematicLayers"),
    buildings3d: t("vworld.buildings3d"),
    buildingsTruncated: t("vworld.buildingsTruncated"),
    search: t("vworld.search"),
    searchPlaceholder: t("vworld.searchPlaceholder"),
    searchButton: t("vworld.searchButton"),
    geocode: t("vworld.geocode"),
    geocodePlaceholder: t("vworld.geocodePlaceholder"),
    geocodeButton: t("vworld.geocodeButton"),
    addressTypeRoad: t("vworld.addressTypeRoad"),
    addressTypeParcel: t("vworld.addressTypeParcel"),
    featureInfo: t("vworld.featureInfo"),
    featureInfoHint: t("vworld.featureInfoHint"),
    featureInfoActive: t("vworld.featureInfoActive"),
    featureInfoEmpty: t("vworld.featureInfoEmpty"),
    featureInfoNoLayers: t("vworld.featureInfoNoLayers"),
    addFeatureLayer: t("vworld.addFeatureLayer"),
    rawAttributes: t("vworld.rawAttributes"),
    // Returned whole: WFS schema decides the field names.
    attributes: t<Record<string, string>>("vworld.attribute", { returnObjects: true }),
    reverseGeocode: t("vworld.reverseGeocode"),
    reverseGeocodeHint: t("vworld.reverseGeocodeHint"),
    reverseGeocodeActive: t("vworld.reverseGeocodeActive"),
    noKey: t("vworld.noKey"),
    searchTypePlace: t("vworld.searchTypePlace"),
    searchTypeAddress: t("vworld.searchTypeAddress"),
    searchTypeDistrict: t("vworld.searchTypeDistrict"),
    searchTypeRoad: t("vworld.searchTypeRoad"),
    zipcode: t("vworld.zipcode"),
    base: t("vworld.base"),
    white: t("vworld.white"),
    midnight: t("vworld.midnight"),
    satellite: t("vworld.satellite"),
    hybrid: t("vworld.hybrid"),
    cadastral: t("vworld.cadastral"),
    cadastralBonbun: t("vworld.cadastralBonbun"),
    building: t("vworld.building"),
    zoningUrban: t("vworld.zoningUrban"),
    zoningManagement: t("vworld.zoningManagement"),
    zoningAgriculture: t("vworld.zoningAgriculture"),
    zoningGreenbelt: t("vworld.zoningGreenbelt"),
    errorNoKey: t("vworld.errorNoKey"),
    errorNetwork: t("vworld.errorNetwork"),
    errorTimeout: t("vworld.errorTimeout"),
    errorInvalidKey: t("vworld.errorInvalidKey"),
    errorRateLimit: t("vworld.errorRateLimit"),
    errorInvalidRequest: t("vworld.errorInvalidRequest"),
    errorNotFound: t("vworld.errorNotFound"),
    errorServer: t("vworld.errorServer"),
    errorUnknown: t("vworld.errorUnknown"),
  });
  setGeoim3dObjectLabels({
    getTitle: () => i18n.t("objects.title"),
    title: t("objects.title"),
    menuLabel: t("objects.menuLabel"),
    openPanel: t("objects.openPanel"),
    openPanelFloating: t("objects.openPanelFloating"),
    addFromUrl: t("objects.addFromUrl"),
    addFromFile: t("objects.addFromFile"),
    threeDTiles: t("objects.threeDTiles"),
    urlPlaceholder: t("objects.urlPlaceholder"),
    load: t("objects.load"),
    loading: t("objects.loading"),
    browse: t("objects.browse"),
    loaded: t("objects.loaded"),
    empty: t("objects.empty"),
    longitude: t("objects.longitude"),
    latitude: t("objects.latitude"),
    altitude: t("objects.altitude"),
    scale: t("objects.scale"),
    rotation: t("objects.rotation"),
    tilesetBadge: t("objects.tilesetBadge"),
    tilesetHint: t("objects.tilesetHint"),
    apply: t("objects.apply"),
    remove: t("objects.remove"),
    hideBasemapBuildings: t("objects.hideBasemapBuildings"),
    savePreset: t("objects.savePreset"),
    presets: t("objects.presets"),
    presetsEmpty: t("objects.presetsEmpty"),
    deletePreset: t("objects.deletePreset"),
    errorUnsupported: t("objects.errorUnsupported"),
    errorHttpUnavailable: t("objects.errorHttpUnavailable"),
    errorPickerUnavailable: t("objects.errorPickerUnavailable"),
    errorLoadFailed: t("objects.errorLoadFailed"),
    errorRendererUnavailable: t("objects.errorRendererUnavailable"),
    errorGlobeActive: t("objects.errorGlobeActive"),
    errorEmptyFile: t("objects.errorEmptyFile"),
    errorTooLarge: t("objects.errorTooLarge"),
    errorPresetNotSavable: t("objects.errorPresetNotSavable"),
    errorPresetUnavailable: t("objects.errorPresetUnavailable"),
    errorPresetMissing: t("objects.errorPresetMissing"),
  });
  setKmaLabels({
    title: t("kma.title"),
    getTitle: () => i18n.t("kma.title"),
    menuLabel: t("kma.menuLabel"),
    openPanel: t("kma.openPanel"),
    openPanelFloating: t("kma.openPanelFloating"),
    stations: t("kma.stations"),
    airQuality: t("kma.airQuality"),
    // Returned whole: the network list lives in the plugin.
    networks: {
      stationsAws: t("kma.stationsAws"),
      stationsBuoy: t("kma.stationsBuoy"),
      stationsWaveBuoy: t("kma.stationsWaveBuoy"),
      stationsPm10: t("kma.stationsPm10"),
    },
    noKey: t("kma.noKey"),
    pickPoint: t("kma.pickPoint"),
    pickPointActive: t("kma.pickPointActive"),
    currentConditions: t("kma.currentConditions"),
    forecast: t("kma.forecast"),
    warnings: t("kma.warnings"),
    typhoons: t("kma.typhoons"),
    refresh: t("kma.refresh"),
    addTyphoonLayer: t("kma.addTyphoonLayer"),
    removeTyphoonLayer: t("kma.removeTyphoonLayer"),
    loading: t("kma.loading"),
    gridCell: t("kma.gridCell"),
    missingValue: t("kma.missingValue"),
    wind: t("kma.wind"),
    compass: t<string[]>("kma.compass", { returnObjects: true }),
    // Returned whole: these mirror the KMA's own code tables.
    categories: t<Record<string, string>>("kma.category", { returnObjects: true }),
    conditions: t<Record<string, string>>("kma.condition", { returnObjects: true }),
    errorNoKey: t("kma.error.no-key"),
    errorNetwork: t("kma.error.network"),
    errorTimeout: t("kma.error.timeout"),
    errorInvalidKey: t("kma.error.invalid-key"),
    errorAccessDenied: t("kma.error.access-denied"),
    errorRateLimit: t("kma.error.rate-limit"),
    errorInvalidRequest: t("kma.error.invalid-request"),
    errorNoData: t("kma.error.no-data"),
    errorServer: t("kma.error.server"),
    errorUnknown: t("kma.error.unknown"),
  });
}

/** Starts pushing labels, and keeps them in step with the language. Safe to call twice. */
let stopLabelSync: (() => void) | null = null;

export function startGeoim3dLabelSync(): () => void {
  stopLabelSync?.();
  // Cast: i18next's key union is too large for TS to relate to a plain string.
  const push = () =>
    pushLabels(
      <T>(key: string, options?: Record<string, unknown>) =>
        i18n.t(key as never, (options ?? {}) as never) as T,
    );
  push();
  i18n.on("languageChanged", push);
  // Catalogs load lazily, so the first push can predate this fork's strings.
  i18n.on("loaded", push);
  stopLabelSync = () => {
    i18n.off("languageChanged", push);
    i18n.off("loaded", push);
    stopLabelSync = null;
  };
  return stopLabelSync;
}
