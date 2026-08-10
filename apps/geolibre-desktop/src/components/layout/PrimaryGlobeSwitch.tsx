import { getCesiumIonToken } from "@geolibre/core";
import { CesiumCanvas } from "@geolibre/map";
import { cn } from "@geolibre/ui";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { setPrimaryCesiumViewer } from "../../lib/map-click-bridge";
import { openSettingsSection } from "./SettingsDialog";

/**
 * Tabs that switch the primary map between the 2D/OSM view and the Cesium globe.
 *
 * Upstream already switches *secondary* panes between the two renderers
 * (`viewKind` on a `SecondaryMapView`, toggled from `MapGrid`), but the primary
 * map was always MapLibre. This adds the same choice to the main view.
 *
 * Written as a wrapper on purpose. Everything — the tab chrome, the renderer
 * choice, the token check — lives in this file, so the upstream shell only
 * gains an opening and closing tag around the map subtree it already renders.
 * That keeps the fork mergeable: a change to what the shell puts inside the map
 * area needs no change here, and a change here needs none there.
 *
 * Camera state is shared for free. `mapLayout.syncView` defaults to true, and
 * `CesiumCanvas` seeds from and writes back to the global `mapView` in that
 * mode, so panning the globe and switching back to OSM lands in the same place.
 */

/**
 * The view id handed to the primary globe.
 *
 * Deliberately not a registered `secondaryMapViews` entry: that array drives
 * the pane grid, and adding one would render a second pane. `CesiumCanvas`
 * tolerates an id it cannot find — it falls back to the shared camera, which is
 * exactly the behaviour wanted here — and the per-pane setters it calls no-op
 * for an unknown id.
 */
const PRIMARY_GLOBE_VIEW_ID = "geolibre-primary-globe";

type PrimaryView = "maplibre" | "cesium";

/**
 * The live tab state, reachable without React.
 *
 * The 3D object plugin renders through `maplibre-gl-splat`, a MapLibre control,
 * so its objects are drawn into the 2D map — which this component hides while
 * the globe is showing. Loading one from the Cesium tab therefore looked like
 * nothing happened at all. The plugin asks here instead of guessing, and can
 * bring the 2D view back so what it just loaded is visible.
 */
let activeView: PrimaryView = "maplibre";
let applyView: ((view: PrimaryView) => void) | null = null;

/**
 * Whether the Cesium globe is the primary view right now.
 *
 * @returns True when the 2D map is hidden behind the globe.
 */
export function isPrimaryGlobeActive(): boolean {
  return activeView === "cesium";
}

/**
 * Switches the primary view back to the 2D map.
 *
 * @returns True when the switch could be made (the shell is mounted).
 */
export function showPrimaryMapLibreView(): boolean {
  if (!applyView) return false;
  applyView("maplibre");
  return true;
}

/**
 * The current Cesium Ion token, re-resolved when the runtime environment
 * changes.
 *
 * A local copy of the same hook in `MapGrid`, which does not export it.
 * Duplicating ten lines is the cheaper trade than editing an upstream file to
 * widen its exports.
 *
 * @returns The token, or undefined when the globe is not available.
 */
function useCesiumIonToken(): string | undefined {
  const [token, setToken] = useState<string | undefined>(() => getCesiumIonToken());
  useEffect(() => {
    const refresh = () => setToken(getCesiumIonToken());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return token;
}

interface PrimaryGlobeSwitchProps {
  /** The primary 2D map and its overlays, rendered by the shell. */
  children: ReactNode;
}

/**
 * Wraps the primary map area with a renderer switch.
 *
 * @param props - The map subtree to show in the 2D tab.
 * @returns The map area with its tab bar.
 */
export function PrimaryGlobeSwitch({ children }: PrimaryGlobeSwitchProps) {
  const { t } = useTranslation();
  const token = useCesiumIonToken();
  const [view, setView] = useState<PrimaryView>("maplibre");

  // Publish the tab state for callers outside React (see the module notes).
  activeView = view;
  useEffect(() => {
    applyView = setView;
    return () => {
      applyView = null;
    };
  }, []);

  // The globe does not need a token. `CesiumCanvas` falls back to keyless
  // OpenStreetMap imagery without one, so the tab is always available; a token
  // only upgrades the basemap to Ion world imagery and adds world terrain, so
  // its absence is a hint rather than a gate.
  //
  // (`MapGrid` still hides the toggle on its secondary panes without a token.
  // That is upstream's call and left alone.)
  const showGlobe = view === "cesium";

  return (
    <div className="relative h-full w-full">
      {/*
        The 2D subtree stays mounted while the globe is shown, hidden with
        `invisible` rather than unmounted or `display:none`. Unmounting would
        tear down the MapLibre instance and re-sync every layer on each switch,
        and `display:none` gives the canvas a zero size that MapLibre restores
        badly. This keeps switching instant and the map's state intact.
      */}
      <div className={cn("absolute inset-0", showGlobe && "invisible pointer-events-none")}>
        {children}
      </div>

      {showGlobe ? (
        // Keyed on the token so a token corrected in Settings remounts the
        // viewer: Cesium applies `Ion.defaultAccessToken` once, at creation.
        <div className="absolute inset-0">
          <CesiumCanvas
            key={token}
            viewId={PRIMARY_GLOBE_VIEW_ID}
            ionToken={token}
            // Lets plugin "click the map" tools reach the globe; without it
            // they attach to the hidden 2D map and never fire here.
            onViewerChange={setPrimaryCesiumViewer}
          />
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
        <div
          role="tablist"
          aria-label={t("primaryGlobe.tablist")}
          className="pointer-events-auto flex overflow-hidden rounded-md border border-input bg-background/90 shadow-sm"
        >
          <ViewTab
            active={!showGlobe}
            label={t("primaryGlobe.maplibre")}
            onSelect={() => setView("maplibre")}
          />
          <ViewTab
            active={showGlobe}
            label={t("primaryGlobe.cesium")}
            // The globe works either way; the tooltip says what a token adds
            // rather than blocking the switch.
            title={token ? undefined : t("primaryGlobe.cesiumWithoutToken")}
            onSelect={() => setView("cesium")}
          />
        </div>
      </div>
    </div>
  );
}

function ViewTab({
  active,
  label,
  title,
  onSelect,
}: {
  active: boolean;
  label: string;
  title?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      title={title}
      onClick={onSelect}
      className={cn(
        "px-3 py-1 text-xs transition-colors",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
