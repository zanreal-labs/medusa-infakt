import { describe, expect, it, vi } from "vitest";
import { lookupVies, readCachedVies } from "./vies";

/**
 * The point of every test here is the third outcome. `unavailable` must never
 * collapse into `invalid`: one means "this buyer is a consumer", the other means
 * "we do not know", and they lead to opposite invoices.
 */

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  }) as Response;

const fetchReturning = (response: Response | Promise<Response>) =>
  vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

describe("lookupVies", () => {
  it("reports a registered number as valid", async () => {
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: fetchReturning(
        jsonResponse({ name: "ACME GmbH", requestDate: "2026-08-27", valid: true }),
      ),
    });
    expect(result).toMatchObject({ checkedAt: "2026-08-27", name: "ACME GmbH", status: "valid" });
  });

  it("reports an unregistered number as invalid", async () => {
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: fetchReturning(jsonResponse({ valid: false })),
    });
    expect(result.status).toBe("invalid");
  });

  it("captures the consultation number, which is the audit artifact", async () => {
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: fetchReturning(jsonResponse({ requestIdentifier: "WAPIAAA", valid: true })),
    });
    expect(result.status === "valid" && result.consultationNumber).toBe("WAPIAAA");
  });

  it("asks for a consultation number when a requester is configured", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ valid: true }));
    await lookupVies("DE", "123456789", {
      fetchImpl: spy as unknown as typeof fetch,
      requester: { countryCode: "PL", vatNumber: "6423261225" },
    });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("requesterMemberStateCode=PL");
    expect(url).toContain("requesterNumber=6423261225");
  });

  it("treats a member-state outage reported in a 200 as unavailable, NOT invalid", async () => {
    // VIES reports node outages this way, and reading MS_UNAVAILABLE as "not
    // registered" would charge VAT to every German business during a DE outage.
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: fetchReturning(jsonResponse({ userError: "MS_UNAVAILABLE" })),
    });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.reason).toContain("MS_UNAVAILABLE");
  });

  it("treats an HTTP error as unavailable", async () => {
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: fetchReturning(jsonResponse({}, 503)),
    });
    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.reason).toContain("503");
  });

  it("treats a network failure as unavailable rather than throwing", async () => {
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: vi.fn().mockRejectedValue(new TypeError("network")) as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });

  it("treats a response that does not state validity as unavailable", async () => {
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: fetchReturning(jsonResponse({ name: "ACME" })),
    });
    expect(result.status).toBe("unavailable");
  });

  it("treats a malformed body as unavailable rather than throwing", async () => {
    const broken = {
      json: async () => {
        throw new Error("not json");
      },
      ok: true,
      status: 200,
    } as unknown as Response;
    const result = await lookupVies("DE", "123456789", { fetchImpl: fetchReturning(broken) });
    expect(result.status).toBe("unavailable");
  });

  it("never throws, whatever the transport does", async () => {
    const result = await lookupVies("DE", "123456789", {
      fetchImpl: vi.fn().mockRejectedValue("a string, not an Error") as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
  });

  it("builds the documented REST path", async () => {
    const spy = vi.fn().mockResolvedValue(jsonResponse({ valid: true }));
    await lookupVies("DE", "123456789", {
      baseUrl: "https://example.test/vies/",
      fetchImpl: spy as unknown as typeof fetch,
    });
    expect(String(spy.mock.calls[0]?.[0])).toBe("https://example.test/vies/ms/DE/vat/123456789");
  });
});

describe("readCachedVies", () => {
  it("reads the full object shape", () => {
    expect(
      readCachedVies({ vies: { checkedAt: "2026-08-27", status: "valid" } }),
    ).toMatchObject({ checkedAt: "2026-08-27", status: "valid" });
  });

  it("reads a bare boolean, which a simple storefront is likely to store", () => {
    expect(readCachedVies({ vies: true })).toEqual({ status: "valid" });
    expect(readCachedVies({ vies: false })).toEqual({ status: "invalid" });
  });

  it("reads a bare status string", () => {
    expect(readCachedVies({ vies: "valid" })).toEqual({ status: "valid" });
    expect(readCachedVies({ vies: "UNAVAILABLE" })).toEqual({ status: "unavailable" });
  });

  it("reads a { valid: boolean } object", () => {
    expect(readCachedVies({ vies: { valid: true } })).toMatchObject({ status: "valid" });
  });

  it("accepts the alternative key spellings", () => {
    expect(readCachedVies({ vies_result: "valid" })).toEqual({ status: "valid" });
    expect(readCachedVies({ viesResult: "valid" })).toEqual({ status: "valid" });
  });

  it("returns null when nothing was recorded, which the tree reads as unavailable", () => {
    expect(readCachedVies(null)).toBeNull();
    expect(readCachedVies({})).toBeNull();
    expect(readCachedVies({ vies: "nonsense" })).toBeNull();
    expect(readCachedVies({ vies: {} })).toBeNull();
  });

  it("keeps the consultation number when one was cached", () => {
    expect(
      readCachedVies({ vies: { consultationNumber: "WAPIAAA", status: "valid" } }),
    ).toMatchObject({ consultationNumber: "WAPIAAA" });
  });
});
