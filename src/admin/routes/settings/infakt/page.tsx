import { defineRouteConfig } from "@medusajs/admin-sdk";
import {
  Alert,
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Select,
  StatusBadge,
  Switch,
  Text,
  toast,
} from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ReconcilePanel } from "../../../components/reconcile-panel";
import { sdk } from "../../../lib/sdk";
import type { InfaktSettings, OverviewResponse } from "../../../lib/types";

type KsefMode = "nip-only" | "all" | "never";
type TriggerEvent = "payment.captured" | "order.placed";
type Environment = "production" | "sandbox";

const useKsefModeOptions = (): readonly { value: KsefMode; label: string }[] => {
  const { t } = useTranslation();
  return [
    {
      label: t(
        "infakt.settings.ksefModeNipOnly",
        "NIP only - B2B invoices, mandatory in Poland from April 2026",
      ),
      value: "nip-only",
    },
    {
      label: t("infakt.settings.ksefModeAll", "All invoices, including consumer ones"),
      value: "all",
    },
    {
      label: t(
        "infakt.settings.ksefModeNever",
        "Never - development only, breaks the KSeF filing obligation",
      ),
      value: "never",
    },
  ];
};

const useTriggerEventOptions = (): readonly { value: TriggerEvent; label: string }[] => {
  const { t } = useTranslation();
  return [
    {
      label: `payment.captured - ${t("infakt.settings.triggerEventPaymentCaptured", "queue once a payment is captured")}`,
      value: "payment.captured",
    },
    {
      label: `order.placed - ${t("infakt.settings.triggerEventOrderPlaced", "queue as soon as the order is placed")}`,
      value: "order.placed",
    },
  ];
};

const useEnvironmentOptions = (): readonly { value: Environment; label: string }[] => {
  const { t } = useTranslation();
  return [
    { label: t("infakt.settings.environmentProduction", "Production"), value: "production" },
    { label: t("infakt.settings.environmentSandbox", "Sandbox"), value: "sandbox" },
  ];
};

/**
 * The inFakt plugin's admin Settings page.
 *
 * Owns every setting that used to be readable but not writable from the admin:
 * currency, the KSeF filing condition, the trigger event, the environment, and
 * the `apiKey` itself, alongside the pause switch this page has always had.
 * Every field here is bound to `InfaktSettings` (the `infakt_settings` table)
 * rather than to the plugin's install-time options - saving one takes effect on
 * the very next subscriber invocation or worker tick, with no redeploy and no
 * restart. See
 * `mergeEffectiveOptions` in `src/lib/invoicing/effective-config.ts` for how the
 * two layers combine.
 *
 * The pause switch stays an immediate toggle, exactly as it always has been -
 * that is a live emergency-grade switch, not a form field to batch with the
 * rest. Everything else is gathered into one "Save configuration" action, so
 * changing the currency does not also re-send whatever an operator has half
 * typed into the API key field.
 *
 * The API key is write-only by design: the stored value is encrypted
 * (`settingsEncryptionKey`) and never read back over any admin route, so this
 * page can only report whether an override is configured, never what it is.
 */
