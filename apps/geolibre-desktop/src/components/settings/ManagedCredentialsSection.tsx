import { verifyKmaApiKey, verifyVWorldApiKey } from "@geolibre/plugins";
import { Button, Input } from "@geolibre/ui";
import { useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useCredentialStore } from "../../hooks/useCredentials";
import type { CredentialId } from "../../lib/credentials";
import { DATA_GO_KR_SERVICES } from "../../lib/data-go-kr-services";

/**
 * The Settings → Environment block for API keys the app manages on the user's
 * behalf (VWorld, the data.go.kr portal).
 *
 * Self-contained on purpose: `SettingsDialog` is a large upstream file that
 * changes with every release, so it only mounts this component. All the state,
 * copy, and behaviour live here, where an upstream update cannot conflict with
 * them.
 *
 * The inputs are **write-only replacement drafts**. A stored credential is
 * never read back into the field — the UI can say whether one is configured and
 * nothing more (docs-internal/directives/07_SECURITY_PRIVACY.md). Saving a
 * blank box changes nothing; removing a key is the explicit Delete button.
 */

/**
 * The credentials offered a field, in render order. Every entry renders the
 * same box; only the copy, the sign-up link, and the check differ, so adding a
 * provider is one row here plus its id in `lib/credentials.ts` and
 * `credential_store.rs`.
 */
const MANAGED_CREDENTIALS: ReadonlyArray<{
  id: CredentialId;
  // The key types are the exact literals rather than i18next's ParseKeys: a
  // `<Trans i18nKey>` typed against the whole catalog union expands to a type
  // too complex for the compiler to represent (TS2590).
  titleKey: "settings.env.vworldKeyTitle" | "settings.env.dataGoKrKeyTitle";
  descriptionKey: "settings.env.vworldKeyDescription" | "settings.env.dataGoKrKeyDescription";
  signupUrl: string;
  /**
   * Whether to list the individual APIs that need their own 활용신청. The
   * portal issues one key per account but licenses each OpenAPI separately, so
   * the key alone does not make a feature work.
   */
  listsPortalServices?: boolean;
  /**
   * Runs one small live request to prove the saved key works. Reads the key
   * from the plugin module it was injected into, so the secret is not passed
   * back through the UI to test it.
   */
  verify: () => Promise<{ ok: boolean; kind?: string; readable?: boolean }>;
}> = [
  {
    id: "vworld:api-key",
    titleKey: "settings.env.vworldKeyTitle",
    descriptionKey: "settings.env.vworldKeyDescription",
    signupUrl: "https://www.vworld.kr/dev/v4api.do",
    verify: verifyVWorldApiKey,
  },
  {
    id: "data-go-kr:service-key",
    titleKey: "settings.env.dataGoKrKeyTitle",
    descriptionKey: "settings.env.dataGoKrKeyDescription",
    signupUrl: "https://www.data.go.kr/iim/api/selectAPIAcountView.do",
    listsPortalServices: true,
    verify: verifyKmaApiKey,
  },
];

/**
 * The APIs a data.go.kr key still has to be approved for, one link each.
 *
 * Without this the key field was the whole story, and it is not: the portal
 * licenses each OpenAPI separately and answers a 403 for one it did not
 * approve, which reads as a rejected key. Naming the services — and saying that
 * an approval takes about an hour to take effect — turns a dead feature into
 * something the user can act on.
 *
 * @returns The list.
 */
