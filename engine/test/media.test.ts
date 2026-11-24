import { describe, expect, it } from 'vitest';
import { sign } from '../src/crypto';
import type { Env } from '../src/env';
import { handle } from '../src/index';
import { cleanMedia, KV_CHUNK, mediaUrl } from '../src/media';
import { A, B, DAY, env, envR2, file, MB, World } from './helpers';

const get = (w: World, url: string, init?: RequestInit, e: Env = env) => handle(e, w.deps, new Request(url, init));
const urlOf = (id: string, ext: string) => sign(env.MEDIA_SIGN_KEY, id).then((s) => `https://posting.test/m/${id}/${s}.${ext}`);
const rows = async () => (await env.DB.prepare('SELECT id, state FROM media').all<any>()).results;

describe.each([['KV', env], ['R2', envR2]] as const)('media on %s', (_name, e) => {
  it('stores and serves a file larger than one piece, with Range and HEAD', async () => {
    const w = new World();
    const bytes = file('video/mp4', KV_CHUNK + 3 * MB);
    const { body } = await w.upload(A, 'video/mp4', bytes, e);
    expect(body).toEqual({ id: expect.any(String), size: bytes.length });
    const url = await urlOf(body.id, 'mp4');
    expect(await mediaUrl(e, (await e.DB.prepare('SELECT * FROM media').first())!)).toBe(url);

    const whole = await get(w, url, {}, e);
    expect([whole.status, whole.headers.get('content-type'), whole.headers.get('content-length'), whole.headers.get('accept-ranges')])
      .toEqual([200, 'video/mp4', String(bytes.length), 'bytes']);
    const back = new Uint8Array(await whole.arrayBuffer());
    expect(back.length).toBe(bytes.length);
    expect(back.every((b, i) => b === bytes[i])).toBe(true);

    for (const [range, from, to] of [
      ['bytes=0-9', 0, 9],
      [`bytes=${KV_CHUNK - 5}-${KV_CHUNK + 4}`, KV_CHUNK - 5, KV_CHUNK + 4],
      [`bytes=${KV_CHUNK + MB}-`, KV_CHUNK + MB, bytes.length - 1],
      ['bytes=-7', bytes.length - 7, bytes.length - 1],
      [`bytes=5-${bytes.length * 2}`, 5, bytes.length - 1],
    ] as const) {
      const res = await get(w, url, { headers: { range } }, e);
      expect([res.status, res.headers.get('content-range')], range).toEqual([206, `bytes ${from}-${to}/${bytes.length}`]);
      const part = new Uint8Array(await res.arrayBuffer());
      expect(part.length).toBe(to - from + 1);
      expect(part.every((b, i) => b === bytes[from + i])).toBe(true);
    }
    expect((await get(w, url, { headers: { range: `bytes=${bytes.length}-` } }, e)).status).toBe(416);
    const head = await get(w, url, { method: 'HEAD' }, e);
    expect([head.status, head.headers.get('content-length'), (await head.arrayBuffer()).byteLength]).toEqual([200, String(bytes.length), 0]);
  });

  it('checks type, real content and size', async () => {
    const w = new World();
    const put = async (type: string, bytes: Uint8Array, length?: number) => (await w.upload(A, type, bytes, e, length)).status;
    expect(await put('image/gif', file('image/jpeg', 100))).toBe(415);
    expect(await put('image/png', file('image/jpeg', 100))).toBe(415);
    expect(await put('video/mp4', file('image/jpeg', 100))).toBe(415);
    const mov = file('video/mp4', 100);
    mov.set(new TextEncoder().encode('qt  '), 8);
    expect(await put('video/mp4', mov)).toBe(415);
    expect(await put('image/jpeg', new Uint8Array([0xff]))).toBe(415);
    expect(await put('image/jpeg', file('image/jpeg', 8 * MB + 1))).toBe(413);
    expect(await put('video/mp4', file('video/mp4', 100), 300 * MB + 1)).toBe(413);
    expect(await put('image/jpeg', file('image/jpeg', 100), 0)).toBe(411);
    expect(await put('image/jpeg', file('image/jpeg', 100), 200)).toBe(400);
    expect(await put('image/jpeg', file('image/jpeg', 100), 50)).toBe(400);
    expect((await rows()).every((r: any) => r.state === 'deleting')).toBe(true);
    expect(await put('image/jpeg', file('image/jpeg', 8 * MB))).toBe(200);
  });

  it('deletes the stored bytes', async () => {
    const w = new World();
    const id = await w.media(A, 'video/mp4', KV_CHUNK + 10, e);
    const stored = async () => e.MEDIA ? (await e.MEDIA.list()).objects.length : (await e.MEDIA_KV!.list()).keys.length;
    expect(await stored()).toBe(e.MEDIA ? 1 : 2);
    await cleanMedia(e, w.time + 14 * DAY + 1);
    expect(await stored()).toBe(0);
    expect(await rows()).toEqual([]);
    expect((await get(w, await urlOf(id, 'mp4'), {}, e)).status).toBe(404);
  });
});

