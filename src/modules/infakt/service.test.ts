import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveInfaktOptions } from "../../lib/options";
import type { InfaktPluginOptions } from "../../lib/options";
import InfaktModuleService, {
  RUN_STATE_SINGLETON_KEY,
  SETTINGS_SINGLETON_KEY,
  STALE_CLAIM_MS,
} from "./service";

/**
 * Unit tests, not module-integration tests.
 *
 * Medusa's module test suite wants a live Postgres, which the unit job does not
 * stand up. What matters here lives in the service and not in the database: which
 * option surface leaves the module, whether the claim/release statements are built
 * and bound correctly, whether enqueue is idempotent, and what the KSeF check
 * persists for each outcome. All of that is observable against a fake table and a
 * fake SQL runner, so the generated CRUD methods and the knex escape hatch are
 * replaced with ones.
 *
 * The real method bodies run - `this` is built on top of the prototype rather than
 * the class being instantiated - so nothing here is a restatement of the
 * implementation.
 *
 * What this CANNOT cover is whether Postgres really serializes the conditional
 * claim UPDATE. That was verified by hand against Postgres 16 while landing the
 * migration (two concurrent claimers: the second blocks on the row lock,
 * re-evaluates its predicate against the committed row and reports 0 rows
 * affected; a claim older than the window is taken over; the taken-over run's
 * release matches nothing) and is recorded in the migration commit.
 */

const validOptions = (overrides: Partial<InfaktPluginOptions> = {}): InfaktPluginOptions => ({
  apiKey: "test-key",
  startDate: "2026-07-01",
  ...overrides,
});

interface FakeRow {
  id: string;
  [key: string]: unknown;
}

/** In-memory stand-in for one of the module's tables. */
const fakeTable = (initial: FakeRow[] = []) => {
  const rows: FakeRow[] = [...initial];
  let sequence = 0;
  return {
    create: (data: Partial<FakeRow>[] | Partial<FakeRow>) => {
      const entries = Array.isArray(data) ? data : [data];
      const created = entries.map((entry) => {
        sequence += 1;
        const row: FakeRow = { id: `row_${sequence}`, ...entry } as FakeRow;
        rows.push(row);
        return { ...row };
      });
      return Promise.resolve(Array.isArray(data) ? created : created[0]);
    },
    list: (filters?: Record<string, unknown>) => {
      if (!filters) {
        return Promise.resolve(rows.map((row) => ({ ...row })));
      }
      const matches = rows.filter((row) =>
        Object.entries(filters).every(([key, value]) =>
          Array.isArray(value) ? value.includes(row[key]) : row[key] === value,
        ),
      );
      return Promise.resolve(matches.map((row) => ({ ...row })));
    },
    rows,
    update: (data: (Partial<FakeRow> & { id: string }) | (Partial<FakeRow> & { id: string })[]) => {
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        const index = rows.findIndex((row) => row.id === entry.id);
        if (index !== -1) {
          rows[index] = { ...rows[index], ...entry };
        }
      }
      return Promise.resolve(entries);
    },
  };
};

interface RawCall {
  sql: string;
  bindings: readonly unknown[];
}

/**
 * Build a `this` on top of the prototype, with the generated CRUD and the raw-SQL
 * escape hatch faked, so the real method bodies execute.
 */
