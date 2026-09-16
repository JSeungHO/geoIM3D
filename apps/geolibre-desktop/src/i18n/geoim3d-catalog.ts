/**
 * This fork's own translation strings, kept out of upstream's `locales/*.json`
 * (deep-merged in at load time so upstream catalogs stay untouched).
 */

import geoim3dEn from "./locales-geoim3d/en.json";
import { mergeCatalogs } from "./merge-catalogs";

/** The fork's English strings, the baseline `t()` is typed against. */
export const geoim3dEnglish = geoim3dEn as Record<string, unknown>;

/** Non-English fork catalogs, lazily loaded like upstream's own. */
const overlayLoaders = import.meta.glob<{ default: Record<string, unknown> }>([
  "./locales-geoim3d/*.json",
  "!./locales-geoim3d/en.json",
]);

const overlays: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {};
for (const [path, loader] of Object.entries(overlayLoaders)) {
  overlays[path.replace(/^\.\/locales-geoim3d\//, "").replace(/\.json$/, "")] = loader;
}

/** Merges the fork's English strings over the upstream English catalog. */
export function withGeoim3dEnglish(base: Record<string, unknown>): Record<string, unknown> {
  return mergeCatalogs(base, geoim3dEnglish);
}

/** Merges the fork's strings for a locale, before i18next has it (boot path). */
export async function geoim3dOverlayFor(
  code: string,
  base: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const loader = overlays[code];
  if (!loader) return base;
  const { default: bundle } = await loader();
  return mergeCatalogs(base, bundle);
}

/** Adds the fork's strings for a non-English locale, if it has any. */
export async function loadGeoim3dCatalog(code: string): Promise<void> {
  const loader = overlays[code];
  if (!loader) return;
  const { default: bundle } = await loader();
  const { default: i18n } = await import("i18next");
  i18n.addResourceBundle(code, "translation", bundle, true, true);
}
