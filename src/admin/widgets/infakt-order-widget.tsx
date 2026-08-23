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
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { sdk } from "../lib/sdk";
import { buildInvoiceTimeline } from "../lib/timeline";
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

const statusLabel = (t: TFunction, status: InvoiceStatus): string => {
  switch (status) {
    case "done": {
      return t("infakt.orderWidget.status.done", "Issued");
    }
    case "needs_review": {
      return t("infakt.orderWidget.status.needsReview", "Needs review");
    }
    case "pending": {
      return t("infakt.orderWidget.status.pending", "Awaiting");
    }
    case "processing": {
      return t("infakt.orderWidget.status.processing", "Awaiting");
    }
    case "skipped": {
      return t("infakt.orderWidget.status.skipped", "Skipped");
    }
    default: {
      return status;
    }
  }
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
// `describeKsef` is exercised directly by unit tests, outside any component
// render, so it cannot rely on `useTranslation()`. It takes the real `t` at
// its one call site inside `RowDetail` below; every other caller (the test
// suite) gets this identity-style default, which returns the given English
// text exactly as the function did before it had any i18n awareness.
const identityT: TFunction = ((_key: string, defaultValue?: string) =>
  defaultValue ?? _key) as TFunction;

export const describeKsef = (row: InfaktInvoiceRow, t: TFunction = identityT): string | null => {
  if (row.ksef_number) {
    return row.ksef_number;
  }
  if (row.ksef_status) {
    return row.ksef_status;
  }
  if (row.ksef_required === false) {
    // A consumer invoice is outside KSeF by law, permanently. There is no state
    // to report and nothing an operator can act on, so the row says nothing
    // rather than explaining an absence. The Buyer field already reads
    // "consumer", and the decision plus its reason stay on the record for audit.
    return null;
  }
  if (row.ksef_required === true) {
    // A terminal adopted row is the one case where "required" does not imply
    // "queued": the document was issued elsewhere, long before this ledger knew
    // about it, and nothing here will ever submit it. Saying "pending" would
    // promise a filing that is not coming.
    return row.adopted_at && row.status === "done"
      ? t("infakt.orderWidget.ksef.notTracked", "not tracked by this plugin")
      : t("infakt.orderWidget.ksef.pending", "pending");
  }
  if (row.status === "skipped") {
    return t("infakt.orderWidget.ksef.notApplicable", "not applicable");
  }
  if (row.status === "done") {
    return row.is_company
      ? t("infakt.orderWidget.ksef.notTracked", "not tracked by this plugin")
      : null;
  }
  return t("infakt.orderWidget.ksef.pending", "pending");
};

const InfaktOrderWidget = ({ data }: { data: WidgetOrder }) => {
  const { t } = useTranslation();
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
      setLoadError(
        errorMessage(
          error,
          t("infakt.orderWidget.loadError", "Could not load the invoicing status for this order."),
        ),
      );
    } finally {
      setLoaded(true);
    }
  }, [orderId, t]);

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
      setNotice(result?.note ?? t("infakt.orderWidget.actionDone", "Done."));
      await load();
    } catch (error) {
      // A 409 carries the refusal reason - the whole value of the action. Shown
      // inline and dismissible, never a crashed panel.
      setLoadError(errorMessage(error, t("infakt.orderWidget.actionRefused", "The action was refused.")));
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
      setNotice(result?.note ?? t("infakt.orderWidget.queued", "Queued."));
      await load();
    } catch (error) {
      setLoadError(
        errorMessage(error, t("infakt.orderWidget.enqueueError", "Could not queue this order for invoicing.")),
      );
    } finally {
      setBusy(false);
    }
  };

  const badge = row ? (
    <StatusBadge color={STATUS_COLOR[row.status] ?? "grey"}>
      {statusLabel(t, row.status)}
    </StatusBadge>
  ) : null;

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">{t("infakt.orderWidget.heading", "Invoicing")}</Heading>
        {badge}
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-x-4 px-6 py-4">
          <Alert className="flex-1" variant="error">
            {loadError}
          </Alert>
          <Button onClick={() => setLoadError(undefined)} size="small" variant="transparent">
            {t("infakt.orderWidget.dismiss", "Dismiss")}
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
  const { t } = useTranslation();

  if (!loaded) {
    return (
      <Text className="text-ui-fg-muted" size="small">
        {t("infakt.orderWidget.loading", "Loading invoicing status...")}
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
        {describeInactive(t, reason)}{" "}
        {t("infakt.orderWidget.notQueuedInactive", "This order has not been queued for invoicing.")}
      </Text>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <Text className="text-ui-fg-subtle" size="small">
        {t(
          "infakt.orderWidget.notQueuedActive",
          "No invoice has been queued for this order. This is expected for an order placed before the plugin was installed, or if its trigger event was missed.",
        )}
      </Text>
      <Button disabled={busy} onClick={onEnqueue} size="small" variant="secondary">
        {t("infakt.orderWidget.queueButton", "Queue for invoicing")}
      </Button>
    </div>
  );
};

