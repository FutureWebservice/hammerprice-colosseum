-- 0004 telegram: the tables of the optional Telegram notifications (FEATURE_TELEGRAM). Only a chat id, a language and opt-in switches are stored.
-- Purely additive and idempotent (every statement is IF NOT EXISTS or guarded), like 0003: nothing is dropped, renamed or retyped, and a
-- running deployment of the previous code does not know these tables, so it keeps working while and after this runs.
CREATE TABLE IF NOT EXISTS "telegram_link_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"prefs" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_links" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"prefs" jsonb NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_sent" (
	"profile_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "telegram_sent" ADD CONSTRAINT "telegram_sent_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_link_tokens_profile_idx" ON "telegram_link_tokens" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_link_tokens_expiry_idx" ON "telegram_link_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_links_chat_idx" ON "telegram_links" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_sent_once_idx" ON "telegram_sent" USING btree ("profile_id","kind","ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_sent_at_idx" ON "telegram_sent" USING btree ("sent_at");
