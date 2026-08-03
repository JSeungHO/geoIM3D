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
        assert.ok(names[service.id], `missing name for ${service.id}`);
        assert.ok(uses[service.id], `missing description for ${service.id}`);
      }
    }
  });

  it("carries no string for a service that was removed", () => {
    const ids = new Set(DATA_GO_KR_SERVICES.map((service) => service.id));
    const names = (
      en as unknown as {
        settings: { env: { services: Record<string, string> } };
      }
    ).settings.env.services;
    for (const id of Object.keys(names)) {
      assert.ok(ids.has(id), `stale string for ${id}`);
    }
  });

  it("links each service to the public-data portal", () => {
    const seen = new Set<string>();
    for (const service of DATA_GO_KR_SERVICES) {
      assert.ok(!seen.has(service.id), `duplicate id ${service.id}`);
      seen.add(service.id);
      // A dataset page or a search for it — never an invented id, which would
      // send the user to confidently apply for the wrong service.
      assert.match(service.url, /^https:\/\/www\.data\.go\.kr\//);
    }
  });
});
