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
import { ReconcilePanel } from "../../../components/reconcile-panel";
import { sdk } from "../../../lib/sdk";
import type { InfaktSettings, OverviewResponse } from "../../../lib/types";

type KsefMode = "nip-only" | "all" | "never";
type TriggerEvent = "payment.captured" | "order.placed";
type Environment = "production" | "sandbox";

const KSEF_MODE_OPTIONS: readonly { value: KsefMode; label: string }[] = [
  { label: "NIP only - B2B invoices, mandatory in Poland from April 2026", value: "nip-only" },
  { label: "All invoices, including consumer ones", value: "all" },
  { label: "Never - development only, breaks the KSeF filing obligation", value: "never" },
];

const TRIGGER_EVENT_OPTIONS: readonly { value: TriggerEvent; label: string }[] = [
  { label: "payment.captured - queue once a payment is captured", value: "payment.captured" },
  { label: "order.placed - queue as soon as the order is placed", value: "order.placed" },
];

const ENVIRONMENT_OPTIONS: readonly { value: Environment; label: string }[] = [
  { label: "Production", value: "production" },
  { label: "Sandbox", value: "sandbox" },
];

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
        error instanceof Error ? error.message : "Could not load the inFakt configuration.",
      );
    }
  }, []);

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
      toast.success(result.invoicing_paused ? "Invoicing paused." : "Invoicing resumed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the pause switch.");
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
      toast.success("Configuration saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the configuration.");
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
      toast.success("Saved API key removed. The plugin falls back to the key it was installed with, if there is one.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear the API key override.");
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
        toast.success("KSeF integration is active.");
      } else {
        toast.error(result.error ?? "The KSeF integration is not active.");
      }
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not re-check the KSeF integration.",
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
            Polish invoicing for paid orders.
          </Text>
        </div>
        {config ? (
          <div className="flex items-center gap-x-2">
            <Badge color={config.environment === "sandbox" ? "orange" : "grey"} size="small">
              {config.environment}
            </Badge>
            <StatusBadge color={active ? (ksefUnhealthy ? "orange" : "green") : "red"}>
              {active ? (ksefUnhealthy ? "needs attention" : "active") : (settings?.reason ?? "-")}
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
                The inFakt account has no active KSeF integration, so B2B invoices cannot be filed.
                Fix it in inFakt, then re-check here.
              </span>
              <Button disabled={checkingKsef} onClick={() => void recheckKsef()} size="small">
                {checkingKsef ? "Checking..." : "Re-check KSeF"}
              </Button>
            </div>
          </Alert>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="mb-3 flex items-center justify-between">
          <Heading level="h2">Invoicing</Heading>
        </div>
        {settings && !active ? (
          <Alert className="mb-3" variant="warning">
            {describeInactiveReason(settings)}
          </Alert>
        ) : null}
        <div className="flex items-center gap-x-3">
          <Switch
            checked={Boolean(settings && !settings.invoicing_paused)}
            disabled={pausing || !settings || settings.env_force_disabled}
            id="infakt-invoicing-paused"
            onCheckedChange={() => void togglePause()}
          />
          <Label htmlFor="infakt-invoicing-paused">Invoicing enabled</Label>
        </div>
        {settings?.env_force_disabled ? (
          <Alert className="mt-3" variant="warning">
            <code>INFAKT_INVOICING_DISABLED</code> forces invoicing off regardless of this switch.
            Unset it to let the switch above govern again.
          </Alert>
        ) : null}
      </div>

      <div className="px-6 py-4">
        <div className="mb-3">
          <Heading level="h2">Configuration</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Changes here take effect on the next order or worker tick - no redeploy, no restart.
            A field left as it loaded is not resaved: it keeps following however this plugin was
            configured at install time.
          </Text>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="infakt-currency">Currency</Label>
            <Input
              id="infakt-currency"
              onChange={(event) => setCurrency(event.target.value)}
              placeholder="PLN"
              value={currency}
            />
          </div>

          <div>
            <Label htmlFor="infakt-environment">Environment</Label>
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
            <Label htmlFor="infakt-trigger-event">Invoice orders on</Label>
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
            <Label htmlFor="infakt-ksef-mode">Send to KSeF</Label>
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
          <Label htmlFor="infakt-api-key">API key</Label>
          <Text className="text-ui-fg-subtle mb-2" size="small">
            Write-only: a previously saved key is never shown here, only whether one is configured.{" "}
            <StatusBadge color={settings?.api_key_configured ? "green" : "grey"}>
              {settings?.api_key_configured ? "configured" : "not configured"}
            </StatusBadge>
          </Text>
          <div className="flex items-center gap-x-2">
            <Input
              autoComplete="off"
              id="infakt-api-key"
              onChange={(event) => setApiKeyInput(event.target.value)}
              placeholder={
                settings?.api_key_override_configured
                  ? "Enter a new key to replace the saved one"
                  : "Enter a key to use instead of the installed one"
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
                Clear override
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <Button disabled={savingConfig || !settings} onClick={() => void saveConfig()}>
            {savingConfig ? "Saving..." : "Save configuration"}
          </Button>
        </div>
      </div>

      <ReconcilePanel />

      {config ? (
        <div className="px-6 py-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
            <Field label="Invoicing orders from">{config.startDate ?? "no date floor"}</Field>
            <Field label="VAT rate symbol">{config.taxSymbol}</Field>
            <Field label="KSeF verified at startup">
              {config.ksefRequireActive ? "yes" : "no"}
            </Field>
            <Field label="Emits infakt.invoice.issued">
              {config.emitIssuedEvent ? "yes" : "no"}
            </Field>
            <Field label="Needs review">{data?.counts.needs_review ?? 0}</Field>
            <Field label="Issued">{data?.counts.done ?? 0}</Field>
          </dl>
        </div>
      ) : null}
    </Container>
  );
};

const describeInactiveReason = (settings: InfaktSettings): string => {
  switch (settings.reason) {
    case "env_force_disabled": {
      return "Invoicing is forced off by the INFAKT_INVOICING_DISABLED environment variable.";
    }
    case "no_api_key": {
      return "No order will be invoiced: no inFakt API key is configured, here or at install time.";
    }
    case "paused": {
      return "Invoicing is paused. No order will be invoiced until it is resumed.";
    }
    default: {
      return "Invoicing is currently off.";
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
