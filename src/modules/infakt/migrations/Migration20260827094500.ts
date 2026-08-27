import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Record the VAT regime each invoice was issued under.
 *
 * Every column is nullable with no default and no backfill. Existing rows stay
 * null, which the pipeline reads as "domestic" - so a store upgrading to this
 * version keeps invoicing Polish orders exactly as before, and no historical
 * invoice is retroactively reinterpreted.
 */
export class Migration20260827094500 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "vat_regime" text null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "vat_country" text null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "vat_rate" text null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "vat_base_minor" numeric null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "raw_vat_base_minor" jsonb null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "vat_currency" text null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add constraint "infakt_invoice_vat_regime_check" check ("vat_regime" is null or "vat_regime" in ('domestic', 'reverse_charge', 'eu_b2c_domestic_rate', 'oss', 'export_services'));`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "infakt_invoice" drop constraint if exists "infakt_invoice_vat_regime_check";`,
    );
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "vat_currency";`);
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "raw_vat_base_minor";`);
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "vat_base_minor";`);
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "vat_rate";`);
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "vat_country";`);
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "vat_regime";`);
  }
}
