import { Alert, Badge, Button, Heading, Input, Label, StatusBadge, Table, Text, toast } from "@medusajs/ui";
import { useState } from "react";
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

const DECISION_LABEL = {
  adopt: "Match",
  ambiguous: "Needs a human",
  no_match: "No invoice found",
} as const;

const formatAmount = (minor: number | null): string =>
  minor === null ? "-" : (minor / 100).toFixed(2);

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export const ReconcilePanel = () => {
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
        `${result.summary.adopt} of ${result.summary.scanned} order(s) matched an invoice in inFakt.`,
      );
    } catch (error) {
      toast.error(errorMessage(error, "Could not read the reconciliation report."));
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
        adopted === 1 ? "1 invoice adopted." : `${adopted} invoices adopted.`,
      );
      if (result.refused?.length) {
        toast.error(
          `${result.refused.length} order(s) were not adopted - the match no longer held when the server re-checked it.`,
        );
      }
    } catch (error) {
      toast.error(errorMessage(error, "Could not adopt the selected invoices."));
    } finally {
      setBusy(false);
    }
  };

  const matched = (report?.entries ?? []).filter((entry) => entry.decision === "adopt");

  return (
    <div className="px-6 py-4">
      <div className="mb-3">
        <Heading level="h2">Adopt existing invoices</Heading>
        <Text className="text-ui-fg-subtle" size="small">
          Finds invoices that already exist in inFakt for orders this plugin has no record of, and
          matches them on the order data alone - the issue date, the buyer and the gross total. It
          never creates an invoice and never files anything to KSeF. Orders that already have an
          invoice record are left alone.
        </Text>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <Label htmlFor="infakt-reconcile-from">Orders placed from</Label>
          <Input
            id="infakt-reconcile-from"
            onChange={(event) => setFrom(event.target.value)}
            placeholder="2026-07-01"
            value={from}
          />
        </div>
        <div>
          <Label htmlFor="infakt-reconcile-to">to</Label>
          <Input
            id="infakt-reconcile-to"
            onChange={(event) => setTo(event.target.value)}
            placeholder="2026-08-12"
            value={to}
          />
        </div>
        <div>
          <Label htmlFor="infakt-reconcile-tolerance">Issue date tolerance (days)</Label>
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
          {busy ? "Working..." : "Preview"}
        </Button>
        <Button
          disabled={busy || matched.length === 0}
          onClick={() => void adopt(matched.map((entry) => entry.orderId))}
        >
          {`Adopt all matched (${matched.length})`}
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
}) => (
  <div className="mt-4 flex flex-col gap-y-3">
    <Text className="text-ui-fg-subtle" size="small">
      {`Scanned ${report.summary.scanned} order(s) with no invoice record against ${report.summary.invoices_considered} invoice(s) in inFakt: ${report.summary.adopt} matched, ${report.summary.ambiguous} need a human, ${report.summary.no_match} found nothing.`}
    </Text>

    {report.truncated ? (
      <Alert variant="warning">
        The window held more orders or invoices than one pass reads. Narrow the dates and run it
        again, or some orders will not have been considered at all.
      </Alert>
    ) : null}

    {report.skipped?.length ? (
      <Alert variant="warning">
        {`${report.skipped.length} order(s) were skipped because an invoice record already existed for them.`}
      </Alert>
    ) : null}

    {report.entries.length === 0 ? (
      <Text className="text-ui-fg-subtle" size="small">
        Every order in this window already has an invoice record. There is nothing to adopt.
      </Text>
    ) : (
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Order</Table.HeaderCell>
            <Table.HeaderCell>Result</Table.HeaderCell>
            <Table.HeaderCell>Invoice</Table.HeaderCell>
            <Table.HeaderCell>Evidence</Table.HeaderCell>
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

const Row = ({
  entry,
  busy,
  onAdopt,
}: {
  entry: ReconcileEntry;
  busy: boolean;
  onAdopt: (orderIds: string[]) => Promise<void>;
}) => (
  <Table.Row>
    <Table.Cell>{entry.displayId ? `#${entry.displayId}` : entry.orderId}</Table.Cell>
    <Table.Cell>
      <div className="flex items-center gap-x-2">
        <StatusBadge color={DECISION_COLOR[entry.decision]}>
          {DECISION_LABEL[entry.decision]}
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
          Adopt
        </Button>
      ) : null}
    </Table.Cell>
  </Table.Row>
);
