import { verify, sign } from './crypto';
import { DAY, MINUTE, HttpError, type Deps, type Env } from './env';

const MB = 1024 * 1024;
/** KV values stop at 25 MB, so files are cut into 20 MB pieces there. */
export const KV_CHUNK = 20 * MB;

export interface Media {
  id: string;
  owner: string;
  type: string;
  size: number;
  store: 'r2' | 'kv';
  state: string;
  created: number;
}

const starts = (head: Uint8Array, ...bytes: number[]) => bytes.every((b, i) => head[i] === b);
const ascii = (head: Uint8Array, from: number, to: number) => String.fromCharCode(...head.subarray(from, to));

const TYPES: Record<string, { ext: string; max: number; magic: (head: Uint8Array) => boolean }> = {
  'image/jpeg': { ext: 'jpg', max: 8 * MB, magic: (h) => starts(h, 0xff, 0xd8, 0xff) },
  'image/png': { ext: 'png', max: 8 * MB, magic: (h) => starts(h, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  // "qt  " is an iPhone .mov file, which the platforms do not accept as MP4.
  'video/mp4': { ext: 'mp4', max: 300 * MB, magic: (h) => ascii(h, 4, 8) === 'ftyp' && ascii(h, 8, 12) !== 'qt  ' },
};

export async function putMedia(env: Env, deps: Deps, owner: string, req: Request) {
  const type = (req.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase();
  const rule = TYPES[type];
  if (!rule) throw new HttpError(415, 'Please use a JPG or PNG image, or an MP4 video.');
  const size = Number(req.headers.get('content-length'));
  if (!Number.isSafeInteger(size) || size <= 0 || !req.body) throw new HttpError(411, 'The upload did not say how big the file is.');
  if (size > rule.max) {
    throw new HttpError(413, type === 'video/mp4' ? 'This video is over 300 MB. Please use a smaller one.' : 'This image is over 8 MB. Please use a smaller one.');
  }

  const id = crypto.randomUUID();
  const store = env.MEDIA ? 'r2' : 'kv';
  await env.DB.prepare('INSERT INTO media (id, owner, type, size, store, state, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, owner, type, size, store, 'uploading', deps.now()).run();
  try {
    await write(env, id, req.body, size, rule.magic);
  } catch (err) {
    await env.DB.prepare("UPDATE media SET state = 'deleting' WHERE id = ?").bind(id).run();
    throw err instanceof HttpError ? err : new HttpError(400, 'The upload did not finish. Please try again.');
  }
  // `created` moves to the end of the upload: the KV settling time counts from here.
  await env.DB.prepare("UPDATE media SET state = 'ready', created = ? WHERE id = ?").bind(deps.now(), id).run();
  return { id, size };
}

async function write(env: Env, id: string, body: ReadableStream<Uint8Array>, size: number, magic: (h: Uint8Array) => boolean) {
  const reader = body.getReader();
  const pull = async () => (await reader.read()).value;

  let buf = new Uint8Array(0);
  while (buf.length < 12) {
    const more = await pull();
    if (!more) break;
    const joined = new Uint8Array(buf.length + more.length);
    joined.set(buf);
    joined.set(more, buf.length);
    buf = joined;
  }
  if (!magic(buf)) {
    await reader.cancel().catch(() => {});
    throw new HttpError(415, 'This file is not a real JPG, PNG or MP4. Please export it again.');
  }

  const piece = env.MEDIA ? size : KV_CHUNK;
  for (let i = 0, left = size; left > 0; i++) {
    const n = Math.min(piece, left);
    const { readable, writable } = new FixedLengthStream(n);
    const put: Promise<unknown> = env.MEDIA ? env.MEDIA.put(id, readable) : env.MEDIA_KV!.put(`${id}/${i}`, readable);
    put.catch(() => {}); // awaited below; this only stops an early "unhandled" warning
    const writer = writable.getWriter();
    try {
      for (let need = n; need > 0; ) {
        if (!buf.length) {
          const more = await pull();
          if (!more) throw new Error('upload ended early');
          buf = more as Uint8Array<ArrayBuffer>;
        }
        const part = buf.subarray(0, need);
        await writer.write(part);
        need -= part.length;
        buf = buf.subarray(part.length);
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    }
    await put;
    left -= n;
  }
  if (buf.length || (await pull())?.length) throw new Error('upload is longer than it said');
}

/** Streams bytes start..end (inclusive). Throws if they are not there (yet). */
export async function readMedia(env: Env, m: Media, start = 0, end = m.size - 1): Promise<ReadableStream> {
  const length = end - start + 1;
  if (m.store === 'r2') {
    const object = await env.MEDIA?.get(m.id, { range: { offset: start, length } });
    if (!object) throw new Error('media missing');
    return object.body;
  }
  const chunk = async (i: number) => {
    const stream = await env.MEDIA_KV?.get(`${m.id}/${i}`, 'stream');
    if (!stream) throw new Error('media missing');
    return stream as ReadableStream<Uint8Array>;
  };
  let i = Math.floor(start / KV_CHUNK);
  let current = await chunk(i);
  const { readable, writable } = new FixedLengthStream(length);
  (async () => {
    const writer = writable.getWriter();
    let skip = start - i * KV_CHUNK;
    let left = length;
    try {
      while (left > 0) {
        const reader = current.getReader();
        for (let r = await reader.read(); !r.done; r = await reader.read()) {
          const part = r.value.subarray(skip, skip + left);
          skip = Math.max(0, skip - r.value.length);
          if (part.length) await writer.write(part);
          left -= part.length;
          if (left === 0) break;
        }
        await reader.cancel().catch(() => {});
        if (left > 0) {
          if (++i > (m.size - 1) / KV_CHUNK) throw new Error('media is shorter than recorded');
          current = await chunk(i);
        }
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
    }
  })();
  return readable;
}

export async function mediaUrl(env: Env, m: Media) {
  return `${env.PUBLIC_URL.replace(/\/$/, '')}/m/${m.id}/${await sign(env.MEDIA_SIGN_KEY, m.id)}.${TYPES[m.type]!.ext}`;
}

/** GET/HEAD /m/:id/:sig.:ext, the one public route: the platforms fetch media from here. */
export async function serveMedia(env: Env, req: Request, id: string, sig: string, ext: string) {
  const missing = () => new Response('Not found', { status: 404 });
  if (!(await verify(env.MEDIA_SIGN_KEY, id, sig))) return missing();
  const m = await env.DB.prepare("SELECT * FROM media WHERE id = ? AND state = 'ready'").bind(id).first<Media>();
  if (!m || TYPES[m.type]!.ext !== ext) return missing();

  let [start, end, status] = [0, m.size - 1, 200];
  const headers = new Headers({
    'content-type': m.type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
  });
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else {
      start = Math.max(0, m.size - Number(range[2]));
    }
    if (start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${m.size}` } });
    status = 206;
    headers.set('content-range', `bytes ${start}-${end}/${m.size}`);
  }
  headers.set('content-length', String(end - start + 1));
  if (req.method === 'HEAD') return new Response(null, { status, headers });
  try {
    return new Response(await readMedia(env, m, start, end), { status, headers });
  } catch {
    // KV can take up to a minute to show a new file everywhere.
    return new Response('Not ready yet', { status: 503, headers: { 'retry-after': '30' } });
  }
}

/** Deletes media 24 h after its last post finished, unused media after 14 days, and broken uploads after a day. */
export async function cleanMedia(env: Env, now: number) {
  await env.DB.prepare(
    `UPDATE media SET state = 'deleting' WHERE id IN (
       SELECT m.id FROM media m
       LEFT JOIN post_media pm ON pm.media = m.id LEFT JOIN posts p ON p.id = pm.post
       WHERE m.state != 'deleting' GROUP BY m.id
       HAVING (m.state = 'uploading' AND m.created < ?1)
         OR (COUNT(p.id) = 0 AND m.created < ?2)
         OR (COUNT(p.id) > 0 AND SUM(p.state IN ('queued', 'publishing')) = 0 AND MAX(p.finished_at) < ?1)
       LIMIT 20)`
  ).bind(now - DAY, now - 14 * DAY).run();
  const { results } = await env.DB.prepare("SELECT * FROM media WHERE state = 'deleting' LIMIT 5").all<Media>();
  for (const m of results) {
    if (m.store === 'r2') {
      if (!env.MEDIA) continue; // binding switched off: keep the row so the file is not forgotten
      await env.MEDIA.delete(m.id);
    } else {
      if (!env.MEDIA_KV) continue;
      for (let i = 0; i * KV_CHUNK < m.size; i++) await env.MEDIA_KV.delete(`${m.id}/${i}`);
    }
    await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(m.id).run();
  }
}

/** KV writes need up to a minute to be visible everywhere, so posts with fresh KV media wait for this. */
export const KV_SETTLE = MINUTE;
