import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { mergeCatalogs } from "../apps/geolibre-desktop/src/i18n/merge-catalogs";

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

const UPSTREAM = "../apps/geolibre-desktop/src/i18n/locales";
const FORK = "../apps/geolibre-desktop/src/i18n/locales-geoim3d";

describe("mergeCatalogs", () => {
  it("merges nested branches instead of replacing them", () => {
    // The failure this guards is silent and total: the fork's catalog is a
    // sparse overlay, so a shallow spread would replace the whole `settings`
    // branch and delete every upstream string beneath it.
    const merged = mergeCatalogs(
      { settings: { title: "Settings", map: { zoom: "Zoom" } } },
      { settings: { env: { newKey: "New" } } },
    );
    const settings = merged.settings as Record<string, unknown>;
    assert.equal(settings.title, "Settings");
    assert.deepEqual(settings.map, { zoom: "Zoom" });
    assert.deepEqual(settings.env, { newKey: "New" });
  });

  it("lets the overlay override a leaf", () => {
    const merged = mergeCatalogs({ a: "upstream" }, { a: "fork" });
    assert.equal(merged.a, "fork");
  });

  it("replaces arrays outright rather than merging them", () => {
    // i18next uses arrays for plural/context lists; merging element-wise would
    // produce a hybrid that matches neither catalog.
    const merged = mergeCatalogs({ compass: ["N", "E"] }, { compass: ["북", "동", "남"] });
    assert.deepEqual(merged.compass, ["북", "동", "남"]);
  });

  it("mutates neither input", () => {
    const base = { settings: { title: "Settings" } };
    const overlay = { settings: { extra: "x" } };
    mergeCatalogs(base, overlay);
    assert.deepEqual(base, { settings: { title: "Settings" } });
    assert.deepEqual(overlay, { settings: { extra: "x" } });
  });
});

describe("the split catalogs", () => {
  it("keeps every upstream English key reachable after the merge", () => {
    // Proves the extraction removed only what the fork added.
    const merged = mergeCatalogs(read(`${UPSTREAM}/en.json`), read(`${FORK}/en.json`));
    const settings = (merged.settings ?? {}) as Record<string, unknown>;
    const env = (settings.env ?? {}) as Record<string, unknown>;
    // An upstream string under a branch the fork also extends.
    assert.equal(typeof env.tokenTitle, "string");
    // And the fork's own string in the same branch.
    assert.equal(typeof env.dataGoKrKeyTitle, "string");
  });

  it("puts the fork's own sections in the fork catalog only", () => {
    const upstream = read(`${UPSTREAM}/en.json`);
    const fork = read(`${FORK}/en.json`);
    for (const section of ["vworld", "kma", "primaryGlobe"]) {
      assert.equal(upstream[section], undefined, `${section} leaked into the upstream catalog`);
      assert.equal(typeof fork[section], "object", `${section} missing from the fork catalog`);
    }
  });

  it("translates the fork's sections into Korean", () => {
    const en = read(`${FORK}/en.json`);
    const ko = read(`${FORK}/ko.json`);
    for (const section of Object.keys(en)) {
      assert.ok(ko[section], `ko.json is missing the ${section} section`);
    }
  });
});
