/** Local Postgres (dev, CI, the embedded test server) speaks plain TCP; every other host is Neon. */
export function isLocalDatabaseUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

/**
 * The startup check of DATABASE_URL: one clean Postgres URL or a clear error that names the variable and the kind of fault, never the value
 * (it holds the password). A production build once failed because the pasted value began with terminal escape sequences; the driver's own error
 * for that is an "Invalid URL" that says nothing about which variable or why. Control characters and whitespace are refused anywhere in it
 * (a trailing newline from a paste included), and so is anything that is not a postgres:// or postgresql:// URL with a host.
 */
export function assertDatabaseUrl(raw: string | undefined, name = 'DATABASE_URL'): string {
  if (!raw) throw new Error(`${name} is not set. Copy it from .env.local or the Neon dashboard.`);
  const bad = /[\u0000-\u001f\u007f-\u009f\s]/.exec(raw);
  if (bad) {
    throw new Error(`${name} contains a control character or whitespace (at position ${bad.index + 1} of ${raw.length}). Paste the connection string again as one clean line, without escape sequences, quotes or spaces; the value is not printed.`);
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} is not a valid URL. Expected postgres://user:password@host/database; the value is not printed.`); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error(`${name} must start with postgres:// or postgresql:// (found "${url.protocol}"); the value is not printed.`);
  if (!url.hostname) throw new Error(`${name} has no host. Expected postgres://user:password@host/database; the value is not printed.`);
  return raw;
}