const buildService = (config?: {
  options?: Partial<InfaktPluginOptions>;
  invoices?: FakeRow[];
  runState?: FakeRow[];
  settings?: FakeRow[];
  /** Rows the fake conditional UPDATE returns; defaults to one (claim taken). */
  rawResult?: () => unknown;
  client?: Record<string, unknown>;
}) => {
  const invoices = fakeTable(config?.invoices);
  const runState = fakeTable(config?.runState);
  const settings = fakeTable(config?.settings);
  const rawCalls: RawCall[] = [];
  // `options` and `client` are private on the class, so an intersection type would
  // collapse to `never`. Cast through unknown and keep the public surface typed.
  const service = Object.create(InfaktModuleService.prototype) as InfaktModuleService;

  Object.assign(service, {
    createInfaktInvoices: invoices.create,
    createInfaktRunStates: runState.create,
    createInfaktSettings: settings.create,
    getRawSql: () => ({
      raw: (sql: string, bindings: readonly unknown[]) => {
        rawCalls.push({ bindings, sql });
        return Promise.resolve(config?.rawResult ? config.rawResult() : { rows: [{ id: "x" }] });
      },
    }),
    listInfaktInvoices: invoices.list,
    listInfaktRunStates: runState.list,
    listInfaktSettings: settings.list,
    updateInfaktInvoices: invoices.update,
    updateInfaktRunStates: runState.update,
    updateInfaktSettings: settings.update,
  });

  // Normally set by the real constructor, which is not run here. Both fields are
  // private on the class, so the write goes through `unknown`.
  const internals = service as unknown as { options: unknown; client?: unknown };
  internals.options = resolveInfaktOptions(validOptions(config?.options));
  if (config?.client) {
    internals.client = config.client;
  }

  return { invoices, rawCalls, runState, service, settings };
};

describe("publicOptions", () => {
  it("never exposes the API key", () => {
    const { service } = buildService();
    expect(JSON.stringify(service.publicOptions)).not.toContain("test-key");
    expect(service.publicOptions).not.toHaveProperty("apiKey");
  });

  it("reports the resolved configuration the admin UI renders", () => {
    const { service } = buildService({ options: { currency: "pln", taxSymbol: "8" } });
    expect(service.publicOptions).toMatchObject({
      currency: "PLN",
      disabled: false,
      environment: "production",
      ksefCustomPredicate: false,
      ksefMode: "nip-only",
      ksefRequireActive: true,
      startDate: "2026-07-01",
      taxSymbol: "8",
      triggerEvent: "payment.captured",
    });
  });

  it("reports disabled when apiKey is absent, never because startDate is unset", () => {
    const { service } = buildService({ options: { apiKey: undefined } });
    expect(service.publicOptions).toMatchObject({ disabled: true });

    const { service: withNoFloor } = buildService({ options: { startDate: undefined } });
    expect(withNoFloor.publicOptions).toMatchObject({ disabled: false, startDate: null });
  });

  it("reports that a custom KSeF predicate is in force without exposing it", () => {
    const { service } = buildService({ options: { ksef: { decide: () => true } } });
    expect(service.publicOptions.ksefCustomPredicate).toBe(true);
    expect(service.publicOptions).not.toHaveProperty("ksefDecide");
  });
});

describe("apiClient", () => {
  it("memoizes one client", () => {
    const { service } = buildService();
    expect(service.apiClient).toBe(service.apiClient);
  });

  it("builds it from the resolved options", () => {
    const { service } = buildService({ options: { environment: "sandbox" } });
    expect(service.apiClient).toBeDefined();
    expect(service.resolvedOptions.environment).toBe("sandbox");
  });

  it("refuses to build one when the plugin is disabled", () => {
    const { service } = buildService({ options: { apiKey: undefined } });
    expect(() => service.apiClient).toThrow(/plugin is disabled/u);
  });
});

