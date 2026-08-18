import { Alert, Badge, Button, Heading, Input, Label, StatusBadge, Table, Text, toast } from "@medusajs/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { sdk } from "../lib/sdk";
import type { ReconcileEntry, ReconcileResponse } from "../lib/types";

/**
 * Adopt invoices that already exist in inFakt.
 *
 * For a store whose history was invoiced elsewhere: the documents are real, filed
 * and sitting in inFakt, and only this plugin's ledger does not know about them.
 * The server matches them to orders on order data alone (issue date, buyer
 * identity, gross total to the grosz) and reports what it found.
 *
 * Two rules shape this panel, and both come from the server rather than from here:
 *
 *  - **Preview writes nothing.** The report is the default; adopting is a second,
 *    separate request.
 *  - **Adopting names orders explicitly.** There is no "adopt everything" call;
 *    "Adopt all matched" simply sends every matched order id, and the server
 *    re-derives each match before writing. An ambiguous order can never be applied,
 *    whether or not it is named.
 *
 * Nothing here can issue an invoice or file one to KSeF. Adoption records a
 * document that already exists.
 */

const today = (): string => new Date().toISOString().slice(0, 10);
const monthAgo = (): string => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 10);
};

const DECISION_COLOR = {
  adopt: "green",
  ambiguous: "orange",
  no_match: "grey",
} as const;

const decisionLabel = (t: TFunction, decision: keyof typeof DECISION_COLOR): string => {
  switch (decision) {
    case "adopt": {
      return t("infakt.reconcile.decision.adopt", "Match");
    }
    case "ambiguous": {
      return t("infakt.reconcile.decision.ambiguous", "Needs review");
    }
    case "no_match": {
      return t("infakt.reconcile.decision.noMatch", "No invoice found");
    }
    default: {
      return decision;
    }
  }
};

const formatAmount = (minor: number | null): string =>
  minor === null ? "-" : (minor / 100).toFixed(2);

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

