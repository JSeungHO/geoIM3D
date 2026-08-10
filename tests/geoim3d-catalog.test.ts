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

/** Flattens a catalog to dotted keys so leaves can be compared across locales. */
function leaves(node: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const path = `${prefix}${key}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, leaves(value as Record<string, unknown>, `${path}.`));
      continue;
    }
    out[path] = value;
  }
  return out;
}

/**
 * Keys whose Korean value is deliberately the English text.
 *
 * Product and brand names are written the same in both locales, so the
 * "looks untranslated" check below would flag them forever. Listed explicitly
 * rather than pattern-matched: an accidental copy is exactly what the check
 * exists to catch, and a rule loose enough to cover these would cover those too.
 */
const INTENTIONALLY_IDENTICAL = new Set([
  "primaryGlobe.maplibre", // "OSM"
  "primaryGlobe.cesium", // "Cesium"
  "objects.threeDTiles", // "3D Tiles…" — the format's name, as VWorld's is
]);

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

  it("translates every fork string into Korean", () => {
    // Korean is the product's primary language, so an untranslated key is a
    // visible defect rather than a cosmetic gap. Checking leaves, not just
    // top-level sections: a section can exist and still be half empty.
    const en = leaves(read(`${FORK}/en.json`));
    const ko = leaves(read(`${FORK}/ko.json`));

    const missing = Object.keys(en).filter((key) => !(key in ko));
    assert.deepEqual(missing, [], `ko.json is missing: ${missing.join(", ")}`);

    // A Korean value identical to the English one is almost always a key that
    // was copied across and never translated.
    const copied = Object.keys(en).filter(
      (key) =>
        !INTENTIONALLY_IDENTICAL.has(key) &&
        typeof en[key] === "string" &&
        ko[key] === en[key] &&
        /[a-z]/i.test(en[key] as string),
    );
    assert.deepEqual(copied, [], `ko.json still holds the English text for: ${copied.join(", ")}`);
  });
});
