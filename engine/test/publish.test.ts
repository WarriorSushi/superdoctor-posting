import { describe, expect, it } from 'vitest';
import { dailyRefresh } from '../src/channels';
import { publishDue } from '../src/publish';
import { A, DAY, env, envR2, error, MINUTE, raw, World } from './helpers';

const IG = 'https://graph.instagram.com/v25.0';
const FB = 'https://graph.facebook.com/v25.0';
const LI = 'https://api.linkedin.com/rest';
const YT = 'https://www.googleapis.com/upload/youtube/v3/videos';
const linkedinPost = (id = 'urn:li:share:1') => new Response(null, { status: 201, headers: { 'x-restli-id': id } });
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}` }));
const done = (w: World) => expect(w.unexpected).toEqual([]);

describe('publishing rules', () => {
  it('waits for its time', async () => {
    const w = new World().on(`POST ${LI}/posts`, linkedinPost);
    const id = await w.post(A, await w.channel(A, 'linkedin'), { kind: 'text', at: new Date(w.time + 10 * MINUTE).toISOString() });
    await w.tick(9);
    expect((await w.get(A, id)).state).toBe('queued');
    await w.tick(2);
    expect(await w.get(A, id)).toMatchObject({ state: 'published', url: 'https://www.linkedin.com/feed/update/urn:li:share:1', error: null });
    const row = await raw(id);
    expect([row.sealed, row.lease, row.armed, row.platform_id]).toEqual([null, null, 0, 'urn:li:share:1']);
  });

  it('two overlapping crons publish once', async () => {
    const w = new World().on(`POST ${LI}/posts`, linkedinPost);
    const channel = await w.channel(A, 'linkedin');
    const posts = await Promise.all([1, 2, 3].map(() => w.post(A, channel, { kind: 'text' })));
    w.time += MINUTE;
    await Promise.all([publishDue(env, w.deps), publishDue(env, w.deps), publishDue(env, w.deps)]);
    expect(w.calls(`POST ${LI}/posts`)).toHaveLength(3);
    for (const id of posts) expect((await w.get(A, id)).state).toBe('published');
  });

  it('a cron that starts while another is mid-call leaves the post alone', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = new World().on(`POST ${LI}/posts`, () => gate.then(() => linkedinPost()));
    const id = await w.post(A, await w.channel(A, 'linkedin'), { kind: 'text' });
    w.time += MINUTE;
    const first = publishDue(env, w.deps);
    while (!w.calls(`POST ${LI}/posts`).length) await new Promise((r) => setTimeout(r, 5));
    await publishDue(env, w.deps);
    expect(await w.api('DELETE', `posts/${id}?owner=${A}`)).toMatchObject({ status: 409, body: { state: 'publishing' } });
    release();
    await first;
    expect(w.calls(`POST ${LI}/posts`)).toHaveLength(1);
    expect((await w.get(A, id)).state).toBe('published');
  });

  it('cancel and publish cannot both win', async () => {
    const w = new World().on(`POST ${LI}/posts`, linkedinPost);
    const channel = await w.channel(A, 'linkedin');
    for (let i = 0; i < 8; i++) {
      const id = await w.post(A, channel, { kind: 'text' });
      const before = w.calls(`POST ${LI}/posts`).length;
      w.time += MINUTE;
      const cancelling = () => w.api('DELETE', `posts/${id}?owner=${A}`);
      const [cancel] = i % 2
        ? await Promise.all([cancelling(), publishDue(env, w.deps)])
        : await Promise.all([publishDue(env, w.deps), cancelling()]).then(([, c]) => [c] as const);
      const { state } = await w.get(A, id);
      expect(cancel.status).toBe(state === 'cancelled' ? 200 : 409);
      await publishDue(env, w.deps);
      expect(w.calls(`POST ${LI}/posts`).length - before).toBe(state === 'cancelled' ? 0 : 1);
    }
  });

  it('no answer to the irreversible call: unconfirmed, and never called again', async () => {
    for (const reply of [() => { throw new Error('socket closed'); }, () => error(503, 'oops'), () => new Response(null, { status: 201 })]) {
      const w = new World().on(`POST ${LI}/posts`, reply as any).on(`POST ${FB}/acct/feed`, reply as any);
      const li = (await w.api('GET', `channels?owner=${A}`)).body.channels[0]?.id ?? (await w.channel(A, 'linkedin'));
      const id = await w.post(A, li, { kind: 'text' });
      for (let i = 0; i < 10; i++) await w.tick(10);
      const post = await w.get(A, id);
      expect(post.state).toBe('unconfirmed');
      expect(post.error).toMatch(/could not confirm/);
      expect(w.calls(`POST ${LI}/posts`)).toHaveLength(1);
    }
  });

  it('a crash after an irreversible call: unconfirmed, no second call', async () => {
    const w = new World();
    for (const platform of ['linkedin', 'facebook'] as const) {
      const id = await w.post(A, await w.channel(A, platform), { kind: 'text' });
      await env.DB.prepare("UPDATE posts SET state = 'publishing', armed = 1, lease = 'dead', lease_until = ? WHERE id = ?").bind(w.time + 5 * MINUTE, id).run();
      await w.tick(2);
      expect((await w.get(A, id)).state).toBe('publishing');
      await w.tick(5);
      expect((await w.get(A, id)).state).toBe('unconfirmed');
    }
    expect(w.seen).toHaveLength(0);
  });

  it('a crash before any irreversible call is tried again, but not for ever', async () => {
    const w = new World().on(`POST ${LI}/posts`, linkedinPost);
    const channel = await w.channel(A, 'linkedin');
    const crash = (id: string, attempts: number) =>
      env.DB.prepare("UPDATE posts SET state = 'publishing', lease = 'dead', attempts = ?, lease_until = ? WHERE id = ?").bind(attempts, w.time, id).run();
    const id = await w.post(A, channel, { kind: 'text' });
    await crash(id, 1);
    await w.tick(6);
    expect((await w.get(A, id)).state).toBe('published');
    const hopeless = await w.post(A, channel, { kind: 'text' });
    await crash(hopeless, 5);
    await w.tick(6);
    expect((await w.get(A, hopeless)).state).toBe('failed');
  });

  it('a run that lost its lease does not publish', async () => {
    const w = new World();
    w.on(`POST ${LI}/images?action=initializeUpload`, async () => {
      await env.DB.prepare("UPDATE posts SET lease = 'someone-else'").run();
      return { value: { uploadUrl: 'https://www.linkedin.com/up/1', image: 'urn:li:image:1' } };
    }).on('PUT https://www.linkedin.com/up/1', {}).on(`POST ${LI}/posts`, linkedinPost);
    const media = await w.media(A, 'image/png');
    const id = await w.post(A, await w.channel(A, 'linkedin'), { kind: 'images', media: [media] });
    await w.tick(2);
    expect((await raw(id)).sealed).toBeNull();
    expect(w.calls(`POST ${LI}/posts`)).toHaveLength(0);
  });

  it('removing the account mid-way stops the post before it goes out', async () => {
    const w = new World();
    const channel = await w.channel(A, 'facebook');
    w.on(`POST ${FB}/acct/photos`, async () => {
      await w.api('DELETE', `channels/${channel}?owner=${A}`);
      return { id: 'p1' };
    }).on(`POST ${FB}/acct/feed`, { id: 'x' });
    const id = await w.post(A, channel, { kind: 'images', media: [await w.media(A, 'image/jpeg')] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'failed', error: 'This account was disconnected before the post went out.' });
    expect(w.calls(`POST ${FB}/acct/feed`)).toHaveLength(0);
  });

  it('refreshes the token once and then publishes; a second token error stops and asks to reconnect', async () => {
    const w = new World()
      .on('POST https://www.linkedin.com/oauth/v2/accessToken', { access_token: 'tok-2', expires_in: 5184000 })
      .on(`POST ${LI}/posts`, error(401, {}), linkedinPost());
    const channel = await w.channel(A, 'linkedin');
    const id = await w.post(A, channel, { kind: 'text' });
    await w.tick(2);
    expect((await w.get(A, id)).state).toBe('published');
    expect(w.calls(`POST ${LI}/posts`).map((c) => c.headers.get('authorization'))).toEqual(['Bearer tok-1', 'Bearer tok-2']);
    expect(w.calls('POST https://www.linkedin.com/oauth')).toHaveLength(1);

    w.on(`POST ${LI}/posts`, error(401, {}));
    const second = await w.post(A, channel, { kind: 'text' });
    await w.tick(2);
    expect(await w.get(A, second)).toMatchObject({ state: 'failed', error: expect.stringMatching(/reconnect your LinkedIn/) });
    expect(w.calls('POST https://www.linkedin.com/oauth')).toHaveLength(2);
    expect((await w.api('GET', `channels?owner=${A}`)).body.channels[0].status).toBe('reconnect');

    const third = await w.post(A, channel, { kind: 'text' });
    await w.tick(2);
    expect(await w.get(A, third)).toMatchObject({ state: 'failed', error: expect.stringMatching(/reconnect/) });
    expect(w.calls(`POST ${LI}/posts`)).toHaveLength(4);
  });

  it('refreshes an expiring token before posting, and a network problem there does not disconnect the account', async () => {
    const w = new World()
      .on('POST https://oauth2.googleapis.com/token', () => { throw new Error('down'); })
      .on(`POST ${YT}`, new Response(null, { headers: { location: 'https://up.yt/1' } }))
      .on('PUT https://up.yt/1', { id: 'v1' });
    const channel = await w.channel(A, 'youtube', { expires: w.time });
    const id = await w.post(A, channel, { kind: 'video', title: 't', media: [await w.media(A, 'video/mp4')] });
    await w.tick(2);
    expect((await w.api('GET', `channels?owner=${A}`)).body.channels[0].status).toBe('ok');
    w.on('POST https://oauth2.googleapis.com/token', { access_token: 'tok-9', expires_in: 3600 });
    expect((await w.settle(A, id)).state).toBe('published');
    expect(w.calls(`POST ${YT}`)[0]!.headers.get('authorization')).toBe('Bearer tok-9');
  });

  it('a busy platform is tried again later, then given up in plain words', async () => {
    const w = new World().on(`POST ${LI}/posts`, error(429, 'slow down'), error(429, 'slow down'), linkedinPost());
    const channel = await w.channel(A, 'linkedin');
    const id = await w.post(A, channel, { kind: 'text' });
    expect((await w.settle(A, id)).state).toBe('published');
    w.on(`POST ${LI}/posts`, error(429, 'slow down'));
    const second = await w.post(A, channel, { kind: 'text' });
    expect(await w.settle(A, second)).toMatchObject({ state: 'failed', error: expect.stringMatching(/slow down/) });
    expect(w.calls(`POST ${LI}/posts`).length).toBe(3 + 5);
  });

  it('never stores tokens, texts of errors or upload links in the clear', async () => {
    const w = new World()
      .on(`POST ${YT}`, new Response(null, { headers: { location: 'https://up.yt/secret-session' } }))
      .on('PUT https://up.yt/secret-session', new Response(null, { status: 308 }));
    const id = await w.post(A, await w.channel(A, 'youtube'), { kind: 'video', title: 't', media: [await w.media(A, 'video/mp4')] });
    await w.tick(2);
    const row = await raw(id);
    expect(row.sealed).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('secret-session');
  });

  it('waits a minute for fresh KV media, but not for R2', async () => {
    for (const [e, state] of [[env, 'queued'], [envR2, 'published']] as const) {
      const w = new World().on(`POST ${FB}/acct/photos`, { id: 'p' }).on(`POST ${FB}/acct/feed`, { id: 'x_1', permalink_url: 'https://fb/x_1' });
      const channel = (await w.api('GET', `channels?owner=${A}`)).body.channels[0]?.id ?? (await w.channel(A, 'facebook'));
      const id = await w.post(A, channel, { kind: 'images', media: [await w.media(A, 'image/jpeg', 100, e)] });
      await w.tick(0.5, e);
      expect((await w.get(A, id)).state).toBe(state);
    }
  });
});

describe('daily token check', () => {
  it('refreshes what expires soon, marks dead ones, and leaves the rest alone', async () => {
    const w = new World()
      .on('GET https://graph.instagram.com/refresh_access_token', { access_token: 'ig-2' })
      .on('POST https://oauth2.googleapis.com/token', error(400, { error: 'invalid_grant' }));
    const soon = await w.channel(A, 'instagram', { expires: w.time + 5 * DAY });
    const dead = await w.channel(A, 'youtube', { expires: w.time });
    const quiet = await w.channel(A, 'linkedin', { expires: w.time + 5 * DAY, refresh: undefined });
    const all = () => env.DB.prepare('UPDATE channels SET check_at = 0').run();
    await all();
    await dailyRefresh(env, w.deps);
    const status = async () => Object.fromEntries((await w.api('GET', `channels?owner=${A}`)).body.channels.map((c: any) => [c.id, c.status]));
    expect(await status()).toEqual({ [soon]: 'ok', [dead]: 'reconnect', [quiet]: 'ok' });
    expect((await env.DB.prepare('SELECT expires_at FROM channels WHERE id = ?').bind(soon).first<any>()).expires_at).toBe(w.time + 58 * DAY);
    expect(w.seen).toHaveLength(2);
    await dailyRefresh(env, w.deps);
    expect(w.seen).toHaveLength(2);
    w.time += 6 * DAY;
    await all();
    await dailyRefresh(env, w.deps);
    expect((await status())[quiet]).toBe('reconnect');
    done(w);
  });
});

describe('Instagram', () => {
  it('one image', async () => {
    const w = new World()
      .on(`POST ${IG}/acct/media`, { id: 'c1' })
      .on(`GET ${IG}/c1`, { status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' })
      .on(`POST ${IG}/acct/media_publish`, { id: 'live' })
      .on(`GET ${IG}/live`, { permalink: 'https://www.instagram.com/p/x' });
    const id = await w.post(A, await w.channel(A, 'instagram'), { kind: 'images', media: [await w.media(A, 'image/jpeg')], text: 'नमस्ते & hello' });
    expect(await w.settle(A, id)).toMatchObject({ state: 'published', url: 'https://www.instagram.com/p/x' });
    const sent = new URLSearchParams(w.calls(`POST ${IG}/acct/media`)[0]!.body);
    expect(sent.get('caption')).toBe('नमस्ते & hello');
    expect(sent.get('image_url')).toMatch(/^https:\/\/posting\.test\/m\/[\w-]+\/[\w-]{43}\.jpg$/);
    expect(new URLSearchParams(w.calls(`POST ${IG}/acct/media_publish`)[0]!.body).get('creation_id')).toBe('c1');
    done(w);
  });

  it('a carousel', async () => {
    const w = new World()
      .on(`POST ${IG}/acct/media`, { id: 'c1' }, { id: 'c2' }, { id: 'car' })
      .on(`GET ${IG}/c`, { status_code: 'FINISHED' })
      .on(`POST ${IG}/acct/media_publish`, { id: 'live' })
      .on(`GET ${IG}/live`, () => error(500, ''));
    const id = await w.post(A, await w.channel(A, 'instagram'), { kind: 'images', media: [await w.media(A, 'image/jpeg'), await w.media(A, 'image/jpeg')] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'published', url: 'https://www.instagram.com/drrao' });
    const made = w.calls(`POST ${IG}/acct/media`).filter((c) => !c.url.endsWith('publish')).map((c) => Object.fromEntries(new URLSearchParams(c.body)));
    expect(made[0]).toMatchObject({ is_carousel_item: 'true' });
    expect(made[0]!.caption).toBeUndefined();
    expect(made[2]).toMatchObject({ media_type: 'CAROUSEL', caption: 'Namaste' });
    expect(made[2]!.children!.split(',').sort()).toEqual(['c1', 'c2']);
    expect(w.calls(`POST ${IG}/acct/media_publish`)).toHaveLength(1);
    done(w);
  });

  it('a reel', async () => {
    const w = new World()
      .on(`POST ${IG}/acct/media`, { id: 'c1' }).on(`GET ${IG}/c1`, { status_code: 'FINISHED' })
      .on(`POST ${IG}/acct/media_publish`, { id: 'live' }).on(`GET ${IG}/live`, { permalink: 'https://www.instagram.com/reel/x' });
    const id = await w.post(A, await w.channel(A, 'instagram'), { kind: 'video', media: [await w.media(A, 'video/mp4')] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'published', url: 'https://www.instagram.com/reel/x' });
    expect(Object.fromEntries(new URLSearchParams(w.calls(`POST ${IG}/acct/media`)[0]!.body))).toMatchObject({ media_type: 'REELS', video_url: expect.stringMatching(/\.mp4$/) });
    done(w);
  });

  it('says in plain words why media was refused', async () => {
    const w = new World()
      .on(`POST ${IG}/acct/media`, error(400, { error: { code: 36003, message: 'raw platform text' } }), { id: 'c1' })
      .on(`GET ${IG}/c1`, { status_code: 'ERROR', status: 'Error: 2207026 raw platform text' });
    const channel = await w.channel(A, 'instagram');
    const media = await w.media(A, 'image/jpeg');
    const one = await w.settle(A, await w.post(A, channel, { kind: 'images', media: [media] }));
    expect(one).toMatchObject({ state: 'failed', error: expect.stringMatching(/image shape is not supported/) });
    const two = await w.settle(A, await w.post(A, channel, { kind: 'images', media: [media] }));
    expect(two).toMatchObject({ state: 'failed', error: 'Instagram does not support this video format.' });
  });

  it('asks Instagram after an unclear answer: published if the container says so, else unconfirmed, never a second publish', async () => {
    for (const [after, state] of [['PUBLISHED', 'published'], ['FINISHED', 'unconfirmed']] as const) {
      const w = new World()
        .on(`POST ${IG}/acct/media`, { id: 'c1' })
        .on(`GET ${IG}/c1`, { status_code: 'FINISHED' }, { status_code: after })
        .on(`POST ${IG}/acct/media_publish`, () => error(500, { error: { message: 'An unknown error occurred', code: 1 } }));
      const channel = (await w.api('GET', `channels?owner=${A}`)).body.channels[0]?.id ?? (await w.channel(A, 'instagram'));
      const id = await w.post(A, channel, { kind: 'images', media: [await w.media(A, 'image/jpeg')] });
      expect((await w.settle(A, id)).state).toBe(state);
      expect(w.calls(`POST ${IG}/acct/media_publish`)).toHaveLength(1);
      done(w);
    }
  });

  it('a "blocked" answer is checked before it counts as failed', async () => {
    for (const [after, state] of [['PUBLISHED', 'published'], ['FINISHED', 'failed']] as const) {
      const w = new World()
        .on(`POST ${IG}/acct/media`, { id: 'c1' })
        .on(`GET ${IG}/c1`, { status_code: 'FINISHED' }, { status_code: after })
        .on(`POST ${IG}/acct/media_publish`, error(400, { error: { error_subcode: 2207051 } }));
      const channel = (await w.api('GET', `channels?owner=${A}`)).body.channels[0]?.id ?? (await w.channel(A, 'instagram'));
      const id = await w.post(A, channel, { kind: 'images', media: [await w.media(A, 'image/jpeg')] });
      expect((await w.settle(A, id)).state).toBe(state);
      expect(w.calls(`POST ${IG}/acct/media_publish`)).toHaveLength(1);
    }
  });

  it('gives up on media that never finishes, saying nothing was published', async () => {
    const w = new World().on(`POST ${IG}/acct/media`, { id: 'c1' }).on(`GET ${IG}/c1`, { status_code: 'IN_PROGRESS' });
    const id = await w.post(A, await w.channel(A, 'instagram'), { kind: 'images', media: [await w.media(A, 'image/jpeg')] });
    expect(await w.settle(A, id, 130)).toMatchObject({ state: 'failed', error: expect.stringMatching(/took too long/) });
  });
});

describe('Facebook', () => {
  it('text', async () => {
    const w = new World().on(`POST ${FB}/acct/feed`, { id: 'acct_1', permalink_url: 'https://www.facebook.com/acct_1' });
    const id = await w.post(A, await w.channel(A, 'facebook'), { kind: 'text' });
    expect(await w.settle(A, id)).toMatchObject({ state: 'published', url: 'https://www.facebook.com/acct_1' });
    expect(JSON.parse(w.calls(`POST ${FB}/acct/feed`)[0]!.body)).toEqual({ message: 'Namaste', published: true });
    done(w);
  });

  it('images', async () => {
    const w = new World().on(`POST ${FB}/acct/photos`, { id: 'p1' }, { id: 'p2' }).on(`POST ${FB}/acct/feed`, { id: 'acct_2' });
    const id = await w.post(A, await w.channel(A, 'facebook'), { kind: 'images', media: [await w.media(A, 'image/jpeg'), await w.media(A, 'image/png')] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'published', url: 'https://www.facebook.com/acct_2' });
    expect(JSON.parse(w.calls(`POST ${FB}/acct/photos`)[0]!.body)).toMatchObject({ published: false });
    expect(JSON.parse(w.calls(`POST ${FB}/acct/feed`)[0]!.body).attached_media).toHaveLength(2);
    done(w);
  });

  it('video, published only once Facebook has processed it', async () => {
    const w = new World().on(`POST ${FB}/acct/videos`, { id: 'v1' })
      .on(`GET ${FB}/v1`, { status: { video_status: 'processing' } }, { status: { video_status: 'ready' } });
    const channel = await w.channel(A, 'facebook');
    const media = await w.media(A, 'video/mp4');
    const id = await w.post(A, channel, { kind: 'video', media: [media] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'published', url: 'https://www.facebook.com/reel/v1' });
    w.on(`GET ${FB}/v1`, { status: { video_status: 'error' } });
    expect(await w.settle(A, await w.post(A, channel, { kind: 'video', media: [media] }))).toMatchObject({ state: 'failed', error: expect.stringMatching(/could not process the video/) });
    // accepted, but the sign-in died before Facebook could be asked
    w.on(`GET ${FB}/v1`, error(400, { error: { code: 190 } }));
    expect((await w.settle(A, await w.post(A, channel, { kind: 'video', media: [media] }))).state).toBe('unconfirmed');
    expect(w.calls(`POST ${FB}/acct/videos`)).toHaveLength(3);
    done(w);
  });

  it('explains a refusal, and a dead page token needs reconnecting', async () => {
    const w = new World().on(`POST ${FB}/acct/feed`, error(400, { error: { error_subcode: 1404102, message: 'raw' } }), error(400, { error: { code: 190, message: 'Error validating access token: secret' } }));
    const channel = await w.channel(A, 'facebook');
    expect(await w.settle(A, await w.post(A, channel, { kind: 'text' }))).toMatchObject({ state: 'failed', error: 'Facebook says this goes against its Community Standards.' });
    expect(await w.settle(A, await w.post(A, channel, { kind: 'text' }))).toMatchObject({ state: 'failed', error: 'Please reconnect your Facebook Page.' });
    expect((await w.api('GET', `channels?owner=${A}`)).body.channels[0].status).toBe('reconnect');
  });
});

describe('YouTube', () => {
  const MB = 1024 * 1024;
  const session = new Response(null, { headers: { location: 'https://up.yt/1' } });
  const more = (last: number) => new Response(null, { status: 308, headers: { range: `bytes=0-${last}` } });

  it('uploads in pieces and publishes', async () => {
    const w = new World().on(`POST ${YT}`, session).on('PUT https://up.yt/1', more(20 * MB - 1), { id: 'v1' });
    const size = 25 * MB;
    const id = await w.post(A, await w.channel(A, 'youtube'), { kind: 'video', title: 'Monsoon fever', media: [await w.media(A, 'video/mp4', size)] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'published', url: 'https://www.youtube.com/watch?v=v1' });
    const start = w.calls(`POST ${YT}`)[0]!;
    expect(start.headers.get('x-upload-content-length')).toBe(String(size));
    expect(JSON.parse(start.body)).toEqual({ snippet: { title: 'Monsoon fever', description: 'Namaste' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } });
    expect(w.calls('PUT https://up.yt/1').map((c) => [c.headers.get('content-range'), c.size])).toEqual([
      [`bytes 0-${20 * MB - 1}/${size}`, 20 * MB], [`bytes ${20 * MB}-${size - 1}/${size}`, 5 * MB],
    ]);
    done(w);
  });

  it('goes on from the offset YouTube reports after a broken piece', async () => {
    const size = 3 * MB;
    const w = new World().on(`POST ${YT}`, session)
      .on('PUT https://up.yt/1', () => error(503, ''), more(MB - 1), more(MB - 1), { id: 'v1' });
    const id = await w.post(A, await w.channel(A, 'youtube'), { kind: 'video', title: 't', media: [await w.media(A, 'video/mp4', size)] });
    expect((await w.settle(A, id)).state).toBe('published');
    expect(w.calls(`POST ${YT}`)).toHaveLength(1);
    expect(w.calls('PUT https://up.yt/1').map((c) => c.headers.get('content-range'))).toEqual([
      `bytes 0-${size - 1}/${size}`, `bytes */${size}`, `bytes */${size}`, `bytes ${MB}-${size - 1}/${size}`,
    ]);
    done(w);
  });

  it('after a crash on the last piece it asks the session: found, or unconfirmed when the session is gone', async () => {
    for (const [answer, state] of [[{ id: 'v1' }, 'published'], [error(410, ''), 'unconfirmed']] as const) {
      const w = new World().on(`POST ${YT}`, session).on('PUT https://up.yt/1', () => { throw new Error('crash'); }, answer);
      const channel = (await w.api('GET', `channels?owner=${A}`)).body.channels[0]?.id ?? (await w.channel(A, 'youtube'));
      const id = await w.post(A, channel, { kind: 'video', title: 't', media: [await w.media(A, 'video/mp4')] });
      expect((await w.settle(A, id)).state).toBe(state);
      expect(w.calls(`POST ${YT}`)).toHaveLength(1);
    }
  });

  it('hands back after a few pieces and goes on next tick', async () => {
    const size = 200 * MB;
    const w = new World().on(`POST ${YT}`, session);
    let at = 0;
    w.on('PUT https://up.yt/1', () => {
      const range = w.seen.at(-1)!.headers.get('content-range')!;
      if (!range.startsWith('bytes *')) at = Number(/-(\d+)\//.exec(range)![1]) + 1;
      return at === size ? { id: 'v1' } : at ? more(at - 1) : new Response(null, { status: 308 });
    });
    const id = await w.post(A, await w.channel(A, 'youtube'), { kind: 'video', title: 't', media: [await w.media(A, 'video/mp4', 100)] });
    // pretend it is big: the same small pieces are enough to test the paging
    await env.DB.prepare('UPDATE media SET size = ?').bind(size).run();
    const fake = new Proxy(env.MEDIA_KV!, { get: (t, k) => (k === 'get' ? async () => new Blob([new Uint8Array(20 * MB)]).stream() : Reflect.get(t, k)) });
    await w.tick(2, { ...env, MEDIA_KV: fake });
    expect((await w.get(A, id)).state).toBe('publishing');
    expect(w.calls('PUT https://up.yt/1')).toHaveLength(8);
    await w.tick(2, { ...env, MEDIA_KV: fake });
    expect((await w.get(A, id)).state).toBe('published');
    done(w);
  });

  it('explains a refusal', async () => {
    const w = new World().on(`POST ${YT}`, error(400, { error: { errors: [{ reason: 'uploadLimitExceeded' }] } }));
    const id = await w.post(A, await w.channel(A, 'youtube'), { kind: 'video', title: 't', media: [await w.media(A, 'video/mp4')] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'failed', error: 'You have reached your daily YouTube upload limit. Please try again tomorrow.' });
  });
});

describe('LinkedIn', () => {
  const MB = 1024 * 1024;

  it('text, escaped', async () => {
    const w = new World().on(`POST ${LI}/posts`, linkedinPost);
    const id = await w.post(A, await w.channel(A, 'linkedin'), { kind: 'text', text: 'BP (120/80) #health' });
    expect((await w.settle(A, id)).state).toBe('published');
    const call = w.calls(`POST ${LI}/posts`)[0]!;
    expect(JSON.parse(call.body)).toMatchObject({ author: 'urn:li:person:acct', commentary: 'BP \\(120/80\\) \\#health', lifecycleState: 'PUBLISHED', visibility: 'PUBLIC' });
    expect(JSON.parse(call.body).content).toBeUndefined();
    expect(call.headers.get('linkedin-version')).toBe('202611');
    done(w);
  });

  it('one image and many images', async () => {
    for (const n of [1, 3]) {
      const w = new World().on(`POST ${LI}/images?action=initializeUpload`, ...ids(n).map(({ id }) => ({ value: { uploadUrl: `https://www.linkedin.com/up/${id}`, image: `urn:li:image:${id}` } })))
        .on('PUT https://www.linkedin.com/up/', {}).on(`POST ${LI}/posts`, linkedinPost);
      const channel = (await w.api('GET', `channels?owner=${A}`)).body.channels[0]?.id ?? (await w.channel(A, 'linkedin'));
      const media = [];
      for (let i = 0; i < n; i++) media.push(await w.media(A, 'image/jpeg', 500 + i));
      expect((await w.settle(A, await w.post(A, channel, { kind: 'images', media }))).state).toBe('published');
      expect(w.calls('PUT https://www.linkedin.com/up/').map((c) => c.size)).toEqual(media.map((_, i) => 500 + i));
      const { content } = JSON.parse(w.calls(`POST ${LI}/posts`)[0]!.body);
      expect(content).toEqual(n === 1 ? { media: { id: 'urn:li:image:m1' } } : { multiImage: { images: ids(n).map(({ id }) => ({ id: `urn:li:image:${id}` })) } });
      done(w);
    }
  });

  it('video, in the parts LinkedIn asks for', async () => {
    const size = 9 * MB;
    const part = 4 * MB;
    const parts = [0, 1, 2].map((i) => ({ uploadUrl: `https://www.linkedin.com/part/${i}`, firstByte: i * part, lastByte: Math.min((i + 1) * part, size) - 1 }));
    const w = new World()
      .on(`POST ${LI}/videos?action=initializeUpload`, { value: { video: 'urn:li:video:1', uploadToken: 'up-token', uploadInstructions: parts } })
      .on(`POST ${LI}/videos?action=finalizeUpload`, {})
      .on(`GET ${LI}/videos/urn%3Ali%3Avideo%3A1`, { status: 'PROCESSING' }, () => error(500, ''), { status: 'AVAILABLE' })
      .on(`POST ${LI}/posts`, linkedinPost);
    parts.forEach((p, i) => w.on(`PUT ${p.uploadUrl}`, () => new Response(null, { headers: { etag: `"tag-${i}"` } })));
    // the second part breaks once: it goes on from there, not from the start
    w.on(`PUT ${parts[1]!.uploadUrl}`, () => error(502, ''), () => new Response(null, { headers: { etag: '"tag-1"' } }));
    const id = await w.post(A, await w.channel(A, 'linkedin'), { kind: 'video', media: [await w.media(A, 'video/mp4', size)] });
    expect((await w.settle(A, id)).state).toBe('published');
    expect(w.calls('PUT https://www.linkedin.com/part/').map((c) => [c.url.at(-1), c.size])).toEqual([['0', part], ['1', part], ['1', part], ['2', MB]]);
    expect(JSON.parse(w.calls(`POST ${LI}/videos?action=finalizeUpload`)[0]!.body)).toEqual({ finalizeUploadRequest: { video: 'urn:li:video:1', uploadToken: 'up-token', uploadedPartIds: ['tag-0', 'tag-1', 'tag-2'] } });
    expect(JSON.parse(w.calls(`POST ${LI}/posts`)[0]!.body).content).toEqual({ media: { id: 'urn:li:video:1' } });
    done(w);
  });

  it('explains a video LinkedIn cannot process', async () => {
    const w = new World()
      .on(`POST ${LI}/videos?action=initializeUpload`, { value: { video: 'urn:li:video:1', uploadToken: '', uploadInstructions: [{ uploadUrl: 'https://www.linkedin.com/part/0', firstByte: 0, lastByte: 999 }] } })
      .on('PUT https://www.linkedin.com/part/0', () => new Response(null, { headers: { etag: 'a' } }))
      .on(`POST ${LI}/videos?action=finalizeUpload`, {})
      .on(`GET ${LI}/videos/`, { status: 'PROCESSING_FAILED', processingFailureReason: 'raw reason' });
    const id = await w.post(A, await w.channel(A, 'linkedin'), { kind: 'video', media: [await w.media(A, 'video/mp4')] });
    expect(await w.settle(A, id)).toMatchObject({ state: 'failed', error: 'LinkedIn could not process the video. Please try another file.' });
  });
});