describe("getRunState", () => {
  it("mints the singleton on first access", async () => {
    const { runState, service } = buildService();
    await service.getRunState();
    expect(runState.rows).toHaveLength(1);
    expect(runState.rows[0]).toMatchObject({ id: RUN_STATE_SINGLETON_KEY, status: "idle" });
  });

  it("returns the existing row without creating a second", async () => {
    const { runState, service } = buildService({
      runState: [{ id: RUN_STATE_SINGLETON_KEY, status: "ok" }],
    });
    const state = await service.getRunState();
    expect(state).toMatchObject({ status: "ok" });
    expect(runState.rows).toHaveLength(1);
  });

  it("survives losing the first-ever-access race", async () => {
    const { service } = buildService();
    let created = false;
    Object.assign(service, {
      createInfaktRunStates: () => {
        created = true;
        return Promise.reject(new Error("duplicate key"));
      },
      // Empty on the first read (before the failed insert), present afterwards.
      listInfaktRunStates: () =>
        Promise.resolve(created ? [{ id: RUN_STATE_SINGLETON_KEY, status: "idle" }] : []),
    });
    await expect(service.getRunState()).resolves.toMatchObject({
      id: RUN_STATE_SINGLETON_KEY,
    });
  });

  it("rethrows when the insert failed for a real reason", async () => {
    const { service } = buildService();
    Object.assign(service, {
      createInfaktRunStates: () => Promise.reject(new Error("connection refused")),
      listInfaktRunStates: () => Promise.resolve([]),
    });
    await expect(service.getRunState()).rejects.toThrow("connection refused");
  });
});

describe("claimRun", () => {
  it("takes the claim with ONE conditional UPDATE and returns its token", async () => {
    const { rawCalls, service } = buildService({
      rawResult: () => ({ rows: [{ claim_token: "t" }] }),
    });
    const claim = await service.claimRun();

    expect(claim.acquired).toBe(true);
    expect(claim.token).toBeTruthy();
    expect(rawCalls).toHaveLength(1);
    const [{ bindings, sql }] = rawCalls;
    // The predicate is what makes this safe: a running claim inside the window
    // matches nothing, so a second run cannot acquire.
    expect(sql).toMatch(/update "infakt_run_state"/u);
    expect(sql).toContain(`"status" <> 'running'`);
    expect(sql).toContain(`"claimed_at" is null`);
    expect(sql).toContain(`"claimed_at" <= ?`);
    expect(sql).toContain("returning");
    expect(bindings[0]).toBe("running");
    expect(bindings[1]).toBe(claim.token);
    expect(bindings[4]).toBe(RUN_STATE_SINGLETON_KEY);
  });

  it("binds a cutoff exactly one stale window behind the claim time", async () => {
    const { rawCalls, service } = buildService({
      rawResult: () => ({ rows: [{ claim_token: "t" }] }),
    });
    await service.claimRun();
    const { bindings } = rawCalls[0];
    const claimedAt = bindings[2] as Date;
    const cutoff = bindings[5] as Date;
    expect(claimedAt.getTime() - cutoff.getTime()).toBe(STALE_CLAIM_MS);
  });

  it("refuses when the UPDATE matched nothing, and never guesses otherwise", async () => {
    const { service } = buildService({
      rawResult: () => ({ rows: [] }),
      runState: [
        {
          claim_token: "other",
          claimed_at: new Date(),
          id: RUN_STATE_SINGLETON_KEY,
          status: "running",
        },
      ],
    });
    const claim = await service.claimRun();
    expect(claim.acquired).toBe(false);
    expect(claim.token).toBeUndefined();
    expect(claim.reason).toContain("still holds the lock");
  });

  it("reports losing a race when the refusal was not an active lock", async () => {
    const { service } = buildService({
      rawResult: () => ({ rows: [] }),
      runState: [{ id: RUN_STATE_SINGLETON_KEY, status: "idle" }],
    });
    expect((await service.claimRun()).reason).toContain("lost the race");
  });

  it("normalizes a bare-array raw result as well as { rows }", async () => {
    const { service } = buildService({ rawResult: () => [{ claim_token: "t" }] });
    expect((await service.claimRun()).acquired).toBe(true);
  });

  it("mints the singleton before attempting the claim", async () => {
    const { runState, service } = buildService({
      rawResult: () => ({ rows: [{ claim_token: "t" }] }),
    });
    await service.claimRun();
    expect(runState.rows).toHaveLength(1);
  });
});

