/**
 * This fork's own translation strings, kept out of the upstream catalogs.
 *
 * `locales/*.json` are upstream files that change with every release. Adding a
 * few hundred lines to them makes each update a merge to reconcile by hand, so
 * everything geoIM3D adds lives in `locales-geoim3d/*.json` instead and is
 * merged in at load time. The upstream loader gains three lines; the catalogs
 * themselves stay byte-identical to upstream apart from strings we deliberately
 * override.
 *
 * The merge is **deep**. The fork's catalog is a sparse overlay — it carries
 * `settings.env.vworldKeyTitle` without the rest of `settings` — so a shallow
 * spread would replace the whole `settings` branch and silently delete every
 * upstream string under it.
 */

import geoim3dEn from "./locales-geoim3d/en.json";
// The merge itself lives in its own module so it stays free of Vite-only
// syntax and can be unit-tested.
import { mergeCatalogs } from "./merge-catalogs";

/** The fork's English strings, the baseline `t()` is typed against. */
export const geoim3dEnglish = geoim3dEn as Record<string, unknown>;

/**
 * Non-English fork catalogs, lazily imported to match how the upstream loader
 * treats its own: only the active language's chunk is fetched.
 */
const overlayLoaders = import.meta.glob<{ default: Record<string, unknown> }>([
  "./locales-geoim3d/*.json",
  "!./locales-geoim3d/en.json",
]);

const overlays: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {};
for (const [path, loader] of Object.entries(overlayLoaders)) {
  overlays[path.replace(/^\.\/locales-geoim3d\//, "").replace(/\.json$/, "")] = loader;
}

/**
 * Merges the fork's English strings over the upstream English catalog.
 *
 * @param base - The upstream English catalog.
 * @returns The combined catalog.
 */
export function withGeoim3dEnglish(base: Record<string, unknown>): Record<string, unknown> {
  return mergeCatalogs(base, geoim3dEnglish);
}

/**
 * Adds the fork's strings for a non-English locale, if it has any.
 *
 * i18next's own deep merge handles the overlay here, so this only has to fetch
 * the chunk. A locale the fork has not translated is a no-op and falls back to
 * the fork's English through i18next's normal fallback chain.
 *
 * @param code - The locale code being loaded.
 */
export async function loadGeoim3dCatalog(code: string): Promise<void> {
  const loader = overlays[code];
  if (!loader) return;
  const { default: bundle } = await loader();
  const { default: i18n } = await import("i18next");
  i18n.addResourceBundle(code, "translation", bundle, true, true);
}
