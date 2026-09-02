// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InfaktInvoiceRow, InfaktSettings } from "../../lib/types";

/**
 * The order-detail invoicing widget renders cleanly in every state it can be
 * handed - paused, unconfigured, not-yet-queued, needs-review and issued - and
 * never throws the way the old Select-based route did.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../lib/sdk", () => ({ sdk: { client: { fetch: fetchMock } } }));

const widgetModule = await import("../infakt-order-widget");
const InfaktOrderWidget = widgetModule.default;
const { describeKsef, isHistoricalImport } = widgetModule;

const settings = (over: Partial<InfaktSettings> = {}): InfaktSettings => ({
  api_key_configured: true,
  api_key_override_configured: false,
  effective: {
    currency: "PLN",
    environment: "production",
    ksef_mode: "nip-only",
    trigger_event: "payment.captured",
  },
  effective_enabled: false,
  env_force_disabled: false,
  invoicing_paused: true,
  reason: "paused",
  settings: { currency: null, environment: null, ksef_mode: null, trigger_event: null },
  ...over,
});

const active = settings({ effective_enabled: true, invoicing_paused: false, reason: "active" });

const wire = (invoices: Partial<InfaktInvoiceRow>[], settingsPayload: InfaktSettings) => {
  fetchMock.mockImplementation((url: string) => {
    if (String(url).startsWith("/admin/infakt/invoices")) {
      return Promise.resolve({ invoices, limit: 1, offset: 0 });
    }
    if (String(url) === "/admin/infakt/settings") {
      return Promise.resolve(settingsPayload);
    }
    return Promise.resolve({});
  });
};

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe("order invoicing widget", () => {
  it("renders the paused reason when the order has no row", async () => {
    wire([], settings());
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText(/Invoicing is paused/)).toBeTruthy();
  });

  it("offers to queue an un-queued order when invoicing is active", async () => {
    wire([], active);
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText(/No invoice has been queued/)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Queue for invoicing/ })).toBeTruthy();
  });

  it("shows the needs_review state with retry and skip and the reason", async () => {
    wire(
      [
        {
          attempts: 2,
          id: "inv_1",
          in_crash_window: false,
          is_company: true,
          last_error: "inFakt rejected the invoice",
          order_id: "order_1",
          status: "needs_review",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("Needs review")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.getByText(/inFakt rejected the invoice/)).toBeTruthy();
  });

  it("offers link/clear instead of retry inside the crash window", async () => {
    wire(
      [
        {
          attempts: 1,
          id: "inv_1",
          in_crash_window: true,
          is_company: true,
          order_id: "order_1",
          status: "needs_review",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByRole("button", { name: "Link invoice" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No invoice in inFakt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows an issued invoice with its number and no actions", async () => {
    wire(
      [
        {
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/1",
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("FV/2026/1")).toBeTruthy();
    expect(screen.getByText("Issued")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
  });

  it("says what a row that reads Awaiting is actually waiting for", async () => {
    // A defer renders as "Awaiting" with no error, which looked identical whether
    // the row was waiting for the buyer's address or for inFakt to finish a task.
    wire(
      [
        {
          attempts: 0,
          defer_reason: "buyer address is incomplete (missing: street, city, postal_code)",
          id: "inv_1",
          in_crash_window: false,
          is_company: false,
          next_attempt_at: "2026-09-02T12:38:24.000Z",
          order_id: "order_1",
          status: "processing",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("Waiting for")).toBeTruthy();
    expect(screen.getByText(/buyer address is incomplete/)).toBeTruthy();
    expect(screen.getByText(/next check/)).toBeTruthy();
  });

  it("says nothing about waiting on a row that is not", async () => {
    wire(
      [
        {
          attempts: 0,
          id: "inv_1",
          in_crash_window: false,
          is_company: false,
          order_id: "order_1",
          status: "processing",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("Awaiting")).toBeTruthy();
    expect(screen.queryByText("Waiting for")).toBeNull();
  });

  it("says so when inFakt never confirmed the payment", async () => {
    // The invoice is correct and issued; only the bookkeeping is outstanding, and
    // only a person can settle it in inFakt. Two words and a time, no prose.
    wire(
      [
        {
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/1",
          is_company: false,
          order_id: "order_1",
          paid_marked_at: "2026-09-02T12:40:03.000Z",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("Paid in inFakt")).toBeTruthy();
    expect(screen.getByText(/not confirmed/)).toBeTruthy();
  });

  it("shows nothing about payment on a row that was never marked", async () => {
    wire(
      [
        {
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/1",
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("FV/2026/1")).toBeTruthy();
    expect(screen.queryByText("Paid in inFakt")).toBeNull();
  });

  it("marks an adopted invoice and shows no actions for it", async () => {
    wire(
      [
        {
          adopted_at: new Date().toISOString(),
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: null,
          invoice_uuid: null,
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText(/\(adopted\/imported\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Link invoice" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    // A backfilled/adopted row never ran the pipeline's KSeF decision step, so
    // `ksef_required` is null here - the same shape as the 24 historical
    // invoices imported straight into the ledger. It must not claim a filing
    // is queued for a consumer invoice that will never be filed.
    expect(screen.queryByText("KSeF")).toBeNull();
    expect(screen.queryByText("pending")).toBeNull();
  });

  it("hides the backfill audit note for the 24 historical rows' exact shape, wherever it was written", async () => {
    const backfillNote =
      "backfilled by migration script (invoice_source=infakt); historical document, not issued by this plugin";
    wire(
      [
        {
          adopted_at: new Date().toISOString(),
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2024/1",
          invoice_uuid: null,
          is_company: false,
          last_error: backfillNote,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("FV/2024/1")).toBeTruthy();
    expect(screen.queryByText(new RegExp(backfillNote, "u"))).toBeNull();
    expect(screen.queryByText(/backfilled by migration script/u)).toBeNull();
  });

  it("still shows a live error or skip reason for a row that is not the historical-import shape", async () => {
    wire(
      [
        {
          attempts: 1,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          is_company: false,
          order_id: "order_1",
          skip_reason: "skipped by an operator: test order",
          status: "skipped",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText(/skipped by an operator: test order/)).toBeTruthy();
  });

  it("offers a View PDF button for a normally issued invoice", async () => {
    wire(
      [
        {
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/1",
          invoice_uuid: "uuid-1",
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByRole("button", { name: "View PDF" })).toBeTruthy();
  });

  it("offers a View PDF button for an adopted/historical row that only carries an invoice number", async () => {
    wire(
      [
        {
          adopted_at: new Date().toISOString(),
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2019/40",
          invoice_uuid: null,
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByRole("button", { name: "View PDF" })).toBeTruthy();
  });

  it("never renders a View PDF button when a row has no usable inFakt identifier", async () => {
    wire(
      [
        {
          adopted_at: new Date().toISOString(),
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: null,
          invoice_uuid: null,
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    await screen.findByText(/\(adopted\/imported\)/);
    expect(screen.queryByRole("button", { name: "View PDF" })).toBeNull();
  });

  it("fetches and opens the PDF through the plugin's own route, never a raw inFakt URL", async () => {
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    const rawFetchMock = vi.fn().mockResolvedValue({ blob: () => Promise.resolve(blob), ok: true });
    vi.stubGlobal("fetch", rawFetchMock);
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn().mockReturnValue("blob:mock") });
    const openMock = vi.fn();
    vi.stubGlobal("open", openMock);

    wire(
      [
        {
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/1",
          invoice_uuid: "uuid-1",
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    const button = await screen.findByRole("button", { name: "View PDF" });
    button.click();

    await vi.waitFor(() => expect(openMock).toHaveBeenCalledWith("blob:mock", "_blank", "noopener,noreferrer"));
    expect(rawFetchMock).toHaveBeenCalledWith("/admin/infakt/invoices/inv_1/pdf", {
      credentials: "include",
    });

    vi.unstubAllGlobals();
  });

  it("surfaces a failed PDF fetch inline, never as a dead navigation - a thrown MedusaError's `message`", async () => {
    // A thrown `MedusaError` (the route's not-found cases) is serialized by
    // Medusa's own error-handler middleware as `{ message, type, code }` - see
    // node_modules/@medusajs/framework's `errorHandler`.
    const rawFetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          message: "inFakt has no invoice numbered FV/2019/40.",
          type: "not_found",
        }),
      ok: false,
      status: 404,
    });
    vi.stubGlobal("fetch", rawFetchMock);

    wire(
      [
        {
          adopted_at: new Date().toISOString(),
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2019/40",
          invoice_uuid: null,
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    const button = await screen.findByRole("button", { name: "View PDF" });
    button.click();

    expect(await screen.findByText(/inFakt has no invoice numbered FV\/2019\/40/)).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("also reads the route's hand-written `error` field, for the disabled-plugin 409", async () => {
    const rawFetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({ error: "the plugin is disabled (no `apiKey` configured)", id: "inv_1" }),
      ok: false,
      status: 409,
    });
    vi.stubGlobal("fetch", rawFetchMock);

    wire(
      [
        {
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/1",
          invoice_uuid: "uuid-1",
          is_company: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    const button = await screen.findByRole("button", { name: "View PDF" });
    button.click();

    expect(await screen.findByText(/plugin is disabled/)).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("shows a consumer invoice no KSeF field at all, never a pending one", async () => {
    wire(
      [
        {
          attempts: 0,
          completed_at: new Date().toISOString(),
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/2",
          is_company: false,
          ksef_required: false,
          order_id: "order_1",
          status: "done",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("consumer")).toBeTruthy();
    expect(screen.queryByText("KSeF")).toBeNull();
    expect(screen.queryByText("pending")).toBeNull();
    expect(screen.queryByText("pending")).toBeNull();
  });

  it("shows a B2B invoice still awaiting KSeF filing as pending", async () => {
    wire(
      [
        {
          attempts: 0,
          id: "inv_1",
          in_crash_window: false,
          invoice_number: "FV/2026/3",
          invoice_uuid: "inv-uuid-1",
          is_company: true,
          ksef_required: true,
          order_id: "order_1",
          status: "processing",
        },
      ],
      active,
    );
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText("company (B2B)")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
  });

  it("surfaces a load failure as an inline dismissible message, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText(/network down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});

describe("describeKsef", () => {
  const baseRow = {
    attempts: 0,
    id: "inv_1",
    in_crash_window: false,
    is_company: false,
    order_id: "order_1",
  } as InfaktInvoiceRow;

  it("reads a known ksef_number or ksef_status first, regardless of anything else", () => {
    expect(describeKsef({ ...baseRow, ksef_number: "KSEF-1", status: "done" })).toBe("KSEF-1");
    expect(describeKsef({ ...baseRow, ksef_status: "sent", status: "processing" })).toBe("sent");
  });

  it("says nothing for a decided consumer invoice: KSeF will never touch it", () => {
    expect(describeKsef({ ...baseRow, ksef_required: false, status: "done" })).toBe(
      null,
    );
  });

  it("is 'pending' for a decided B2B invoice still awaiting filing", () => {
    expect(
      describeKsef({ ...baseRow, is_company: true, ksef_required: true, status: "processing" }),
    ).toBe("pending");
  });

  it("does not promise a filing for an adopted B2B document this plugin will never submit", () => {
    // The reconciliation records `ksef_required` on an adopted row as an audit
    // fact. The row is terminal, so nothing will act on it - and claiming a
    // pending filing would be a promise nobody is going to keep.
    expect(
      describeKsef({
        ...baseRow,
        adopted_at: new Date().toISOString(),
        is_company: true,
        ksef_required: true,
        status: "done",
      }),
    ).toBe("not tracked by this plugin");
  });

  it("still reports a pending filing for an adopted row the worker is still driving", () => {
    expect(
      describeKsef({
        ...baseRow,
        adopted_at: new Date().toISOString(),
        is_company: true,
        ksef_required: true,
        status: "processing",
      }),
    ).toBe("pending");
  });

  it("is 'not applicable' for a skipped order - no invoice was ever issued", () => {
    expect(describeKsef({ ...baseRow, status: "skipped" })).toBe("not applicable");
    expect(describeKsef({ ...baseRow, is_company: true, status: "skipped" })).toBe(
      "not applicable",
    );
  });

  it("says nothing for a terminal consumer row with no recorded decision (adopted/backfilled)", () => {
    expect(describeKsef({ ...baseRow, is_company: false, status: "done" })).toBeNull();
  });

  it("does not guess for a terminal company row with no recorded decision", () => {
    expect(describeKsef({ ...baseRow, is_company: true, status: "done" })).toBe(
      "not tracked by this plugin",
    );
  });

  it("is still 'pending' for a row that has not reached the decision step yet", () => {
    expect(describeKsef({ ...baseRow, status: "pending" })).toBe("pending");
    expect(describeKsef({ ...baseRow, status: "needs_review" })).toBe("pending");
  });
});

describe("isHistoricalImport", () => {
  const baseRow = {
    attempts: 0,
    id: "inv_1",
    in_crash_window: false,
    is_company: false,
    order_id: "order_1",
    status: "done",
  } as InfaktInvoiceRow;

  it("is true for the exact shape the 24 backfilled rows carry: adopted, no uuid", () => {
    expect(isHistoricalImport({ ...baseRow, adopted_at: "2024-01-01", invoice_uuid: null })).toBe(
      true,
    );
  });

  it("is false once a real adopt has linked a uuid, even though adopted_at is also set", () => {
    expect(
      isHistoricalImport({ ...baseRow, adopted_at: "2024-01-01", invoice_uuid: "uuid-1" }),
    ).toBe(false);
  });

  it("is false for an ordinary row that was never adopted", () => {
    expect(isHistoricalImport({ ...baseRow, adopted_at: null, invoice_uuid: null })).toBe(false);
  });
});