describe("releaseRun", () => {
  it("releases conditionally on the claim token", async () => {
    const { rawCalls, service } = buildService();
    await expect(service.releaseRun("token-A", { status: "ok" })).resolves.toBe(true);
    const [{ bindings, sql }] = rawCalls;
    // Conditional on the token so a run taken over as stale cannot clear its
    // successor's claim, which would let a third run start alongside it.
    expect(sql).toContain(`"claim_token" = ?`);
    expect(bindings.at(-1)).toBe("token-A");
    expect(bindings.at(-2)).toBe(RUN_STATE_SINGLETON_KEY);
    expect(sql).toContain(`"claim_token" = null`);
  });

  it("reports false when the token no longer matches", async () => {
    const { service } = buildService({ rawResult: () => ({ rows: [] }) });
    await expect(service.releaseRun("stale", { status: "ok" })).resolves.toBe(false);
  });

  it("writes last_error only when it was provided", async () => {
    const withError = buildService();
    await withError.service.releaseRun("t", { lastError: "2 sent to review", status: "error" });
    expect(withError.rawCalls[0].sql).toContain(`"last_error" = ?`);
    expect(withError.rawCalls[0].bindings).toContain("2 sent to review");

    const without = buildService();
    await without.service.releaseRun("t", { status: "ok" });
    expect(without.rawCalls[0].sql).not.toContain(`"last_error"`);
  });

  it("clears last_error when explicitly given null", async () => {
    const { rawCalls, service } = buildService();
    await service.releaseRun("t", { lastError: null, status: "ok" });
    expect(rawCalls[0].sql).toContain(`"last_error" = ?`);
    expect(rawCalls[0].bindings).toContain(null);
  });

  it("records the processed count when given", async () => {
    const { rawCalls, service } = buildService();
    await service.releaseRun("t", { processed: 7, status: "ok" });
    expect(rawCalls[0].sql).toContain(`"processed" = ?`);
    expect(rawCalls[0].bindings).toContain(7);
  });

  it("always stamps last_run_at, so a stuck worker is visible", async () => {
    const { rawCalls, service } = buildService();
    await service.releaseRun("t", { status: "ok" });
    expect(rawCalls[0].sql).toContain(`"last_run_at" = ?`);
  });
});

describe("listDueInvoices", () => {
  it("filters in the DATABASE, not in JS", async () => {
    // The JS-filter version let a backlog starve the queue: enough deferred rows
    // (orders awaiting payment) fill every page, and a genuinely due row behind them
    // is never reached. That is an invoice that never gets issued, not a slowdown.
    const { rawCalls, service } = buildService({ rawResult: () => ({ rows: [{ id: "inv_1" }] }) });
    const rows = await service.listDueInvoices(20);

    expect(rows).toEqual([{ id: "inv_1" }]);
    const [{ bindings, sql }] = rawCalls;
    expect(sql).toContain(`"status" in ('pending', 'processing')`);
    expect(sql).toContain(`"next_attempt_at" is null or "next_attempt_at" <= ?`);
    expect(sql).toContain(`"deleted_at" is null`);
    expect(sql).toContain('order by "created_at" asc');
    expect(sql).toContain("limit ?");
    expect(bindings[0]).toBeInstanceOf(Date);
    expect(bindings[1]).toBe(20);
  });

  it("never selects a terminal status", async () => {
    // done, skipped and needs_review are terminal. Getting a needs_review row moving
    // again is an explicit operator action, which is the point of that state.
    const { rawCalls, service } = buildService();
    await service.listDueInvoices(20);
    for (const terminal of ["done", "skipped", "needs_review"]) {
      expect(rawCalls[0].sql).not.toContain(`'${terminal}'`);
    }
  });

  it("normalizes a bare-array driver result", async () => {
    const { service } = buildService({ rawResult: () => [{ id: "inv_1" }] });
    await expect(service.listDueInvoices(20)).resolves.toEqual([{ id: "inv_1" }]);
  });
});

