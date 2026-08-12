import { useTranslation } from "react-i18next";

/**
 * The geoIM3D licence block in Help → About.
 *
 * Its own component so `AboutDialog` — an upstream file that carries the whole
 * update-check flow — gains one import and one tag rather than a block of ours
 * in the middle of it.
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
 * Renders the copyright and the upstream attribution.
 *
 * @returns The licence section.
 */
export function Geoim3dAboutSection() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("geoim3dAbout.licenseTitle")}
      </div>
      <div className="rounded-md border bg-muted/30 px-3 py-2">
        <div className="text-foreground">{t("geoim3dAbout.copyright")}</div>
        {/* GeoLibre is MIT, which requires the notice to travel with the work.
            Stating the basis here is the attribution, not decoration. */}
        <div className="text-xs text-muted-foreground">{t("geoim3dAbout.basis")}</div>
      </div>
    </div>
  );
}
