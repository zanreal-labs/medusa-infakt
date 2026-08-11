import { randomUUID } from "node:crypto";
import { MedusaError, MedusaService } from "@medusajs/framework/utils";
import { InfaktClient } from "../../lib/infakt";
import type { InfaktKsefIntegration } from "../../lib/infakt";
import { resolveInfaktOptions, toPublicInfaktOptions } from "../../lib/options";
import type {
  InfaktPluginOptions,
  InfaktPublicOptions,
  ResolvedInfaktOptions,
} from "../../lib/options";
import { isClaimActive, staleClaimCutoff } from "./claim-logic";
import InfaktInvoiceModel from "./models/infakt-invoice";
import InfaktRunStateModel from "./models/infakt-run-state";

/**
 * How long a claim stays valid before another run may take it over.
 *
 * Must comfortably exceed a healthy full run. A batch is 20 rows processed
 * sequentially, each making a handful of inFakt calls with a 60s timeout ceiling,
 * so the realistic worst case is a few minutes; ten gives room without leaving a
 * crashed run wedged for an hour.
 */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

/** The one InfaktRunState row ever expected to exist. */
export const RUN_STATE_SINGLETON_KEY = "singleton";

/**
 * Physical table behind InfaktInvoiceModel. Named here for the same reason as the
 * run-state table: the due-row query is raw SQL. Must match
 * `model.define("infakt_invoice", ...)`.
 */
const INVOICE_TABLE = "infakt_invoice";

/**
 * Physical table behind InfaktRunStateModel. Named here because the atomic
 * claim/release statements are raw SQL - the generated CRUD methods cannot express
 * a conditional UPDATE (see `claimRun`). Must match
 * `model.define("infakt_run_state", ...)`.
 */
const RUN_STATE_TABLE = "infakt_run_state";

export interface RunClaim {
  acquired: boolean;
  /**
   * Opaque proof of ownership, present only when `acquired`. Pass it back to
   * `releaseRun` - a release without the current token is a no-op, so a run that
   * lost its claim to a stale takeover cannot clear its successor's.
   */
  token?: string;
  /** Present when a claim was NOT acquired: another run holds a fresh lock. */
  reason?: string;
}

export interface RunOutcome {
  status: "ok" | "error";
  /** A string records it, `null` clears it, omitting leaves it as-is. */
  lastError?: string | null;
  processed?: number;
}

/**
 * Minimal slice of knex needed for the two conditional statements. Typed
 * structurally rather than importing knex: it is a transitive dependency of
 * MikroORM here, not a declared one, and only `raw` is used.
 */
interface RawSqlRunner {
  raw: <TRow>(
    sql: string,
    bindings: readonly unknown[],
  ) => Promise<{ rows?: TRow[] } | TRow[] | undefined>;
}

/**
 * knex's `raw` resolves to the driver's result object (`{ rows }` on pg) but is
 * typed loosely enough that a bare array shows up on some paths. Normalize both.
 */
const rawRows = <TRow>(result: { rows?: TRow[] } | TRow[] | undefined): TRow[] => {
  if (Array.isArray(result)) {
    return result;
  }
  return result?.rows ?? [];
};

/**
 * The `infakt` module service.
 *
 * Owns the invoice ledger, the worker's single-flight claim, and the lazily
 * constructed inFakt client. It deliberately does NOT own the pipeline: the
 * worker job drives the steps, and every rule it applies lives in
 * `src/lib/invoicing/`, unit-tested without a database.
 */
