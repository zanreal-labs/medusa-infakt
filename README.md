# @zanreal/medusa-infakt

Polish invoicing for Medusa v2. Issues an [inFakt](https://www.infakt.pl/) invoice for
every paid order and files the B2B ones to **KSeF**, Poland's national e-invoicing
system.

Full documentation, in English and Polish, is published at
<https://zanreal.com/docs/oss/medusa-infakt> and authored in [`docs/`](./docs).

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
- [Adopting invoices that already exist in inFakt](#adopting-invoices-that-already-exist-in-infakt)
- [Where the buyer's NIP comes from](#where-the-buyers-nip-comes-from)
- [KSeF](#ksef)
- [Operator runbook: needs_review](#operator-runbook-needs_review)
- [Cross-border VAT](#cross-border-vat)
- [Cross-plugin event](#cross-plugin-event)
- [Admin API](#admin-api)
- [Privacy](#privacy)
- [Testing](#testing)
- [Generating a migration](#generating-a-migration)
- [Roadmap](#roadmap)
- [Releasing](#releasing)
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

This package is not on npm yet. It installs as a git dependency, pinned to a commit:

```jsonc
// package.json
{
  "dependencies": {
    "@zanreal/medusa-infakt": "github:zanreal-labs/medusa-infakt#1c7a50c551f59658156d6f0b024996946cd71417"
  }
}
```

Pin to the commit you tested against. There is no published tag yet, so `#main` would move under
you on the next push to the repository.

The package compiles itself on install - `prepare` runs `medusa plugin:build`, which turns the
checked-out source into the `.medusa/server` output its `exports` point at. pnpm 10 and newer
refuse to run that script for a dependency they do not already trust, so a fresh install needs it
allowed once, in your project's `pnpm-workspace.yaml`:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  "@zanreal/medusa-infakt@https://codeload.github.com/zanreal-labs/medusa-infakt/tar.gz/1c7a50c551f59658156d6f0b024996946cd71417": true
```

The key is the exact tarball URL pnpm resolves the pinned commit to, which is why it carries the
same SHA as the dependency line above - update both together when you move the pin.

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
        // Optional. Required only before an operator can save an apiKey
        // override from Settings -> inFakt - see "Live overrides" below.
        settingsEncryptionKey: process.env.INFAKT_SETTINGS_ENCRYPTION_KEY,
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

| Option                  | Type                                   | Default              | Notes                                                                                                                                          |
| ----------------------- | -------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                | `string`                               | -                    | **The enable switch.** inFakt API key, sent as `X-inFakt-ApiKey`. Absent or blank leaves the plugin inert; see below. Read it from an env var. |
| `environment`           | `"production" \| "sandbox"`            | `"production"`       | See the sandbox note above.                                                                                                                    |
| `startDate`             | `string`                               | -                    | **Optional**, strict `YYYY-MM-DD`. Orders placed before it are skipped. Absent means no floor. See below.                                      |
| `currency`              | `string`                               | `"PLN"`              | The domestic currency. Orders in any other currency are skipped unless `crossBorder` opts them in.                                             |
| `taxSymbol`             | `string`                               | `"23"`               | inFakt VAT rate symbol for **domestic** lines. Cross-border lines are decided by the VAT regime, not by this.                                  |
| `crossBorder.enabled`   | `boolean`                              | `false`              | **Master switch for all cross-border VAT.** Off means the plugin behaves exactly as it did before this feature existed. See below.             |
| `crossBorder.currencies`| `string[]`                             | `[]`                 | Extra currencies to invoice, e.g. `["EUR"]`. Only consulted when `crossBorder.enabled`.                                                        |
| `crossBorder.viesFallback` | `"review" \| "consumer"`             | `"review"`           | What an unreachable VIES means. `review` parks the order; `consumer` charges destination VAT. Never zero-rates either way.                     |
| `crossBorder.viesBaseUrl` | `string`                             | EU REST endpoint     | Override the VIES endpoint.                                                                                                                    |
| `crossBorder.viesTimeoutMs` | `number`                           | `8000`               | VIES request timeout.                                                                                                                          |
| `crossBorder.emailInvoice` | `boolean`                           | `true`               | Email cross-border invoices to the buyer. A foreign buyer cannot collect one from KSeF.                                                        |
| `oss.enabled`           | `boolean`                              | `false`              | Switches the OSS code path on. Requires `crossBorder.enabled`. **Read the OSS warning below before enabling.**                                 |
| `oss.registered`        | `boolean`                              | `false`              | Whether the company actually holds a union OSS registration (VIU-R). Without it, EU consumers get the domestic rate below the threshold.       |
| `oss.thresholds`        | `Record<string, number>`               | EUR 10 000 / PLN 42 000 | Per-currency intra-EU B2C limits, minor units. A currency with no entry parks the order rather than being excluded from the count.          |
| `oss.alertRatio`        | `number`                               | `0.8`                | Warn at this fraction of the threshold, so there is time to register before orders start parking.                                              |
| `oss.serviceType`       | `"electronic" \| "broadcasting" \| "telecommunications"` | `"electronic"` | inFakt's service taxonomy. Software and license keys are `electronic`.                                     |
| `triggerEvent`          | `"payment.captured" \| "order.placed"` | `"payment.captured"` | Which event queues an order. Medusa has no `order.paid` event.                                                                                 |
| `ksef.mode`             | `"nip-only" \| "all" \| "never"`       | `"nip-only"`         | Who gets filed. `never` is for development only.                                                                                               |
| `ksef.requireActive`    | `boolean`                              | `true` in production | Verify the account's KSeF integration and refuse to run when it is not active.                                                                 |
| `ksef.decide`           | `(input) => boolean`                   | -                    | Per-invoice predicate. Overrides `mode` entirely, including `never`.                                                                           |
| `nipExtractor`          | `(order) => string \| undefined`       | see below            | Where to find the buyer's NIP.                                                                                                                 |
| `emitIssuedEvent`       | `boolean`                              | `true`               | Emit `infakt.invoice.issued` once an invoice is issued.                                                                                        |
| `timeoutMs`             | `number`                               | `60000`              | Per-request timeout for inFakt calls.                                                                                                          |
| `settingsEncryptionKey` | `string`                               | -                    | Encrypts an admin-set `apiKey` override at rest. Required before one can be saved from Settings -> inFakt; see below. Read it from an env var. |

## Cross-border VAT

**Off by default.** Without `crossBorder.enabled`, this plugin invoices the domestic
currency only, puts `taxSymbol` on every line, and skips everything else - exactly as
it did before cross-border support existed. Nothing below applies until you opt in.

### The decision tree

Every order gets exactly one regime, decided in `src/lib/invoicing/regime.ts`:

| Destination | Buyer | Regime | Rate | On the invoice | VAT-UE? |
| --- | --- | --- | --- | --- | --- |
| Poland | anyone | `domestic` | `taxSymbol` (23) | nothing extra | no |
| Another member state | business, VAT id **confirmed by VIES** | `reverse_charge` | `np` | "Odwrotne obciazenie / Reverse charge" + basis | **yes** |
| Another member state | consumer, **below** the threshold, not OSS-registered | `eu_b2c_domestic_rate` | `taxSymbol` (23) | nothing extra | no |
| Another member state | consumer, **above** the threshold, not OSS-registered | **blocked** | - | - | - |
| Another member state | consumer, OSS-**registered** | `oss` | destination country's rate | OSS document | no |
| Outside the EU (incl. GB) | business | `export_services` | `np` | out-of-scope annotation | **no** |
| Outside the EU | consumer | **blocked** | - | - | - |

The EU-consumer row is the one to read twice. **Today this store is not registered
for OSS**, so an EU consumer is charged Polish 23% - not the destination rate, and
emphatically not zero. That is correct *because* of the intra-EU B2C threshold, and
it stops being correct the moment the threshold is crossed.

Anything the tree cannot answer becomes `needs_review` with a reason, never a guess.
A late invoice is a support ticket; a wrong one is a liability.

### Three things that are easy to get wrong

**`np` is not `0`.** inFakt's `0` is a Polish zero *rate*; `np` ("nie podlega") means the
supply is outside the scope of Polish VAT. Cross-border services are `np`. There is no
reverse-charge rate symbol any more - inFakt's `oo` expired on 2019-11-01 with the
domestic reverse charge - so the legal annotation is carried as invoice text.

**"Not Poland" does not mean "no VAT".** An EU consumer is never zero-rated. Below the
threshold they owe Polish VAT; above it (or once we register for OSS) they owe their
own country's. Zero is wrong in both directions.

**A reverse charge and an export of services are not the same thing.** They carry the
same `np`, but a reverse charge belongs in the VAT-UE summary and an export must never
appear there. They are separate regimes for that reason alone.

### B2B vs B2C, and what VIES has to do with it

A VAT id that is merely *present* is not one that is *valid*. A buyer is treated as a
business only when all three hold: an id is supplied, VIES confirms it, and its country
matches the billing country. Anything else is a consumer or a park.

VIES has three outcomes, not two, and the third one matters:

- **valid** - reverse charge.
- **invalid** - the buyer is a consumer; destination VAT applies.
- **unavailable** - VIES or a member state's node is down. By default the order **parks**.

Parking is the default because both automatic answers are wrong in different directions:
zero-rating rests on evidence we do not have, and charging destination VAT silently
overrides a business customer's own statement about who they are. Set
`crossBorder.viesFallback: "consumer"` to never delay a paid order - that over-collects,
which a corrective invoice can fix, rather than under-collecting, which it cannot.
Neither setting can produce a reverse charge on an unconfirmed number.

Validate **at checkout** and cache the result on the order (`order.metadata.vies`), so a
routine VIES outage cannot strand an order the customer has already paid for. The reader
accepts `true`/`false`, `"valid"`, or `{ status, checkedAt, consultationNumber }`.

### Products must be classified

The place of supply of a *service* follows the customer; the place of supply of *goods*
follows the goods. So each product needs a marker - `metadata.tax_supply` set to
`"service"` or `"goods"`, on the line, the variant or the product.

Unmarked products are **not** assumed to be services. They keep invoicing normally
domestically (a Polish sale is 23% either way) and park on the first foreign order,
naming the product. That means no catalogue backfill is needed before shipping this,
and no silent wrong answer either.

### The intra-EU B2C threshold

A supplier established in one member state may keep taxing intra-EU B2C sales at its
own rate while the combined net value of those sales stays at or below **EUR 10 000**,
measured across the **current and previous** calendar year (art. 28k ust. 2 ustawy o
VAT; Directive 2006/112 art. 59c). Above it, the place of supply moves to each
consumer's country and OSS registration is required.

Three properties of that rule shape the implementation:

1. **Crossing flips the treatment mid-year, on the transaction that crosses it** - not
   at a period boundary. So the counter is consulted *before* an invoice is issued,
   and the pending sale is included in the total before comparing.
2. **There is no safe fallback above the line.** Below it, 23% is right because of the
   threshold; above it the identical 23% is wrong. So a crossing order is **parked**,
   never issued at either rate.
3. **Registration is not instantaneous.** An alert fires at `oss.alertRatio` (default
   **80%**) through the same admin feed as a parked invoice, so the owner has room to
   file VIU-R before anything starts blocking. The block at 100% is a backstop, not
   the notification mechanism.

**Where the counter lives.** It is derived from the invoices themselves: every
`eu_b2c_domestic_rate` row stores `vat_base_minor` and `vat_currency`, and the counter
sums those rows. There is no separate ledger to drift out of sync, and an accountant
can audit the figure by listing the same rows they would anyway. Only EU B2C counts -
reverse-charge B2B and non-EU sales are outside the threshold entirely.

**The currency approximation, stated plainly.** The limit is EUR 10 000 with a
statutory PLN equivalent of 42 000 PLN. Sales may be in either. Doing this exactly
needs NBP rates per transaction date, which this plugin does not have and will not
invent. Instead it tracks a running total per currency, expresses each as a fraction
of that currency's own limit, and sums the fractions. A currency with no configured
limit does **not** get skipped - it parks the order, because silently not counting a
currency is the one failure mode the whole mechanism exists to prevent.

### OSS: read this before enabling

`oss.enabled` and `oss.registered` are separate flags, and both default to false.
`enabled` switches the code path on; `registered` asserts that destination-rate
invoicing is actually lawful for this company. Setting `enabled` without `registered`
changes nothing about which regime an EU consumer gets.

Two further reasons OSS is gated:

**1. Checkout has to charge the destination rate first.** This plugin decides the rate
from inFakt's own `/moss_vat_rates.json`, but the money was already taken by Medusa at
whatever rate its tax module was configured with. If those disagree, no correct invoice
exists - it would either misstate the tax or misstate the total. The builder therefore
cross-checks and parks on a mismatch. If your non-Polish tax regions have no rate
configured, **every OSS order will park** with a reason saying so. That is intended.

**2. OSS invoices have their own numbering series.** They are a separate document family
at inFakt. Downstream, the invoice number is the reference license keys are bought and
recovered under, and it is not unique across families - a series that restarts at 1 can
collide with an existing VAT invoice number and cause one order's keys to be delivered
against another's. A collision guard (`src/lib/invoicing/invoice-number.ts`) refuses to
announce a number another order already holds, but the numbering inFakt actually assigns
to OSS invoices has not been confirmed against a real document.

### Delivery is not filing

A Polish B2B buyer collects their invoice from KSeF. A foreign buyer cannot - they have
no access to it - so filing a cross-border invoice is not the same as delivering it. The
pipeline emails cross-border invoices via inFakt, best-effort, controlled by
`crossBorder.emailInvoice`. Foreign tax ids are still filed to KSeF: `ksef.mode:
"nip-only"` keys on *any* tax id, not only a Polish NIP.

### Enabling a currency also arms key delivery

Today a non-domestic order is skipped, which means no invoice, no
`infakt.invoice.issued`, and therefore no downstream license-key purchase or delivery.
Adding a currency to `crossBorder.currencies` turns all of that on for those orders.

### Why `currency` and `taxSymbol` have defaults at all

Both describe inFakt, not a preference of whoever wrote this plugin. inFakt is a Polish invoicing
and bookkeeping service: an account belongs to a Polish registered business, the books it keeps are
Polish books, and its ledger currency is PLN, so defaulting to anything else would describe no real
inFakt account. `"23"` is likewise inFakt's own symbol for the Polish basic VAT rate, from the same
vocabulary as `"8"`, `"5"`, `"0"`, `"zw"` and `"np"` - a value from the integrated service, not a
commercial choice.

They are kept deliberately, and the reasoning is repeated next to the constants in
`src/lib/options.ts` and locked by a test, so that a later sweep for shipped defaults does not
delete them by mistake. A store that invoices in another currency or at another rate sets these two
options explicitly, and everything else keeps working.

`apiKey`, `environment`, `currency`, `triggerEvent` and `ksef.mode` can all be overridden
live from **Settings -> inFakt** without a redeploy - see
[Live overrides](#live-overrides-currency-ksefmode-triggerevent-environment-apikey) below.
Every other option in this table stays `medusa-config.ts`-only.

Every option is validated in the module loader, so a misconfiguration is a boot failure
with a precise message rather than an opaque 401 or 422 in the middle of a customer's
checkout.

### Enablement: `apiKey`, the pause switch, and the environment force-off

The plugin should simply work when it is configured and do nothing when it is not.
`apiKey` is that switch at the config level: absent or blank, the plugin boots
inert - no order is ever enqueued or invoiced - with one clear line in the boot
log and in the admin UI. Set it, and the plugin is fully active.

This is the one option that does not throw when it is missing. Every other option,
including `startDate`, fails loudly at boot when it is malformed.

That is not the whole story, though, because `apiKey` alone is not a safe signal to
start invoicing. A store cutting over from a legacy invoicing system has `apiKey`
configured from day one - the admin UI needs it to render at all - but invoicing has
to stay off until an operator deliberately turns it on. Two more layers sit on top of
`apiKey`, checked fresh on every subscriber invocation and every worker tick (not
just at boot, because both of these CAN change without a restart):

1. **The pause switch** (`invoicing_paused`, in the `InfaktSettings` table). Editable
   live from **Settings -> inFakt** in the admin. **Defaults to `true`** on a fresh
   install - a store that already has `apiKey` configured does not start issuing
   invoices the moment it boots. An operator resumes it explicitly.
2. **`INFAKT_INVOICING_DISABLED`** (environment variable; `1`, `true` or `yes`,
   case-insensitively). A hard, operator-controlled force-off that cannot be
   released from inside the admin - it overrides everything, including an admin
   having already unpaused invoicing. Meant for a deploy-time emergency brake, not
   day-to-day operation.

The combined answer - `effectiveEnabled = apiKeyPresent && !invoicingPaused &&
!envForceDisabled` - is what the subscriber and the worker actually check. `GET
/admin/infakt/settings` reports it, along with which of the three is responsible
(`reason`: `active`, `no_api_key`, `paused`, or `env_force_disabled`).

### Live overrides: `currency`, `ksef.mode`, `triggerEvent`, `environment`, `apiKey`

`invoicing_paused` is not the only field this plugin lets an operator change without a
redeploy. **Settings -> inFakt** can also override `currency`, `ksef.mode`, `triggerEvent`,
`environment` and `apiKey` - every one of these plugin options, except `startDate`,
`taxSymbol`, `ksef.requireActive`, `ksef.decide`, `nipExtractor`, `emitIssuedEvent` and
`timeoutMs`, which stay `medusa-config.ts`-only.

Each override is a nullable column on the same `InfaktSettings` singleton row as the pause
switch. Null means "not overridden - use the `medusa-config.ts` value", so **shipping this
onto an existing install changes nothing** until an operator opens the Settings page and
saves a field on purpose. Once saved, the override wins outright and is read fresh on every
subscriber invocation and every worker tick - see `mergeEffectiveOptions` in
`src/lib/invoicing/effective-config.ts`.

`POST /admin/infakt/settings` accepts any subset of `invoicing_paused`, `currency`,
`ksef_mode`, `trigger_event`, `environment` and `api_key` - only the fields present in the
body are written. `GET /admin/infakt/settings` reports both `settings` (the raw override,
null where unset) and `effective` (the merged, currently-in-effect value).

**`apiKey` is handled differently from the other four.** It is a credential, not
configuration, so an override is encrypted (AES-256-GCM, via Node's built-in `crypto`, no
new dependency) with the plugin's `settingsEncryptionKey` option before it is ever written
to the database, and it is never read back by any admin route - `GET
/admin/infakt/settings` reports only `api_key_configured` (true from either source) and
`api_key_override_configured` (true when an override specifically is saved). Setting
`settingsEncryptionKey` is required before an `apiKey` override can be saved at all;
`POST /admin/infakt/settings { "api_key": "..." }` answers 400 with a message naming the
option otherwise. `POST /admin/infakt/settings { "api_key": "" }` clears a saved override
and falls back to the boot-time `apiKey`. If `settingsEncryptionKey` is ever rotated or
removed, a previously saved override can no longer be decrypted; the plugin falls back to
the boot-time `apiKey` silently at every runtime decision point (never a crash), and
`api_key_override_configured` staying `true` while invoicing behaves as if it were `false`
is the signal that this happened.

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

| Variable                    | Default       | Effect                                                                 |
| --------------------------- | ------------- | ---------------------------------------------------------------------- |
| `INFAKT_WORKER_CRON`        | `*/5 * * * *` | Cron schedule for the worker job. A reconciliation interval, not a latency budget: a paid order is invoiced immediately by the `payment.captured` subscriber, and this tick retries whatever that could not finish. |
| `INFAKT_INVOICING_DISABLED` | unset         | `1`/`true`/`yes` force-disables invoicing, overriding everything else. |

**Why the cron is not an option.** Medusa evaluates a scheduled job's `config.schedule`
at plugin-load time, before the DI container - and therefore this plugin's options -
exists. There is no supported way for a static `config` export to read a resolved
module's options, so this one setting has to be an environment variable.

**Why the force-off is an environment variable too, and not a plugin option.** Unlike
the pause switch, this one is deliberately NOT reachable from the admin - an operator
flips it at deploy time (or during an incident) without touching the database, and it
cannot be undone by anyone clicking around in the admin. See
[Enablement](#enablement-apikey-the-pause-switch-and-the-environment-force-off) above.

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
                        ksef_sent_at       ->  POST /ksef2/documents/{uuid}/send.json (when required)
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

Resolving it is a human decision with exactly two outcomes, both on the order's detail page:

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
- **Nothing about that guard reaches inFakt.** It reads the order's own metadata and
  refuses, which is a decision about this pipeline. Recovering the invoice itself is
  a separate, deliberate act; see the next section.

An export that produced this metadata can also be WRONG. An order whose invoice
number was lost in the export looks, to the guard above, like an order that was
never invoiced - while the invoice sits in inFakt, correctly issued and filed. That
is what the reconciliation below exists to recover, and it recovers it from inFakt,
not from whatever produced the export.

## Adopting invoices that already exist in inFakt

`GET /admin/infakt/reconcile`, and the **Adopt existing invoices** panel on the
plugin's settings page.

For a store whose history was invoiced somewhere else: the documents are real,
numbered and filed, and only this ledger does not know about them. The
reconciliation reads invoices from the **inFakt API** and matches them to Medusa
orders on **order data alone**. No other system is consulted, and none needs to
exist - not the legacy system that issued them, not the export that lost them.

### The rules, and why each one is there

Every rule below is a hard gate. There is no score, and no signal can make up for a
failing one.

| Gate                  | Rule                                                                                | Why                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Issue date**        | `invoice_date` within `tolerance_days` (default **7**, max 31) of the order's Warsaw calendar day. An undated invoice is dropped. | Keeps a repeat customer's later order from matching the earlier invoice for the same basket. Warsaw, because that is the day the invoice itself is dated. |
| **Buyer identity**    | B2B: exact normalized NIP. B2C: exact email OR exact normalized full name.           | The one signal that says these are the same person. Diacritics and NIP prefixes are normalized away first.                |
| **Gross total**       | Integer equality in grosze, no tolerance. Currency must agree when both state one. An order whose total cannot be read matches nothing and says so. | An amount that is close is an amount that is wrong. A one-grosz drift means it is a different document, and an unreadable total is never treated as 0. |
| **Uniqueness**        | Exactly one invoice may survive all three, unless the chronological pairing below settles it. | Two survivors is the duplicate-invoice case, which is precisely what a human has to look at.                               |
| **Not already taken** | The invoice must not already be recorded on another ledger row, by uuid or by number. | One document settles one order. The number check matters because an imported row may carry only the number.               |
| **The order's own claim** | When `order.metadata.invoice_number` names an invoice, the match must BE that one. | An order that names an invoice and matches a different one by amount and buyer is a warning, not a discovery.            |

**What an invoice calls its lines is never compared.** Not as a gate, not as a
confidence grade, not as a tiebreak. The two systems name a line their own way for
perfectly legitimate documents - a catalogue title here, a shortened trade name or a
single aggregate line there - so a name check can only ever report a correct match as
weaker than it is, and an operator then learns to ignore the grade. The signals are
the person, the date and the amount.

### Same-day duplicate orders, paired by chronology

One buyer, several orders on one day, all for the same amount, invoiced with several
documents that are equally identical: nothing but the order of events separates them,
and refusing every one of them helps nobody. So the orders are sorted by the moment
they were placed, the invoices by their number within their shared issue date, and the
two lists are paired one to one.

That is the ONLY place chronology decides anything here, and it is fenced in hard. It
engages only when the two sides are genuinely twins - same buyer, same Warsaw day, same
gross total, the very same set of candidate invoices, and those invoices agreeing on
issue date, amount and currency - and only when the counts on both sides are equal.
Everything else refuses the whole group and says so per order:

- **Counts differ** (three orders, two identical invoices): any two of the three could
  be the invoiced ones, so nothing is determined and nothing is paired.
- **A lone order facing several candidates**: there is no duplicate to pair against,
  so the other document belongs to something outside this scan.
- **The invoices are not twins** (different issue dates): something other than
  chronology separates them, and guessing by nearest date is what this refuses to do.
- **The numbers are not one readable sequence**: the sequence is derived, not assumed -
  every number must share one format and vary in exactly one digit position, which is
  then the counter. Two formats, two varying positions or a repeated counter refuse.
- **Two orders share a placement instant**, or one has none: they cannot be ordered.
- **An order outside the group also matches one of these invoices**: pairing could
  hand over a document that belongs elsewhere.

Any other multi-candidate case is **reported, never guessed**. `matching.ts` has a
nearest-date tiebreak for the crash-window flow, where a human is already looking at
one order and knows an invoice exists; it is deliberately not used here.

### The confidence grade

Every proposal is graded `high` or `medium`, and the grade is about what a human should
look at rather than whether the match is allowed - every gate above passed either way.

`high` when the buyer was identified by a **key** (a NIP or an email address) and the
invoice was issued **on the order's day or the day next to it**, or when the order
**names that invoice number itself**, which is the order's own claim rather than an
inference.

`medium` when the buyer was matched on a **full name** alone (two people can share
one), when the issue date sat **more than a day** from the order (still inside the
window the operator asked for, but no longer the obvious document), or when the
**chronological pairing** settled it, which is correct only if duplicate orders were
invoiced in the order they were placed.

How many invoices happened to be in the date window is recorded as evidence but does
**not** grade: candidates that lost on identity or amount lost on a hard gate, and
letting their number darken a survivor would mark every match in a busy week as weaker
than the same match in a quiet one.

### What it will not do

- **It will not touch an order that already has a ledger row.** Not re-match it, not
  update it, not report it. That is the idempotency guarantee, and it rests on the
  same unique `order_id` the enqueue path does: a re-run writes nothing.
- **It will not issue anything.** No invoice is created, nothing is sent to KSeF, and
  no `infakt.invoice.issued` event is emitted. An adopted row is written straight to
  `done`, and `listDueInvoices` never picks a `done` row up again.
- **It will not apply anything you did not ask for.** Both methods are a dry run
  unless the POST body carries BOTH `apply: true` and an explicit `order_ids` list,
  and the server re-derives each named order's match before writing - a plan that has
  gone stale between the preview and the click cannot be applied from the client's
  copy of it.

### What is recorded

An adopted row carries `adopted_at`, the invoice's uuid and number, `completed_at`
set to the day the document was issued, and `adopted_evidence`: the signal that
identified the buyer, the gross total, how far the issue date sat from the order, and
whether chronology had to tell same-day duplicates apart (`tie_breaker`, with the
order's place among them). Signal KINDS and numbers only - never an email or a name,
because this table holds no buyer data.

`ksef_required` is recorded too, decided from the tax code on the adopted document
exactly as `decideKsef` would have decided it. On a terminal adopted row it is an
audit fact, not an instruction: nothing acts on a `done` row, and the order widget
says "not tracked by this plugin" rather than claiming a filing is queued.

### Which inFakt endpoints it uses

- `GET /invoices.json` with `q[invoice_date_gteq]` / `q[invoice_date_lteq]`, paged
  100 at a time. The date range is the only server-side narrowing that helps:
  **inFakt has no filter for the gross total, and none for the buyer's email or
  name**, so those are applied here, after the page is read.
That list response carries every field the rules read - buyer, amount, currency, issue
date and number - so the reconciliation makes **no per-invoice detail call at all**. It
used to fetch `GET /invoices/{uuid}.json` for line positions; nothing reads those now.

It is a read. The reconciliation calls nothing that creates, sends or files.

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
account's KSeF integration via `GET /ksef2/integration.json` and **fails the whole run
loudly** when it is not active - a clear error in the log and a red run state in the
admin UI.

Letting the rows accumulate instead would be worse. An inactive integration makes every
B2B submit fail with a 422, which is non-retryable, so every company invoice would
quietly park itself for a human while a legal deadline passed. A red run state is
something an operator notices; a growing queue is not.

The check runs at most hourly, and immediately when the integration is known to be
inactive, so fixing it in inFakt takes effect on the next tick. **Re-check KSeF** on
**Settings -> inFakt** forces it right away.

A failed _check_ is recorded as an error, never as `active: false`. "We could not reach
inFakt" and "your integration has lapsed" call for completely different responses.

## Operator runbook: needs_review

A `needs_review` row raises a Medusa admin notification that deep-links to the order.
Open that order - the Invoicing widget on its detail page carries the reason, PII-free,
and usually names the fix, alongside the same operator actions listed below.

| What it says                                                      | What happened                                                                  | What to do                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| _a previous inFakt create attempt may have gone through..._       | The process died between the create being sent and its reference being stored. | Look for an invoice for that order in inFakt. Found one: **Link invoice** with its uuid. None: **No invoice in inFakt**, confirm. |
| _line total N does not match order total M_                       | The order has a discount, credit line or fee this plugin does not model.       | Decide what the invoice should say. Invoice it manually in inFakt and **Link invoice**, or **Skip** with a reason.                |
| _buyer address is incomplete (missing: ...)_                      | The billing address lacks a field inFakt requires.                             | Fix the order's billing address, then **Retry**.                                                                                  |
| _buyer tax id does not normalize to a 10-digit NIP (N digits...)_ | The captured tax id is not a Polish NIP - often a foreign VAT id.              | Correct or remove the tax id on the order, then **Retry**. Removing it makes the order a consumer invoice, outside KSeF.          |
| _...could not be confirmed against VIES..._                       | VIES, or that member state's node, was unreachable. Not a rejection.           | **Retry** once VIES is back. If this recurs, validate at checkout and cache on the order, or set `crossBorder.viesFallback`.      |
| _the VAT id was issued by X but the billing country is Y_         | The two pieces of evidence disagree about where the customer belongs.          | Correct whichever is wrong on the order, then **Retry**. Do not guess - the place of supply follows the customer.                |
| _order to X contains products with no VAT classification (...)_   | A product has no `metadata.tax_supply`. Only blocks cross-border orders.       | Tag the named product `"service"` or `"goods"`, then **Retry**.                                                                   |
| _order to X mixes services and goods_                             | One invoice would need two different VAT treatments.                          | Split the order. The plugin will not pick one treatment for both.                                                                |
| _sale to a consumer in X, outside the EU_                         | Union OSS does not cover it and the non-union scheme is unavailable to us.     | A registration decision, not a retry. Escalate. GB in particular needs UK VAT registration from the first sale.                  |
| _the order was charged no VAT, but an OSS sale needs..._          | Checkout did not apply the destination rate - the tax region is unconfigured.  | Configure the destination tax region in Medusa. Until then no correct OSS invoice exists for that order.                          |
| _this sale crosses the intra-EU B2C threshold..._                 | EUR 10 000 of EU consumer sales reached without an OSS registration.          | **Register for OSS (VIU-R).** Not a retry: no correct invoice exists for this order until registration is in place.               |
| _no intra-EU B2C threshold is configured for X_                   | An EU consumer sale in a currency with no configured limit.                    | Add the currency to `oss.thresholds`, or stop selling to EU consumers in it.                                                      |
| _invoice number N is already recorded against order X_            | Two orders hold the same invoice number, across inFakt document families.      | **Do not retry blindly.** Downstream license keys are keyed on this number; resolve which invoice belongs to which order first.   |
| _buyer has a NIP but no company name_                             | A B2B invoice needs both.                                                      | Add the company name to the billing address, then **Retry**.                                                                      |
| _inFakt rejected the invoice: ..._                                | inFakt's validation refused the payload; its own message follows.              | Fix what it names, then **Retry**. Nothing was issued.                                                                            |
| _KSeF rejected the invoice: ..._                                  | The invoice exists in inFakt but KSeF refused it. The description is KSeF's.   | Fix it in inFakt, then **Retry** - the row resumes at the KSeF step and does not re-create the invoice.                           |
| _is the KSeF integration active on the inFakt account?_           | The submit was refused and no KSeF status could be read.                       | Fix the integration in inFakt, **Re-check KSeF** on Settings -> inFakt, then **Retry**.                                           |
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

| Route                        | Method    | Purpose                                                                 |
| ---------------------------- | --------- | ----------------------------------------------------------------------- |
| `/admin/infakt`              | GET       | Configuration, worker run state, per-status counts, crash-window count. |
| `/admin/infakt/invoices`     | GET       | The ledger. `?status=`, `?limit=`, `?offset=`.                          |
| `/admin/infakt/invoices/:id` | POST      | `{ action: "retry" \| "adopt" \| "clear" \| "skip", ... }`.             |
| `/admin/infakt/ksef-check`   | POST      | Re-verify the KSeF integration now.                                     |
| `/admin/infakt/enqueue`      | POST      | `{ order_id }`. Queue an order the trigger missed.                      |
| `/admin/infakt/reconcile`    | GET, POST | Adopt invoices that already exist in inFakt. Dry run unless asked otherwise. |
| `/admin/infakt/settings`     | GET, POST | The effective-enablement picture and every live override. See below.    |

`GET /admin/infakt/settings` reports `settings` (the raw override, null where unset) and
`effective` (the merged, currently-in-effect value) alongside the enablement fields.
`POST /admin/infakt/settings` accepts any subset of `invoicing_paused`, `currency`,
`ksef_mode`, `trigger_event`, `environment` and `api_key` - only the fields present are
written; see
[Live overrides](#live-overrides-currency-ksefmode-triggerevent-environment-apikey) for the
full contract, and note that `api_key` has its own 400 when `settingsEncryptionKey` is not
configured.

`/admin/infakt/reconcile` takes `from` and `to` (both `YYYY-MM-DD`, required) and an
optional `tolerance_days`. `GET` always reports; `POST` reports too, unless the body
carries BOTH `apply: true` and a non-empty `order_ids` - applying every match at once
is deliberately not possible. See
[Adopting invoices that already exist in inFakt](#adopting-invoices-that-already-exist-in-infakt).

A refused action answers **409** with the reason: the request was well-formed, and it is
the row's state that makes it impossible. The reason is written for the person reading it.

Every route in this table answers with a normal 200 (or a 409 refusal) in every plugin
state, including fully disabled, unconfigured, paused, or with an empty ledger - none of
them ever throw into the admin UI over that. The two that touch inFakt directly
(`ksef-check`, and `invoices/:id` for an `adopt`) guard on the EFFECTIVE `apiKey` being
configured (boot option or admin override) before reaching the client, and answer with the
same shape they would on success rather than surfacing the getter's throw.

The API key never appears in any response, encrypted or otherwise - the configuration is
filtered through a public-options shape that does not carry it, and the settings route
reports only whether one is configured.

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
- **The one credential this plugin persists is encrypted.** An admin-set `apiKey` override
  (see [Live overrides](#live-overrides-currency-ksefmode-triggerevent-environment-apikey))
  is the only secret this plugin ever writes to the database, and it is encrypted at rest
  with `settingsEncryptionKey` before that write happens. No admin route ever reads it back.

## Testing

```bash
pnpm test          # vitest run
pnpm check         # tsc --noEmit for both the backend and the admin bundle
pnpm lint          # medusa lint src
pnpm build         # medusa plugin:build
```

Everything runs without a database or network access. What each area covers:

| File                                     | Covers                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/infakt/client.test.ts`              | The API client: auth header, base URLs, response mapping, error shapes, the KSeF-2.0 fallback.                                                                      |
| `lib/invoicing/builder.test.ts`          | The payload rules, the total-match guard, and that no rejection reason leaks buyer data.                                                                            |
| `lib/invoicing/money.test.ts`            | Minor-unit conversion, Warsaw calendar dates, strict date validation.                                                                                               |
| `lib/options.test.ts`                    | Every boot failure, `apiKey` as the enable switch, `startDate` as an optional floor, and that the public option shape never carries the API key.                    |
| `lib/invoicing/nip.test.ts`              | Normalization, the checksum, the `company`-field heuristic, the extractor's precedence.                                                                             |
| `lib/invoicing/ksef.test.ts`             | Mode decisions, the custom predicate's override, `requireActive` defaults.                                                                                          |
| `lib/invoicing/paid.test.ts`             | The fully-paid gate: partial captures, refunds, canceled collections, float drift.                                                                                  |
| `lib/invoicing/state-machine.test.ts`    | Backoff, outcome classification, and `nextStep` - including the crash-window refusal.                                                                               |
| `lib/invoicing/pipeline.test.ts`         | The steps in order, resume from every intermediate state, the KSeF 422 ambiguity, and the backfilled-order guard.                                                   |
| `lib/invoicing/operator-actions.test.ts` | What an operator may and may not do to a parked row.                                                                                                                |
| `lib/invoicing/matching.test.ts`         | The matching engine's three stages and its date tiebreak.                                                                                                          |
| `lib/invoicing/reconcile.test.ts`        | The adoption rules: the date window, what is refused, one invoice per order, and that the evidence carries no buyer data.                                            |
| `workflows/adopt-invoices.test.ts`       | That an already-ledgered order is left alone, that the written row is terminal, and that compensation removes exactly what it created.                               |
| `lib/invoicing/order-mapper.test.ts`     | Medusa DTO mapping, plus mapper-and-builder end to end.                                                                                                             |
| `modules/infakt/service.test.ts`         | The claim/release SQL, idempotent enqueue, what the KSeF check persists, the settings singleton, and every config-override read/write/encrypt path.                 |
| `lib/invoicing/enablement.test.ts`       | The three-source precedence (`apiKey`, pause switch, env force-off) and the env flag's accepted spellings.                                                          |
| `jobs/infakt-invoicing.test.ts`          | The enablement gate: the worker never claims a run when not effectively enabled, checked fresh every tick.                                                          |
| `workflows/set-invoicing-paused.test.ts` | The pause switch's write-and-compensate pair, including the round trip back to the original value.                                                                  |
| `workflows/update-infakt-config.test.ts` | The other five overrides' write-and-compensate pair, restoring the exact raw (still-encrypted) row on rollback, never a re-encrypted plaintext.                     |
| `lib/crypto/secret-box.test.ts`          | AES-256-GCM round-trip, a wrong key, a corrupt payload, a tampered ciphertext - every one of them a throw, never garbage output.                                    |
| `lib/invoicing/effective-config.test.ts` | Merging overrides onto boot options field by field, and the `apiKey` override's decrypt-or-fall-back-silently behavior under every failure mode.                    |
| `workflows/`, `api/`, `subscribers/`     | Compensation capture, route contracts, that every admin route answers 200/409 rather than throwing when disabled or empty, and that the trigger only ever enqueues. |

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
- **Invoice PDF storage** through Medusa's File Module, so a merchant is not dependent on
  inFakt's retention.
- **A `pl` translation** for the admin surface.

## Releasing

Publishing happens only from
[`.github/workflows/release.yml`](./.github/workflows/release.yml), and there is
no second path. npm **provenance** is a signed statement about where a tarball
was built and from which commit, and only a cloud CI run holding an OIDC
identity can produce one. An `npm publish` from a laptop would put a version on
npm carrying no provenance, and a published version cannot be replaced
afterwards, only deprecated. `publishConfig.provenance` in `package.json` makes
that local publish fail rather than quietly succeed without it.

Nothing has been published yet. `@zanreal/medusa-infakt` is not on the registry,
so the pinned git dependency in [Install](#install) is still the only way to
consume it; the first GitHub Release is what changes that.

To cut a release:

1. Bump `version` in `package.json` on `main`.
2. Publish a GitHub Release whose tag is `v<version>`, exactly.

The workflow refuses to publish when the tag disagrees with `package.json`, or
when that version is already on the registry. A release marked as a prerelease
on GitHub publishes under the `next` dist-tag, so `npm install
@zanreal/medusa-infakt` never resolves to a release candidate.

Authentication is an `NPM_TOKEN` repository secret: a granular access token with
write permission on this package. npm's trusted publishing (OIDC, with nothing
stored in GitHub) cannot cover the *first* publish, because npmjs.com only
offers the trusted publisher form on a package that already exists. Once the
first version is up, add one under the package's settings on npmjs.com - GitHub
Actions, owner `zanreal-labs`, repository `medusa-infakt`, workflow
`release.yml`, environment `npm` - and then delete the `NPM_TOKEN` secret. The
workflow needs no edit for that: npm attempts the OIDC exchange first and falls
back to the token only when the exchange fails.

## License

MIT. See [LICENSE](./LICENSE).
