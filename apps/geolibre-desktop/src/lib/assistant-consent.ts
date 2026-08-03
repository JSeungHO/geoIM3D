/**
 * Consent gate for the AI Assistant.
 *
 * A prompt does not travel alone: the assistant prepends a description of every
 * loaded layer — names, geometry types, feature counts, and attribute field
 * names — so the model stays grounded (see `describeLayers` in
 * `lib/assistant/tools.ts`). That is a larger disclosure than any other outbound
 * feature in the app, which is why it gets the same one-time notice the
 * directions, reverse-geocode, and network-routing gates already use.
 *
 * Consent is recorded **per provider**, not once for the app: switching from a
 * local Ollama model to Google changes who receives the data, and an
 * acknowledgment of one is not an acknowledgment of the other.
 */

/** Storage key prefix; the provider id is appended. */
export const ASSISTANT_CONSENT_KEY_PREFIX = "geolibre:assistant-transmission-notice:";

/**
 * The storage key for one provider's acknowledgment.
 *
 * @param providerId - The assistant provider id (e.g. `google`).
 * @returns The localStorage key.
 */
export function assistantConsentKey(providerId: string): string {
  return `${ASSISTANT_CONSENT_KEY_PREFIX}${providerId}`;
}

/**
 * Whether the user has acknowledged the transmission notice for a provider.
 *
 * @param providerId - The assistant provider id.
 * @returns True when the notice was acknowledged for this provider.
 */
export function hasAssistantConsent(providerId: string): boolean {
  if (!providerId) return false;
  try {
    return localStorage.getItem(assistantConsentKey(providerId)) === "1";
  } catch {
    // localStorage unavailable (private mode): treat as not acknowledged so the
    // notice is shown rather than silently sending the layer description.
    return false;
  }
}

/**
 * Records that the user acknowledged the notice for a provider.
 *
 * @param providerId - The assistant provider id.
 */
export function recordAssistantConsent(providerId: string): void {
  if (!providerId) return;
  try {
    localStorage.setItem(assistantConsentKey(providerId), "1");
  } catch {
    // Ignore: the notice will simply show again next time.
  }
}

/** What the notice tells the user it is about to send. */
export interface AssistantTransmissionSummary {
  /** Provider id, e.g. `google`. */
  providerId: string;
  /** Model id, when one is resolved. */
  modelId: string;
  /**
   * True when the request goes through the deployment's own AI proxy before
   * reaching the provider — a second party the user should know about.
   */
  viaProxy: boolean;
  layerCount: number;
  featureCount: number;
  fieldCount: number;
}

/**
 * Summarizes what a prompt would disclose, for the notice.
 *
 * Counts come from the same layer list the assistant describes, so the numbers
 * shown are the numbers sent rather than an estimate.
 *
 * @param layers - The loaded layers.
 * @param provider - Provider id, model id, and whether a proxy is in front.
 * @returns The summary rendered in the notice.
 */
export function summarizeAssistantTransmission(
  layers: ReadonlyArray<{
    name?: string;
    geojson?: { features?: unknown[] } | null;
    metadata?: Record<string, unknown> | null;
  }>,
  provider: { providerId: string; modelId: string; viaProxy: boolean },
): AssistantTransmissionSummary {
  let featureCount = 0;
  const fieldNames = new Set<string>();
  for (const layer of layers) {
    const features = layer.geojson?.features;
    if (!Array.isArray(features)) continue;
    featureCount += features.length;
    for (const feature of features) {
      const properties = (feature as { properties?: Record<string, unknown> } | null)?.properties;
      if (!properties) continue;
      for (const name of Object.keys(properties)) fieldNames.add(name);
      // One feature is enough to learn the schema; scanning every feature of a
      // large layer to build the notice would stall opening it.
      break;
    }
  }
  return {
    providerId: provider.providerId,
    modelId: provider.modelId,
    viaProxy: provider.viaProxy,
    layerCount: layers.length,
    featureCount,
    fieldCount: fieldNames.size,
  };
}