describe("enqueueOrder", () => {
  it("creates a pending row for a new order", async () => {
    const { invoices, service } = buildService();
    await expect(service.enqueueOrder("order_1")).resolves.toEqual({ created: true });
    expect(invoices.rows[0]).toMatchObject({ order_id: "order_1", status: "pending" });
  });

  it("is idempotent - a second enqueue creates nothing", async () => {
    const { invoices, service } = buildService({
      invoices: [{ id: "inv_1", order_id: "order_1", status: "done" }],
    });
    await expect(service.enqueueOrder("order_1")).resolves.toEqual({ created: false });
    expect(invoices.rows).toHaveLength(1);
  });

  it("does not restart a pipeline for an order already in needs_review", async () => {
    // The whole point of the unique order_id: a re-fired trigger must never give a
    // parked row a second chance to create a duplicate invoice.
    const { service } = buildService({
      invoices: [{ id: "inv_1", order_id: "order_1", status: "needs_review" }],
    });
    await expect(service.enqueueOrder("order_1")).resolves.toEqual({ created: false });
  });

  it("treats losing the insert race as a duplicate, not a failure", async () => {
    const { service } = buildService();
    let attempted = false;
    Object.assign(service, {
      createInfaktInvoices: () => {
        attempted = true;
        return Promise.reject(new Error("duplicate key"));
      },
      listInfaktInvoices: () =>
        Promise.resolve(attempted ? [{ id: "inv_1", order_id: "order_1" }] : []),
    });
    await expect(service.enqueueOrder("order_1")).resolves.toEqual({ created: false });
  });

  it("throws when the insert failed and no row exists afterwards", async () => {
    const { service } = buildService();
    Object.assign(service, {
      createInfaktInvoices: () => Promise.reject(new Error("connection refused")),
      listInfaktInvoices: () => Promise.resolve([]),
    });
    await expect(service.enqueueOrder("order_1")).rejects.toThrow(/could not enqueue order/u);
  });
});

describe("verifyKsefIntegration", () => {
  it("persists an active integration and clears any previous error", async () => {
    const { runState, service } = buildService({
      client: { getKsefIntegration: vi.fn().mockResolvedValue({ active: true }) },
      runState: [{ id: RUN_STATE_SINGLETON_KEY, ksef_error: "old failure", status: "idle" }],
    });
    await expect(service.verifyKsefIntegration()).resolves.toMatchObject({ active: true });
    expect(runState.rows[0]).toMatchObject({ ksef_active: true, ksef_error: null });
    expect(runState.rows[0].ksef_checked_at).toBeInstanceOf(Date);
  });

  it("persists an inactive integration as a hard false", async () => {
    const { runState, service } = buildService({
      client: { getKsefIntegration: vi.fn().mockResolvedValue({ active: false }) },
      runState: [{ id: RUN_STATE_SINGLETON_KEY, status: "idle" }],
    });
    await expect(service.verifyKsefIntegration()).resolves.toMatchObject({ active: false });
    expect(runState.rows[0].ksef_active).toBe(false);
  });

  it("records a failed CHECK as an error, and never as active: false", async () => {
    // "We could not reach inFakt" and "your KSeF integration has lapsed" need
    // completely different operator responses. Conflating them would raise a false
    // alarm on a network blip, or hide a real lapse behind one.
    const { runState, service } = buildService({
      client: { getKsefIntegration: vi.fn().mockRejectedValue(new Error("socket hang up")) },
      runState: [{ id: RUN_STATE_SINGLETON_KEY, ksef_active: true, status: "idle" }],
    });
    const result = await service.verifyKsefIntegration();
    expect(result).toMatchObject({ active: false, error: "socket hang up" });
    expect(runState.rows[0].ksef_active).toBe(true);
    expect(runState.rows[0].ksef_error).toBe("socket hang up");
  });
});

