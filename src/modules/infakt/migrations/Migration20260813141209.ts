import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260813141209 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "infakt_invoice" add column if not exists "adopted_evidence" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "infakt_invoice" drop column if exists "adopted_evidence";`);
  }

}
