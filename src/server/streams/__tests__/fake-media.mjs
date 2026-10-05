/**
 * A fake MediaMTX for tests. One plain-http listener on loopback that answers the few calls the app makes: the control API
 * (`/v3/paths/get|kick/<path>`, key in X-API-Key), the manifest (`/<path>/index.m3u8`, for a path somebody is sending on) and the WHIP
 * signaling (`POST /<path>/whip`, Basic credential, `DELETE /<path>/whip/<uuid>`).
 *
 * It records every request (`seen`) so a test can assert what the server sent (the Authorization header) and what a browser must NOT
 * send (any request at all before the viewer's click). Nothing here is real: the SDP answer is a stub, so tests check the hand-over up to
 * the call, never a real WebRTC session.
 *
 *   const m = await startFakeMedia({ apiKey: 'k', publishUser: 'u', publishPass: 'p' });
 *   m.live.add('hp/abc');          // somebody is sending on this path
 *   m.url, m.port, m.seen, m.mode  // mode.api = 'ok' | 'down' | 'hang', mode.whip = 'ok' | 'redirect' | 'fail' | 'noLocation' | 'badAnswer'
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const MANIFEST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2.0,\nseg0.seg\n';

export async function startFakeMedia({ port = 0, apiKey = 'test-api-key', publishUser = 'test-user', publishPass = 'test-pass' } = {}) {
  const live = new Set();
  const sessions = new Map(); // uuid -> path
  const seen = [];
  const mode = { api: 'ok', whip: 'ok', hang: false };
  const expectedBasic = `Basic ${Buffer.from(`${publishUser}:${publishPass}`).toString('base64')}`;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization ?? null, apiKey: req.headers['x-api-key'] ?? null, contentType: req.headers['content-type'] ?? null, origin: req.headers.origin ?? null, body });
    const send = (status, headers = {}, text = '') => { res.writeHead(status, { 'Access-Control-Allow-Origin': req.headers.origin ?? '*', ...headers }); res.end(text); };
    if (mode.hang) return; // never answers: the caller's timeout decides
    if (req.method === 'OPTIONS') return send(204, { 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });

    // control API
    const api = /^\/v3\/paths\/(get|kick)\/(.+)$/.exec(url.pathname);
    if (api) {
      if (req.headers['x-api-key'] !== apiKey) return send(403);
      if (mode.api === 'down') return send(500, {}, 'secret upstream detail');
      if (mode.api === 'hang') return;
      const p = api[2];
      if (api[1] === 'kick') { live.delete(p); return send(live.has(p) ? 500 : 200, { 'Content-Type': 'application/json' }, '{}'); }
      return live.has(p) ? send(200, { 'Content-Type': 'application/json' }, JSON.stringify({ name: p, ready: true, source: { type: 'webRTCSession' } })) : send(404, {}, 'path not found');
    }

    // WHIP
    const whip = /^\/(.+?)\/whip(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
    if (whip) {
      const p = whip[1];
      if (req.headers.authorization !== expectedBasic) return send(401);
      if (req.method === 'POST') {
        if (mode.whip === 'fail') return send(500, {}, 'secret upstream detail');
        if (mode.whip === 'redirect') return send(302, { Location: `http://127.0.0.1:1/elsewhere` });
        const id = randomUUID();
        sessions.set(id, p);
        live.add(p);
        const answer = mode.whip === 'badAnswer' ? 'not sdp' : 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=fake\r\nt=0 0\r\n';
        return send(201, { 'Content-Type': 'application/sdp', ...(mode.whip === 'noLocation' ? {} : { Location: `/${p}/whip/${id}` }) }, answer);
      }
      if (req.method === 'DELETE') {
        const known = sessions.delete(whip[2] ?? '');
        if (known) live.delete(p);
        return send(known ? 200 : 404);
      }
      return send(405);
    }

    // HLS manifest: only for a path somebody is sending on
    const hls = /^\/(.+?)\/index\.m3u8$/.exec(url.pathname);
    if (hls && req.method === 'GET') {
      if (!live.has(hls[1])) return send(404);
      return send(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' }, MANIFEST);
    }
    return send(404);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  return {
    port: actual,
    host: '127.0.0.1',
    url: `http://127.0.0.1:${actual}`,
    live, sessions, seen, mode, apiKey, publishUser, publishPass,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
