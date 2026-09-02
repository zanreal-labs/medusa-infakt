import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Record whether the paid marking this plugin sends to inFakt actually took.
 *
 * Both columns are nullable with no default and no backfill. Existing rows stay
 * null, which reads as "never marked" - and since only rows the worker is still
 * advancing are ever marked, no historical invoice is re-touched in inFakt as a
 * result of this migration.
 */
export class Migration20260902120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "paid_marked_at" timestamptz null;`,
    );
    this.addSql(
      `alter table if exists "infakt_invoice" add column if not exists "paid_confirmed_at" timestamptz null;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "paid_confirmed_at";`);
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "paid_marked_at";`);
  }
}
