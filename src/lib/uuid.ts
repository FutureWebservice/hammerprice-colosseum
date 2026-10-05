/** Postgres' `uuid` columns throw on a malformed string rather than just not matching - every
 *  lookup by id (a raw URL path segment) needs this guard first, or a bad id (typo, scraper
 *  probe) 500s instead of falling through to the normal "not found" path. Pure and DB-free
 *  so it is usable, and testable, from any caller without pulling in `@/db`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
  return UUID_RE.test(id);
}
