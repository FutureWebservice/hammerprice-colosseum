-- 0009 waiting list: an email left on the landing page (POST /api/waitlist), one row per address (unique on lower(email)).
-- Purely additive and idempotent (IF NOT EXISTS): nothing is dropped, renamed or retyped, and a running deployment of the previous code does not know
-- this table, so it keeps working while and after this runs.
CREATE TABLE IF NOT EXISTS "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"locale" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "waitlist_email_lower_idx" ON "waitlist" USING btree (lower("email"));