const InfaktSettingsPage = () => {
  const { t } = useTranslation();
  const KSEF_MODE_OPTIONS = useKsefModeOptions();
  const TRIGGER_EVENT_OPTIONS = useTriggerEventOptions();
  const ENVIRONMENT_OPTIONS = useEnvironmentOptions();

  const [data, setData] = useState<OverviewResponse | undefined>();
  const [settings, setSettings] = useState<InfaktSettings | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [pausing, setPausing] = useState(false);

  const [currency, setCurrency] = useState("");
  const [ksefMode, setKsefMode] = useState<KsefMode>("nip-only");
  const [triggerEvent, setTriggerEvent] = useState<TriggerEvent>("payment.captured");
  const [environment, setEnvironment] = useState<Environment>("production");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [clearingApiKey, setClearingApiKey] = useState(false);
  const [checkingKsef, setCheckingKsef] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overviewResponse, settingsResponse] = await Promise.all([
        sdk.client.fetch<OverviewResponse>("/admin/infakt"),
        sdk.client.fetch<InfaktSettings>("/admin/infakt/settings"),
      ]);
      setData(overviewResponse);
      setSettings(settingsResponse);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? error.message
          : t("infakt.settings.loadError", "Could not load the inFakt configuration."),
      );
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Seed the form from the EFFECTIVE value, once, the first time settings load.
  // Re-seeding on every refetch (a Save re-fetches to pick up the new state)
  // would overwrite whatever an operator is mid-editing in another field.
  useEffect(() => {
    if (settings && !seeded) {
      setCurrency(settings.effective.currency);
      setKsefMode(settings.effective.ksef_mode);
      setTriggerEvent(settings.effective.trigger_event);
      setEnvironment(settings.effective.environment);
      setSeeded(true);
    }
  }, [settings, seeded]);

  const togglePause = async () => {
    if (!settings) {
      return;
    }
    setPausing(true);
    try {
      const result = await sdk.client.fetch<InfaktSettings>("/admin/infakt/settings", {
        body: { invoicing_paused: !settings.invoicing_paused },
        method: "POST",
      });
      setSettings(result);
      toast.success(
        result.invoicing_paused
          ? t("infakt.settings.pausedToast", "Invoicing paused.")
          : t("infakt.settings.resumedToast", "Invoicing resumed."),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("infakt.settings.pauseError", "Could not change the pause switch."),
      );
    } finally {
      setPausing(false);
    }
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    try {
      const body: Record<string, string> = {
        currency,
        environment,
        ksef_mode: ksefMode,
        trigger_event: triggerEvent,
      };
      const trimmedApiKey = apiKeyInput.trim();
      if (trimmedApiKey) {
        body.api_key = trimmedApiKey;
      }
      const result = await sdk.client.fetch<InfaktSettings>("/admin/infakt/settings", {
        body,
        method: "POST",
      });
      setSettings(result);
      setApiKeyInput("");
      await load();
      toast.success(t("infakt.settings.configSaved", "Configuration saved."));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("infakt.settings.configSaveError", "Could not save the configuration."),
      );
    } finally {
      setSavingConfig(false);
    }
  };

  const clearApiKeyOverride = async () => {
    setClearingApiKey(true);
    try {
      const result = await sdk.client.fetch<InfaktSettings>("/admin/infakt/settings", {
        body: { api_key: "" },
        method: "POST",
      });
      setSettings(result);
      toast.success(
        t(
          "infakt.settings.apiKeyCleared",
          "Saved API key removed. The plugin falls back to the key it was installed with, if there is one.",
        ),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("infakt.settings.apiKeyClearError", "Could not clear the API key override."),
      );
    } finally {
      setClearingApiKey(false);
    }
  };

  const recheckKsef = async () => {
    setCheckingKsef(true);
    try {
      const result = await sdk.client.fetch<{ active: boolean; error?: string }>(
        "/admin/infakt/ksef-check",
        { method: "POST" },
      );
      if (result.active) {
        toast.success(t("infakt.settings.ksefActive", "KSeF integration is active."));
      } else {
        toast.error(result.error ?? t("infakt.settings.ksefInactive", "The KSeF integration is not active."));
      }
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("infakt.settings.ksefCheckError", "Could not re-check the KSeF integration."),
      );
    } finally {
      setCheckingKsef(false);
    }
  };

  const config = data?.config;
  const runState = data?.run_state;
  const ksefUnhealthy = runState?.ksef_active === false && config?.ksefMode !== "never";
  const active = settings?.reason === "active";

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">inFakt</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            {t("infakt.settings.subtitle", "Polish invoicing for paid orders.")}
          </Text>
        </div>
        {config ? (
          <div className="flex items-center gap-x-2">
            <Badge color={config.environment === "sandbox" ? "orange" : "grey"} size="small">
              {config.environment}
            </Badge>
            <StatusBadge color={active ? (ksefUnhealthy ? "orange" : "green") : "red"}>
              {active
                ? ksefUnhealthy
                  ? t("infakt.settings.statusNeedsAttention", "needs attention")
                  : t("infakt.settings.statusActive", "active")
                : (settings?.reason ?? "-")}
            </StatusBadge>
          </div>
        ) : null}
      </div>

      {loadError ? (
        <div className="px-6 py-4">
          <Alert variant="error">{loadError}</Alert>
        </div>
      ) : null}

      {ksefUnhealthy ? (
        <div className="px-6 py-4">
          <Alert variant="error">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span>
                {t(
                  "infakt.settings.ksefUnhealthyAlert",
                  "The inFakt account has no active KSeF integration, so B2B invoices cannot be filed. Fix it in inFakt, then re-check here.",
                )}
              </span>
              <Button disabled={checkingKsef} onClick={() => void recheckKsef()} size="small">
                {checkingKsef
                  ? t("infakt.settings.checking", "Checking...")
                  : t("infakt.settings.recheckKsef", "Re-check KSeF")}
              </Button>
            </div>
          </Alert>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="mb-3 flex items-center justify-between">
          <Heading level="h2">{t("infakt.settings.invoicingHeading", "Invoicing")}</Heading>
        </div>
        {settings && !active ? (
          <Alert className="mb-3" variant="warning">
            {describeInactiveReason(t, settings)}
          </Alert>
        ) : null}
        <div className="flex items-center gap-x-3">
          <Switch
            checked={Boolean(settings && !settings.invoicing_paused)}
            disabled={pausing || !settings || settings.env_force_disabled}
            id="infakt-invoicing-paused"
            onCheckedChange={() => void togglePause()}
          />
          <Label htmlFor="infakt-invoicing-paused">
            {t("infakt.settings.invoicingEnabledLabel", "Invoicing enabled")}
          </Label>
        </div>
        {settings?.env_force_disabled ? (
          <Alert className="mt-3" variant="warning">
            <code>INFAKT_INVOICING_DISABLED</code>{" "}
            {t(
              "infakt.settings.envForceNotice",
              "forces invoicing off regardless of this switch. Unset it to let the switch above govern again.",
            )}
          </Alert>
        ) : null}
      </div>

      <div className="px-6 py-4">
        <div className="mb-3">
          <Heading level="h2">{t("infakt.settings.configHeading", "Configuration")}</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            {t(
              "infakt.settings.configDescription",
              "Changes here apply from the next order onward - no redeploy, no restart needed. A field left unchanged keeps using whatever this plugin was configured with at install.",
            )}
          </Text>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="infakt-currency">{t("infakt.settings.currencyLabel", "Currency")}</Label>
            <Input
              id="infakt-currency"
              onChange={(event) => setCurrency(event.target.value)}
              placeholder="PLN"
              value={currency}
            />
          </div>

          <div>
            <Label htmlFor="infakt-environment">
              {t("infakt.settings.environmentLabel", "Environment")}
            </Label>
            <Select
              onValueChange={(value) => setEnvironment(value as Environment)}
              value={environment}
            >
              <Select.Trigger id="infakt-environment">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {ENVIRONMENT_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>

          <div>
            <Label htmlFor="infakt-trigger-event">
              {t("infakt.settings.triggerEventLabel", "Invoice orders on")}
            </Label>
            <Select
              onValueChange={(value) => setTriggerEvent(value as TriggerEvent)}
              value={triggerEvent}
            >
              <Select.Trigger id="infakt-trigger-event">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {TRIGGER_EVENT_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>

          <div>
            <Label htmlFor="infakt-ksef-mode">
              {t("infakt.settings.ksefModeLabel", "Send to KSeF")}
            </Label>
            <Select onValueChange={(value) => setKsefMode(value as KsefMode)} value={ksefMode}>
              <Select.Trigger id="infakt-ksef-mode">
                <Select.Value />
              </Select.Trigger>
              <Select.Content>
                {KSEF_MODE_OPTIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
        </div>

        <div className="mt-4">
          <Label htmlFor="infakt-api-key">{t("infakt.settings.apiKeyLabel", "API key")}</Label>
          <Text className="text-ui-fg-subtle mb-2" size="small">
            {t(
              "infakt.settings.apiKeyWriteOnly",
              "A previously saved key is never shown here again - only whether one is configured.",
            )}{" "}
            <StatusBadge color={settings?.api_key_configured ? "green" : "grey"}>
              {settings?.api_key_configured
                ? t("infakt.settings.configured", "configured")
                : t("infakt.settings.notConfigured", "not configured")}
            </StatusBadge>
          </Text>
          <div className="flex items-center gap-x-2">
            <Input
              autoComplete="off"
              id="infakt-api-key"
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder={
                settings?.api_key_override_configured
                  ? t("infakt.settings.apiKeyPlaceholderReplace", "Enter a new key to replace the saved one")
                  : t("infakt.settings.apiKeyPlaceholderNew", "Enter a key to use instead of the installed one")
              }
              type="password"
              value={apiKeyInput}
            />
            {settings?.api_key_override_configured ? (
              <Button
                disabled={clearingApiKey}
                onClick={() => void clearApiKeyOverride()}
                size="small"
                variant="secondary"
              >
                {t("infakt.settings.clearOverride", "Clear override")}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button disabled={savingConfig || !settings} onClick={() => void saveConfig()}>
            {savingConfig
              ? t("infakt.settings.saving", "Saving...")
              : t("infakt.settings.saveConfig", "Save configuration")}
          </Button>
        </div>
      </div>

      <ReconcilePanel />

      {config ? (
        <div className="px-6 py-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
            <Field label={t("infakt.settings.fields.invoicingFrom", "Invoicing orders from")}>
              {config.startDate ?? t("infakt.settings.noDateFloor", "no date floor")}
            </Field>
            <Field label={t("infakt.settings.fields.vatSymbol", "VAT rate symbol")}>
              {config.taxSymbol}
            </Field>
            <Field label={t("infakt.settings.fields.ksefVerifiedAtStartup", "KSeF verified at startup")}>
              {config.ksefRequireActive
                ? t("infakt.common.yes", "yes")
                : t("infakt.common.no", "no")}
            </Field>
            <Field label={t("infakt.settings.fields.emitsEvent", "Emits infakt.invoice.issued")}>
              {config.emitIssuedEvent
                ? t("infakt.common.yes", "yes")
                : t("infakt.common.no", "no")}
            </Field>
            <Field label={t("infakt.settings.fields.needsReview", "Needs review")}>
              {data?.counts.needs_review ?? 0}
            </Field>
            <Field label={t("infakt.settings.fields.issued", "Issued")}>{data?.counts.done ?? 0}</Field>
          </dl>
        </div>
      ) : null}
    </Container>
  );
};

const describeInactiveReason = (t: TFunction, settings: InfaktSettings): string => {
  switch (settings.reason) {
    case "env_force_disabled": {
      return t(
        "infakt.settings.inactive.envForceDisabled",
        "Invoicing is forced off by the INFAKT_INVOICING_DISABLED environment variable.",
      );
    }
    case "no_api_key": {
      return t(
        "infakt.settings.inactive.noApiKey",
        "No order will be invoiced: no inFakt API key is configured, here or at install time.",
      );
    }
    case "paused": {
      return t(
        "infakt.settings.inactive.paused",
        "Invoicing is paused. No order will be invoiced until it is resumed.",
      );
    }
    default: {
      return t("infakt.settings.inactive.default", "Invoicing is currently off.");
    }
  }
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-ui-fg-muted txt-compact-small">{label}</dt>
    <dd className="txt-compact-small">{children}</dd>
  </div>
);

export const config = defineRouteConfig({
  label: "inFakt",
});

export default InfaktSettingsPage;
