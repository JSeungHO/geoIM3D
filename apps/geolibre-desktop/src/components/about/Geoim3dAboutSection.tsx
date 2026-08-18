/**
 * The geoIM3D licence block in Help → About.
 *
 * The licence block itself now lives inline in `AboutDialog`, from the
 * parallel implementation this fork merged; what is left here is the identity
 * those two surfaces share.
 */

/**
 * The product's own version.
 *
 * Deliberately not `APP_VERSION`: that is the GeoLibre release this fork is
 * built from (2.5.x) and it drives the update check against GeoLibre's
 * releases, so it has to keep tracking upstream. geoIM3D ships on its own
 * numbering, and the About dialog is where a user reads which product they
 * have.
 */
export const GEOIM3D_VERSION = "1.0.0";

/** Product name as shown to users, beside the version. */
export const GEOIM3D_NAME = "geoIM3D";

/**
 * Whether the in-app update check is offered.
 *
 * Off: the check reads GeoLibre's GitHub releases, which say nothing about
 * which geoIM3D a user is running and point at installers that are not this
 * product. geoIM3D has no release feed of its own yet, so the honest thing is
 * to offer nothing rather than a button that reports someone else's versions.
 *
 * To turn it back on, publish geoIM3D releases, point `LATEST_RELEASE_URL` and
 * `UPDATE_URL` in `lib/updates.ts` at them, compare against
 * {@link GEOIM3D_VERSION} rather than `APP_VERSION`, and set this to true.
 */
export const GEOIM3D_UPDATES_ENABLED = false;
