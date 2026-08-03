/**
 * Deep merge for translation catalogs.
 *
 * Split out from `geoim3d-catalog.ts` so it carries no Vite-only syntax
 * (`import.meta.glob`) and can therefore be unit-tested under the Node test
 * runner — which is where the property that matters gets checked.
 *
 * The merge must be deep. The fork's catalog is a sparse overlay: it carries
 * `settings.env.vworldKeyTitle` without the rest of `settings`, so a shallow
 * spread would replace the whole `settings` branch and silently delete every
 * upstream string under it.
 */

/**
 * Recursively merges an overlay over a base catalog.
 *
 * @param base - The upstream catalog.
 * @param overlay - The fork's sparse additions.
 * @returns A new object; neither input is mutated.
 */
export function mergeCatalogs(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    // Only plain objects recurse: an array (i18next plural/context lists) or a
    // string is a leaf the overlay replaces outright.
    if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = mergeCatalogs(existing, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
