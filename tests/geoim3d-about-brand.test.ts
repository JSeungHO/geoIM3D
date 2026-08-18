import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

test("geoIM3D desktop release version is 1.0.0 across app and Windows packaging", () => {
  const desktopPackage = readJson("apps/geolibre-desktop/package.json");
  const tauriConfig = readJson("apps/geolibre-desktop/src-tauri/tauri.conf.json");
  const cargoToml = readFileSync("apps/geolibre-desktop/src-tauri/Cargo.toml", "utf8");

  assert.equal(desktopPackage.version, "1.0.0");
  assert.equal(tauriConfig.version, "1.0.0");
  assert.match(cargoToml, /^version = "1\.0\.0"$/m);
});

test("Korean About content exposes the approved JBT and upstream attribution", () => {
  const locale = readJson("apps/geolibre-desktop/src/i18n/locales-geoim3d/ko.json") as {
    about: Record<string, string>;
  };

  assert.equal(locale.about.title, "geoIM3D 정보");
  assert.equal(
    locale.about.description,
    "geoIM3D는 건축·토목·부동산·환경·안전 분야를 위한 JBT의 실감형 3D 공간 플랫폼입니다.",
  );
  assert.equal(locale.about.licenseSectionTitle, "라이선스");
  assert.equal(locale.about.copyright, "Copyright © 2026 JBT. All Rights Reserved");
  assert.equal(locale.about.licenseAttribution, "GeoLibre 기반 · MIT 라이선스");
  assert.equal(locale.about.homePage, "JBT 홈페이지");
  assert.equal(locale.about.githubRepository, "원본 GeoLibre 프로젝트");
});

test("About dialog renders approved version, license, and external links", () => {
  const source = readFileSync(
    "apps/geolibre-desktop/src/components/layout/AboutDialog.tsx",
    "utf8",
  );

  assert.match(source, /geoIM3D \{APP_VERSION\}/);
  assert.match(source, /about\.licenseSectionTitle/);
  assert.match(source, /about\.copyright/);
  assert.match(source, /about\.licenseAttribution/);
  assert.match(source, /https:\/\/www\.ejbt\.co\.kr\//);
  assert.match(source, /https:\/\/github\.com\/opengeos\/GeoLibre/);
});