function PortalServiceList() {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 rounded-md border bg-muted/40 p-2 text-xs">
      <p className="font-medium">{t("settings.env.servicesTitle")}</p>
      <p className="text-muted-foreground">{t("settings.env.servicesIntro")}</p>
      <ul className="space-y-1 pt-1">
        {DATA_GO_KR_SERVICES.map((service) => (
          <li key={service.id}>
            <a className="underline" href={service.url} target="_blank" rel="noreferrer noopener">
              {/* defaultValue picks the plain-string overload: typing a computed
                  key against the whole catalog union is too complex for the
                  compiler to represent (TS2590). */}
              {t(`settings.env.services.${service.id}`, {
                defaultValue: service.id,
              })}
            </a>
            <span className="text-muted-foreground">
              {" — "}
              {t(`settings.env.servicesUse.${service.id}`, {
                defaultValue: "",
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Per-credential result of the "test key" button. */
type CredentialCheck =
  | { status: "checking" }
  | { status: "ok" }
  | { status: "failed"; kind: string; readable: boolean };

interface ManagedCredentialsSectionProps {
  /** Whether the Settings dialog is open; closing discards typed drafts. */
  open: boolean;
}

/**
 * Renders one write-only field per managed credential.
 *
 * @param props - Dialog open state.
 * @returns The credential fields.
 */
export function ManagedCredentialsSection({ open }: ManagedCredentialsSectionProps) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Partial<Record<CredentialId, string>>>({});
  const [checks, setChecks] = useState<Partial<Record<CredentialId, CredentialCheck>>>({});

  const backend = useCredentialStore((s) => s.backend);
  const errorCode = useCredentialStore((s) => s.errorCode);
  const values = useCredentialStore((s) => s.values);
  const setCredential = useCredentialStore((s) => s.setCredential);
  const deleteCredential = useCredentialStore((s) => s.deleteCredential);

  // Never carry a typed credential across a close: the boxes are one-shot
  // replacement drafts, and leaving one populated would also leave the value
  // sitting in component state for the rest of the session.
  useEffect(() => {
    if (!open) {
      setDrafts({});
      setChecks({});
    }
  }, [open]);

  const setDraft = useCallback((id: CredentialId, value: string) => {
    setDrafts((current) => ({ ...current, [id]: value }));
  }, []);

  const runCheck = useCallback((credential: (typeof MANAGED_CREDENTIALS)[number]) => {
    setChecks((current) => ({
      ...current,
      [credential.id]: { status: "checking" },
    }));
    void credential.verify().then(
      (result) =>
        setChecks((current) => ({
          ...current,
          [credential.id]: result.ok
            ? { status: "ok" }
            : {
                status: "failed",
                kind: result.kind ?? "unknown",
                readable: result.readable ?? true,
              },
        })),
      () =>
        setChecks((current) => ({
          ...current,
          [credential.id]: {
            status: "failed",
            kind: "unknown",
            readable: false,
          },
        })),
    );
  }, []);

  return (
    <>
      {MANAGED_CREDENTIALS.map((credential) => {
        const configured = Boolean(values[credential.id]);
        const draft = drafts[credential.id] ?? "";
        const check = checks[credential.id];
        return (
          <div key={credential.id} className="space-y-2 border-t pt-5">
            <h3 className="text-sm font-semibold">{t(credential.titleKey)}</h3>
            <p className="text-xs text-muted-foreground">
              <Trans
                i18nKey={credential.descriptionKey}
                components={{
                  keyLink: (
                    <a
                      className="underline"
                      href={credential.signupUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  ),
                }}
              />
            </p>
            {credential.listsPortalServices ? <PortalServiceList /> : null}
            <div className="flex gap-2">
              <Input
                aria-label={t(credential.titleKey)}
                type="password"
                autoComplete="new-password"
                placeholder={t(
                  configured
                    ? "settings.env.credentialConfigured"
                    : "settings.env.credentialPlaceholder",
                )}
                value={draft}
                onChange={(event) => setDraft(credential.id, event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!draft.trim()}
                onClick={() => {
                  void setCredential(credential.id, draft).then((saved) => {
                    if (saved) setDraft(credential.id, "");
                  });
                }}
              >
                {t("settings.env.credentialSave")}
              </Button>
              {configured ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={check?.status === "checking"}
                    onClick={() => runCheck(credential)}
                  >
                    {check?.status === "checking"
                      ? t("settings.env.credentialTesting")
                      : t("settings.env.credentialTest")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void deleteCredential(credential.id)}
                  >
                    {t("settings.env.credentialDelete")}
                  </Button>
                </>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {t(
                backend === "os"
                  ? "settings.env.credentialStorageOs"
                  : "settings.env.credentialStorageMemory",
              )}
            </p>
            {check?.status === "ok" ? (
              <p className="text-xs text-emerald-600 dark:text-emerald-500">
                {t("settings.env.credentialTestOk")}
              </p>
            ) : null}
            {check?.status === "failed" ? (
              <p className="text-xs text-destructive">
                {/* A readable answer carries the service's own reason; an
                    unreadable one (the portal omits CORS headers on errors) can
                    only be reported as inconclusive. */}
                {check.readable
                  ? t(`settings.env.credentialTestFailed.${check.kind}`, {
                      defaultValue: t("settings.env.credentialTestFailed.unknown"),
                    })
                  : t("settings.env.credentialTestUnreadable")}
              </p>
            ) : null}
          </div>
        );
      })}
      {errorCode ? (
        <p className="text-xs text-destructive">{t(`settings.env.credentialError.${errorCode}`)}</p>
      ) : null}
    </>
  );
}
