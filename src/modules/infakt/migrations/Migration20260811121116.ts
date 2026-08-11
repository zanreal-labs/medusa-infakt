import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260811121116 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "infakt_invoice" drop constraint if exists "infakt_invoice_order_id_unique";`);
    this.addSql(`create table if not exists "infakt_invoice" ("id" text not null, "adopted_at" timestamptz null, "attempts" integer not null default 0, "completed_at" timestamptz null, "event_emitted_at" timestamptz null, "invoice_number" text null, "invoice_uuid" text null, "is_company" boolean not null default false, "ksef_decision_reason" text null, "ksef_number" text null, "ksef_required" boolean null, "ksef_sent_at" timestamptz null, "ksef_status" text null, "last_error" text null, "next_attempt_at" timestamptz null, "order_id" text not null, "skip_reason" text null, "status" text check ("status" in ('pending', 'processing', 'done', 'skipped', 'needs_review')) not null default 'pending', "submit_started_at" timestamptz null, "task_reference" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "infakt_invoice_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_infakt_invoice_order_id_unique" ON "infakt_invoice" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_infakt_invoice_deleted_at" ON "infakt_invoice" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_infakt_invoice_status_next_attempt_at" ON "infakt_invoice" ("status", "next_attempt_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_infakt_invoice_status" ON "infakt_invoice" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "infakt_run_state" ("id" text not null, "claim_token" text null, "claimed_at" timestamptz null, "ksef_active" boolean null, "ksef_checked_at" timestamptz null, "ksef_error" text null, "last_error" text null, "last_run_at" timestamptz null, "processed" integer not null default 0, "status" text check ("status" in ('idle', 'running', 'ok', 'error')) not null default 'idle', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "infakt_run_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_infakt_run_state_deleted_at" ON "infakt_run_state" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "infakt_invoice" cascade;`);

    this.addSql(`drop table if exists "infakt_run_state" cascade;`);
  }

}
