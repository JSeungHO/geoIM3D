import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Guards the dev-server proxy wiring in `vite.config.ts`.
 *
 * That file is listed in `tsconfig.node.json`, but `npm run build` does not
 * build that project — so nothing type-checks it. A GeoLibre merge renamed
 * `proxyBinaryRequest` to `proxyBinaryRequestGuarded` and updated every
 * upstream call site; the fork's own call, added elsewhere in the file, merged
 * cleanly and kept calling a function that no longer existed. Nothing caught
 * it until the Korean public-data proxy started answering 502 and the key
 * check reported a bare "service error".
 *
 * Reading the source is crude, but it is the check that would have caught it:
 * importing the config pulls in the whole plugin graph, and type-checking the
 * project fails on an unrelated undici/DOM mismatch in upstream's own guard.
 */

const CONFIG = new URL("../apps/geolibre-desktop/vite.config.ts", import.meta.url);

describe("vite dev-server proxy wiring", () => {
  const source = readFileSync(CONFIG, "utf8");

  it("calls only proxy helpers that exist", () => {
    const called = new Set(
      [...source.matchAll(/\bawait\s+(proxy\w+)\s*\(/g)].map((match) => match[1]),
    );
    assert.ok(called.size > 0, "no proxy helpers called — has the wiring moved?");

    for (const name of called) {
      const declared = new RegExp(`(?:function|const|let)\\s+${name}\\b`).test(source);
      const imported = new RegExp(`\\b${name}\\b[^;]*?from\\s+["']`, "s").test(
        source.slice(0, source.indexOf("\n\n")),
      );
      const importedAnywhere = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "s").test(
        source,
      );
      assert.ok(
        declared || imported || importedAnywhere,
        `${name}() is called but neither declared nor imported in vite.config.ts`,
      );
    }
  });

  it("routes the Korean public-data proxy through the SSRF guard", () => {
    // Not just any helper: this one reaches a government API from the dev
    // server, and the guarded helper is also the one that sends no Origin —
    // which is the whole reason the portal answers it at all.
    const handler = source.slice(source.indexOf("KR_API_PROXY_PATH, async"));
    assert.match(handler.slice(0, 400), /proxyBinaryRequestGuarded\(req, res, KR_API_PROXY_PATH\)/);
  });
});
