import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_MAP_CENTER,
  DEFAULT_MAP_ZOOM,
  createDefaultMapView,
} from "../packages/core/src/project";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the default map opens centered on Seoul", () => {
  assert.deepEqual(DEFAULT_MAP_CENTER, [126.978, 37.5665]);
  assert.equal(DEFAULT_MAP_ZOOM, 11);
  assert.deepEqual(createDefaultMapView(), {
    center: [126.978, 37.5665],
    zoom: 11,
    bearing: 0,
    pitch: 0,
  });
});

test("application startup never mounts the automatic update checker", () => {
  const app = read("../apps/geolibre-desktop/src/App.tsx");

  assert.doesNotMatch(app, /useStartupUpdateCheck/);
  assert.doesNotMatch(app, /UpdateNotificationModal/);
});

test("startup update checks stay disabled in defaults and settings UI", () => {
  const settings = read("../apps/geolibre-desktop/src/hooks/useDesktopSettings.ts");
  const dialog = read("../apps/geolibre-desktop/src/components/layout/SettingsDialog.tsx");

  assert.match(
    settings,
    /DEFAULT_UPDATE_SETTINGS[\s\S]*?checkOnStartup:\s*false/,
  );
  assert.match(dialog, /if \(id === "updates"\) return false;/);
});
