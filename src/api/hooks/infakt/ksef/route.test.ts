import { createHmac } from "node:crypto";
import type { MedusaRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Shared with the admin route tests deliberately: there is one `MedusaResponse`
// double in this repo, and a second copy would drift from it.
import { mockResponse } from "../../../admin/infakt/__tests__/mock-response";
import { runInvoicingNow } from "../../../../lib/invoicing/run";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import { POST } from "./route";

vi.mock("../../../../lib/invoicing/run", () => ({ runInvoicingNow: vi.fn() }));

const SECRET = "webhook-secret-from-the-infakt-panel";

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

/** A row sitting exactly on the `poll-ksef` step, deferred two minutes out. */
const pollingRow = (overrides: Record<string, unknown> = {}) => ({
  attempts: 0,
  id: "inv_row_1",
  invoice_number: "FV/2026/09/1",
  invoice_uuid: "ee2484ce-052c-495a-9ce1-5bd3ae8314aa",
  ksef_required: true,
  ksef_sent_at: new Date("2026-09-03T10:00:00Z"),
  next_attempt_at: new Date("2999-01-01T00:00:00Z"),
  order_id: "order_01ABC",
  status: "processing",
  ...overrides,
});

const service = (rows: Record<string, unknown>[] = [], webhookSecret: string | null = SECRET) => ({
  listInfaktInvoices: vi.fn().mockResolvedValue(rows),
  resolvedOptions: { emitIssuedEvent: true, webhookSecret },
  updateInfaktInvoices: vi.fn().mockResolvedValue(undefined),
});

const request = (
  body: unknown,
  infakt: ReturnType<typeof service>,
  options: { signature?: string; rawBody?: Buffer | string | null } = {},
): MedusaRequest => {
  const raw =
    options.rawBody === undefined ? Buffer.from(JSON.stringify(body), "utf-8") : options.rawBody;
  const signature =
    options.signature ??
    (raw === null
      ? undefined
      : createHmac("sha256", SECRET)
          .update(typeof raw === "string" ? Buffer.from(raw, "utf-8") : raw)
          .digest("hex"));
  return {
    body,
    headers: signature ? { "x-infakt-signature": signature } : {},
    ...(raw === null ? {} : { rawBody: raw }),
    scope: {
      resolve: vi.fn((key: string) => (key === ContainerRegistrationKeys.LOGGER ? logger : infakt)),
    },
  } as unknown as MedusaRequest;
};

const ksefEvent = (name: string, invoiceUuid: string) => ({
  event: { created_at: "2026-09-03T12:00:00+02:00", name, retry_counter: 0, uuid: "evt_1" },
  resource: { invoice_uuid: invoiceUuid, ksef_number: null, status: "error" },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runInvoicingNow).mockResolvedValue(undefined);
});

