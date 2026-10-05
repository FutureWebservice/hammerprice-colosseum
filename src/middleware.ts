import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './lib/i18n';

const intlMiddleware = createMiddleware(routing);

/**
 * Internationalisation for pages, CORS preflight for /api, and a pass-through for /api (which does its own
 * auth: src/lib/auth). Nothing else lives here: no user-agent filter, no rate limiter (lib/http/ratelimit.ts
 * is database-backed), no sessions (a cookie is checked where it is used, not at the edge).
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/api') || pathname.match(/^\/[a-z]{2}(-[A-Z]{2})?\/api/)) {
    // CORS preflight. Every caller of these routes is same-origin (the room, the landing page) and
    // same-origin requests never preflight, so the only origin allowed is this deployment's own. The
    // session cookie is never sent cross-origin (SameSite=Lax, and no Allow-Credentials here).
    if (request.method === 'OPTIONS') {
      let origin = request.nextUrl.origin;
      try { origin = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? origin).origin; } catch { /* keep the request's own origin */ }
      return new NextResponse(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }

    // No i18n for API routes
    return NextResponse.next();
  }

  // Apply internationalization middleware to non-API routes
  return intlMiddleware(request);
}

/**
 * Configure which paths this middleware will run on
 */
export const config = {
  matcher: [
    // Apply to all routes except static assets, common file extensions, and /hp.
    // /hp is the public landing page: no locale, no session, no wallet - it must render
    // for a visitor who has none of those, so it deliberately bypasses this middleware.
    // sitemap.xml, opengraph-image and icon are the same story as favicon.ico/robots.txt
    // above them: generated metadata routes with no locale of their own - without this they
    // get treated as an unprefixed page path and 307 to /en/sitemap.xml, which doesn't exist.
    '/((?!_next|static|hp|favicon.ico|robots.txt|sitemap.xml|opengraph-image|icon|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.svg|.*\\.webp|.*\\.ico|.*\\.ttf|.*\\.woff|.*\\.woff2|.*\\.webmanifest|.*\\.txt|.*\\.json|\\.well-known).*)'
  ],
};
