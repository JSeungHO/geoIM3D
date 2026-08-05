import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const readCatalog = (path: string) => JSON.parse(read(path)) as {
  primaryGlobe: { maplibre: string };
};

test("the primary MapLibre map is created with reduced motion enabled", () => {
  const source = read("../packages/map/src/map-controller.ts");
  const constructorOptions = source.match(/new maplibregl\.Map\(\{([\s\S]*?)\n\s*\}\);/)?.[1];

  assert.ok(constructorOptions, "MapLibre constructor options were not found");
  assert.match(constructorOptions, /\breduceMotion:\s*true\b/);
});

test("the primary renderer tab is labeled MapLibre in both product locales", () => {
  const en = readCatalog(
    "../apps/geolibre-desktop/src/i18n/locales-geoim3d/en.json",
  );
  const ko = readCatalog(
    "../apps/geolibre-desktop/src/i18n/locales-geoim3d/ko.json",
  );

  assert.equal(en.primaryGlobe.maplibre, "MapLibre");
  assert.equal(ko.primaryGlobe.maplibre, "MapLibre");
});
