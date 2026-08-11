import { defineRouteConfig } from "@medusajs/admin-sdk";
import { DocumentText } from "@medusajs/icons";
import {
  Alert,
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Prompt,
  Select,
  StatusBadge,
  Table,
  Text,
  Textarea,
} from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { sdk } from "../../lib/sdk";
import type {
  InfaktInvoiceRow,
  InvoiceListResponse,
  InvoiceStatus,
  OverviewResponse,
} from "../../lib/types";

/**
 * The Invoicing page.
 *
 * Its reason for existing is the `needs_review` list. A durable pipeline that parks
 * an invoice for a human is only durable if a human can see it - otherwise a parked
 * B2B invoice is indistinguishable from a store with no B2B orders, right up until a
 * customer asks where theirs is or an audit does.
 *
 * The one rule the UI enforces on its own: a row in the create crash window shows no
 * Retry button at all. The server refuses it too, but an operator should not have to
 * learn that from an error message.
 */

const STATUS_COLOR: Record<InvoiceStatus, "green" | "orange" | "red" | "grey" | "blue"> = {
  done: "green",
  needs_review: "red",
  pending: "grey",
  processing: "blue",
  skipped: "orange",
};

const RUN_STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey"> = {
  error: "red",
  idle: "grey",
  ok: "green",
  running: "orange",
};

const STATUS_FILTERS: { value: string; label: string }[] = [
  { label: "Needs review", value: "needs_review" },
  { label: "All", value: "" },
  { label: "Pending", value: "pending" },
  { label: "Processing", value: "processing" },
  { label: "Done", value: "done" },
  { label: "Skipped", value: "skipped" },
];

const formatDate = (value?: string | null): string => {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleString();
};

const errorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === "object" && error !== null) {
    const record = error as { message?: string };
    if (record.message) {
      return record.message;
    }
  }
  return fallback;
};

