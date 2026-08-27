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

  it("names a file that exists, wherever the binaries are present", () => {
    // The binaries are gitignored — tens of megabytes each — so a clean clone
    // has the manifest and no files, and this cannot demand they be there.
    // Where a file *is* present the name still has to match, which is what
    // catches a typo on the machine that added it, before it ships.
    const entries = (JSON.parse(raw) as { objects: { file?: string }[] }).objects;
    const present = new Set(readdirSync(DIR).filter((name) => !/\.(md|json)$/i.test(name)));
    for (const entry of entries) {
      assert.ok(entry.file, "every entry needs a `file`");
      if (present.size === 0) continue;
      assert.ok(
        existsSync(new URL(entry.file, DIR)),
        `manifest names "${entry.file}", which is not in public/objects/ (found: ${[...present].join(", ")})`,
      );
    }
  });

  it("names a tileset that exists, wherever it is present", () => {
    // A `tileset` is what the globe shows for a preset the splat renderer can
    // only draw on the 2D map. Same rule as `file`: gitignored, so only
    // checked where it is actually there.
    const entries = (JSON.parse(raw) as { objects: { tileset?: string }[] }).objects;
    for (const entry of entries) {
      if (!entry.tileset) continue;
      const folder = entry.tileset.split("/")[0] ?? "";
      if (!existsSync(new URL(`${folder}/`, DIR))) continue;
      assert.ok(
        existsSync(new URL(entry.tileset, DIR)),
        `manifest names tileset "${entry.tileset}", which is not in public/objects/`,
      );
    }
  });

  it("has an entry for every object file present", () => {
    // The other direction: a file copied in but never listed ships its bytes
    // in the installer and is reachable from nowhere. A tileset is reachable
    // through its own field, so its folder counts as listed.
    const objects = (JSON.parse(raw) as { objects: { file?: string; tileset?: string }[] }).objects;
    const listed = new Set<string | undefined>(objects.map((entry) => entry.file));
    for (const entry of objects) {
      if (entry.tileset) listed.add(entry.tileset.split("/")[0]);
    }
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
