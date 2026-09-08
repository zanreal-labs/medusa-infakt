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

[Unreleased]: https://github.com/zanreal-labs/medusa-infakt/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/zanreal-labs/medusa-infakt/releases/tag/v1.0.0
[0.1.0]: https://github.com/zanreal-labs/medusa-infakt/releases/tag/v0.1.0
