/**
 * A fake Google for the adapter tests: a local node:http server that plays the OAuth token endpoint and generateContent for BOTH providers.
 * It verifies the JWT against an RSA key pair generated here (nothing real), records every request, and answers what the test queues.
 * Not a test file.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface Recorded { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }
export interface FakeGoogle {
  base: string;
  requests: Recorded[];
  tokenRequests: number;
  /** Queue the next generateContent answers (status + JSON body). The last one repeats. */
  answers: { status: number; body: unknown }[];
  jwtClaims: Record<string, unknown> | null;
  jwtValid: boolean | null;
  /** Hold every generateContent answer back this long (lets parallel requests pile up before any settles). */
  delayMs: number;
  serviceAccountJson: string;
  close(): Promise<void>;
}

export const okBody = (json: unknown, usage = { promptTokenCount: 1620, candidatesTokenCount: 400, thoughtsTokenCount: 0 }) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(json) }] }, finishReason: 'STOP' }],
  usageMetadata: usage,
});

const read = (req: IncomingMessage): Promise<string> => new Promise((res) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => res(s)); });

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pub = createPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  const f: FakeGoogle = {
    base: '', requests: [], tokenRequests: 0, answers: [], jwtClaims: null, jwtValid: null, delayMs: 0,
    serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'test-sa@test-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }),
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const path = req.url ?? '';
    f.requests.push({ method: req.method ?? '', path, headers: req.headers, body });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    if (path === '/token') {
      f.tokenRequests++;
      const jwt = new URLSearchParams(body).get('assertion') ?? '';
      const [h, c, s] = jwt.split('.');
      f.jwtValid = !!h && !!c && !!s && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(pub, Buffer.from(s, 'base64url'));
      f.jwtClaims = c ? JSON.parse(Buffer.from(c, 'base64url').toString()) : null;
      return send(200, { access_token: 'fake-access-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (path.endsWith(':generateContent')) {
      const a = f.answers.length > 1 ? f.answers.shift()! : f.answers[0];
      if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
      return a ? send(a.status, a.body) : send(500, { error: 'nothing queued' });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return f;
}