const describeInactive = (t: TFunction, reason: InfaktSettings["reason"]): string => {
  switch (reason) {
    case "env_force_disabled": {
      return t(
        "infakt.orderWidget.inactive.envForceDisabled",
        "Invoicing is forced off by the INFAKT_INVOICING_DISABLED environment variable.",
      );
    }
    case "no_api_key": {
      return t(
        "infakt.orderWidget.inactive.noApiKey",
        "Invoicing is disabled: the plugin's apiKey option is not configured.",
      );
    }
    case "paused": {
      return t("infakt.orderWidget.inactive.paused", "Invoicing is paused.");
    }
    default: {
      return t("infakt.orderWidget.inactive.default", "Invoicing is currently off.");
    }
  }
};

/**
 * The exact signature a row backfilled straight into the ledger carries, never
 * produced by the normal `adopt` flow: `planAdopt` always writes `invoice_uuid`
 * in the same patch as `adopted_at` (see `src/lib/invoicing/operator-actions.ts`),
 * so the two coming apart means a row that reached the ledger some other way:
 * a historical invoice bulk-imported by a migration script rather than issued
 * by this plugin.
 *
 * Such a script typically writes an audit note straight into whichever text
 * column it reached for, worded for a database read rather than for an operator
 * glancing at an order. This flag is what the display-only fix hangs off - it
 * does not care WHICH column carries that text, only that a row with this exact
 * shape should not surface its free-text detail line at all.
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
  const { t } = useTranslation();
  const ksef = describeKsef(row, t);
  const detail = row.in_crash_window
    ? t(
        "infakt.orderWidget.crashWindowDetail",
        "A previous attempt may have reached inFakt. Look for a stray invoice there, then link it or clear this one.",
      )
    : isHistoricalImport(row)
      ? null
      : // Deliberately NOT ksef_decision_reason: for a consumer invoice that
        // sentence only ever restates that KSeF does not apply, which is noise
        // on every consumer order. It stays on the record for an audit.
        (row.last_error ?? row.skip_reason ?? null);

  return (
    <div className="flex flex-col gap-y-4">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 md:grid-cols-2">
        <Field label={t("infakt.orderWidget.fields.invoiceNumber", "Invoice number")}>
          {row.invoice_number ??
            (row.invoice_uuid
              ? t("infakt.orderWidget.issuedNumberPending", "issued (number pending)")
              : "-")}
        </Field>
        {ksef === null ? null : (
          <Field label={t("infakt.orderWidget.fields.ksef", "KSeF")}>{ksef}</Field>
        )}
        <Field label={t("infakt.orderWidget.fields.buyer", "Buyer")}>
          {row.is_company
            ? t("infakt.orderWidget.buyerCompany", "company (B2B)")
            : t("infakt.orderWidget.buyerConsumer", "consumer")}
        </Field>
        <Field
          label={
            row.status === "skipped"
              ? t("infakt.orderWidget.fields.skippedOn", "Skipped on")
              : t("infakt.orderWidget.fields.issuedOn", "Issued on")
          }
        >
          {formatDate(row.completed_at)}
          {row.adopted_at ? ` ${t("infakt.orderWidget.adoptedSuffix", "(adopted/imported)")}` : ""}
        </Field>
      </dl>

      <PdfLink row={row} />

      <HistorySection row={row} />

      {detail ? (
        <Text className="text-ui-fg-subtle" size="small">
          {detail}
          {row.attempts > 0
            ? ` (${t("infakt.orderWidget.attemptLabel", "attempt")} ${row.attempts})`
            : ""}
        </Text>
      ) : null}

      <RowActions busy={busy} onAct={onAct} row={row} />
    </div>
  );
};

/**
 * The order's invoicing milestones, in the order they happened - "Faktura ...
 * wystawiona", then, when it was filed, "Wysłano do KSeF".
 *
 * This is the plugin's answer to a hard constraint: the native Medusa 2.18 order
 * Activity timeline is a closed set (payments, fulfillments and a fixed list of
 * order-change types) that never renders a plugin's entries, so issuance and KSeF
 * filing are surfaced here, on the plugin's own widget, from the row already
 * loaded. `buildInvoiceTimeline` is pure and stably keyed (see `lib/timeline.ts`),
 * so this renders nothing at all until there is a genuinely issued invoice.
 */