export default class InfaktModuleService extends MedusaService({
  InfaktInvoice: InfaktInvoiceModel,
  InfaktRunState: InfaktRunStateModel,
}) {
  private readonly options: ResolvedInfaktOptions;
  private client?: InfaktClient;

  constructor(_container: unknown, moduleOptions?: Partial<InfaktPluginOptions>) {
    super(...arguments);
    // Resolved (and therefore validated) here as well as in the module loader. The
    // loader is what produces a readable boot failure; this is what guarantees no
    // code path downstream ever sees a half-applied option object.
    this.options = resolveInfaktOptions(moduleOptions);
  }

  /** The resolved options, minus the API key. Safe to return over HTTP. */
  get publicOptions(): InfaktPublicOptions {
    return toPublicInfaktOptions(this.options);
  }

  /** The resolved options in full. Never serialize this - it carries `apiKey`. */
  get resolvedOptions(): ResolvedInfaktOptions {
    return this.options;
  }

  /**
   * The inFakt client, memoized.
   *
   * Constructed lazily rather than in the constructor so the module can be resolved
   * (and the admin UI can render its configuration) in a deployment where inFakt is
   * unreachable. The API key itself is already validated at boot by the loader.
   *
   * A getter rather than a method because nothing about it is asynchronous, and
   * Medusa's lint rule - rightly - requires public service methods to return a
   * promise.
   */
  get apiClient(): InfaktClient {
    this.client ??= new InfaktClient({
      apiKey: this.options.apiKey,
      environment: this.options.environment,
      timeoutMs: this.options.timeoutMs,
    });
    return this.client;
  }

  /**
   * The raw-SQL escape hatch, for the two statements the generated CRUD cannot
   * express.
   *
   * `update({ selector, data })` lists the matching rows and then updates them,
   * which is the same check-then-act race the atomic claim exists to close. The
   * documented way to reach knex from a module is
   * `baseRepository_.getActiveManager().getKnex()`, exactly as core's own
   * `InventoryLevelRepository` does it. `baseRepository_` is set by MedusaService's
   * generated base class but absent from its public type, hence the cast.
   */
  private getRawSql(): RawSqlRunner {
    const repository = (
      this as unknown as {
        baseRepository_?: { getActiveManager?: <T>() => { getKnex?: () => RawSqlRunner } };
      }
    ).baseRepository_;
    const knex = repository?.getActiveManager?.<{ getKnex?: () => RawSqlRunner }>()?.getKnex?.();
    if (!knex) {
      // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error -- an internal wiring invariant, never surfaced over HTTP
      throw new Error(
        "medusa-infakt: no database connection available on the module's base repository - the worker claim cannot be taken safely without one.",
      );
    }
    return knex;
  }

  /**
   * The one InfaktRunState row, created on first access. Never call
   * `createInfaktRunStates` directly elsewhere - this is the only path that should
   * mint the singleton, so there is never a race that produces two.
   */
  async getRunState() {
    const [existing] = await this.listInfaktRunStates({ id: [RUN_STATE_SINGLETON_KEY] });
    if (existing) {
      return existing;
    }
    try {
      return await this.createInfaktRunStates({
        id: RUN_STATE_SINGLETON_KEY,
        status: "idle",
      });
    } catch (error) {
      // Two processes reaching first-ever access together both see no row and both
      // insert; the primary key lets exactly one win. The loser's insert failing is
      // not a run failure - re-read and carry on.
      const [raced] = await this.listInfaktRunStates({ id: [RUN_STATE_SINGLETON_KEY] });
      if (raced) {
        return raced;
      }
      throw error;
    }
  }

  /**
   * Single-flight guard for the invoicing worker: take the claim, or report that
   * someone else holds it.
   *
   * **This must be one atomic statement, and it is.** A read-decide-write version
   * is a check-then-act race, and the consequence here is not a duplicated log
   * line: two overlapping runs reading the same due row would both pass the
   * crash-window check, both write `submit_started_at`, and both POST an invoice
   * create. inFakt has no idempotency key, so that is two real, numbered,
   * legally-issued invoices for one order, with no way to withdraw either - only a
   * formal corrective invoice.
   *
   * A single `UPDATE ... WHERE` cannot interleave: the second transaction blocks on
   * the row lock, then re-evaluates its predicate against the committed row and
   * matches nothing, so `RETURNING` gives back zero rows. Zero rows is the signal
   * that the claim was refused - never an inferred "probably fine".
   *
   * The caller MUST hold the claim for its whole run and release it in a `finally`.
   */
  async claimRun(): Promise<RunClaim> {
    await this.getRunState();

    const now = new Date();
    const token = `${now.getTime().toString(36)}-${randomUUID()}`;
    const cutoff = staleClaimCutoff(now, STALE_CLAIM_MS);

    const claimed = rawRows<{ claim_token: string }>(
      await this.getRawSql().raw(
        `update "${RUN_STATE_TABLE}"
            set "status" = ?, "claim_token" = ?, "claimed_at" = ?, "updated_at" = ?
          where "id" = ?
            and "deleted_at" is null
            and ("status" <> 'running' or "claimed_at" is null or "claimed_at" <= ?)
          returning "claim_token"`,
        ["running", token, now, now, RUN_STATE_SINGLETON_KEY, cutoff],
      ),
    );

    if (claimed.length === 0) {
      return { acquired: false, reason: await this.describeRefusedClaim() };
    }
    return { acquired: true, token };
  }

  /**
   * Human-readable reason a claim was refused. Read AFTER the failed UPDATE, so it
   * is only ever an explanation for a log line - the refusal itself was already
   * decided atomically and is not revisited here.
   */
  private async describeRefusedClaim(): Promise<string> {
    const [state] = await this.listInfaktRunStates({ id: [RUN_STATE_SINGLETON_KEY] });
    const claimedAt = (state as { claimed_at?: Date | string | null } | undefined)?.claimed_at;
    const ageMs = claimedAt ? Date.now() - new Date(claimedAt).getTime() : Number.POSITIVE_INFINITY;

    if (state && isClaimActive(String(state.status), ageMs, STALE_CLAIM_MS)) {
      return `another invoicing run claimed ${Math.round(ageMs / 1000)}s ago still holds the lock (window ${Math.round(STALE_CLAIM_MS / 1000)}s).`;
    }
    return "lost the race for the invoicing claim to a concurrent run.";
  }

  /**
   * Release a claim taken by `claimRun` and record the run's outcome.
   *
   * Conditional on `claim_token` for a specific reason: after a stale takeover two
   * processes both believe they are the current run. The one that was taken over
   * must not be able to clear its successor's claim (which would let a third run
   * start alongside it) nor overwrite its status. A non-matching token updates
   * nothing and returns false, which the caller should log.
   */
  async releaseRun(token: string, outcome: RunOutcome): Promise<boolean> {
    const now = new Date();
    const sets = [
      `"status" = ?`,
      `"claim_token" = null`,
      `"claimed_at" = null`,
      `"updated_at" = ?`,
      `"last_run_at" = ?`,
    ];
    const bindings: unknown[] = [outcome.status, now, now];
    if (outcome.lastError !== undefined) {
      sets.push(`"last_error" = ?`);
      bindings.push(outcome.lastError);
    }
    if (outcome.processed !== undefined) {
      sets.push(`"processed" = ?`);
      bindings.push(outcome.processed);
    }
    bindings.push(RUN_STATE_SINGLETON_KEY, token);

    const released = rawRows<{ id: string }>(
      await this.getRawSql().raw(
        `update "${RUN_STATE_TABLE}"
            set ${sets.join(", ")}
          where "id" = ? and "claim_token" = ? and "deleted_at" is null
          returning "id"`,
        bindings,
      ),
    );

    return released.length > 0;
  }

  /**
   * The rows the worker should advance now: pending or processing, whose
   * `next_attempt_at` has passed or was never set, oldest first.
   *
   * Raw SQL because the predicate has to run in the DATABASE. Fetching a padded page
   * and filtering in JS - the obvious version - lets a backlog starve the queue: a
   * store with more deferred rows than the page size (orders awaiting payment, each
   * re-checked every 30 minutes) can fill every page with rows that are not due, and
   * a genuinely due row behind them is never reached. That is not a slowdown; it is
   * an invoice that never gets issued.
   *
   * `done`, `skipped` and `needs_review` are terminal and are never picked up here.
   * Getting a needs_review row moving again is an explicit operator action, which is
   * the entire point of that state.
   *
   * The `(status, next_attempt_at)` index on the model covers the filter. Postgres
   * chooses a sequential scan on a small table regardless, which is correct - the
   * index earns its keep once the ledger is large.
   *
   * Verified against Postgres 16 with the real migration applied: it returns exactly
   * the pending/processing rows that are due, excludes future-dated, needs_review,
   * done, skipped and soft-deleted rows, and still returns a due row sitting behind
   * 500 not-due ones.
   */
  async listDueInvoices(limit: number): Promise<Record<string, unknown>[]> {
    return rawRows<Record<string, unknown>>(
      await this.getRawSql().raw(
        `select * from "${INVOICE_TABLE}"
          where "deleted_at" is null
            and "status" in ('pending', 'processing')
            and ("next_attempt_at" is null or "next_attempt_at" <= ?)
          order by "created_at" asc
          limit ?`,
        [new Date(), limit],
      ),
    );
  }

  /**
   * Idempotently add an order to the invoicing queue.
   *
   * `order_id` is unique, so a second call for the same order is a no-op rather
   * than a second pipeline. Returns whether a row was created, which is what the
   * subscriber logs - a silently-ignored duplicate and a genuine first enqueue
   * look identical otherwise.
   */
  async enqueueOrder(orderId: string): Promise<{ created: boolean }> {
    const [existing] = await this.listInfaktInvoices({ order_id: [orderId] });
    if (existing) {
      return { created: false };
    }
    try {
      await this.createInfaktInvoices({ order_id: orderId, status: "pending" });
      return { created: true };
    } catch {
      // The unique constraint is the real guard; losing the race to a concurrent
      // enqueue is the expected outcome, not a failure. Re-read to confirm rather
      // than swallowing a genuine error.
      const [raced] = await this.listInfaktInvoices({ order_id: [orderId] });
      if (raced) {
        return { created: false };
      }
      throw new MedusaError(
        MedusaError.Types.DB_ERROR,
        `medusa-infakt: could not enqueue order ${orderId} for invoicing.`,
      );
    }
  }

  /**
   * Verify the inFakt account's KSeF integration and persist the result.
   *
   * Called at startup (and by the admin UI's refresh action) rather than per
   * invoice: it is an account-level fact that changes rarely, and a per-invoice
   * check would burn a request from the GET rate limit on every row.
   *
   * A failed CHECK is recorded as an error but never as `active: false`. "We could
   * not reach inFakt" and "your KSeF integration has lapsed" call for completely
   * different operator responses, and conflating them would either raise a false
   * alarm during a network blip or hide a real lapse behind one.
   */
  async verifyKsefIntegration(): Promise<InfaktKsefIntegration & { error?: string }> {
    await this.getRunState();
    try {
      const integration = await this.apiClient.getKsefIntegration();
      await this.updateInfaktRunStates({
        id: RUN_STATE_SINGLETON_KEY,
        ksef_active: integration.active,
        ksef_checked_at: new Date(),
        ksef_error: null,
      });
      return integration;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.updateInfaktRunStates({
        id: RUN_STATE_SINGLETON_KEY,
        ksef_checked_at: new Date(),
        ksef_error: message,
      });
      return { active: false, error: message };
    }
  }
}
