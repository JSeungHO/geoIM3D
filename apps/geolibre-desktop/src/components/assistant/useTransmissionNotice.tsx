import { useAppStore } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  hasAssistantConsent,
  recordAssistantConsent,
  summarizeAssistantTransmission,
  type AssistantTransmissionSummary,
} from "../../lib/assistant-consent";

/**
 * The one-time notice shown before the first prompt reaches a given AI provider.
 *
 * A prompt does not travel alone: the assistant prepends a description of every
 * loaded layer — names, geometry types, feature counts, and attribute field
 * names. That is the largest outbound disclosure in the app, so it gets the same
 * acknowledgment the directions, reverse-geocode, and routing gates already use
 * (docs-internal/directives/07_SECURITY_PRIVACY.md).
 *
 * Packaged as a hook plus an overlay node so `AssistantPanel` — a large upstream
 * file — only awaits one call and renders one variable. Everything else lives
 * here, out of the way of upstream changes.
 */

export interface TransmissionProvider {
  /** Provider id, or `deployment-proxy`, or empty when none is resolved. */
  providerId: string;
  modelId: string;
  /** True when the request reaches a provider through the deployment's proxy. */
  viaProxy: boolean;
}

export interface TransmissionNotice {
  /**
   * Resolves true when the prompt may be sent: either this provider was already
   * acknowledged, or the user accepts the notice now. Nothing has left the
   * device when this is called.
   */
  ensureConsent: () => Promise<boolean>;
  /** The modal, or null when no notice is showing. Render inside the panel. */
  overlay: ReactNode;
}

/**
 * Gates outbound prompts behind a per-provider acknowledgment.
 *
 * @param provider - Where a prompt would be sent right now.
 * @returns The gate and its overlay.
 */
export function useTransmissionNotice(provider: TransmissionProvider): TransmissionNotice {
  const [pending, setPending] = useState<{
    summary: AssistantTransmissionSummary;
    resolve: (accepted: boolean) => void;
  } | null>(null);

  // Read through a ref so `ensureConsent` stays stable for callers that capture
  // it, while still seeing the provider selected at the moment of sending.
  const providerRef = useRef(provider);
  providerRef.current = provider;

  // A pending notice left unresolved would block its caller forever.
  useEffect(() => () => pending?.resolve(false), [pending]);

  const ensureConsent = (): Promise<boolean> => {
    const current = providerRef.current;
    if (hasAssistantConsent(current.providerId)) return Promise.resolve(true);
    const summary = summarizeAssistantTransmission(useAppStore.getState().layers, current);
    return new Promise<boolean>((resolve) => {
      setPending({
        summary,
        resolve: (accepted) => {
          if (accepted) recordAssistantConsent(current.providerId);
          setPending(null);
          resolve(accepted);
        },
      });
    });
  };

  return {
    ensureConsent,
    overlay: pending ? (
      <TransmissionNoticeOverlay summary={pending.summary} onDecide={pending.resolve} />
    ) : null,
  };
}

/**
 * States the four things the user needs in order to decide: where the data
 * goes, what kinds go, how much there is right now, and that this leaves the
 * device. Cancel is the safe default.
 */
function TransmissionNoticeOverlay({
  summary,
  onDecide,
}: {
  summary: AssistantTransmissionSummary;
  onDecide: (accepted: boolean) => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const destination = summary.viaProxy
    ? t("assistant.transmissionProxy")
    : [summary.providerId, summary.modelId].filter(Boolean).join(" · ") || summary.providerId;

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/80 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("assistant.transmissionTitle")}
        className="flex max-h-full w-full max-w-md flex-col gap-3 overflow-auto rounded-lg border bg-card p-4 shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onDecide(false);
          }
        }}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-semibold">{t("assistant.transmissionTitle")}</span>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t("assistant.transmissionDestination")}</dt>
          <dd className="font-medium">{destination}</dd>
          <dt className="text-muted-foreground">{t("assistant.transmissionContents")}</dt>
          <dd>{t("assistant.transmissionContentsValue")}</dd>
          <dt className="text-muted-foreground">{t("assistant.transmissionScope")}</dt>
          <dd>
            {t("assistant.transmissionScopeValue", {
              layers: summary.layerCount,
              features: summary.featureCount,
              fields: summary.fieldCount,
            })}
          </dd>
        </dl>

        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t("assistant.transmissionWarning")}
        </p>

        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} size="sm" variant="outline" onClick={() => onDecide(false)}>
            {t("assistant.transmissionCancel")}
          </Button>
          <Button size="sm" onClick={() => onDecide(true)}>
            {t("assistant.transmissionContinue")}
          </Button>
        </div>
      </div>
    </div>
  );
}
