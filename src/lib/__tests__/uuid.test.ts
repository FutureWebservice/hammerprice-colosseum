import { describe, it, expect } from 'vitest';
import { isValidUuid } from '../uuid';

// getShowWithLots (src/lib/catalogue.ts) guards on isValidUuid before querying, so a
// malformed `id` path segment (GET /api/shows/[id]) now falls through to the route's
// existing "not found" 404 instead of Postgres throwing on an invalid uuid literal and
// 500ing. catalogue.ts itself isn't imported here because it pulls in `@/db`, which this
// repo's test setup doesn't resolve (no other test in this suite imports it either) - the
// regression is covered at the pure-guard level instead.
describe('isValidUuid', () => {
  it('accepts a well-formed uuid', () => {
    expect(isValidUuid('de5a9c8b-6105-43e5-9875-604642f2234e')).toBe(true);
  });

  it('rejects a malformed id', () => {
    for (const bad of ['not-a-uuid', '', '12345', 'de5a9c8b-6105-43e5-9875-604642f2234e; DROP TABLE shows;']) {
      expect(isValidUuid(bad), bad).toBe(false);
    }
  });
});
