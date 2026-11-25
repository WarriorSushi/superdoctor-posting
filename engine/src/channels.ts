import { open, pkceChallenge, randomToken, seal } from './crypto';
import { DAY, HttpError, MINUTE, type Deps, type Env } from './env';
import { caller, Fail, reconnectMessage, type Account, type Client, type Platform, type PlatformId, type Tokens } from './platforms/base';
import { platforms } from './platforms';

export interface Channel {
  id: string;
  owner: string;
  platform: PlatformId;
  account: string;
  name: string;
  handle: string;
  picture: string;
  status: 'ok' | 'reconnect';
  sealed: string;
  expires_at: number | null;
}

interface Flow {
  id: string;
  platform: PlatformId;
  redirect_uri: string;
  sealed: string;
}

const PUBLIC = 'id, platform, name, handle, picture, status';

export function configured(env: Env, p: Platform): Client | null {
  const { id, secret } = p.client(env);
  return id && secret ? { id, secret } : null;
}

function client(env: Env, p: Platform): Client {
  const c = configured(env, p);
  if (!c) throw new HttpError(503, `${p.label} is not switched on yet.`);
  return c;
}

function platform(id: unknown): Platform {
  const p = typeof id === 'string' && Object.hasOwn(platforms, id) ? platforms[id as PlatformId] : undefined;
  if (!p) throw new HttpError(400, 'This platform is not supported.');
  return p;
}

export async function listChannels(env: Env, owner: string) {
  const { results } = await env.DB.prepare(`SELECT ${PUBLIC} FROM channels WHERE owner = ? ORDER BY created, id`).bind(owner).all();
  return { channels: results };
}

async function saveFlow(env: Env, kind: 'state' | 'ticket', id: string, owner: string, p: PlatformId, redirectUri: string, data: unknown, expires: number) {
  await env.DB.prepare('INSERT INTO flows (id, kind, owner, platform, redirect_uri, sealed, expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, kind, owner, p, redirectUri, await seal(env.TOKEN_KEY, id, data), expires).run();
}

export async function connect(env: Env, deps: Deps, owner: string, body: any) {
  const p = platform(body.platform);
  const c = client(env, p);
  const redirect = typeof body.redirect_uri === 'string' ? URL.parse(body.redirect_uri) : null;
  if (!redirect || redirect.origin !== new URL(env.APP_ORIGIN).origin || redirect.username || redirect.password || redirect.hash) {
    throw new HttpError(400, 'The return address is not allowed.');
  }
  const state = randomToken();
  const verifier = randomToken();
  await saveFlow(env, 'state', state, owner, p.id, body.redirect_uri, { verifier }, deps.now() + 15 * MINUTE);
  return { url: p.authUrl(c, body.redirect_uri, state, p.pkce ? await pkceChallenge(verifier) : '') };
}

const friendly = (err: unknown): never => {
  if (err instanceof Fail) throw new HttpError(err.kind === 'unknown' || err.kind === 'retry' ? 502 : 400, err.message);
  throw err;
};

export async function complete(env: Env, deps: Deps, owner: string, body: any) {
  const p = platform(body.platform);
  const c = client(env, p);
  if (typeof body.code !== 'string' || !body.code) throw new HttpError(400, `${p.label} did not finish the sign-in. Please try again.`);
  // Checked and removed in one statement, so a state works only once.
  const flow = await env.DB.prepare("DELETE FROM flows WHERE id = ? AND kind = 'state' AND owner = ? AND platform = ? AND expires > ? RETURNING *")
    .bind(String(body.state), owner, p.id, deps.now()).first<Flow>();
  if (!flow) throw new HttpError(400, 'This sign-in has expired or was already used. Please start again.');
  const { verifier } = await open<{ verifier: string }>(env.TOKEN_KEY, flow.id, flow.sealed);

  const accounts = await p
    .complete(c, caller(deps, p), { code: body.code, redirectUri: flow.redirect_uri, verifier, now: deps.now() })
    .catch((err) => friendly(err instanceof Fail && err.kind === 'refresh' ? new Fail('bad', `${p.label} did not accept the sign-in. Please try again.`) : err));

  if (p.choose) {
    const ticket = randomToken();
    await saveFlow(env, 'ticket', ticket, owner, p.id, flow.redirect_uri, accounts, deps.now() + 15 * MINUTE);
    return { choose: { ticket, options: accounts.map((a) => ({ id: a.account, name: a.name, picture: a.picture })) } };
  }
  return { channels: await saveChannels(env, deps, owner, p.id, accounts) };
}

export async function choose(env: Env, deps: Deps, owner: string, body: any) {
  const expired = new HttpError(400, 'This choice has expired. Please connect again.');
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length) throw new HttpError(400, 'Please pick at least one page.');
  const peek = await env.DB.prepare("SELECT * FROM flows WHERE id = ? AND kind = 'ticket' AND owner = ? AND expires > ?")
    .bind(String(body.ticket), owner, deps.now()).first<Flow>();
  if (!peek) throw expired;
  const accounts = await open<Account[]>(env.TOKEN_KEY, peek.id, peek.sealed);
  const picked = accounts.filter((a) => ids.includes(a.account));
  if (picked.length !== ids.length) throw new HttpError(400, 'One of these pages was not in the list. Please pick again.');
  const taken = await env.DB.prepare('DELETE FROM flows WHERE id = ? AND owner = ?').bind(peek.id, owner).run();
  if (!taken.meta.changes) throw expired;
  return { channels: await saveChannels(env, deps, owner, peek.platform, picked) };
}

