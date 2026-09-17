/**
 * Drops geoIM3D's session-only layers before a project is written to disk.
 *
 * A separate module for the reason the other `geoim3d-*` files are: keeps
 * `project.ts` — a file every upstream merge touches — down to the one call
 * this needs, so a future merge's conflict here is a single line instead of
 * this whole mechanism.
 */

import type { GeoLibreLayer, GeoLibreProject } from "./types";

/**
 * A layer that belongs to this session only and must not reach a project file.
 *
 * A locally dropped 3D object is addressed by a `blob:` or `asset:` URL that
 * means nothing in the next session, so saving it produces a project that
 * cannot be reopened — and marking the project dirty for one asks the user to
 * save work that will not survive.
 */
function isSessionOnlyLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.excludeFromHistory === true ||
    layer.metadata.sourceKind === "splatting-local-file" ||
    // geoIM3D's own 3D objects, which are addressed the same way.
    layer.metadata.sourceKind === "geoim3d-object"
  );
}

/**
 * Drops references to layers that are not being written.
 *
 * A legend entry, a widget or a selection keyed by a layer that no longer
 * exists in the file would be restored pointing at nothing.
 */
function stripSessionLayerReferences(
  value: unknown,
  excludedLayerIds: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item !== "string" || !excludedLayerIds.has(item))
      .map((item) => stripSessionLayerReferences(item, excludedLayerIds))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if (typeof record.layerId === "string" && excludedLayerIds.has(record.layerId)) {
    return undefined;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const referencesExcludedLayer =
      excludedLayerIds.has(key) ||
      [...excludedLayerIds].some((id) => key.startsWith(`${id}::`)) ||
      (typeof entry === "string" && excludedLayerIds.has(entry));
    if (referencesExcludedLayer) continue;

    const next = stripSessionLayerReferences(entry, excludedLayerIds);
    if (next !== undefined) stripped[key] = next;
  }
  return stripped;
}

/** The project as it should be written: without its session-only layers. */
export function projectForSerialization(project: GeoLibreProject): GeoLibreProject {
  const excludedLayerIds = new Set(
    project.layers.filter(isSessionOnlyLayer).map((layer) => layer.id),
  );
  if (excludedLayerIds.size === 0) return project;

  const layers = project.layers.filter((layer) => !excludedLayerIds.has(layer.id));
  const selectedLayerId =
    project.selectedLayerId && excludedLayerIds.has(project.selectedLayerId)
      ? null
      : project.selectedLayerId;
  return stripSessionLayerReferences(
    { ...project, layers, selectedLayerId },
    excludedLayerIds,
  ) as GeoLibreProject;
}
