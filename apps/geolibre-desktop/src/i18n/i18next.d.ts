import "i18next";

import type en from "./locales/en.json";
// geoIM3D adds its strings in a separate catalog (see geoim3d-catalog.ts),
// so `t()` is typed against the union of the two.
import type geoim3dEn from "./locales-geoim3d/en.json";

// Type the `t()` keys against the English catalog so missing/misspelled keys are
// compile errors. `en.json` is the source of truth; other locales may be partial
// and fall back to it at runtime.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en & typeof geoim3dEn;
    };
  }
}