/** New account -> new channel; a known account -> same channel with fresh tokens. */
async function saveChannels(env: Env, deps: Deps, owner: string, p: PlatformId, accounts: Account[]) {
  const channels = [];
  for (const a of accounts) {
    // The row comes first because the tokens are encrypted against its id.
    await env.DB.prepare(
      'INSERT INTO channels (id, owner, platform, account, check_at, created) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (owner, platform, account) DO NOTHING'
    ).bind(crypto.randomUUID(), owner, p, a.account, deps.now() + DAY, deps.now()).run();
    const { id } = (await env.DB.prepare('SELECT id FROM channels WHERE owner = ? AND platform = ? AND account = ?').bind(owner, p, a.account).first<{ id: string }>())!;
    channels.push(
      await env.DB.prepare(
        `UPDATE channels SET name = ?, handle = ?, picture = ?, status = 'ok', sealed = ?, expires_at = ?, check_at = ? WHERE id = ? AND owner = ? RETURNING ${PUBLIC}`
      ).bind(a.name, a.handle, a.picture, await seal(env.TOKEN_KEY, id, a.tokens), a.tokens.expires, deps.now() + DAY, id, owner).first()
    );
  }
  return channels;
}

export async function deleteChannel(env: Env, deps: Deps, owner: string, id: string) {
  const [gone] = await env.DB.batch([
    env.DB.prepare('DELETE FROM channels WHERE id = ? AND owner = ?').bind(id, owner),
    env.DB.prepare("UPDATE posts SET state = 'cancelled', finished_at = ? WHERE channel = ? AND owner = ? AND state = 'queued'").bind(deps.now(), id, owner),
  ]);
  if (!gone!.meta.changes) throw new HttpError(404, 'This account is not connected.');
  return { ok: true };
}

/** Forgets everything held for one owner. Refused, with nothing changed, while a post is on its way out. Files go at the next sweeps. */
export async function deleteOwner(env: Env, owner: string) {
  const idle = "owner = ?1 AND NOT EXISTS (SELECT 1 FROM posts WHERE owner = ?1 AND state = 'publishing')";
  await env.DB.batch([
    `DELETE FROM channels WHERE ${idle}`,
    `DELETE FROM flows WHERE ${idle}`,
    `UPDATE media SET state = 'deleting' WHERE ${idle}`,
    `DELETE FROM posts WHERE ${idle}`,
  ].map((sql) => env.DB.prepare(sql).bind(owner)));
  const busy = await env.DB.prepare("SELECT 1 FROM posts WHERE owner = ? AND state = 'publishing'").bind(owner).first();
  if (busy) throw new HttpError(409, 'A post is going out right now. Try again in a few minutes.');
  return { ok: true };
}

