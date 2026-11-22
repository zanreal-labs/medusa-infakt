# Changelog

All notable changes to `@zanreal/medusa-infakt` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

Read the entries as an accountant would. Every line here describes something that changes
which document gets issued, when it gets filed, or what an operator has to do about it.

## [Unreleased]

Nothing yet.

## [2.0.0] - 2026-11-22

### Changed

- **BREAKING: requires Medusa 2.23.0.** Built and tested against Medusa 2.23.0 (was 2.18.0 in
  1.0.1): the `@medusajs/*` peers pin 2.23.0 (`@medusajs/ui` 4.3.0), so npm will not install this
  release next to an older Medusa - stay on 1.0.1 there. Medusa 2.23 requires Node.js 22.22 or
  newer, and so does this package now.
- **React 19 admin toolchain.** The admin widgets are built with React 19, Vite 8 and the i18n
  majors the 2.23.0 dashboard ships (`react-i18next` 18, `i18next` 27); the `react-i18next` peer
  is now `^18.0.1`. Admin extensions share the host's i18n instance, so these follow the
  dashboard rather than moving on their own. Two widget call sites were adjusted to the stricter
  i18next 27 `t()` typings; rendering is unchanged.
- Dependency updates now come from Renovate, run weekly by the `zanek-ai` app from
  `.github/workflows/renovate.yml`, instead of Dependabot.

## [1.0.1] - 2026-09-08

### Fixed

- The install line no longer pins a version number. It named `0.1.0` explicitly,
  so it went stale the moment a release shipped and contradicted the version npm
  resolves. The `npm install` command below it was always version-less and correct.

## [1.0.0] - 2026-09-08

### Added

- **Cross-border VAT.** Reverse charge, export of services and the EU B2C distance-selling
  threshold are resolved before the document is built, so an intra-EU B2B sale is not
  issued with domestic VAT on it.
- **KSeF status from the webhook.** The filing outcome is learned from inFakt's webhook
  instead of a polling timer. This is the one transition in the plugin with a statutory
  deadline attached, and a timer is the wrong instrument for it.
- **Payment reconciliation against `paid_date`.** Settlement is decided from inFakt's
  `paid_date` rather than from its payment status field, which is not durable.
- **Re-arming.** An invoice parked only because the customer address was missing is
  re-armed automatically once the address arrives, instead of waiting for an operator.

### Fixed

- The company-name gate is applied everywhere free text can reach the document, not only
  on the first path found. Mangled company names no longer reach an issued invoice.
- Marking an invoice paid is confirmed rather than fired and forgotten, and it can no
  longer hold an otherwise finished invoice out of `done`.
- Waiting for data is no longer classified as a review, and the sweep stops waiting on it.
- Errors render through `describeError` instead of the `[object Object]` idiom.

### Changed

- README states the package is on npm and how to install it from the registry. The
  previous text still told readers it was unpublished.

## [0.1.0] - 2026-08-26

First public release. MIT, published from CI with npm provenance.

### Added

- **Zero-dependency inFakt API v3 client.**
- **Durable state machine** for invoice issuance. inFakt has no idempotency key, so a
  naive retry issues a second legally numbered document that can only be withdrawn by a
  correction. Every classification, gate and persisted transition in this plugin exists
  because of that single fact.
- **Issue on payment**: the invoice is issued the moment payment lands, gated on a real
  paid signal, reading Medusa `BigNumber` amounts through one shared parser.
- **KSeF filing**, with `ksef.mode` defaulting to `nip-only` and `ksef.requireActive` on
  in production - a store whose KSeF integration has lapsed otherwise looks exactly like a
  store with no B2B orders.
- **Adoption of historical invoices** already present in inFakt, matched on person, date
  and amount, never on line item names.
- **Operator surface** in the admin: invoices needing review on the order page, an admin
  notification when one appears, a real invoice PDF link, and labelling for adopted
  documents.
- **Settings page** with currency, KSeF mode, trigger event, environment and API key
  editable live; `apiKey` is the plugin's only enable switch, with a pause toggle and an
  environment force-off.
- **Order timeline entry** recording issuance.
- **Admin UI in English and Polish.**

[Unreleased]: https://github.com/zanreal-labs/medusa-infakt/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/zanreal-labs/medusa-infakt/compare/v1.0.1...v2.0.0
[1.0.1]: https://github.com/zanreal-labs/medusa-infakt/releases/tag/v1.0.1
[1.0.0]: https://github.com/zanreal-labs/medusa-infakt/releases/tag/v1.0.0
[0.1.0]: https://github.com/zanreal-labs/medusa-infakt/releases/tag/v0.1.0
