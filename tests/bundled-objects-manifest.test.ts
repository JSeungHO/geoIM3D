import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";
import { parseBundledManifest } from "../packages/plugins/src/plugins/geoim3d-object-presets";

/**
 * Checks the objects actually shipped in `public/objects/`.
 *
 * A name that does not match the file on disk fails at click time, as a 404
 * the panel can only report as "the object could not be loaded" — it cannot
 * tell a missing file from a corrupt one. That mismatch happened on the first
 * entry ever added (`gogiri-park.sog` against `gogiri_park.sog`), so it is
 * checked here rather than left to whoever clicks it next.
 */

const DIR = new URL("../apps/geolibre-desktop/public/objects/", import.meta.url);
const MANIFEST = new URL("manifest.json", DIR);

describe("the shipped object manifest", () => {
  const raw = readFileSync(MANIFEST, "utf8");

  it("is valid JSON with an objects array", () => {
    const parsed = JSON.parse(raw) as { objects?: unknown };
    assert.ok(Array.isArray(parsed.objects), "manifest.json needs an `objects` array");
  });

  it("names a file that exists for every entry", () => {
    const entries = (JSON.parse(raw) as { objects: { file?: string }[] }).objects;
    for (const entry of entries) {
      assert.ok(entry.file, "every entry needs a `file`");
      assert.ok(
        existsSync(new URL(entry.file, DIR)),
        `manifest names "${entry.file}", which is not in public/objects/`,
      );
    }
  });

  it("has an entry for every object file present", () => {
    // The other direction: a file copied in but never listed ships its bytes
    // in the installer and is reachable from nowhere.
    const listed = new Set(
      (JSON.parse(raw) as { objects: { file?: string }[] }).objects.map((entry) => entry.file),
    );
    const present = readdirSync(DIR).filter((name) => !/\.(md|json)$/i.test(name));
    for (const file of present) {
      assert.ok(listed.has(file), `public/objects/${file} is not listed in manifest.json`);
    }
  });

  it("survives the parser every entry has to pass", () => {
    // parseBundledManifest drops an entry with a missing rotation or a
    // non-numeric placement, so a listed object could still never appear.
    const parsed = JSON.parse(raw) as { objects: unknown[] };
    assert.equal(
      parseBundledManifest(raw, "http://localhost/").length,
      parsed.objects.length,
      "an entry was dropped by the parser — check rotation and the coordinates",
    );
  });
});
