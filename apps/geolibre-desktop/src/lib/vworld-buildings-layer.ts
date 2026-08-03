/**
 * Adds VWorld building footprints as an extruded layer.
 *
 * Lives in the app because the plugin API exposes no way to set a layer's
 * style, and extrusion is the point: added flat, these polygons are just the
 * WMS overlay again. The plugin fetches and shapes the data; this applies it.
 *
 * Extruding the authoritative footprints is what gives the 3D view real
 * buildings without a Cesium Ion asset — the heights come from the building
 * register's storey counts rather than a hosted global tileset.
 */

import { useAppStore } from "@geolibre/core";
import type { FeatureCollection } from "geojson";

/**
 * Adds the layer and turns extrusion on.
 *
 * @param input - Layer name, the GeoJSON, and the property holding metres.
 */
export function addVWorldBuildingLayer(input: {
  name: string;
  geojson: unknown;
  heightProperty: string;
}): void {
  const store = useAppStore.getState();
  const layerId = store.addGeoJsonLayer(
    input.name,
    input.geojson as FeatureCollection,
    "vworld://wfs/lt_c_bldginfo",
  );
  store.setLayerStyle(layerId, {
    extrusionEnabled: true,
    extrusionHeightProperty: input.heightProperty,
    // The property is already in metres, so no rescaling; the plugin resolves
    // measured height first and falls back to storeys x storey height.
    extrusionHeightScale: 1,
    extrusionBase: 0,
  });
}
