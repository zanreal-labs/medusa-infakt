import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260813105554 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "infakt_settings" add column if not exists "api_key_ciphertext" text null, add column if not exists "currency" text null, add column if not exists "environment" text check ("environment" in ('production', 'sandbox')) null, add column if not exists "ksef_mode" text check ("ksef_mode" in ('nip-only', 'all', 'never')) null, add column if not exists "trigger_event" text check ("trigger_event" in ('payment.captured', 'order.placed')) null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "infakt_settings" drop column if exists "api_key_ciphertext", drop column if exists "currency", drop column if exists "environment", drop column if exists "ksef_mode", drop column if exists "trigger_event";`);
  }

}
