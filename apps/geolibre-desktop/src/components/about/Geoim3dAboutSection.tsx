/** geoIM3D identity shared by Help → About and AboutDialog's licence block. */

/** Not `APP_VERSION` (the GeoLibre base this fork tracks) — geoIM3D's own version. */
export const GEOIM3D_VERSION = "1.0.0";

/** Product name as shown to users, beside the version. */
export const GEOIM3D_NAME = "geoIM3D";

/**
 * Off: no geoIM3D release feed exists yet, so there's nothing to check
 * against but GeoLibre's own releases (wrong product). Flip on once
 * geoIM3D publishes releases and `lib/updates.ts` points at them.
 */
export const GEOIM3D_UPDATES_ENABLED = false;
