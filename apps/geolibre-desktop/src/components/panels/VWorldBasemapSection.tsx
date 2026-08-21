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
 *
 * Built as its own component, laid out like `RegionalBasemapSection`, so the
 * picker gains one tag rather than a block of fork code — and so this does not
 * have to go into `@geolibre/core`'s regional table, which has no notion of a
 * basemap that needs a key.
 *
 * The key is exactly why it is separate. VWorld tiles 403 without one, so a
 * button offered to a user who has not entered a key leads to a blank map; the
 * section is simply absent until Settings has one, and appears the moment it
 * does.
 */

interface VWorldBasemapSectionProps {
  /** The map's current style URL, so an active VWorld basemap highlights. */
  activeStyleUrl?: string;
  /** Applies the chosen style. */
  onSelect: (styleUrl: string) => void;
}

/**
 * Whether a VWorld key is configured, kept current as Settings changes it.
 *
 * @returns True when a key is set.
 */
function useHasVWorldKey(): boolean {
  const [configured, setConfigured] = useState(() => hasVWorldApiKey());
  useEffect(() => onVWorldApiKeyChange(() => setConfigured(hasVWorldApiKey())), []);
  return configured;
}

/**
 * Renders the VWorld basemap choices.
 *
 * @param props - Current style and the apply callback.
 * @returns The section, or null when no key is configured.
 */
export function VWorldBasemapSection({ activeStyleUrl, onSelect }: VWorldBasemapSectionProps) {
  const { t } = useTranslation();
  const configured = useHasVWorldKey();
  const mapView = useAppStore((s) => s.mapView);
  const setMapView = useAppStore((s) => s.setMapView);
  if (!configured) return null;

  // Hybrid is transparent annotation, not imagery, and is drawn into the
  // Satellite basemap's own style. Listing it here would offer the half that is
  // unreadable on its own.
  const basemaps = VWORLD_BASE_MAPS.filter((basemap) => !basemap.overlayFor);

  // Asked of the plugin rather than parsed out of the URL: a sentinel only
  // resolves for the session that registered it, so a dead one left in the
  // store would highlight a basemap that is not on the map.
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
                // VWorld covers Korea from zoom 6 down. Chosen from a world
                // view it draws nothing at all, and a blank globe reads as a
                // basemap that failed rather than one you are standing too far
                // from. A view already inside the coverage is left alone.
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
