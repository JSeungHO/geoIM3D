import assert from "node:assert/strict";
import { describe, it } from "node:test";
import en from "../apps/geolibre-desktop/src/i18n/locales-geoim3d/en.json";
import ko from "../apps/geolibre-desktop/src/i18n/locales-geoim3d/ko.json";
import { DATA_GO_KR_SERVICES } from "../apps/geolibre-desktop/src/lib/data-go-kr-services";

/**
 * The settings list renders each entry through `t()` with a `defaultValue`, so a
 * missing string degrades to the raw id ("airQualityReadings") rather than
 * failing the build. That is the right runtime behaviour and a silent defect in
 * a list whose whole job is to name services precisely, so the pairing is
 * checked here instead.
 */
describe("data.go.kr service list", () => {
  it("names every service in both catalogs", () => {
    for (const locale of [en, ko] as Array<Record<string, never>>) {
      const env = (locale as unknown as { settings: { env: Record<string, unknown> } }).settings
        .env;
      const names = env.services as Record<string, string>;
      const uses = env.servicesUse as Record<string, string>;
      for (const service of DATA_GO_KR_SERVICES) {
        assert.ok(names[service], `missing name for ${service}`);
        assert.ok(uses[service], `missing description for ${service}`);
      }
    }
  });

  it("carries no string for a service that was removed", () => {
    const ids = new Set(DATA_GO_KR_SERVICES);
    const names = (
      en as unknown as {
        settings: { env: { services: Record<string, string> } };
      }
    ).settings.env.services;
    for (const id of Object.keys(names)) {
      assert.ok(ids.has(id), `stale string for ${id}`);
    }
  });

  it("lists each service once", () => {
    assert.equal(new Set(DATA_GO_KR_SERVICES).size, DATA_GO_KR_SERVICES.length);
  });

  it("names the service rather than linking to it", () => {
    // The portal's URLs are not ours: a moved page does not fail loudly, it
    // lands somewhere wrong. The names are what its search takes.
    const names = (
      en as unknown as {
        settings: { env: { services: Record<string, string> } };
      }
    ).settings.env.services;
    for (const service of DATA_GO_KR_SERVICES) {
      assert.doesNotMatch(names[service], /https?:\/\//);
    }
  });
});
