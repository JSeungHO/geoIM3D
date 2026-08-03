import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  assistantConsentKey,
  hasAssistantConsent,
  recordAssistantConsent,
  summarizeAssistantTransmission,
} from "../apps/geolibre-desktop/src/lib/assistant-consent";

/** Minimal localStorage stand-in; the module reads it through the global. */
function installStorage(store: Map<string, string> = new Map()) {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  return store;
}

/** A storage that throws, as private-browsing modes do. */
function installFailingStorage() {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
    removeItem: () => {},
  };
}

const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
});

describe("assistant transmission consent", () => {
  it("withholds consent until it is recorded", () => {
    assert.equal(hasAssistantConsent("google"), false);
    recordAssistantConsent("google");
    assert.equal(hasAssistantConsent("google"), true);
  });

  it("records consent per provider, not once for the app", () => {
    // Switching provider changes who receives the layer description, so an
    // acknowledgment of one is not an acknowledgment of another.
    recordAssistantConsent("ollama");
    assert.equal(hasAssistantConsent("ollama"), true);
    assert.equal(hasAssistantConsent("google"), false);
    assert.equal(hasAssistantConsent("deployment-proxy"), false);
  });

  it("treats an empty provider id as unconsented", () => {
    // No resolved provider means no destination to disclose; sending anyway
    // would be exactly the silent transmission this gate exists to stop.
    recordAssistantConsent("");
    assert.equal(hasAssistantConsent(""), false);
  });

  it("fails closed when storage is unavailable", () => {
    installFailingStorage();
    // Private-browsing mode must show the notice again, never skip it.
    assert.equal(hasAssistantConsent("google"), false);
    assert.doesNotThrow(() => recordAssistantConsent("google"));
    assert.equal(hasAssistantConsent("google"), false);
  });

  it("namespaces its storage key", () => {
    assert.equal(
      assistantConsentKey("google"),
      "geolibre:assistant-transmission-notice:google",
    );
  });
});

describe("summarizeAssistantTransmission", () => {
  const provider = { providerId: "google", modelId: "gemini-3.5-flash", viaProxy: false };

  it("counts what the notice claims it will send", () => {
    const summary = summarizeAssistantTransmission(
      [
        {
          name: "sites",
          geojson: {
            features: [
              { properties: { parcel: "1", owner: "a" } },
              { properties: { parcel: "2", owner: "b" } },
            ],
          },
        },
        { name: "roads", geojson: { features: [{ properties: { ref: "1", owner: "c" } }] } },
      ],
      provider,
    );
    assert.equal(summary.layerCount, 2);
    assert.equal(summary.featureCount, 3);
    // `owner` appears in both layers but is one field name to the reader.
    assert.deepEqual([summary.fieldCount], [3]);
    assert.equal(summary.providerId, "google");
    assert.equal(summary.modelId, "gemini-3.5-flash");
  });

  it("handles layers with no vector data", () => {
    const summary = summarizeAssistantTransmission(
      [{ name: "basemap", geojson: null }, { name: "raster" }],
      provider,
    );
    assert.equal(summary.layerCount, 2);
    assert.equal(summary.featureCount, 0);
    assert.equal(summary.fieldCount, 0);
  });

  it("reports an empty map without inventing counts", () => {
    const summary = summarizeAssistantTransmission([], provider);
    assert.deepEqual(
      { layers: summary.layerCount, features: summary.featureCount, fields: summary.fieldCount },
      { layers: 0, features: 0, fields: 0 },
    );
  });

  it("carries the proxy hop through to the notice", () => {
    const summary = summarizeAssistantTransmission([], {
      providerId: "deployment-proxy",
      modelId: "",
      viaProxy: true,
    });
    assert.equal(summary.viaProxy, true);
  });
});

describe("the notice's copy", () => {
  /** Reads a locale catalog without the i18n runtime. */
  function locale(name: string): Record<string, Record<string, string>> {
    return JSON.parse(
      readFileSync(
        new URL(`../apps/geolibre-desktop/src/i18n/locales/${name}.json`, import.meta.url),
        "utf8",
      ),
    ) as Record<string, Record<string, string>>;
  }

  it("states all four things the directive requires, in every shipped locale", () => {
    // 07_SECURITY_PRIVACY: before sending, name the provider, the kinds and
    // scope of the data, the counts, and that this is an external transmission.
    const required = [
      "transmissionTitle",
      "transmissionDestination",
      "transmissionContents",
      "transmissionContentsValue",
      "transmissionScope",
      "transmissionScopeValue",
      "transmissionWarning",
      "transmissionCancel",
      "transmissionContinue",
    ];
    for (const name of ["en", "ko"]) {
      const assistant = locale(name).assistant;
      for (const key of required) {
        assert.equal(typeof assistant[key], "string", `${name}.json is missing assistant.${key}`);
        assert.notEqual(assistant[key].trim(), "", `${name}.json has an empty assistant.${key}`);
      }
      // The counts are interpolated, so the placeholders have to survive
      // translation or the user sees a sentence with no numbers in it.
      for (const placeholder of ["{{layers}}", "{{features}}", "{{fields}}"]) {
        assert.ok(
          assistant.transmissionScopeValue.includes(placeholder),
          `${name}.json transmissionScopeValue lost ${placeholder}`,
        );
      }
    }
  });
});