describe('media links', () => {
  it('opens only with the right signature and extension', async () => {
    const w = new World();
    const id = await w.media(A, 'image/jpeg');
    const other = await w.media(A, 'image/jpeg');
    const sig = await sign(env.MEDIA_SIGN_KEY, id);
    expect((await get(w, `https://posting.test/m/${id}/${sig}.jpg`)).status).toBe(200);
    for (const path of [`${id}/${sig}.png`, `${other}/${sig}.jpg`, `${id}/${'A'.repeat(43)}.jpg`, `${id}/x.jpg`, `${crypto.randomUUID()}/${sig}.jpg`]) {
      expect((await get(w, `https://posting.test/m/${path}`)).status, path).toBe(404);
    }
    expect((await get(w, `https://posting.test/m/${id}/${sig}.jpg`, { method: 'DELETE' })).status).toBe(404);
  });

  it('asks to come back later when KV has not caught up', async () => {
    const w = new World();
    const id = await w.media(A, 'image/jpeg');
    await env.MEDIA_KV!.delete(`${id}/0`);
    expect((await get(w, await urlOf(id, 'jpg'))).status).toBe(503);
  });

  it('keeps media for queued posts, and deletes it 24 h after the last one finished', async () => {
    const w = new World();
    const channel = await w.channel(A, 'linkedin');
    const [used, unused] = [await w.media(A, 'image/jpeg'), await w.media(A, 'image/jpeg')];
    const one = await w.post(A, channel, { kind: 'images', media: [used], at: '2027-06-01T00:00:00Z' });
    const two = await w.post(A, channel, { kind: 'images', media: [used], at: '2027-06-01T00:00:00Z' });
    const left = async (ms: number) => { await cleanMedia(env, w.time + ms); return (await rows()).map((r: any) => r.id); };
    expect(await left(13 * DAY)).toHaveLength(2);
    expect(await left(14 * DAY + 1)).toEqual([used]);
    expect(unused).not.toBe(used);
    await w.api('DELETE', `posts/${one}?owner=${A}`);
    expect(await left(20 * DAY)).toEqual([used]);
    await w.api('DELETE', `posts/${two}?owner=${A}`);
    expect(await left(DAY - 1)).toEqual([used]);
    expect(await left(DAY + 1)).toEqual([]);
    expect((await w.get(A, two)).state).toBe('cancelled');
  });

  it('belongs to one doctor', async () => {
    const w = new World();
    const id = await w.media(A, 'image/jpeg');
    const channel = await w.channel(B, 'facebook');
    expect((await w.api('POST', 'posts', { owner: B, ref: 'r', channel, kind: 'images', text: '', media: [id], at: null })).status).toBe(404);
  });
});
