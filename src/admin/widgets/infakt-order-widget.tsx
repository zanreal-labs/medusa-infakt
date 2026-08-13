import { defineWidgetConfig } from "@medusajs/admin-sdk";
import {
  Alert,
  Button,
  Container,
  Heading,
  Input,
  Prompt,
  StatusBadge,
  Text,
  Textarea,
} from "@medusajs/ui";
import { useCallback, useEffect, useState } from "react";
import { sdk } from "../lib/sdk";
import type {
  InfaktInvoiceRow,
  InfaktSettings,
  InvoiceListResponse,
  InvoiceStatus,
} from "../lib/types";

/**
 * Per-order invoicing status, on the order detail page.
 *
 * This is the home for everything about ONE order's invoice, following the
 * principle that per-order data belongs on the order rather than in a separate
 * table an operator has to hunt through. It shows the invoice number, the KSeF
 * filing, the issued date and the current state with its reason - and, when the
 * order needs a human decision, it carries the exact same operator actions
 * (retry / link an existing invoice / clear / skip) that resolve it.
 *
 * Every state it can be in renders cleanly:
 *  - loading: a quiet line, never a spinner that hides a crash.
 *  - invoicing off (paused / no apiKey / env force-off): the reason, in words.
 *  - no row for this order: "not queued", with a one-click enqueue for the
 *    recovery case (an order that predates the plugin, or a missed trigger event).
 *  - a live row: its state, fields and actions.
 *  - an API refusal (a 409 from an action): a dismissible inline message, never a
 *    thrown, crashed panel.
 *
 * The initial load reads only routes that answer 200 in every state and never
 * touch the inFakt client, so an unconfigured or paused plugin renders this
 * widget as calmly as a fully active one. The one exception is "View PDF" -
 * shown only once a row carries a usable identifier, and fetched on demand
 * through the plugin's own PDF route rather than a link straight to inFakt, so
 * a resolution failure surfaces inline instead of a dead navigation.
 */

const STATUS_COLOR: Record<InvoiceStatus, "green" | "orange" | "red" | "grey" | "blue"> = {
  done: "green",
  needs_review: "red",
  pending: "grey",
  processing: "blue",
  skipped: "orange",
};

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  done: "Issued",
  needs_review: "Needs review",
  pending: "Awaiting",
  processing: "Awaiting",
  skipped: "Skipped",
};

interface WidgetOrder {
  id: string;
  display_id?: number;
}

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

/**
 * What to show for the KSeF field, honestly.
 *
 * `ksef_required` is decided once, in the pipeline's submit-create step (see
 * `decideKsef` in `src/lib/invoicing/ksef.ts`), and stays null only for rows that
 * never ran that step: one adopted through the crash-window recovery flow, or one
 * backfilled straight into the ledger as an already-issued, already-adopted
 * record. Falling back to "pending" for those was the bug - it told an operator a
 * filing was queued for an invoice that will never be submitted, which is exactly
 * what a consumer invoice (no NIP) is.
 *
 * With no live decision to read, this reasons from what IS known:
 *  - `skipped` means no invoice was ever issued for the order, so there is
 *    nothing to file, full stop - "not applicable" regardless of buyer type.
 *  - `done` with a consumer buyer (`is_company` false) will never need KSeF
 *    under the NIP-based rule the plugin itself applies, so it renders exactly
 *    like a live "not required" decision.
 *  - `done` with a company buyer is genuinely ambiguous - the row may already be
 *    filed outside this plugin, or may still need it - so it says so rather than
 *    guessing either way.
 *  - anything still in flight (`pending`, `processing`, `needs_review`) has not
 *    reached the decision step yet, so "pending" is still the honest answer.
 */
export const describeKsef = (row: InfaktInvoiceRow): string => {
  if (row.ksef_number) {
    return row.ksef_number;
  }
  if (row.ksef_status) {
    return row.ksef_status;
  }
  if (row.ksef_required === false) {
    return "not required";
  }
  if (row.ksef_required === true) {
    return "pending";
  }
  if (row.status === "skipped") {
    return "not applicable";
  }
  if (row.status === "done") {
    return row.is_company ? "not tracked by this plugin" : "not required";
  }
  return "pending";
};

