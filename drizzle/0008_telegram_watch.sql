-- 0008 telegram watch: "alert me when the next lots of this room open" (Telegram /watch, bot only, FEATURE_TELEGRAM). One row per profile and show:
-- how many more lot alerts to send (NULL = every lot until the show ends). It only says who gets a message; nothing here places or signs a bid.
-- Purely additive and idempotent (every statement is IF NOT EXISTS or guarded), like 0004: nothing is dropped, renamed or retyped, and a running
-- deployment of the previous code does not know this table, so it keeps working while and after this runs.
CREATE TABLE IF NOT EXISTS "telegram_watches" (
	"profile_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"remaining" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_watches_profile_id_show_id_pk" PRIMARY KEY("profile_id","show_id")
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "telegram_watches" ADD CONSTRAINT "telegram_watches_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "telegram_watches" ADD CONSTRAINT "telegram_watches_show_id_shows_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."shows"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_watches_show_idx" ON "telegram_watches" USING btree ("show_id");
