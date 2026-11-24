import { analytics, choose, complete, configured, connect, dailyRefresh, deleteChannel, listChannels } from './channels';
import { sameSecret } from './crypto';
import { HttpError, MINUTE, type Deps, type Env } from './env';
import { cleanMedia, putMedia, serveMedia } from './media';
import { platforms } from './platforms';
import { cancelPost, createPost, listPosts, movePost } from './posts';
import { publishDue } from './publish';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function tenant(owner: unknown): string {
  if (typeof owner !== 'string' || !UUID.test(owner)) throw new HttpError(400, 'The account owner is missing.');
  return owner.toLowerCase();
}

async function readBody(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > 500_000) throw new HttpError(413, 'This request is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'The request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'The request could not be read.');
  return body;
}

async function route(env: Env, deps: Deps, req: Request, url: URL): Promise<object> {
  const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '')?.[1] ?? '';
  if (!env.POSTING_SECRET || !(await sameSecret(bearer, env.POSTING_SECRET))) throw new HttpError(401, 'Not allowed.');

  const query = url.searchParams;
  const [, , what, id, ...rest] = url.pathname.split('/');
  if (rest.length) throw new HttpError(404, 'Not found.');

  switch (`${req.method} ${what}${id ? '/:id' : ''}`) {
    case 'GET health':
      return { ok: true, platforms: Object.fromEntries(Object.values(platforms).map((p) => [p.id, !!configured(env, p)])) };
    case 'GET channels':
      return listChannels(env, tenant(query.get('owner')));
    case 'DELETE channels/:id':
      return deleteChannel(env, deps, tenant(query.get('owner')), id!);
    case 'PUT media':
      return putMedia(env, deps, tenant(query.get('owner')), req);
    case 'GET posts':
      return listPosts(env, tenant(query.get('owner')), query.get('ids'), query.get('refs'));
    case 'DELETE posts/:id':
      return cancelPost(env, deps, tenant(query.get('owner')), id!);
    case 'GET analytics/:id': {
      const days = Number(query.get('days') || 30);
      if (!Number.isInteger(days) || days < 1 || days > 90) throw new HttpError(400, 'Please ask for between 1 and 90 days.');
      return analytics(env, deps, tenant(query.get('owner')), id!, days);
    }
    case 'POST connect':
    case 'POST complete':
    case 'POST choose':
    case 'POST posts':
    case 'PATCH posts/:id': {
      const body = await readBody(req);
      const owner = tenant(body.owner);
      if (req.method === 'PATCH') return movePost(env, deps, owner, id!, body);
      if (what === 'connect') return connect(env, deps, owner, body);
      if (what === 'complete') return complete(env, deps, owner, body);
      if (what === 'choose') return choose(env, deps, owner, body);
      return createPost(env, deps, owner, body);
    }
  }
  throw new HttpError(404, 'Not found.');
}

export async function handle(env: Env, deps: Deps, req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    const file = /^\/m\/([0-9a-f-]{36})\/([\w-]+)\.(\w+)$/.exec(url.pathname);
    if (file && (req.method === 'GET' || req.method === 'HEAD')) return await serveMedia(env, req, file[1]!, file[2]!, file[3]!);
    if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, 'Not found.');
    return Response.json(await route(env, deps, req, url), { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: err.message, ...err.extra }, { status: err.status });
    console.error('request failed', req.method, url.pathname.split('/')[2], (err as Error)?.name);
    return Response.json({ error: 'Something went wrong on our side. Please try again.' }, { status: 500 });
  }
}

/** Every minute. */
export async function tick(env: Env, deps: Deps) {
  const now = deps.now();
  const chores: Promise<unknown>[] = [publishDue(env, deps), dailyRefresh(env, deps)];
  if (Math.floor(now / MINUTE) % 15 === 0) {
    chores.push(cleanMedia(env, now), env.DB.prepare('DELETE FROM flows WHERE expires < ?').bind(now).run());
  }
  for (const chore of await Promise.allSettled(chores)) {
    if (chore.status === 'rejected') console.error('chore failed', chore.reason?.name);
  }
}

const live: Deps = { fetch: (url, init) => fetch(url, init), now: () => Date.now() };

export default {
  fetch: (req, env) => handle(env, live, req),
  scheduled: (_controller, env) => tick(env, live),
} satisfies ExportedHandler<Env>;
