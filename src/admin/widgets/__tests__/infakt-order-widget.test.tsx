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

const InfaktOrderWidget = (await import("../infakt-order-widget")).default;

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
  });

  it("surfaces a load failure as an inline dismissible message, not a crash", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    render(<InfaktOrderWidget data={{ id: "order_1" }} />);
    expect(await screen.findByText(/network down/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});
