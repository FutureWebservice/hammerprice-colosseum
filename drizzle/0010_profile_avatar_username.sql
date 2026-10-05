-- 0010 profile page: an uploaded avatar (a small image kept in the row), and a username that is unique without regard to case.
-- `profiles.username` and `profiles.bio` already exist (0000) and nothing wrote them; the account page now does.
-- Purely additive and idempotent (every statement is IF NOT EXISTS or guarded): nothing is dropped, renamed or retyped, and a running
-- deployment of the previous code does not know these columns, so it keeps working while and after this runs.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "avatar" bytea;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "avatar_type" text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "profiles" ADD CONSTRAINT "profiles_avatar_check" CHECK (("avatar" IS NULL AND "avatar_type" IS NULL) OR ("avatar" IS NOT NULL AND "avatar_type" IS NOT NULL AND "avatar_type" IN ('image/png', 'image/jpeg', 'image/webp') AND octet_length("avatar") <= 204800)); EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_username_lower_idx" ON "profiles" USING btree (lower("username"));
