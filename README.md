# @zanreal/medusa-infakt

Polish invoicing for Medusa v2. Issues an [inFakt](https://www.infakt.pl/) invoice for
every paid order and files the B2B ones to **KSeF**, Poland's national e-invoicing
system.

Built against Medusa core `2.18.0`.

The hard part of this integration is not the API calls. It is that **issuing an invoice
cannot be undone.** inFakt's create endpoint has no idempotency key, so a retried
request produces a second real, numbered, legally-issued document - and the only way
to withdraw one is a formal corrective invoice. Almost every design decision below
follows from that.

---

## Contents

- [What it does](#what-it-does)
- [The legal context](#the-legal-context)
- [Install](#install)
- [Options](#options)
- [Environment variables](#environment-variables)
- [How an order becomes an invoice](#how-an-order-becomes-an-invoice)
- [The crash window, and why the create is never retried](#the-crash-window-and-why-the-create-is-never-retried)
- [The total-match guard](#the-total-match-guard)
- [Orders backfilled from a legacy system](#orders-backfilled-from-a-legacy-system)
- [Where the buyer's NIP comes from](#where-the-buyers-nip-comes-from)
- [KSeF](#ksef)
- [Operator runbook: needs_review](#operator-runbook-needs_review)
- [Cross-plugin event](#cross-plugin-event)
- [Admin API](#admin-api)
- [Privacy](#privacy)
- [Testing](#testing)
- [Generating a migration](#generating-a-migration)
- [Roadmap](#roadmap)
- [License](#license)

---

## What it does

1. A trigger event (`payment.captured` by default) **queues** the order. That is all the
   event does.
2. A scheduled worker drives each queued order to completion, sequentially:
   - verifies the order is not already invoiced outside this pipeline, is **fully
     paid**, in the configured currency, not canceled, and placed on or after
     `startDate` (when one is configured);
   - builds the inFakt payload and verifies the line sum **equals the order total exactly**;
   - creates the invoice in inFakt and waits for its async task to settle;
   - reads the number inFakt assigned (numbering is entirely inFakt's job);
   - files the invoice to KSeF when required, and polls until KSeF assigns a number;
   - emits `infakt.invoice.issued` so other plugins can react.
3. Anything that needs a human lands in `needs_review`, with a reason, on the
   **Invoicing** page in the admin dashboard.

Each step persists its result before the next one starts, and the next step is derived
from which columns are still null. A crash at any instant resumes exactly where it
stopped on the following tick.

## The legal context

- **KSeF (Krajowy System e-Faktur)** is Poland's mandatory national e-invoicing system.
  Since **April 2026**, an invoice issued to a buyer identified by a NIP - a B2B invoice
  - must be filed there. Penalties for failing to file start in **January 2027**.
- A **consumer** invoice (no NIP) is outside the system.
- That shape is why `ksef.mode` defaults to `nip-only` and is not a boolean, and why
  `ksef.requireActive` defaults to on in production: a store whose KSeF integration has
  lapsed looks identical to a store with no B2B orders, and silence there is a legal
  exposure rather than a failed sync.

This plugin is not legal advice. It automates a filing obligation; confirming that
obligation applies to your business, and that your invoices are correct, remains yours.

## Install

```bash
npm install @zanreal/medusa-infakt
```

Register it in `medusa-config.ts`:

```ts
import { defineConfig, loadEnv } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "development", process.cwd());

module.exports = defineConfig({
  // ...
  plugins: [
    {
      resolve: "@zanreal/medusa-infakt",
      options: {
        // The plugin's enable switch. Unset (or point this at an env var that is
        // not set) and the plugin boots inert, with one line in the boot log.
        apiKey: process.env.INFAKT_API_KEY,
        environment: "production",
        // Optional. Leave it unset to invoice every order the pipeline sees.
        // Set it when installing onto a store with a back catalogue this plugin
        // should not touch - orders placed before it are skipped.
        // startDate: "2026-08-01",
        currency: "PLN",
        taxSymbol: "23",
        ksef: { mode: "nip-only", requireActive: true },
      },
    },
  ],
});
```

Then generate and run the migration in the consuming app, as with any other module:

```bash
npx medusa db:migrate
```

### Testing against inFakt

inFakt's sandbox (`api.sandbox-infakt.pl`) has been unreliable, so **testing against a
real inFakt trial account is the more dependable path.** If you do:

- Set `ksef: { mode: "never" }` so nothing is filed to the live KSeF while you are
  experimenting. It is the only setting this plugin has that intentionally breaks the
  legal obligation, and it exists for exactly this.
- Remember that every successful create is a real invoice in that account's numbering
  series. There is no dry-run mode.

## Options

Passed via `medusa-config.ts` `plugins[].options`. The single object cascades to every
module the plugin registers (there is one: `infakt`).

| Option               | Type                                   | Default              | Notes                                                                                                                                          |
| -------------------- | -------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`             | `string`                               | -                    | **The enable switch.** inFakt API key, sent as `X-inFakt-ApiKey`. Absent or blank leaves the plugin inert; see below. Read it from an env var. |
| `environment`        | `"production" \| "sandbox"`            | `"production"`       | See the sandbox note above.                                                                                                                    |
| `startDate`          | `string`                               | -                    | **Optional**, strict `YYYY-MM-DD`. Orders placed before it are skipped. Absent means no floor. See below.                                      |
| `currency`           | `string`                               | `"PLN"`              | Orders in any other currency are skipped with a reason.                                                                                        |
| `taxSymbol`          | `string`                               | `"23"`               | inFakt VAT rate symbol applied to every line.                                                                                                  |
| `triggerEvent`       | `"payment.captured" \| "order.placed"` | `"payment.captured"` | Which event queues an order. Medusa has no `order.paid` event.                                                                                 |
| `ksef.mode`          | `"nip-only" \| "all" \| "never"`       | `"nip-only"`         | Who gets filed. `never` is for development only.                                                                                               |
| `ksef.requireActive` | `boolean`                              | `true` in production | Verify the account's KSeF integration and refuse to run when it is not active.                                                                 |
| `ksef.decide`        | `(input) => boolean`                   | -                    | Per-invoice predicate. Overrides `mode` entirely, including `never`.                                                                           |
| `nipExtractor`       | `(order) => string \| undefined`       | see below            | Where to find the buyer's NIP.                                                                                                                 |
| `emitIssuedEvent`    | `boolean`                              | `true`               | Emit `infakt.invoice.issued` once an invoice is issued.                                                                                        |
| `timeoutMs`          | `number`                               | `60000`              | Per-request timeout for inFakt calls.                                                                                                          |

Every option is validated in the module loader, so a misconfiguration is a boot failure
with a precise message rather than an opaque 401 or 422 in the middle of a customer's
checkout.

### Enablement: `apiKey` is the only switch

The plugin should simply work when it is configured and do nothing when it is not.
That is `apiKey`'s entire job: absent or blank, the plugin boots inert - no order is
ever enqueued or invoiced - with one clear line in the boot log and in the admin UI.
Set it, and the plugin is fully active. There is no separate enable flag; unwiring
the credential is the supported way to turn this integration off.

This is the one option that does not throw when it is missing. Every other option,
including `startDate`, fails loudly at boot when it is malformed.

### `startDate` is optional, not an enable switch

Leave it unset and every order the pipeline otherwise sees is invoiced, subject to
every other gate (fully paid, right currency, not canceled, not already invoiced
outside this pipeline - see below). There is no back-catalogue risk in leaving it
unset on a brand-new store: it is a floor for stores that already have order
history this plugin should not touch, not a precondition for the plugin to run.

Set it to add that floor. It must be exactly `YYYY-MM-DD` and a real calendar date -
a value that is present but malformed still fails loudly at boot rather than being
read as "unset", because a typo here must not silently turn into "invoice
everything". The parse has to round-trip: `Date.parse("2026-02-30")` succeeds by
rolling over to March 2nd, which would make a fat-fingered floor silently mean a
different day than it reads as.

## Environment variables

| Variable             | Default       | Effect                            |
| -------------------- | ------------- | --------------------------------- |
| `INFAKT_WORKER_CRON` | `*/5 * * * *` | Cron schedule for the worker job. |

**Why the cron is not an option.** Medusa evaluates a scheduled job's `config.schedule`
at plugin-load time, before the DI container - and therefore this plugin's options -
exists. There is no supported way for a static `config` export to read a resolved
module's options, so this one setting has to be an environment variable. It is the only
one.

## How an order becomes an invoice

```
payment.captured  ->  subscriber  ->  InfaktInvoice row (status: pending)
                                             |
                        worker tick (every 5 min, single-flighted)
                                             |
                        gates: not backfilled, startDate, currency, canceled, fully paid
                                             |
                        submit_started_at  ->  POST /async/invoices.json
                                             |
                        task_reference     ->  poll until 201 + invoice_uuid
                                             |
                        invoice_number     ->  GET /invoices/{uuid}.json
                                             |
                        ksef_sent_at       ->  POST .../send_to_ksef.json   (when required)
                                             |
                        ksef_number        ->  poll until "success"
                                             |
                        event_emitted_at   ->  emit infakt.invoice.issued
                                             |
                                          done
```

### The trigger only enqueues

`payment.captured` fires once **per capture**, and an order can be captured in parts
(several payment collections, a partial capture, a split payment). Invoicing on the
first capture would issue an invoice for the full order total against a partial payment.

So the subscriber's only job is to create the ledger row. Every consequential decision
belongs to the worker, which is idempotent, restartable, and re-reads live state on
every tick. A deferred order needs no second event; the next tick picks it up.

Duplicate delivery is harmless (`order_id` is unique, so a second enqueue is a no-op).
A **missed** event is recoverable through `POST /admin/infakt/enqueue`, since Medusa's
event delivery is at-most-once.

### Runs are single-flighted

The worker takes an atomic claim - one `UPDATE ... WHERE ... RETURNING` against the run
state row - and holds it for the whole run. Zero returned rows means the claim was
refused; nothing is inferred.

That is not bookkeeping. Two overlapping runs reading the same due row would both pass
the crash-window check, both write `submit_started_at`, and both POST a create: two real
numbered invoices for one order.

A claim older than ten minutes is treated as a crashed process and taken over, so a dead
run can never wedge invoicing permanently. Releases are conditional on the claim token,
so a taken-over run cannot clear its successor's lock.

## The crash window, and why the create is never retried

`submit_started_at` is written to the database **before** the create call. On resume, a
row with that marker set but **no** `task_reference` means the create may already have
reached inFakt.

Such a row goes to `needs_review` and **the create is never retried automatically.**
That is the one failure mode this design refuses to guess about: inFakt has no
idempotency key, so a retried create can issue a second real numbered invoice, and the
customer receives two invoices for one order.

Resolving it is a human decision with exactly two outcomes, both on the Invoicing page:

- **Link invoice** - there is a stray invoice in inFakt. Paste its uuid; the row adopts
  it and continues from the KSeF step. No new invoice is created.
- **No invoice in inFakt** - you checked and there is none. Confirm explicitly, and the
  create is allowed to run again.

The **Retry** button is not rendered at all for these rows, and the server refuses a
retry on them independently.

Every other failure retries with backoff (base 10 minutes, doubling, capped at 6 hours,
8 attempts), because every other failure is either idempotent or observable. HTTP
`400/403/404/405/409/422` go straight to `needs_review` - retrying an identical request
against those cannot succeed. `429` and `5xx` are deliberately not in that set.

Waiting is not failing: a deferral (inFakt still processing, KSeF still processing, the
order not yet fully paid) does **not** consume an attempt. An order that sits unpaid for
a week still has its full retry budget when the money lands.

## The total-match guard

The sum of the invoice lines **must equal the order total, grosz for grosz**, or the
build fails and the row goes to `needs_review`.

An invoice is a legal statement of what the buyer paid. One that states a different
number is worse than no invoice at all, because correcting it needs a formal corrective
invoice. So a discount, gift card, credit line or fee adjustment this plugin does not
model gets a human's attention rather than being silently absorbed into a line.

Practically:

- Every amount is converted to integer minor units exactly **once**. Rounding per unit
  and again after multiplying is how a line total drifts one grosz from what was charged.
- The mapper reads each line's `item.total` (tax-inclusive, post-discount), not
  `unit_price * quantity`. The latter is pre-discount and would fail this guard on every
  promoted order.
- A missing order total is refused outright: there is nothing to verify against, and
  trusting the line sum blindly is exactly what this guard exists to prevent.

Shipping becomes one line per method that costs anything, labelled
`Dostawa - {method name}`. Free methods produce no line.

## Orders backfilled from a legacy system

A store migrating off an older invoicing system typically ports its order history
into Medusa with the invoice it already issued recorded on the order itself, not in
this plugin's ledger: `order.metadata.invoice_number` (and usually
`metadata.invoice_source`, naming where it came from).

The worker treats a non-empty `invoice_number` in that metadata as a fact, not a
suggestion. Before any other check runs, an order carrying one is skipped with
`skip_reason: "already invoiced outside the pipeline"`, and nothing is ever
submitted to inFakt for it. This is a build-time gate, so it holds no matter which
path put the row in the queue - an `order.placed` trigger firing at import time, or
an operator manually queuing it through `POST /admin/infakt/enqueue`.

Two structural facts make this a narrower problem than it first sounds:

- **A backfilled order has no Medusa payment**, so `payment.captured` never fires
  for it. A store on the default trigger never enqueues these orders at all - the
  metadata guard above is the safety net for `order.placed`-triggered stores and
  for the manual recovery endpoint, not the first line of defense.
- **The reconciliation engine only touches rows already in this plugin's ledger.**
  `lib/invoicing/matching.ts` exists to adopt a stray inFakt invoice onto an
  existing `infakt_invoice` row - it is not wired to a route yet (see
  [Roadmap](#roadmap)) - and even once it is, it will never create a row for an
  order the pipeline has not already enqueued. It cannot import history on its own.

## Where the buyer's NIP comes from

Medusa core has no field for a business buyer's tax id, so every storefront puts it
somewhere different. The default extractor tries, in order:

1. `order.metadata.nip`
2. `order.billing_address.metadata.nip`
3. a NIP parsed out of `order.billing_address.company`

It also accepts `tax_id`, `taxId`, `vat_id` and `vatId` as metadata keys. Override it
entirely with the `nipExtractor` option rather than reshaping your orders:

```ts
options: {
  nipExtractor: (order) => order.metadata?.company_tax_id as string | undefined,
}
```

Two deliberate restrictions:

- **The shipping address is never consulted.** A company shipping address on a consumer
  order is common - delivery to an office - and reading it would file that consumer's
  invoice to KSeF under their employer's NIP.
- **Parsing from `company` is strict.** The field must contain exactly one ten-digit
  candidate and it must pass the NIP checksum. Otherwise a phone number or a KRS number
  in the wrong field would turn a consumer invoice into a B2B one filed under a
  stranger's number.

A NIP that normalizes to ten digits but fails its checksum is still used. inFakt, and
ultimately KSeF, is the authority on whether a number is acceptable; refusing here would
park a legally required document over a check this plugin is not the arbiter of.

## KSeF

### Modes

| `ksef.mode`          | Behaviour                                                           |
| -------------------- | ------------------------------------------------------------------- |
| `nip-only` (default) | A buyer with a NIP is filed. A consumer is not. What the law wants. |
| `all`                | Every invoice is filed, including consumer ones.                    |
| `never`              | Nothing is filed. **Development and testing only.**                 |

`ksef.decide` overrides the mode entirely, including `never`. An operator who wrote a
predicate has made a more specific statement than the mode does; the recorded reason says
which of the two answered, so the override is visible in the audit trail.

The decision is **frozen onto the row** at build time, with its reason, in
`ksef_required` and `ksef_decision_reason`. Re-deriving it from live config on a later
tick would let a mid-flight `ksef.mode` change reclassify an invoice that has already
been issued.

### `requireActive`

With `ksef.requireActive` on (the default in production), the worker verifies the inFakt
account's KSeF integration via `GET /ksef/integration.json` and **fails the whole run
loudly** when it is not active - a clear error in the log and a red run state in the
admin UI.

Letting the rows accumulate instead would be worse. An inactive integration makes every
B2B submit fail with a 422, which is non-retryable, so every company invoice would
quietly park itself for a human while a legal deadline passed. A red run state is
something an operator notices; a growing queue is not.

The check runs at most hourly, and immediately when the integration is known to be
inactive, so fixing it in inFakt takes effect on the next tick. **Re-check KSeF
integration** on the Invoicing page forces it right away.

A failed _check_ is recorded as an error, never as `active: false`. "We could not reach
inFakt" and "your integration has lapsed" call for completely different responses.

## Operator runbook: needs_review

Open **Invoicing** in the admin dashboard. It opens on the `needs_review` filter.

Read the **Detail** column first - it carries the reason, PII-free, and it usually names
the fix.

| What it says                                                      | What happened                                                                  | What to do                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| _a previous inFakt create attempt may have gone through..._       | The process died between the create being sent and its reference being stored. | Look for an invoice for that order in inFakt. Found one: **Link invoice** with its uuid. None: **No invoice in inFakt**, confirm. |
| _line total N does not match order total M_                       | The order has a discount, credit line or fee this plugin does not model.       | Decide what the invoice should say. Invoice it manually in inFakt and **Link invoice**, or **Skip** with a reason.                |
| _buyer address is incomplete (missing: ...)_                      | The billing address lacks a field inFakt requires.                             | Fix the order's billing address, then **Retry**.                                                                                  |
| _buyer tax id does not normalize to a 10-digit NIP (N digits...)_ | The captured tax id is not a Polish NIP - often a foreign VAT id.              | Correct or remove the tax id on the order, then **Retry**. Removing it makes the order a consumer invoice, outside KSeF.          |
| _buyer has a NIP but no company name_                             | A B2B invoice needs both.                                                      | Add the company name to the billing address, then **Retry**.                                                                      |
| _inFakt rejected the invoice: ..._                                | inFakt's validation refused the payload; its own message follows.              | Fix what it names, then **Retry**. Nothing was issued.                                                                            |
| _KSeF rejected the invoice: ..._                                  | The invoice exists in inFakt but KSeF refused it. The description is KSeF's.   | Fix it in inFakt, then **Retry** - the row resumes at the KSeF step and does not re-create the invoice.                           |
| _is the KSeF integration active on the inFakt account?_           | The submit was refused and no KSeF status could be read.                       | Fix the integration in inFakt, **Re-check KSeF integration**, then **Retry**.                                                     |
| _the order was canceled after its invoice was issued_             | The invoice is real and the order is not.                                      | Issue a corrective invoice in inFakt. This plugin will not do it for you. Then **Skip** with a reason.                            |
| _the order is no longer fully paid after its invoice was issued_  | The payment was reversed after the fact.                                       | Same as above: correct in inFakt, then **Skip** with a reason.                                                                    |
| _the order behind this invoice no longer exists_                  | The order was hard-deleted.                                                    | **Skip** with a reason.                                                                                                           |

Two rules that hold regardless of the reason:

1. **Retry never creates a duplicate.** It is refused on exactly the rows where it could.
2. **Nothing in this UI can withdraw an issued invoice.** A document that exists in inFakt
   can only be undone by a corrective invoice, which is a legal act. `Skip` closes the
   ledger row; it does not touch inFakt.

An order the pipeline never heard about (an event lost while the bus was down, or an order
placed before the plugin was installed) can be queued with
`POST /admin/infakt/enqueue { "order_id": "..." }`. It is safe: the worker still applies
every gate.

## Cross-plugin event

Once an invoice is issued, the plugin emits:

```ts
{
  name: "infakt.invoice.issued",
  data: {
    order_id: string,
    invoice_uuid: string,
    invoice_number: string | null,
    ksef_number: string | null,
    pdf_available: true,
  }
}
```

Any plugin can subscribe - for example, to fetch the PDF and attach it to a marketplace
order. There is no hard dependency in either direction, and no consumer is required.

Fetch the PDF through the module service:

```ts
const infakt = container.resolve("infakt");
const pdf = await infakt.apiClient.getInvoicePdf(invoice_uuid);
```

Note that downloading the PDF flips the invoice's status to `printed` on the inFakt side.
That is how inFakt records that the document left the system, not a bug.

`event_emitted_at` is persisted, so a crash between the invoice landing and the row
completing cannot emit twice - a consumer attaching a PDF would otherwise attach it
twice. An emission failure never blocks the invoice: the legal document already exists,
and refusing to complete the row over a message-bus hiccup would leave a correctly-issued
invoice looking broken.

## Admin API

All routes live under `/admin` and use Medusa's default admin authentication.

| Route                        | Method | Purpose                                                                 |
| ---------------------------- | ------ | ----------------------------------------------------------------------- |
| `/admin/infakt`              | GET    | Configuration, worker run state, per-status counts, crash-window count. |
| `/admin/infakt/invoices`     | GET    | The ledger. `?status=`, `?limit=`, `?offset=`.                          |
| `/admin/infakt/invoices/:id` | POST   | `{ action: "retry" \| "adopt" \| "clear" \| "skip", ... }`.             |
| `/admin/infakt/ksef-check`   | POST   | Re-verify the KSeF integration now.                                     |
| `/admin/infakt/enqueue`      | POST   | `{ order_id }`. Queue an order the trigger missed.                      |

A refused action answers **409** with the reason: the request was well-formed, and it is
the row's state that makes it impossible. The reason is written for the person reading it.

The API key never appears in any response - the configuration is filtered through a
public-options shape that does not carry it.

## Privacy

- **No buyer data is stored by this plugin.** The `infakt_invoice` table holds order ids,
  inFakt identifiers, timestamps, statuses and reasons. No name, no address, no email, no
  NIP. `is_company` is the only fact about the buyer, and it is a boolean.
- **No buyer data appears in an error.** Failure reasons are rendered in the admin UI and
  persisted to `last_error`, so they carry field names, digit counts and amounts only.
  A rejected tax id is reported as _"(9 digits found)"_, never as the value. There are
  tests asserting the NIP, name, street and company name never appear in one.
- Buyer data is read from the order transiently to build the payload, and is never logged.
- The invoice itself lives in inFakt, which is its system of record.

## Testing

```bash
pnpm test          # vitest run
pnpm check         # tsc --noEmit for both the backend and the admin bundle
pnpm lint          # medusa lint src
pnpm build         # medusa plugin:build
```

Everything runs without a database or network access. What each area covers:

| File                                     | Covers                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/infakt/client.test.ts`              | The API client: auth header, base URLs, response mapping, error shapes, the KSeF-2.0 fallback.                                                   |
| `lib/invoicing/builder.test.ts`          | The payload rules, the total-match guard, and that no rejection reason leaks buyer data.                                                         |
| `lib/invoicing/money.test.ts`            | Minor-unit conversion, Warsaw calendar dates, strict date validation.                                                                            |
| `lib/options.test.ts`                    | Every boot failure, `apiKey` as the enable switch, `startDate` as an optional floor, and that the public option shape never carries the API key. |
| `lib/invoicing/nip.test.ts`              | Normalization, the checksum, the `company`-field heuristic, the extractor's precedence.                                                          |
| `lib/invoicing/ksef.test.ts`             | Mode decisions, the custom predicate's override, `requireActive` defaults.                                                                       |
| `lib/invoicing/paid.test.ts`             | The fully-paid gate: partial captures, refunds, canceled collections, float drift.                                                               |
| `lib/invoicing/state-machine.test.ts`    | Backoff, outcome classification, and `nextStep` - including the crash-window refusal.                                                            |
| `lib/invoicing/pipeline.test.ts`         | The steps in order, resume from every intermediate state, the KSeF 422 ambiguity, and the backfilled-order guard.                                |
| `lib/invoicing/operator-actions.test.ts` | What an operator may and may not do to a parked row.                                                                                             |
| `lib/invoicing/matching.test.ts`         | The reconciliation engine's three stages and its date tiebreak.                                                                                  |
| `lib/invoicing/order-mapper.test.ts`     | Medusa DTO mapping, plus mapper-and-builder end to end.                                                                                          |
| `modules/infakt/service.test.ts`         | The claim/release SQL, idempotent enqueue, and what the KSeF check persists.                                                                     |
| `workflows/`, `api/`, `subscribers/`     | Compensation capture, route contracts, and that the trigger only ever enqueues.                                                                  |

`service.test.ts` builds a `this` on top of `InfaktModuleService.prototype` with the
generated CRUD methods and the raw-SQL escape hatch stubbed, so the real method bodies
run against a fake table.

What unit tests **cannot** cover is whether Postgres really serializes the conditional
claim UPDATE. That was verified by hand against Postgres 16 while landing the migration:
two concurrent claimers - the second blocks on the row lock, re-evaluates its predicate
against the committed row and reports 0 rows affected; a claim older than the window is
taken over; the taken-over run's token-conditional release matches nothing while the new
holder's succeeds. An automated version needs a live Postgres via
`moduleIntegrationTestRunner` - see [Roadmap](#roadmap).

## Generating a migration

Requires a local Postgres. Always generate rather than hand-writing, so
`.snapshot-medusa-infakt.json` stays authoritative. CI enforces this: it regenerates
against a throwaway Postgres and fails on a dirty tree.

**Use this exact container name and port.** They are recorded here so the next person
reuses them rather than hunting for a free port - two people independently picking "the
next free port" is how one of them ends up deleting the other's container.

```bash
# 1. A throwaway Postgres, named after this repo, on this repo's port.
docker run -d --name infakt-migrate-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=medusa_infakt_dev \
  -p 55433:5432 postgres:16-alpine

# 2. .env (not committed; see .env.template)
cat > .env <<'ENV'
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_HOST=localhost
DB_PORT=55433
DB_NAME=medusa_infakt_dev
DATABASE_URL=postgres://postgres:postgres@localhost:55433/medusa_infakt_dev
ENV

# 3. Generate, then commit BOTH the migration and the updated snapshot.
pnpm exec medusa plugin:db:generate

# 4. Tear down in the same sitting, BY NAME. Never by `--filter publish=<port>`:
#    that matches whatever else happens to be on the port, including another
#    repo's container.
docker rm -f infakt-migrate-pg && rm -f .env
```

Create and destroy it within the same task, so it never outlives the migration it was
for.

## Roadmap

- **Corrective invoices** (`faktura korygująca`). Today a canceled or refunded order that
  was already invoiced goes to `needs_review` and a human issues the correction in inFakt.
  inFakt has an API for it; the hard part is deciding what a correction should say, which
  is a business rule and not obviously ours to guess.
- **A webhook instead of polling.** inFakt's KSeF docs recommend a webhook for the final
  processing status, which would remove most of the `status.json` polling.
- **Integration tests against a live Postgres** via `@medusajs/test-utils`
  (`moduleIntegrationTestRunner`) for the one property unit tests cannot assert: that two
  concurrent claims really do serialize on the row lock.
- **The reconciliation tool wired to a route.** The matching engine
  (`lib/invoicing/matching.ts`) is complete and tested - identity, exact total, position
  overlap, with a day-precision date tiebreak - but nothing calls it yet. It is what will
  let an operator adopt a whole back catalogue of existing inFakt invoices, and it will
  never auto-apply an ambiguous match.
- **Invoice PDF storage** through Medusa's File Module, so a merchant is not dependent on
  inFakt's retention.
- **A `pl` translation** for the admin surface.

## License

MIT. See [LICENSE](./LICENSE).