const InfaktOrderWidget = ({ data }: { data: WidgetOrder }) => {
  const orderId = data?.id;
  const [row, setRow] = useState<InfaktInvoiceRow | undefined>();
  const [settings, setSettings] = useState<InfaktSettings | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Two GETs, neither of which ever throws on a disabled, paused or empty plugin.
  // A row simply may not exist yet, which is a state to render, not an error.
  const load = useCallback(async () => {
    if (!orderId) {
      return;
    }
    try {
      const [listResponse, settingsResponse] = await Promise.all([
        sdk.client.fetch<InvoiceListResponse>("/admin/infakt/invoices", {
          query: { limit: 1, order_id: orderId },
        }),
        sdk.client.fetch<InfaktSettings>("/admin/infakt/settings"),
      ]);
      setRow(listResponse.invoices[0]);
      setSettings(settingsResponse);
      setLoadError(undefined);
    } catch (error) {
      setLoadError(errorMessage(error, "Could not load the invoicing status for this order."));
    } finally {
      setLoaded(true);
    }
  }, [orderId]);

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
      // A 409 carries the refusal reason - the whole value of the action. Shown
      // inline and dismissible, never a crashed panel.
      setLoadError(errorMessage(error, "The action was refused."));
    } finally {
      setBusy(false);
    }
  };

  const enqueue = async () => {
    if (!orderId) {
      return;
    }
    setBusy(true);
    setNotice(undefined);
    setLoadError(undefined);
    try {
      const result = await sdk.client.fetch<{ note?: string }>("/admin/infakt/enqueue", {
        body: { order_id: orderId },
        method: "POST",
      });
      setNotice(result?.note ?? "Queued.");
      await load();
    } catch (error) {
      setLoadError(errorMessage(error, "Could not queue this order for invoicing."));
    } finally {
      setBusy(false);
    }
  };

  const badge = row ? (
    <StatusBadge color={STATUS_COLOR[row.status] ?? "grey"}>
      {STATUS_LABEL[row.status] ?? row.status}
    </StatusBadge>
  ) : null;

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Invoicing</Heading>
        {badge}
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-x-4 px-6 py-4">
          <Alert className="flex-1" variant="error">
            {loadError}
          </Alert>
          <Button onClick={() => setLoadError(undefined)} size="small" variant="transparent">
            Dismiss
          </Button>
        </div>
      ) : null}

      {notice ? (
        <div className="px-6 py-4">
          <Alert variant="success">{notice}</Alert>
        </div>
      ) : null}

      <div className="px-6 py-4">
        <Body
          busy={busy}
          loaded={loaded}
          onAct={act}
          onEnqueue={() => void enqueue()}
          row={row}
          settings={settings}
        />
      </div>
    </Container>
  );
};

