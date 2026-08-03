import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { mergeCatalogs } from "../apps/geolibre-desktop/src/i18n/merge-catalogs";
import {
  PLUGIN_MENU_GROUPS,
  pluginMenuGroupFor,
} from "../packages/plugins/src/plugins/plugin-menu-groups";

/**
 * The catalog the app actually resolves: upstream plus this fork's overlay.
 *
 * The fork keeps its strings in `locales-geoim3d/` so the upstream files stay
 * mergeable, and merges them at load time — so a test that read only the
 * upstream file would be asserting against something the app never uses.
 */
function locale(name: string): Record<string, any> {
  const read = (dir: string) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../apps/geolibre-desktop/src/i18n/${dir}/${name}.json`,
          import.meta.url
        ),
        "utf8"
      )
    ) as Record<string, unknown>;
  return mergeCatalogs(read("locales"), read("locales-geoim3d"));
}

/** Resolves a dotted i18n key against a catalog. */
function lookup(catalog: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, segment) => {
    if (!node || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[segment];
  }, catalog);
}

describe("plugin menu groups", () => {
  it("maps every member id back to its group", () => {
    for (const group of PLUGIN_MENU_GROUPS) {
      for (const pluginId of group.pluginIds) {
        assert.equal(
          pluginMenuGroupFor(pluginId)?.id,
          group.id,
          `${pluginId} -> ${group.id}`
        );
      }
    }
  });

  it("returns undefined for an ungrouped plugin", () => {
    // Upstream plugins must keep rendering as top-level entries, so a miss has
    // to be a miss rather than a default group.
    assert.equal(pluginMenuGroupFor("maplibre-layer-control"), undefined);
    assert.equal(pluginMenuGroupFor(""), undefined);
  });

  it("claims no plugin twice", () => {
    // Two groups owning one plugin would render it in both submenus, and the
    // host's "render the group at its first member" placement would be ambiguous.
    const seen = new Set<string>();
    for (const group of PLUGIN_MENU_GROUPS) {
      for (const pluginId of group.pluginIds) {
        assert.equal(
          seen.has(pluginId),
          false,
          `${pluginId} is claimed by two groups`
        );
        seen.add(pluginId);
      }
    }
  });

  it("has a translated label in every shipped locale", () => {
    // The host renders `t(group.labelKey)`; a missing key would surface the raw
    // key as the submenu title.
    for (const group of PLUGIN_MENU_GROUPS) {
      for (const name of ["en", "ko"]) {
        assert.equal(
          typeof lookup(locale(name), group.labelKey),
          "string",
          `${name}.json is missing ${group.labelKey}`
        );
      }
    }
  });

  it("names every grouped plugin in the Plugins menu", () => {
    // The menu falls back to the plugin's registered English name, so a missing
    // `toolbar.plugin.<id>` entry is not fatal — but for these it means the
    // Korean UI would show an English label.
    const ko = locale("ko");
    for (const group of PLUGIN_MENU_GROUPS) {
      for (const pluginId of group.pluginIds) {
        assert.equal(
          typeof lookup(ko, `toolbar.plugin.${pluginId}`),
          "string",
          `ko.json is missing toolbar.plugin.${pluginId}`
        );
      }
    }
  });
});