describe("POST /hooks/infakt/ksef", () => {
  it("answers 401 and touches nothing when no `webhookSecret` is configured", async () => {
    const infakt = service([pollingRow()], null);
    const res = mockResponse();
    await POST(request(ksefEvent("send_to_ksef_success", "ee2484ce"), infakt), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ok: false });
    expect(infakt.listInfaktInvoices).not.toHaveBeenCalled();
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("answers 401 to a missing signature, and looks up nothing first", async () => {
    const infakt = service([pollingRow()]);
    const res = mockResponse();
    const body = ksefEvent("send_to_ksef_success", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa");
    await POST(request(body, infakt, { signature: "" }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(infakt.listInfaktInvoices).not.toHaveBeenCalled();
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("answers 401 to a signature computed under a different secret", async () => {
    const infakt = service([pollingRow()]);
    const res = mockResponse();
    const body = ksefEvent("send_to_ksef_success", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa");
    const forged = createHmac("sha256", "not-the-secret")
      .update(JSON.stringify(body))
      .digest("hex");
    await POST(request(body, infakt, { signature: forged }), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("answers 401 rather than approximating a raw body that was not preserved", async () => {
    const infakt = service([pollingRow()]);
    const res = mockResponse();
    const body = ksefEvent("send_to_ksef_success", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa");
    await POST(
      request(body, infakt, {
        rawBody: null,
        signature: createHmac("sha256", SECRET).update(JSON.stringify(body)).digest("hex"),
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("echoes the activation challenge, so inFakt can move the webhook to active", async () => {
    const infakt = service();
    const res = mockResponse();
    await POST(request({ verification_code: "3e18cd8c09a3b729958bf393b459b761" }, infakt), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      verification_code: "3e18cd8c09a3b729958bf393b459b761",
    });
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("makes the deferred row due and runs the same pipeline the cron runs", async () => {
    const infakt = service([pollingRow()]);
    const res = mockResponse();
    await POST(
      request(ksefEvent("send_to_ksef_success", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa"), infakt),
      res,
    );

    expect(infakt.listInfaktInvoices).toHaveBeenCalledWith({
      invoice_uuid: ["ee2484ce-052c-495a-9ce1-5bd3ae8314aa"],
    });
    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith({
      id: "inv_row_1",
      next_attempt_at: null,
    });
    expect(runInvoicingNow).toHaveBeenCalledWith(expect.anything(), {
      orderId: "order_01ABC",
      source: "medusa-infakt/ksef-webhook",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("writes no KSeF status or number from the payload - the poll re-reads both", async () => {
    const infakt = service([pollingRow()]);
    await POST(
      request(
        {
          event: { name: "send_to_ksef_success", uuid: "evt_2" },
          resource: {
            invoice_uuid: "ee2484ce-052c-495a-9ce1-5bd3ae8314aa",
            ksef_number: "FORGED-KSEF-NUMBER",
            status: "success",
          },
        },
        infakt,
      ),
      mockResponse(),
    );

    for (const [patch] of infakt.updateInfaktInvoices.mock.calls) {
      expect(patch).not.toHaveProperty("ksef_number");
      expect(patch).not.toHaveProperty("ksef_status");
    }
  });

  it("acts on an error event too, and lets the poll decide what it means", async () => {
    const infakt = service([pollingRow()]);
    await POST(
      request(ksefEvent("send_to_ksef_error", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa"), infakt),
      mockResponse(),
    );
    expect(runInvoicingNow).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a redelivery of an event already applied does nothing", async () => {
    const infakt = service([pollingRow({ ksef_number: "7343521162-20231004-47A70D8BD670-57" })]);
    const res = mockResponse();
    await POST(
      request(ksefEvent("send_to_ksef_success", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa"), infakt),
      res,
    );

    expect(infakt.updateInfaktInvoices).not.toHaveBeenCalled();
    expect(runInvoicingNow).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("never restarts a row an operator parked for review", async () => {
    const infakt = service([pollingRow({ status: "needs_review" })]);
    await POST(
      request(ksefEvent("send_to_ksef_error", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa"), infakt),
      mockResponse(),
    );
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("answers an unknown invoice exactly as it answers a known one", async () => {
    const known = mockResponse();
    await POST(
      request(ksefEvent("send_to_ksef_success", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa"), service([pollingRow()])),
      known,
    );

    const infakt = service([]);
    const unknown = mockResponse();
    await POST(request(ksefEvent("send_to_ksef_success", "someone-elses-invoice"), infakt), unknown);

    expect(unknown.status).toHaveBeenCalledWith(200);
    expect(unknown.json.mock.calls).toEqual(known.json.mock.calls);
    expect(runInvoicingNow).toHaveBeenCalledTimes(1);
  });

  it("answers 200 to an event this plugin does not care about, so inFakt stops retrying", async () => {
    const infakt = service([pollingRow()]);
    const res = mockResponse();
    await POST(
      request(
        { event: { name: "invoice_paid", uuid: "evt_3" }, resource: { uuid: "inv" } },
        infakt,
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(infakt.listInfaktInvoices).not.toHaveBeenCalled();
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("still answers 200 when the run itself fails - the worker still owns the row", async () => {
    vi.mocked(runInvoicingNow).mockRejectedValueOnce(new Error("inFakt is unreachable"));
    const infakt = service([pollingRow()]);
    const res = mockResponse();
    await POST(
      request(ksefEvent("send_to_ksef_success", "ee2484ce-052c-495a-9ce1-5bd3ae8314aa"), infakt),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("resolves the inFakt module rather than reaching for a global", async () => {
    const infakt = service([pollingRow()]);
    const req = request(ksefEvent("send_to_ksef_success", "ee2484ce"), infakt);
    await POST(req, mockResponse());
    expect(req.scope.resolve).toHaveBeenCalledWith(INFAKT_MODULE);
  });
});