const HistorySection = ({ row }: { row: InfaktInvoiceRow }) => {
  const { t } = useTranslation();
  const entries = buildInvoiceTimeline(row, (key, defaultValue, options) =>
    t(key, defaultValue, options),
  );
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-y-1">
      <Text className="text-ui-fg-muted txt-compact-small" weight="plus">
        {t("infakt.orderWidget.history.heading", "History")}
      </Text>
      <ul className="flex flex-col gap-y-1">
        {entries.map((entry) => (
          <li className="flex flex-wrap items-baseline justify-between gap-x-4" key={entry.key}>
            <Text className="txt-compact-small" size="small">
              {entry.title}
            </Text>
            <Text className="text-ui-fg-subtle txt-compact-small" size="small">
              {formatDate(entry.timestamp)}
            </Text>
          </li>
        ))}
      </ul>
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
  const { t } = useTranslation();
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
          body?.message ??
            body?.error ??
            t("infakt.orderWidget.pdfFetchError", "The PDF could not be fetched (HTTP {{status}}).").replace(
              "{{status}}",
              String(res.status),
            ),
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(errorMessage(err, t("infakt.orderWidget.pdfOpenError", "Could not open the invoice PDF.")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-y-1">
      <div>
        <Button disabled={busy} onClick={() => void open()} size="small" variant="secondary">
          {t("infakt.orderWidget.viewPdf", "View PDF")}
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
  const { t } = useTranslation();
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
          {t("infakt.orderWidget.retry", "Retry")}
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
  const { t } = useTranslation();
  const [uuid, setUuid] = useState("");
  return (
    <Prompt>
      <Prompt.Trigger asChild>
        <Button disabled={busy} size="small" variant="primary">
          {t("infakt.orderWidget.linkInvoiceButton", "Link invoice")}
        </Button>
      </Prompt.Trigger>
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>
            {t("infakt.orderWidget.linkInvoiceDialog.title", "Link an existing inFakt invoice")}
          </Prompt.Title>
          <Prompt.Description>
            {t(
              "infakt.orderWidget.linkInvoiceDialog.description",
              "Find the invoice for this order in inFakt and paste its UUID. This order will use that invoice instead - no new invoice is created.",
            )}
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
          <Prompt.Cancel>{t("infakt.common.cancel", "Cancel")}</Prompt.Cancel>
          <Prompt.Action
            onClick={() => void onAct(row.id, { action: "adopt", invoice_uuid: uuid })}
          >
            {t("infakt.orderWidget.linkInvoiceDialog.action", "Link")}
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
}) => {
  const { t } = useTranslation();
  return (
    <Prompt variant="danger">
      <Prompt.Trigger asChild>
        <Button disabled={busy} size="small" variant="danger">
          {t("infakt.orderWidget.clearButton", "No invoice in inFakt")}
        </Button>
      </Prompt.Trigger>
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>
            {t("infakt.orderWidget.clearDialog.title", "Allow the invoice to be created again?")}
          </Prompt.Title>
          <Prompt.Description>
            {t(
              "infakt.orderWidget.clearDialog.descriptionBeforeStrong",
              "Only confirm this if you have checked inFakt and there is",
            )}{" "}
            <strong>{t("infakt.orderWidget.clearDialog.descriptionStrong", "no")}</strong>{" "}
            {t(
              "infakt.orderWidget.clearDialog.descriptionAfterStrong",
              "invoice for this order. If one exists, this will issue a second one, and undoing that needs a formal corrective invoice.",
            )}
          </Prompt.Description>
        </Prompt.Header>
        <Prompt.Footer>
          <Prompt.Cancel>{t("infakt.common.cancel", "Cancel")}</Prompt.Cancel>
          <Prompt.Action
            onClick={() => void onAct(row.id, { action: "clear", confirm_no_duplicate: true })}
          >
            {t("infakt.orderWidget.clearDialog.action", "I checked - there is no invoice")}
          </Prompt.Action>
        </Prompt.Footer>
      </Prompt.Content>
    </Prompt>
  );
};

const SkipButton = ({
  row,
  busy,
  onAct,
}: {
  row: InfaktInvoiceRow;
  busy: boolean;
  onAct: (id: string, body: Record<string, unknown>) => Promise<void>;
}) => {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  return (
    <Prompt>
      <Prompt.Trigger asChild>
        <Button disabled={busy} size="small" variant="transparent">
          {t("infakt.orderWidget.skipButton", "Skip")}
        </Button>
      </Prompt.Trigger>
      <Prompt.Content>
        <Prompt.Header>
          <Prompt.Title>{t("infakt.orderWidget.skipDialog.title", "Do not invoice this order")}</Prompt.Title>
          <Prompt.Description>
            {t(
              "infakt.orderWidget.skipDialog.description",
              "A reason is required and is kept on the record - skipping is a decision not to issue a document you may be required to issue.",
            )}
          </Prompt.Description>
        </Prompt.Header>
        <div className="px-6 pb-4">
          <Textarea
            onChange={(event) => setReason(event.target.value)}
            placeholder={t(
              "infakt.orderWidget.skipDialog.reasonPlaceholder",
              "e.g. test order, invoiced manually outside Medusa, duplicate of order ...",
            )}
            value={reason}
          />
        </div>
        <Prompt.Footer>
          <Prompt.Cancel>{t("infakt.common.cancel", "Cancel")}</Prompt.Cancel>
          <Prompt.Action onClick={() => void onAct(row.id, { action: "skip", reason })}>
            {t("infakt.orderWidget.skipDialog.action", "Skip")}
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
