import { applyD1Migrations, reset } from 'cloudflare:test';
import { env as testEnv } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import { seal } from '../src/crypto';
import { DAY, MINUTE, type Deps, type Env } from '../src/env';
import { handle, tick as runTick } from '../src/index';
import type { PlatformId, Tokens } from '../src/platforms/base';

const full = testEnv as unknown as Env & { TEST_MIGRATIONS: any };
/** R2 is off unless a test turns it on, like in production today. */
export const env: Env = { ...full, MEDIA: undefined };
export const envR2: Env = { ...full };

export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const START = Date.parse('2026-12-01T04:30:00Z');
const MB = 1024 * 1024;

type Reply = Response | object | (() => Response | object | Promise<Response | object>);
export interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string;
  size: number;
}

/** A scripted platform: each rule answers its replies in order, the last one repeats. Anything else fails the test. */
export class World {
  time = START;
  seen: Seen[] = [];
  unexpected: string[] = [];
  private rules: { match: string; replies: Reply[] }[] = [];

  on(match: string, ...replies: Reply[]) {
    this.rules = this.rules.filter((r) => r.match !== match);
    this.rules.push({ match, replies });
    return this;
  }

  calls(match: string) {
    return this.seen.filter((s) => `${s.method} ${s.url}`.startsWith(match));
  }

  deps: Deps = {
    now: () => this.time,
    fetch: async (url, init = {}) => {
      const req = new Request(url, { ...init, signal: undefined });
      const bytes = new Uint8Array(await req.arrayBuffer());
      const line = `${req.method} ${url}`;
      const body = bytes.length < 50_000 ? new TextDecoder().decode(bytes) : '';
      this.seen.push({ method: req.method, url, headers: req.headers, body, size: bytes.length });
      // The longest matching rule wins.
      const rule = this.rules.filter((r) => line.startsWith(r.match)).sort((a, b) => b.match.length - a.match.length)[0];
      if (!rule) {
        this.unexpected.push(line);
        throw new Error(`unexpected call ${line}`);
      }
      let reply = rule.replies.length > 1 ? rule.replies.shift()! : rule.replies[0]!;
      if (typeof reply === 'function') reply = await reply();
      return reply instanceof Response ? reply.clone() : Response.json(reply);
    },
  };

  async api(method: string, path: string, body?: unknown, e: Env = env) {
    const res = await handle(e, this.deps, new Request(`https://posting.test/v1/${path}`, {
      method,
      headers: { authorization: 'Bearer test-posting-secret', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    return { status: res.status, body: (await res.json()) as any };
  }

  tick(minutes = 1, e: Env = env) {
    this.time += minutes * MINUTE;
    return runTick(e, this.deps);
  }

  async upload(owner: string, type: string, bytes: Uint8Array, e: Env = env, length = bytes.length) {
    const res = await handle(e, this.deps, new Request(`https://posting.test/v1/media?owner=${owner}`, {
      method: 'PUT',
      headers: { authorization: 'Bearer test-posting-secret', 'content-type': type, 'content-length': String(length) },
      body: bytes,
    }));
    return { status: res.status, body: (await res.json()) as any };
  }

  async media(owner: string, type: 'image/jpeg' | 'image/png' | 'video/mp4', size = 1000, e: Env = env): Promise<string> {
    const { status, body } = await this.upload(owner, type, file(type, size), e);
    if (status !== 200) throw new Error(JSON.stringify(body));
    return body.id;
  }

  async channel(owner: string, platform: PlatformId, tokens: Partial<Tokens> = {}): Promise<string> {
    const id = crypto.randomUUID();
    const t: Tokens = { access: 'tok-1', refresh: platform === 'facebook' ? undefined : 'ref-1', expires: platform === 'facebook' ? null : START + 50 * DAY, ...tokens };
    await env.DB.prepare('INSERT INTO channels (id, owner, platform, account, name, handle, sealed, expires_at, check_at, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, owner, platform, 'acct', 'Dr Rao', 'drrao', await seal(env.TOKEN_KEY, id, t), t.expires, START + 365 * DAY, START).run();
    return id;
  }

  async post(owner: string, channel: string, fields: object): Promise<string> {
    const { status, body } = await this.api('POST', 'posts', { owner, ref: crypto.randomUUID(), channel, text: 'Namaste', at: null, ...fields });
    if (status !== 200) throw new Error(`${status} ${JSON.stringify(body)}`);
    return body.id;
  }

  async get(owner: string, id: string) {
    return (await this.api('GET', `posts?owner=${owner}&ids=${id}`)).body.posts[0];
  }

  /** Ticks until the post leaves "publishing" / "queued". */
  async settle(owner: string, id: string, max = 30) {
    for (let i = 0; i < max; i++) {
      await this.tick(2);
      const post = await this.get(owner, id);
      if (post.state !== 'queued' && post.state !== 'publishing') return post;
    }
    return this.get(owner, id);
  }
}

export function file(type: string, size: number) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  const head = type === 'image/jpeg' ? [0xff, 0xd8, 0xff] : type === 'image/png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    : [0, 0, 0, 24, ...new TextEncoder().encode('ftypisom')];
  bytes.set(head);
  return bytes;
}

export const raw = (id: string) => env.DB.prepare('SELECT * FROM posts WHERE id = ?').bind(id).first<any>();
export const error = (status: number, body: object | string) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
export { MB, DAY, MINUTE };

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, full.TEST_MIGRATIONS);
});