const Body = ({
  loaded,
  row,
  settings,
  busy,
  onAct,
  onEnqueue,
}: {
  loaded: boolean;
  row: InfaktInvoiceRow | undefined;
  settings: InfaktSettings | undefined;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
  onEnqueue: () => void;
}) => {
  if (!loaded) {
    return (
      <Text className="text-ui-fg-muted" size="small">
        Loading invoicing status...
      </Text>
    );
  }

  if (row) {
    return <RowDetail busy={busy} onAct={onAct} row={row} />;
  }

  // No ledger row for this order yet. Why depends on whether invoicing is on.
  const reason = settings?.reason;
  if (reason && reason !== "active") {
    return (
      <Text className="text-ui-fg-subtle" size="small">
        {describeInactive(reason)} This order has not been queued for invoicing.
      </Text>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <Text className="text-ui-fg-subtle" size="small">
        No invoice has been queued for this order. This is expected for an order placed before the
        plugin was installed, or if its trigger event was missed.
      </Text>
      <Button disabled={busy} onClick={onEnqueue} size="small" variant="secondary">
        Queue for invoicing
      </Button>
    </div>
  );
};

const describeInactive = (reason: InfaktSettings["reason"]): string => {
  switch (reason) {
    case "env_force_disabled": {
      return "Invoicing is forced off by the INFAKT_INVOICING_DISABLED environment variable.";
    }
    case "no_api_key": {
      return "Invoicing is disabled: the plugin's apiKey option is not configured.";
    }
    case "paused": {
      return "Invoicing is paused.";
    }
    default: {
      return "Invoicing is currently off.";
    }
  }
};

/**
 * The exact signature a row backfilled straight into the ledger carries, never
 * produced by the normal `adopt` flow: `planAdopt` always writes `invoice_uuid`
 * in the same patch as `adopted_at` (see `src/lib/invoicing/operator-actions.ts`),
 * so the two coming apart means a row that reached the ledger some other way -
 * the 24 historical invoices imported from intra, in production.
 *
 * That import wrote an audit note straight into whichever text column the
 * script reached for, worded for a database read, not an operator glancing at
 * an order: "backfilled from intra (invoice_source=infakt); historical
 * document, not issued by this plugin". This flag is what the display-only fix
 * hangs off - it does not care WHICH column carries that text, only that a row
 * with this exact shape should not surface its free-text detail line at all.
 * Whatever wrote it stays in the database as the audit trail; only the admin
 * widget stops rendering it.
 */
export const isHistoricalImport = (row: InfaktInvoiceRow): boolean =>
  Boolean(row.adopted_at) && !row.invoice_uuid;

const RowDetail = ({
  row,
  busy,
  onAct,
}: {
  row: InfaktInvoiceRow;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
}) => {
  const ksef = describeKsef(row);
  const detail = row.in_crash_window
    ? "A previous create may have reached inFakt. Look for a stray invoice there, then link it or clear this row."
    : isHistoricalImport(row)
      ? null
      : (row.last_error ?? row.skip_reason ?? row.ksef_decision_reason ?? null);

  return (
    <div className="flex flex-col gap-y-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
        <Field label="Invoice number">
          {row.invoice_number ?? (row.invoice_uuid ? "issued (number pending)" : "-")}
        </Field>
        <Field label="KSeF">{ksef}</Field>
        <Field label="Buyer">{row.is_company ? "company (B2B)" : "consumer"}</Field>
        <Field label={row.status === "skipped" ? "Skipped on" : "Issued on"}>
          {formatDate(row.completed_at)}
          {row.adopted_at ? " (adopted/imported)" : ""}
        </Field>
      </dl>

      <PdfLink row={row} />

      {detail ? (
        <Text className="text-ui-fg-subtle" size="small">
          {detail}
          {row.attempts > 0 ? ` (attempt ${row.attempts})` : ""}
        </Text>
      ) : null}

      <RowActions busy={busy} onAct={onAct} row={row} />
    </div>
  );
};

/**
 * A button to view the invoice PDF, shown if and only if this row can produce
 * a real document reference - never a link that only fails once clicked.
 *
 * `invoice_uuid` set: the direct case, every invoice this pipeline issued or an
 * operator adopted through the crash-window flow.
 *
 * `invoice_uuid` null but `invoice_number` set: the shape of a historical row
 * backfilled straight into the ledger. The server resolves the PDF by number
 * through inFakt's invoice search - see `GET /admin/infakt/invoices/:id/pdf` -
 * so the button still appears, and a failed resolution surfaces as the inline
 * error below it, never a dead navigation.
 *
 * Neither set: nothing renders. There is no identifier to try.
 */
const PdfLink = ({ row }: { row: InfaktInvoiceRow }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  if (!(row.invoice_uuid || row.invoice_number)) {
    return null;
  }

  const open = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(`/admin/infakt/invoices/${row.id}/pdf`, { credentials: "include" });
      if (!res.ok) {
        // A thrown `MedusaError` (the not-found cases) is serialized by the
        // framework's own error handler as `{ message, type, code }`; the
        // disabled-plugin refusal below writes `{ error, id }` by hand, matching
        // the rest of this plugin's 409 responses. Read whichever is present.
        const body = (await res.json().catch(() => undefined)) as
          | { message?: string; error?: string }
          | undefined;
        throw new Error(
          body?.message ?? body?.error ?? `The PDF could not be fetched (HTTP ${res.status}).`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(errorMessage(err, "Could not open the invoice PDF."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-y-1">
      <div>
        <Button disabled={busy} onClick={() => void open()} size="small" variant="secondary">
          View PDF
        </Button>
      </div>
      {error ? (
        <Text className="text-ui-fg-error" size="small">
          {error}
        </Text>
      ) : null}
    </div>
  );
};

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
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* No Retry at all in the crash window: the next step there is the one call
          that can issue a second real invoice. The server refuses it too. */}
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
            Find the invoice for this order in inFakt and paste its UUID. The row takes it over and
            continues from there - no new invoice is created.
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
          this order. If one exists, this will issue a second one, and undoing that needs a formal
          corrective invoice.
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

export const config = defineWidgetConfig({
  zone: "order.details.after",
});

export default InfaktOrderWidget;