/** Gets a new token and saves it. A clear "no" marks the channel for reconnecting. */
export async function refreshChannel(env: Env, deps: Deps, channel: Channel): Promise<string> {
  const p = platforms[channel.platform];
  try {
    const tokens = await open<Tokens>(env.TOKEN_KEY, channel.id, channel.sealed);
    const c = configured(env, p);
    if (!p.refresh || !tokens.refresh || !c) throw new Fail('disconnect', reconnectMessage(p.label));
    const fresh = await p.refresh(c, caller(deps, p), tokens, deps.now());
    channel.sealed = await seal(env.TOKEN_KEY, channel.id, fresh);
    channel.expires_at = fresh.expires;
    await env.DB.prepare("UPDATE channels SET sealed = ?, expires_at = ?, status = 'ok' WHERE id = ?")
      .bind(channel.sealed, channel.expires_at, channel.id).run();
    return fresh.access;
  } catch (err) {
    if (!(err instanceof Fail) || err.kind === 'unknown' || err.kind === 'retry') throw err;
    await markReconnect(env, channel);
    throw new Fail('disconnect', reconnectMessage(p.label));
  }
}

export async function markReconnect(env: Env, channel: Channel) {
  channel.status = 'reconnect';
  await env.DB.prepare("UPDATE channels SET status = 'reconnect' WHERE id = ?").bind(channel.id).run();
}

/** A token that is good for at least five more minutes. */
export async function accessToken(env: Env, deps: Deps, channel: Channel): Promise<string> {
  if (channel.expires_at !== null && channel.expires_at < deps.now() + 5 * MINUTE) return refreshChannel(env, deps, channel);
  return (await open<Tokens>(env.TOKEN_KEY, channel.id, channel.sealed)).access;
}

/** Once a day per channel: refresh what expires within ten days, so a dead sign-in shows up before a post fails. */
export async function dailyRefresh(env: Env, deps: Deps) {
  const now = deps.now();
  const { results } = await env.DB.prepare(
    `UPDATE channels SET check_at = ?1 WHERE id IN (SELECT id FROM channels WHERE check_at <= ?2 ORDER BY check_at LIMIT 3)
     AND check_at <= ?2 RETURNING *`
  ).bind(now + DAY, now).all<Channel>();
  for (const channel of results) {
    if (channel.status !== 'ok' || channel.expires_at === null || channel.expires_at > now + 10 * DAY) continue;
    try {
      const { refresh } = await open<Tokens>(env.TOKEN_KEY, channel.id, channel.sealed);
      // LinkedIn without refresh tokens keeps working until the day it runs out.
      if (refresh || channel.expires_at <= now) await refreshChannel(env, deps, channel);
    } catch (err) {
      if (err instanceof Fail && err.kind === 'disconnect') continue;
      await env.DB.prepare('UPDATE channels SET check_at = ? WHERE id = ?').bind(now + 60 * MINUTE, channel.id).run();
    }
  }
}

export async function analytics(env: Env, deps: Deps, owner: string, id: string, days: number) {
  const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ? AND owner = ?').bind(id, owner).first<Channel>();
  if (!channel) throw new HttpError(404, 'This account is not connected.');
  const p = platforms[channel.platform];
  if (!p.analytics) return { rows: [] };
  if (channel.status !== 'ok') throw new HttpError(409, `Please reconnect your ${p.label} account to see its numbers.`);
  const ask = (token: string) => p.analytics!(caller(deps, p), token, channel.account, days, deps.now());
  try {
    const token = await accessToken(env, deps, channel);
    const rows = await ask(token).catch(async (err) => {
      if (!(err instanceof Fail) || err.kind !== 'refresh') throw err;
      return ask(await refreshChannel(env, deps, channel));
    });
    return { rows };
  } catch (err) {
    if (err instanceof Fail && (err.kind === 'disconnect' || err.kind === 'refresh')) {
      await markReconnect(env, channel);
      throw new HttpError(409, `Please reconnect your ${p.label} account to see its numbers.`);
    }
    if (err instanceof Fail && err.kind === 'bad') return { rows: [] };
    throw new HttpError(502, `${p.label} did not give its numbers right now. Please try again later.`);
  }
}