describe("getSettings", () => {
  it("mints the singleton on first access, paused by default", async () => {
    const { service, settings } = buildService();
    const row = await service.getSettings();
    expect(row).toMatchObject({ id: SETTINGS_SINGLETON_KEY, invoicing_paused: true });
    expect(settings.rows).toHaveLength(1);
  });

  it("returns the existing row without creating a second", async () => {
    const { service, settings } = buildService({
      settings: [{ id: SETTINGS_SINGLETON_KEY, invoicing_paused: false }],
    });
    const row = await service.getSettings();
    expect(row).toMatchObject({ invoicing_paused: false });
    expect(settings.rows).toHaveLength(1);
  });

  it("survives losing the first-ever-access race", async () => {
    const { service } = buildService();
    let created = false;
    Object.assign(service, {
      createInfaktSettings: () => {
        created = true;
        return Promise.reject(new Error("duplicate key"));
      },
      listInfaktSettings: () =>
        Promise.resolve(created ? [{ id: SETTINGS_SINGLETON_KEY, invoicing_paused: true }] : []),
    });
    await expect(service.getSettings()).resolves.toMatchObject({ id: SETTINGS_SINGLETON_KEY });
  });
});

describe("setInvoicingPaused", () => {
  it("mints the singleton if needed, then writes the switch", async () => {
    const { service, settings } = buildService();
    await service.setInvoicingPaused(false);
    expect(settings.rows[0]).toMatchObject({ id: SETTINGS_SINGLETON_KEY, invoicing_paused: false });
  });

  it("flips an existing row", async () => {
    const { service, settings } = buildService({
      settings: [{ id: SETTINGS_SINGLETON_KEY, invoicing_paused: true }],
    });
    await service.setInvoicingPaused(false);
    expect(settings.rows[0].invoicing_paused).toBe(false);
    await service.setInvoicingPaused(true);
    expect(settings.rows[0].invoicing_paused).toBe(true);
  });
});

describe("getEffectiveEnablement", () => {
  const ENV_VAR = "INFAKT_INVOICING_DISABLED";
  const originalValue = process.env[ENV_VAR];

  beforeEach(() => {
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = originalValue;
    }
  });

  it("is active when apiKey is configured, not paused, and the env flag is unset", async () => {
    const { service } = buildService({
      settings: [{ id: SETTINGS_SINGLETON_KEY, invoicing_paused: false }],
    });
    await expect(service.getEffectiveEnablement()).resolves.toMatchObject({
      apiKeyConfigured: true,
      effectiveEnabled: true,
      envForceDisabled: false,
      invoicingPaused: false,
      reason: "active",
    });
  });

  it("reports no_api_key when apiKey is absent, regardless of the pause switch", async () => {
    const { service } = buildService({
      options: { apiKey: undefined },
      settings: [{ id: SETTINGS_SINGLETON_KEY, invoicing_paused: false }],
    });
    await expect(service.getEffectiveEnablement()).resolves.toMatchObject({
      effectiveEnabled: false,
      reason: "no_api_key",
    });
  });

  it("reports paused when apiKey is configured but a fresh singleton has not been unpaused", async () => {
    // No settings row at all - getSettings mints one, paused by default.
    const { service } = buildService();
    await expect(service.getEffectiveEnablement()).resolves.toMatchObject({
      effectiveEnabled: false,
      invoicingPaused: true,
      reason: "paused",
    });
  });

  it("reports env_force_disabled, outranking an apiKey and an unpaused switch", async () => {
    process.env[ENV_VAR] = "true";
    const { service } = buildService({
      settings: [{ id: SETTINGS_SINGLETON_KEY, invoicing_paused: false }],
    });
    await expect(service.getEffectiveEnablement()).resolves.toMatchObject({
      effectiveEnabled: false,
      envForceDisabled: true,
      reason: "env_force_disabled",
    });
  });
});
