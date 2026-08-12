import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260812172755 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "infakt_settings" ("id" text not null, "invoicing_paused" boolean not null default true, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "infakt_settings_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_infakt_settings_deleted_at" ON "infakt_settings" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "infakt_settings" cascade;`);
  }

}
