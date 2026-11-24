import type { Channel } from './channels';
import { HttpError, type Deps, type Env } from './env';
import type { Media } from './media';
import type { Kind, PlatformId } from './platforms/base';
import { platforms } from './platforms';

const TEXT_LIMIT: Record<PlatformId, number> = { instagram: 2200, linkedin: 3000, youtube: 5000, facebook: 60000 };
const MAX_IMAGES = 10;
const PUBLIC = 'id, ref, channel, state, error, url, at';

const bad = (message: string) => new HttpError(400, message);
const view = (row: any) => ({ ...row, at: new Date(row.at).toISOString() });

/** null or a past time means now. A time zone is required, or 10 am in Mumbai would go out at 3.30 pm. */
function when(at: unknown, now: number): number {
  if (at === null || at === undefined) return now;
  const ms = typeof at === 'string' && /T.*(Z|[+-]\d\d:?\d\d)$/.test(at) ? Date.parse(at) : NaN;
  if (Number.isNaN(ms)) throw bad('The posting time is not valid.');
  return Math.max(ms, now);
}

function validate(p: PlatformId, kind: Kind, text: string, title: string, media: Media[]) {
  const label = platforms[p].label;
  const images = media.every((m) => m.type !== 'video/mp4');
  if (kind === 'text' && media.length) throw bad('A text post cannot have images or a video.');
  if (kind === 'text' && !text.trim()) throw bad('Please write something to post.');
  if (kind === 'images' && (!images || !media.length || media.length > MAX_IMAGES)) throw bad(`Please add between 1 and ${MAX_IMAGES} images.`);
  if (kind === 'video' && (media.length !== 1 || images)) throw bad('Please add exactly one MP4 video.');
  if (p === 'instagram' && kind === 'text') throw bad('Instagram needs an image or a video.');
  if (p === 'instagram' && kind === 'images' && media.some((m) => m.type !== 'image/jpeg')) throw bad('Instagram only takes JPG images.');
  if (p === 'youtube') {
    if (kind !== 'video') throw bad('YouTube needs a video.');
    if (!title.trim()) throw bad('YouTube needs a title.');
    if (title.length > 100) throw bad('The YouTube title can have at most 100 characters.');
    if (/[<>]/.test(title + text)) throw bad('YouTube does not allow < or > in the title or description.');
  }
  // YouTube counts bytes, so Hindi and other scripts run out sooner.
  const length = p === 'youtube' ? new TextEncoder().encode(text).length : text.length;
  if (length > TEXT_LIMIT[p]) throw bad(`The text is too long for ${label} (limit ${TEXT_LIMIT[p]}).`);
  if (title.length > 255) throw bad('The title is too long.');
}

export async function createPost(env: Env, deps: Deps, owner: string, body: any) {
  const { ref } = body;
  if (typeof ref !== 'string' || !ref || ref.length > 200) throw bad('The post reference is missing.');
  const existing = () => env.DB.prepare('SELECT id, state FROM posts WHERE owner = ? AND ref = ?').bind(owner, ref).first();
  // Before any validation: a repeated call must find its post even if the media is gone by now.
  const before = await existing();
  if (before) return before;

  const text = body.text ?? '';
  const title = body.title ?? '';
  if (typeof text !== 'string' || typeof title !== 'string') throw bad('The text is not valid.');
  if (!['text', 'images', 'video'].includes(body.kind)) throw bad('The post type is not valid.');
  const ids: unknown[] = body.media ?? [];
  if (!Array.isArray(ids) || ids.length > 50 || new Set(ids).size !== ids.length) throw bad('The media list is not valid.');
  const at = when(body.at, deps.now());

  const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ? AND owner = ?').bind(String(body.channel), owner).first<Channel>();
  if (!channel) throw new HttpError(404, 'This account is not connected.');
  const { results } = await env.DB.prepare("SELECT * FROM media WHERE owner = ? AND state = 'ready' AND id IN (SELECT value FROM json_each(?))")
    .bind(owner, JSON.stringify(ids)).all<Media>();
  const media = ids.map((id) => results.find((m) => m.id === id));
  if (media.some((m) => !m)) throw new HttpError(404, 'An image or video was not found. Please upload it again.');
  validate(channel.platform, body.kind, text, title, media as Media[]);

  const id = crypto.randomUUID();
  await env.DB.batch([
    // Checks the channel again in the same statement, in case it is being deleted right now.
    env.DB.prepare(
      `INSERT INTO posts (id, owner, ref, channel, kind, text, title, at, next_at, created, media_count)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10 WHERE EXISTS (SELECT 1 FROM channels WHERE id = ?4 AND owner = ?2)
       ON CONFLICT (owner, ref) DO NOTHING`
    ).bind(id, owner, ref, channel.id, body.kind, text, title, at, deps.now(), ids.length),
    ...ids.map((m, pos) =>
      env.DB.prepare(
        "INSERT INTO post_media (post, media, pos) SELECT p.id, m.id, ? FROM posts p, media m WHERE p.id = ? AND m.id = ? AND m.state = 'ready'"
      ).bind(pos, id, m)
    ),
  ]);
  const saved = await existing();
  if (!saved) throw new HttpError(404, 'This account is not connected.');
  return saved;
}

export async function listPosts(env: Env, owner: string, idsParam: string | null, refsParam: string | null) {
  const split = (s: string | null) => (s ? s.split(',').filter(Boolean) : []);
  const ids = split(idsParam);
  const refs = split(refsParam);
  const count = ids.length + refs.length;
  if (!count || count > 100) throw bad('Please ask for between 1 and 100 posts.');
  const { results } = await env.DB.prepare(
    `SELECT ${PUBLIC} FROM posts WHERE owner = ?1
     AND (id IN (SELECT value FROM json_each(?2)) OR ref IN (SELECT value FROM json_each(?3)))`
  ).bind(owner, JSON.stringify(ids), JSON.stringify(refs)).all();
  return { posts: results.map(view) };
}

async function stateOf(env: Env, owner: string, id: string) {
  const row = await env.DB.prepare('SELECT state FROM posts WHERE id = ? AND owner = ?').bind(id, owner).first<{ state: string }>();
  if (!row) throw new HttpError(404, 'This post was not found.');
  return row.state;
}

export async function movePost(env: Env, deps: Deps, owner: string, id: string, body: any) {
  if (!('at' in body)) throw bad('The posting time is not valid.');
  const at = when(body.at, deps.now());
  const done = await env.DB.prepare("UPDATE posts SET at = ?1, next_at = ?1 WHERE id = ?2 AND owner = ?3 AND state = 'queued' RETURNING id, state")
    .bind(at, id, owner).first();
  if (done) return done;
  const state = await stateOf(env, owner, id);
  throw new HttpError(409, 'This post can no longer be moved.', { state });
}

export async function cancelPost(env: Env, deps: Deps, owner: string, id: string) {
  // A failed post was never published, so it may be cancelled too.
  const done = await env.DB.prepare(
    "UPDATE posts SET state = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND owner = ? AND state IN ('queued', 'failed', 'cancelled') RETURNING state"
  ).bind(deps.now(), id, owner).first();
  if (done) return done;
  const state = await stateOf(env, owner, id);
  throw new HttpError(409, 'This post can no longer be cancelled.', { state });
}
