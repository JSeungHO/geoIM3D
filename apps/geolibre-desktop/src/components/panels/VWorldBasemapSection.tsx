import {
  hasVWorldApiKey,
  onVWorldApiKeyChange,
  registerVWorldBasemapStyle,
  VWORLD_BASE_MAPS,
  vworldBasemapIdFor,
  vworldCoverageView,
} from "@geolibre/plugins";
import { useAppStore } from "@geolibre/core";
import { cn } from "@geolibre/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CollapsibleSection } from "../CollapsibleSection";

/**
 * The VWorld basemaps, offered in Change Basemap beside the other regions.
 * Hidden until a key is configured, since VWorld tiles 403 without one.
 */

interface VWorldBasemapSectionProps {
  /** The map's current style URL, so an active VWorld basemap highlights. */
  activeStyleUrl?: string;
  /** Applies the chosen style. */
  onSelect: (styleUrl: string) => void;
}

/** Whether a VWorld key is configured, kept current as Settings changes it. */
function useHasVWorldKey(): boolean {
  const [configured, setConfigured] = useState(() => hasVWorldApiKey());
  useEffect(() => onVWorldApiKeyChange(() => setConfigured(hasVWorldApiKey())), []);
  return configured;
}

/** Renders the VWorld basemap choices, or null when no key is configured. */
export function VWorldBasemapSection({ activeStyleUrl, onSelect }: VWorldBasemapSectionProps) {
  const { t } = useTranslation();
  const configured = useHasVWorldKey();
  const mapView = useAppStore((s) => s.mapView);
  const setMapView = useAppStore((s) => s.setMapView);
  if (!configured) return null;

  // Hybrid is annotation-only, drawn into Satellite's own style.
  const basemaps = VWORLD_BASE_MAPS.filter((basemap) => !basemap.overlayFor);

  // Asked of the plugin: a sentinel only resolves for the session that made it.
  const activeId = vworldBasemapIdFor(activeStyleUrl);

  return (
    <CollapsibleSection title={t("vworld.basemapSection")} defaultOpen={Boolean(activeId)}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {basemaps.map((basemap) => (
          <button
            key={basemap.id}
            type="button"
            aria-pressed={basemap.id === activeId}
            className={cn(
              "flex min-h-10 items-center justify-center rounded-md border px-3 py-1.5 text-center text-sm font-medium leading-tight transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              basemap.id === activeId
                ? "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                : "border-input bg-background",
            )}
            onClick={() => {
              void registerVWorldBasemapStyle(basemap.id).then((styleUrl) => {
                if (!styleUrl) return;
                // VWorld only covers Korea from zoom 6 down; jump there if needed.
                const view = vworldCoverageView({
                  longitude: mapView.center[0],
                  latitude: mapView.center[1],
                  zoom: mapView.zoom,
                });
                if (view) setMapView({ center: [view.longitude, view.latitude], zoom: view.zoom });
                onSelect(styleUrl);
              });
            }}
          >
            {/* defaultValue picks the plain-string overload: a computed key
                typed against the whole catalog union is too complex for the
                compiler to represent (TS2590). */}
            {t(`vworld.${basemap.labelKey}`, { defaultValue: basemap.labelKey })}
          </button>
        ))}
      </div>
    </CollapsibleSection>
  );
}