const InfaktPage = () => {
  const [overview, setOverview] = useState<OverviewResponse | undefined>();
  const [rows, setRows] = useState<InfaktInvoiceRow[]>([]);
  const [status, setStatus] = useState<string>("needs_review");
  const [loadError, setLoadError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overviewResponse, listResponse] = await Promise.all([
        sdk.client.fetch<OverviewResponse>("/admin/infakt"),
        sdk.client.fetch<InvoiceListResponse>("/admin/infakt/invoices", {
          query: status ? { status } : {},
        }),
      ]);
      setOverview(overviewResponse);
      setRows(listResponse.invoices);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorMessage(error, "Failed to load invoicing state."));
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, body: Record<string, unknown>) => {
    setBusy(true);
    setNotice(undefined);
    setLoadError(undefined);
    try {
      const result = await sdk.client.fetch<{ note?: string }>(`/admin/infakt/invoices/${id}`, {
        body,
        method: "POST",
      });
      setNotice(result?.note ?? "Done.");
      await load();
    } catch (error) {
      // A 409 carries the refusal reason, which is the whole value of the action -
      // it says what to do instead.
      setLoadError(errorMessage(error, "The action was refused."));
    } finally {
      setBusy(false);
    }
  };

  const recheckKsef = async () => {
    setBusy(true);
    try {
      const result = await sdk.client.fetch<{ active: boolean; error?: string }>(
        "/admin/infakt/ksef-check",
        { method: "POST" },
      );
      setNotice(
        result.active
          ? "The KSeF integration is active."
          : `The KSeF integration is NOT active${result.error ? `: ${result.error}` : "."}`,
      );
      await load();
    } catch (error) {
      setLoadError(errorMessage(error, "Could not check the KSeF integration."));
    } finally {
      setBusy(false);
    }
  };

  const config = overview?.config;
  const runState = overview?.run_state;

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h1">Invoicing</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            inFakt invoices and KSeF filings for paid orders.
          </Text>
        </div>
        <div className="flex items-center gap-x-2">
          {config?.environment ? (
            <Badge color={config.environment === "sandbox" ? "orange" : "grey"} size="small">
              {config.environment}
            </Badge>
          ) : null}
          <Button disabled={busy} onClick={() => void load()} size="small" variant="secondary">
            Refresh
          </Button>
        </div>
      </div>

      {config?.disabled ? (
        <div className="px-6 py-4">
          <Alert variant="warning">
            Invoicing is <strong>disabled</strong>: the plugin's <code>startDate</code> option is
            missing or is not a <code>YYYY-MM-DD</code> date. No order will be invoiced until it is
            set. This is the safe default - without a floor, installing this plugin on an existing
            store would issue a real invoice for every historical order.
          </Alert>
        </div>
      ) : null}

      {runState?.ksef_active === false && config?.ksefMode !== "never" ? (
        <div className="px-6 py-4">
          <Alert variant="error">
            The inFakt account has <strong>no active KSeF integration</strong>
            {runState.ksef_error ? ` (last check: ${runState.ksef_error})` : ""}. Filing B2B
            invoices to KSeF is mandatory in Poland, so this is a legal exposure and not just a
            failed sync. Fix the integration in inFakt, then re-check below.
          </Alert>
        </div>
      ) : null}

      {loadError ? (
        <div className="px-6 py-4">
          <Alert variant="error">{loadError}</Alert>
        </div>
      ) : null}

      {notice ? (
        <div className="px-6 py-4">
          <Alert variant="success">{notice}</Alert>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <div className="mb-4 flex items-center justify-between">
          <Heading level="h2">Worker</Heading>
          {runState ? (
            <StatusBadge color={RUN_STATUS_COLOR[runState.status] ?? "grey"}>
              {runState.status}
            </StatusBadge>
          ) : null}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-3">
          <Field label="Last run">{formatDate(runState?.last_run_at)}</Field>
          <Field label="Rows last run">{runState?.processed ?? 0}</Field>
          <Field label="Last error">
            <span className="text-ui-fg-subtle">{runState?.last_error ?? "none"}</span>
          </Field>
          <Field label="KSeF integration">
            {runState?.ksef_active === true
              ? "active"
              : (runState?.ksef_active === false
                ? "NOT active"
                : "not checked")}
            {" ("}
            {formatDate(runState?.ksef_checked_at)}
            {")"}
          </Field>
          <Field label="KSeF mode">
            {config?.ksefMode ?? "-"}
            {config?.ksefCustomPredicate ? " (custom predicate)" : ""}
          </Field>
          <Field label="Invoicing from">{config?.startDate ?? "not set"}</Field>
        </dl>
        <div className="mt-4">
          <Button
            disabled={busy}
            onClick={() => void recheckKsef()}
            size="small"
            variant="secondary"
          >
            Re-check KSeF integration
          </Button>
        </div>
      </div>

      <div className="px-6 py-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-y-2">
          <Heading level="h2">Invoices</Heading>
          <div className="flex items-center gap-x-3">
            {overview ? (
              <Text className="text-ui-fg-subtle" size="small">
                {overview.counts.needs_review} need review
                {overview.crash_window_count > 0
                  ? `, ${overview.crash_window_count} of them cannot be retried`
                  : ""}
              </Text>
            ) : null}
            <Select onValueChange={setStatus} value={status}>
              <Select.Trigger className="w-48">
                <Select.Value placeholder="Filter by status" />
              </Select.Trigger>
              <Select.Content>
                {STATUS_FILTERS.map((option) => (
                  <Select.Item key={option.value || "all"} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select>
          </div>
        </div>

        {rows.length === 0 ? (
          <Text className="text-ui-fg-muted" size="small">
            Nothing here.
          </Text>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Order</Table.HeaderCell>
                  <Table.HeaderCell>Status</Table.HeaderCell>
                  <Table.HeaderCell>Invoice</Table.HeaderCell>
                  <Table.HeaderCell>KSeF</Table.HeaderCell>
                  <Table.HeaderCell>Detail</Table.HeaderCell>
                  <Table.HeaderCell>Actions</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row) => (
                  <InvoiceRow busy={busy} key={row.id} onAct={act} row={row} />
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </div>
    </Container>
  );
};

const InvoiceRow = ({
  row,
  busy,
  onAct,
}: {
  row: InfaktInvoiceRow;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
}) => (
  <Table.Row>
    <Table.Cell>
      <div className="flex flex-col">
        <span className="txt-compact-small">{row.order_id}</span>
        <span className="text-ui-fg-muted txt-compact-xsmall">
          {row.is_company ? "company" : "consumer"}
          {row.adopted_at ? " - adopted" : ""}
        </span>
      </div>
    </Table.Cell>
    <Table.Cell>
      <StatusBadge color={STATUS_COLOR[row.status] ?? "grey"}>{row.status}</StatusBadge>
    </Table.Cell>
    <Table.Cell>{row.invoice_number ?? (row.invoice_uuid ? "issued" : "-")}</Table.Cell>
    <Table.Cell>
      {row.ksef_required === false
        ? "not required"
        : (row.ksef_number ?? row.ksef_status ?? "pending")}
    </Table.Cell>
    <Table.Cell className="text-ui-fg-subtle max-w-md">
      <span className="txt-compact-xsmall">
        {row.in_crash_window ? (
          <strong>
            A previous create may have reached inFakt. Look for a stray invoice there, then adopt it
            or clear this row.{" "}
          </strong>
        ) : null}
        {row.last_error ?? row.skip_reason ?? row.ksef_decision_reason ?? "-"}
        {row.attempts > 0 ? ` (attempt ${row.attempts})` : ""}
      </span>
    </Table.Cell>
    <Table.Cell>
      <RowActions busy={busy} onAct={onAct} row={row} />
    </Table.Cell>
  </Table.Row>
);

const RowActions = ({
  row,
  busy,
  onAct,
}: {
  row: InfaktInvoiceRow;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
}) => {
  const terminal = row.status === "done" || row.status === "skipped";
  if (terminal) {
    return (
      <Text className="text-ui-fg-muted" size="xsmall">
        -
      </Text>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* No Retry at all in the crash window. The server refuses it too, but an
          operator should not have to learn that from an error message. */}
      {row.in_crash_window ? (
        <>
          <AdoptButton busy={busy} onAct={onAct} row={row} />
          <ClearButton busy={busy} onAct={onAct} row={row} />
        </>
      ) : (
        <Button
          disabled={busy}
          onClick={() => void onAct(row.id, { action: "retry" })}
          size="small"
          variant="secondary"
        >
          Retry
        </Button>
      )}
      <SkipButton busy={busy} onAct={onAct} row={row} />
    </div>
  );
};

const AdoptButton = ({
  row,
  busy,
  onAct,
}: {
  row: InfaktInvoiceRow;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
}) => {
  const [uuid, setUuid] = useState("");
  return (
    <Prompt>
      <Prompt.Trigger asChild>
        <Button disabled={busy} size="small" variant="primary">
          Link invoice
        </Button>
      </Prompt.Trigger>
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>Link an existing inFakt invoice</Prompt.Title>
          <Prompt.Description>
            Find the invoice for order <code>{row.order_id}</code> in inFakt and paste its UUID. The
            row takes it over and continues from there - no new invoice is created.
          </Prompt.Description>
        </Prompt.Header>
        <div className="px-6 pb-4">
          <Input
            onChange={(event) => setUuid(event.target.value)}
            placeholder="1ba43eaf-4b29-41e5-a629-48e345e4c675"
            value={uuid}
          />
        </div>
        <Prompt.Footer>
          <Prompt.Cancel>Cancel</Prompt.Cancel>
          <Prompt.Action
            onClick={() => void onAct(row.id, { action: "adopt", invoice_uuid: uuid })}
          >
            Link
          </Prompt.Action>
        </Prompt.Footer>
      </Prompt.Content>
    </Prompt>
  );
};

const ClearButton = ({
  row,
  busy,
  onAct,
}: {
  row: InfaktInvoiceRow;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
}) => (
  <Prompt variant="danger">
    <Prompt.Trigger asChild>
      <Button disabled={busy} size="small" variant="danger">
        No invoice in inFakt
      </Button>
    </Prompt.Trigger>
    <Prompt.Content>
      <Prompt.Header>
        <Prompt.Title>Allow the invoice to be created again?</Prompt.Title>
        <Prompt.Description>
          Only confirm this if you have checked inFakt and there is <strong>no</strong> invoice for
          order <code>{row.order_id}</code>. If one exists, this will issue a second one, and
          undoing that needs a formal corrective invoice.
        </Prompt.Description>
      </Prompt.Header>
      <Prompt.Footer>
        <Prompt.Cancel>Cancel</Prompt.Cancel>
        <Prompt.Action
          onClick={() => void onAct(row.id, { action: "clear", confirm_no_duplicate: true })}
        >
          I checked - there is no invoice
        </Prompt.Action>
      </Prompt.Footer>
    </Prompt.Content>
  </Prompt>
);

const SkipButton = ({
  row,
  busy,
  onAct,
}: {
  row: InfaktInvoiceRow;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
}) => {
  const [reason, setReason] = useState("");
  return (
    <Prompt>
      <Prompt.Trigger asChild>
        <Button disabled={busy} size="small" variant="transparent">
          Skip
        </Button>
      </Prompt.Trigger>
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>Do not invoice this order</Prompt.Title>
          <Prompt.Description>
            A reason is required and is kept on the record - skipping is a decision not to issue a
            document you may be required to issue.
          </Prompt.Description>
        </Prompt.Header>
        <div className="px-6 pb-4">
          <Textarea
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. test order, invoiced manually outside Medusa, duplicate of order ..."
            value={reason}
          />
        </div>
        <Prompt.Footer>
          <Prompt.Cancel>Cancel</Prompt.Cancel>
          <Prompt.Action onClick={() => void onAct(row.id, { action: "skip", reason })}>
            Skip
          </Prompt.Action>
        </Prompt.Footer>
      </Prompt.Content>
    </Prompt>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-ui-fg-muted txt-compact-small">{label}</dt>
    <dd className="txt-compact-small">{children}</dd>
  </div>
);

export const config = defineRouteConfig({
  icon: DocumentText,
  label: "Invoicing",
});

export default InfaktPage;
