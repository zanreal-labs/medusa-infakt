import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * The settlement ledger: what inFakt's `paid_date` says, and when we last looked.
 *
 * Four nullable columns, no default and NO BACKFILL - which is the whole safety
 * argument for shipping this onto a live store. Every existing row stays null,
 * and null reads as "nobody has checked this invoice yet", not as "unsettled".
 * Nothing about how an existing store invoices changes, and no historical
 * document is reinterpreted; the reconciliation fills these in on its own
 * schedule, oldest-unchecked first.
 *
 * `settlement_paid_minor` is a Medusa big number, hence the two columns - the
 * numeric value and its `raw_` json companion - exactly as `vat_base_minor`.
 */
export class Migration20260903121500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "settled_at" timestamptz null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "settlement_checked_at" timestamptz null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "settlement_drift" text null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "settlement_paid_minor" numeric null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "raw_settlement_paid_minor" jsonb null;`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_infakt_invoice_settlement_checked_at" ON "infakt_invoice" ("settlement_checked_at") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_infakt_invoice_settlement_checked_at";`);
    this.addSql(
      `alter table if exists "infakt_invoice" drop column if exists "raw_settlement_paid_minor";`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" drop column if exists "settlement_paid_minor";`,
    );
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "settlement_drift";`);
    this.addSql(
      `alter table if exists "infakt_invoice" drop column if exists "settlement_checked_at";`,
    );
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "settled_at";`);
  }
}
