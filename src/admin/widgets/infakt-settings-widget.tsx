import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Button, Container, Heading, StatusBadge, Text } from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { sdk } from "../lib/sdk";
import type { InfaktSettings, OverviewResponse } from "../lib/types";

/**
 * A summary of how invoicing is configured, on the store settings page - and,
 * per the plugin's runtime pause switch, the one place besides the Invoicing
 * page where an operator can flip it.
 *
 * It exists because the things that quietly stop invoices from being issued - an
 * unset `apiKey`, the pause switch, the `INFAKT_INVOICING_DISABLED` environment
 * override, and a lapsed KSeF integration - are invisible everywhere else in the
 * dashboard. All four are reported here in the words an operator needs, next to
 * the rest of the store's configuration, rather than only on a page someone has
 * to think to open.
 *
 * Both requests answer 200 with a payload that says so in every state, including
 * fully disabled or unconfigured - neither one ever throws into this widget.
 *
 * No secret material is rendered: the overview route filters the configuration
 * through `toPublicInfaktOptions`, which does not carry the API key.
 */
const InfaktSettingsWidget = () => {
  const [data, setData] = useState<OverviewResponse | undefined>();
  const [settings, setSettings] = useState<InfaktSettings | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overviewResponse, settingsResponse] = await Promise.all([
        sdk.client.fetch<OverviewResponse>("/admin/infakt"),
        sdk.client.fetch<InfaktSettings>("/admin/infakt/settings"),
      ]);
      setData(overviewResponse);
      setSettings(settingsResponse);
      setError(undefined);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not load the inFakt settings.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const togglePause = async () => {
    if (!settings) {
      return;
    }
    setBusy(true);
    try {
      const result = await sdk.client.fetch<InfaktSettings>("/admin/infakt/settings", {
        body: { invoicing_paused: !settings.invoicing_paused },
        method: "POST",
      });
      setSettings(result);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error ? toggleError.message : "Could not change the pause switch.",
      );
    } finally {
      setBusy(false);
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
          <Heading level="h2">Invoicing (inFakt / KSeF)</Heading>
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

      {error ? (
        <div className="px-6 py-4">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      {settings && !active ? (
        <div className="px-6 py-4">
          <Alert variant="warning">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span>{describeReason(settings)}</span>
              {settings.reason === "paused" ? (
                <Button disabled={busy} onClick={() => void togglePause()} size="small">
                  Resume invoicing
                </Button>
              ) : null}
            </div>
          </Alert>
        </div>
      ) : null}

      {ksefUnhealthy ? (
        <div className="px-6 py-4">
          <Alert variant="error">
            The inFakt account has no active KSeF integration, so B2B invoices cannot be filed. Open
            Invoicing to re-check after fixing it in inFakt.
          </Alert>
        </div>
      ) : null}

      {config ? (
        <div className="px-6 py-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
            <Field label="Invoicing orders from">{config.startDate ?? "no date floor"}</Field>
            <Field label="Currency">{config.currency}</Field>
            <Field label="VAT rate symbol">{config.taxSymbol}</Field>
            <Field label="Triggered by">{config.triggerEvent}</Field>
            <Field label="KSeF">
              {config.ksefMode}
              {config.ksefCustomPredicate ? " (custom predicate)" : ""}
              {config.ksefRequireActive ? ", verified at startup" : ", not verified at startup"}
            </Field>
            <Field label="Emits infakt.invoice.issued">
              {config.emitIssuedEvent ? "yes" : "no"}
            </Field>
            <Field label="Needs review">{data?.counts.needs_review ?? 0}</Field>
            <Field label="Issued">{data?.counts.done ?? 0}</Field>
            {settings && !settings.env_force_disabled && settings.api_key_configured ? (
              <Field label="Pause switch">
                <Button
                  disabled={busy}
                  onClick={() => void togglePause()}
                  size="small"
                  variant="secondary"
                >
                  {settings.invoicing_paused ? "Resume invoicing" : "Pause invoicing"}
                </Button>
              </Field>
            ) : null}
          </dl>
        </div>
      ) : null}
    </Container>
  );
};

const describeReason = (settings: InfaktSettings): string => {
  switch (settings.reason) {
    case "env_force_disabled": {
      return "Invoicing is forced off by the INFAKT_INVOICING_DISABLED environment variable.";
    }
    case "no_api_key": {
      return "No order will be invoiced: the plugin's apiKey option is not configured.";
    }
    case "paused": {
      return "Invoicing is paused. No order will be invoiced until an operator resumes it.";
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

export const config = defineWidgetConfig({
  zone: "store.details.after",
});

export default InfaktSettingsWidget;
