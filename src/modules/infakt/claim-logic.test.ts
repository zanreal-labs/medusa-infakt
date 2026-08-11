import { describe, expect, it } from "vitest";
import { isClaimActive, runHealth, staleClaimCutoff } from "./claim-logic";

describe("staleClaimCutoff", () => {
  it("is the window before now", () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    expect(staleClaimCutoff(now, 10 * 60_000).toISOString()).toBe("2026-07-15T11:50:00.000Z");
  });
});

describe("isClaimActive", () => {
  it("is true only for a running claim inside the window", () => {
    expect(isClaimActive("running", 60_000, 600_000)).toBe(true);
    expect(isClaimActive("running", 600_000, 600_000)).toBe(true);
  });

  it("is false once the window has passed - a crashed run must be takeoverable", () => {
    expect(isClaimActive("running", 600_001, 600_000)).toBe(false);
    expect(isClaimActive("running", Number.POSITIVE_INFINITY, 600_000)).toBe(false);
  });

  it("is false for any status other than running", () => {
    for (const status of ["idle", "ok", "error", ""]) {
      expect(isClaimActive(status, 0, 600_000)).toBe(false);
    }
  });
});

describe("runHealth", () => {
  it("is ok for a clean run", () => {
    expect(runHealth({ failed: 0, review: 0 })).toEqual({ lastError: null, status: "ok" });
  });

  it("is an error when any row went to review, even though the run completed", () => {
    // A run that parks invoices a human must handle is not healthy. Reporting ok
    // here is how a legal filing obligation gets missed quietly.
    const health = runHealth({ failed: 0, review: 1 });
    expect(health.status).toBe("error");
    expect(health.lastError).toContain("1 sent to review");
  });

  it("is an error when any row failed and will retry", () => {
    expect(runHealth({ failed: 2, review: 0 }).status).toBe("error");
  });

  it("counts both in one message", () => {
    expect(runHealth({ failed: 2, review: 3 }).lastError).toBe("2 failed, 3 sent to review");
  });
});
