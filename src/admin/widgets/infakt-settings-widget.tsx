import { defineWidgetConfig } from "@medusajs/admin-sdk";
import { Alert, Badge, Container, Heading, StatusBadge, Text } from "@medusajs/ui";
import { useEffect, useState } from "react";
import { sdk } from "../lib/sdk";
import type { OverviewResponse } from "../lib/types";

/**
 * A read-only summary of how invoicing is configured, on the store settings page.
 *
 * It exists because the two things that quietly stop invoices from being issued -
 * an unset `apiKey` and a lapsed KSeF integration - are invisible everywhere else
 * in the dashboard. Both are reported here in the words an operator needs, next to
 * the rest of the store's configuration, rather than only on a page someone has to
 * think to open.
 *
 * No secret material is rendered: the route filters the configuration through
 * `toPublicInfaktOptions`, which does not carry the API key.
 */
const InfaktSettingsWidget = () => {
  const [data, setData] = useState<OverviewResponse | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    sdk.client
      .fetch<OverviewResponse>("/admin/infakt")
      .then((response) => {
        if (!cancelled) {
          setData(response);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : "Could not load the inFakt settings.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const config = data?.config;
  const runState = data?.run_state;
  const ksefUnhealthy = runState?.ksef_active === false && config?.ksefMode !== "never";

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
            <StatusBadge color={config.disabled ? "red" : (ksefUnhealthy ? "orange" : "green")}>
              {config.disabled ? "disabled" : (ksefUnhealthy ? "needs attention" : "active")}
            </StatusBadge>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="px-6 py-4">
          <Alert variant="error">{error}</Alert>
        </div>
      ) : null}

      {config?.disabled ? (
        <div className="px-6 py-4">
          <Alert variant="warning">
            No order will be invoiced: the plugin's <code>apiKey</code> option is not configured.
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
          </dl>
        </div>
      ) : null}
    </Container>
  );
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