// i18next interpolation only fires once a translation resource is actually
// loaded; without one (the plugin's own component tests, which render with
// no i18next instance configured) `t(key, defaultValue)` returns
// `defaultValue` verbatim, `{{tokens}}` included. Substituting by hand here
// keeps both paths - translated and untranslated - correct the same way.
const interpolate = (template: string, values: Record<string, string | number>): string =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{{${key}}}`).join(String(value)),
    template,
  );

export const ReconcilePanel = () => {
  const { t } = useTranslation();
  const [from, setFrom] = useState(monthAgo());
  const [to, setTo] = useState(today());
  const [tolerance, setTolerance] = useState("7");
  const [report, setReport] = useState<ReconcileResponse | undefined>();
  const [busy, setBusy] = useState(false);

  const preview = async () => {
    setBusy(true);
    try {
      const result = await sdk.client.fetch<ReconcileResponse>("/admin/infakt/reconcile", {
        query: { from, to, tolerance_days: tolerance },
      });
      setReport(result);
      toast.success(
        interpolate(
          t(
            "infakt.reconcile.previewSummary",
            "{{adopt}} of {{scanned}} order(s) matched an invoice in inFakt.",
          ),
          { adopt: result.summary.adopt, scanned: result.summary.scanned },
        ),
      );
    } catch (error) {
      toast.error(
        errorMessage(error, t("infakt.reconcile.previewError", "Could not read the reconciliation report.")),
      );
    } finally {
      setBusy(false);
    }
  };

  const adopt = async (orderIds: string[]) => {
    if (orderIds.length === 0) {
      return;
    }
    setBusy(true);
    try {
      const result = await sdk.client.fetch<ReconcileResponse>("/admin/infakt/reconcile", {
        body: { apply: true, from, order_ids: orderIds, to, tolerance_days: Number(tolerance) },
        method: "POST",
      });
      setReport(result);
      const adopted = result.adopted?.length ?? 0;
      toast.success(
        adopted === 1
          ? t("infakt.reconcile.adoptedOne", "1 invoice adopted.")
          : interpolate(t("infakt.reconcile.adoptedMany", "{{count}} invoices adopted."), {
              count: adopted,
            }),
      );
      if (result.refused?.length) {
        toast.error(
          interpolate(
            t(
              "infakt.reconcile.refusedWarning",
              "{{count}} order(s) were not adopted - the match no longer held when the server re-checked it.",
            ),
            { count: result.refused.length },
          ),
        );
      }
    } catch (error) {
      toast.error(errorMessage(error, t("infakt.reconcile.adoptError", "Could not adopt the selected invoices.")));
    } finally {
      setBusy(false);
    }
  };

  const matched = (report?.entries ?? []).filter((entry) => entry.decision === "adopt");

  return (
    <div className="px-6 py-4">
      <div className="mb-3">
        <Heading level="h2">{t("infakt.reconcile.heading", "Adopt existing invoices")}</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          {t(
            "infakt.reconcile.description",
            "Finds invoices that already exist in inFakt for orders this plugin has no record of, and matches them on the order data alone - the issue date, the buyer and the gross total. It never creates an invoice and never files anything to KSeF. Orders that already have an invoice record are left alone.",
          )}
        </Text>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <Label htmlFor="infakt-reconcile-from">
            {t("infakt.reconcile.fromLabel", "Orders placed from")}
          </Label>
          <Input
            id="infakt-reconcile-from"
            onChange={(event) => setFrom(event.target.value)}
            placeholder="2026-07-01"
            value={from}
          />
        </div>
        <div>
          <Label htmlFor="infakt-reconcile-to">{t("infakt.reconcile.toLabel", "to")}</Label>
          <Input
            id="infakt-reconcile-to"
            onChange={(event) => setTo(event.target.value)}
            placeholder="2026-08-12"
            value={to}
          />
        </div>
        <div>
          <Label htmlFor="infakt-reconcile-tolerance">
            {t("infakt.reconcile.toleranceLabel", "Issue date tolerance (days)")}
          </Label>
          <Input
            id="infakt-reconcile-tolerance"
            onChange={(event) => setTolerance(event.target.value)}
            placeholder="7"
            value={tolerance}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button disabled={busy} onClick={() => void preview()} variant="secondary">
          {busy ? t("infakt.reconcile.working", "Working...") : t("infakt.reconcile.preview", "Preview")}
        </Button>
        <Button
          disabled={busy || matched.length === 0}
          onClick={() => void adopt(matched.map((entry) => entry.orderId))}
        >
          {interpolate(t("infakt.reconcile.adoptAllMatched", "Adopt all matched ({{count}})"), {
            count: matched.length,
          })}
        </Button>
      </div>

      {report ? <Report busy={busy} onAdopt={adopt} report={report} /> : null}
    </div>
  );
};

const Report = ({
  report,
  busy,
  onAdopt,
}: {
  report: ReconcileResponse;
  busy: boolean;
  onAdopt: (orderIds: string[]) => Promise<void>;
}) => {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex flex-col gap-y-3">
      <Text className="text-ui-fg-subtle" size="small">
        {interpolate(
          t(
            "infakt.reconcile.reportSummary",
            "Scanned {{scanned}} order(s) with no invoice record against {{considered}} invoice(s) in inFakt: {{adopt}} matched, {{ambiguous}} need review, {{noMatch}} found nothing.",
          ),
          {
            adopt: report.summary.adopt,
            ambiguous: report.summary.ambiguous,
            considered: report.summary.invoices_considered,
            noMatch: report.summary.no_match,
            scanned: report.summary.scanned,
          },
        )}
      </Text>

      {report.truncated ? (
        <Alert variant="warning">
          {t(
            "infakt.reconcile.truncatedWarning",
            "The window held more orders or invoices than one pass reads. Narrow the dates and run it again, or some orders will not have been considered at all.",
          )}
        </Alert>
      ) : null}

      {report.skipped?.length ? (
        <Alert variant="warning">
          {interpolate(
            t(
              "infakt.reconcile.skippedWarning",
              "{{count}} order(s) were skipped because an invoice record already existed for them.",
            ),
            { count: report.skipped.length },
          )}
        </Alert>
      ) : null}

      {report.entries.length === 0 ? (
        <Text className="text-ui-fg-subtle" size="small">
          {t(
            "infakt.reconcile.nothingToAdopt",
            "Every order in this window already has an invoice record. There is nothing to adopt.",
          )}
        </Text>
      ) : (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>{t("infakt.reconcile.columns.order", "Order")}</Table.HeaderCell>
              <Table.HeaderCell>{t("infakt.reconcile.columns.result", "Result")}</Table.HeaderCell>
              <Table.HeaderCell>{t("infakt.reconcile.columns.invoice", "Invoice")}</Table.HeaderCell>
              <Table.HeaderCell>
                {t("infakt.reconcile.columns.evidence", "Evidence")}
              </Table.HeaderCell>
              <Table.HeaderCell />
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {report.entries.map((entry) => (
              <Row busy={busy} entry={entry} key={entry.orderId} onAdopt={onAdopt} />
            ))}
          </Table.Body>
        </Table>
      )}
    </div>
  );
};

const Row = ({
  entry,
  busy,
  onAdopt,
}: {
  entry: ReconcileEntry;
  busy: boolean;
  onAdopt: (orderIds: string[]) => Promise<void>;
}) => {
  const { t } = useTranslation();
  return (
    <Table.Row>
      <Table.Cell>{entry.displayId ? `#${entry.displayId}` : entry.orderId}</Table.Cell>
      <Table.Cell>
        <div className="flex items-center gap-x-2">
          <StatusBadge color={DECISION_COLOR[entry.decision]}>
            {decisionLabel(t, entry.decision)}
          </StatusBadge>
          {entry.confidence ? (
            <Badge color={entry.confidence === "high" ? "green" : "orange"} size="2xsmall">
              {entry.confidence}
            </Badge>
          ) : null}
        </div>
      </Table.Cell>
      <Table.Cell>
        {entry.invoice ? (
          <span>
            {entry.invoice.number ?? entry.invoice.uuid}
            <span className="text-ui-fg-muted">{` ${entry.invoice.invoiceDate ?? ""} ${formatAmount(entry.invoice.grossPrice)}`}</span>
          </span>
        ) : (
          entry.candidates.map((candidate) => candidate.number ?? candidate.uuid).join(", ") || "-"
        )}
      </Table.Cell>
      <Table.Cell>
        <Text className="text-ui-fg-subtle" size="small">
          {entry.reasons.join(" ")}
        </Text>
      </Table.Cell>
      <Table.Cell>
        {entry.decision === "adopt" ? (
          <Button
            disabled={busy}
            onClick={() => void onAdopt([entry.orderId])}
            size="small"
            variant="secondary"
          >
            {t("infakt.reconcile.adoptOne", "Adopt")}
          </Button>
        ) : null}
      </Table.Cell>
    </Table.Row>
  );
};
