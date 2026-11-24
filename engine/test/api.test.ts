import { describe, expect, it } from 'vitest';
import { open } from '../src/crypto';
import { handle } from '../src/index';
import { A, B, DAY, env, MINUTE, raw, World } from './helpers';

const CB = (p: string) => `https://app.test/api/channels/callback/${p}`;

describe('access', () => {
  it('needs the secret on every /v1 route and hides everything else', async () => {
    const w = new World();
    for (const [method, path] of [['GET', 'health'], ['GET', `channels?owner=${A}`], ['POST', 'connect'], ['POST', 'complete'], ['POST', 'choose'],
      ['DELETE', `channels/x?owner=${A}`], ['PUT', `media?owner=${A}`], ['POST', 'posts'], ['PATCH', 'posts/x'], ['DELETE', `posts/x?owner=${A}`],
      ['GET', `posts?owner=${A}&ids=x`], ['GET', `analytics/x?owner=${A}`]] as const) {
      for (const authorization of ['', 'Bearer ', 'Bearer wrong', 'Basic test-posting-secret']) {
        const res = await handle(env, w.deps, new Request(`https://posting.test/v1/${path}`, { method, headers: { authorization } }));
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
    expect((await handle({ ...env, POSTING_SECRET: '' }, w.deps, new Request('https://posting.test/v1/health', { headers: { authorization: 'Bearer ' } }))).status).toBe(401);
    expect((await handle(env, w.deps, new Request('https://posting.test/'))).status).toBe(404);
  });

  it('reports which platforms are configured', async () => {
    const w = new World();
    expect((await w.api('GET', 'health', undefined, { ...env, YOUTUBE_CLIENT_SECRET: '' })).body)
      .toEqual({ ok: true, platforms: { instagram: true, facebook: true, youtube: false, linkedin: true } });
    expect((await w.api('POST', 'connect', { owner: A, platform: 'youtube', redirect_uri: CB('youtube') }, { ...env, YOUTUBE_CLIENT_SECRET: '' })).status).toBe(503);
  });

  it('rejects a bad owner, a bad body and unknown routes in plain words', async () => {
    const w = new World();
    expect((await w.api('GET', 'channels?owner=nope')).status).toBe(400);
    expect((await w.api('GET', 'channels')).status).toBe(400);
    expect((await w.api('POST', 'connect', [])).status).toBe(400);
    expect((await w.api('GET', 'nope')).status).toBe(404);
    expect((await w.api('POST', 'connect', { owner: A, platform: 'toString', redirect_uri: CB('x') })).status).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('never lets one doctor see or touch another', async () => {
    const w = new World();
    const channel = await w.channel(A, 'linkedin');
    const media = await w.media(A, 'image/jpeg');
    const post = await w.post(A, channel, { ref: 'shared-ref', kind: 'images', media: [media], at: '2026-12-25T10:00:00+05:30' });

    expect((await w.api('GET', `channels?owner=${B}`)).body.channels).toEqual([]);
    expect((await w.api('GET', `channels?owner=${A}`)).body.channels).toEqual([
      { id: channel, platform: 'linkedin', name: 'Dr Rao', handle: 'drrao', picture: '', status: 'ok' },
    ]);
    expect((await w.api('GET', `posts?owner=${B}&ids=${post}&refs=shared-ref`)).body.posts).toEqual([]);
    expect((await w.api('PATCH', `posts/${post}`, { owner: B, at: null })).status).toBe(404);
    expect((await w.api('DELETE', `posts/${post}?owner=${B}`)).status).toBe(404);
    expect((await w.api('DELETE', `channels/${channel}?owner=${B}`)).status).toBe(404);
    expect((await w.api('GET', `analytics/${channel}?owner=${B}`)).status).toBe(404);
    expect((await w.api('POST', 'posts', { owner: B, ref: 'r', channel, kind: 'text', text: 'x', at: null })).status).toBe(404);
    const own = await w.channel(B, 'linkedin');
    expect((await w.api('POST', 'posts', { owner: B, ref: 'r', channel: own, kind: 'images', text: 'x', media: [media], at: null })).status).toBe(404);
    // the same ref belongs to each doctor separately
    const mine = await w.post(B, own, { ref: 'shared-ref', kind: 'text' });
    expect(mine).not.toBe(post);
    expect((await raw(post)).state).toBe('queued');
    expect((await w.api('GET', `channels?owner=${A}`)).body.channels).toHaveLength(1);
  });
});

describe('connecting', () => {
  const youtube = (w: World) => w
    .on('POST https://oauth2.googleapis.com/token', { access_token: 'yt-access', refresh_token: 'yt-refresh', expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly' })
    .on('GET https://www.googleapis.com/youtube/v3/channels', { items: [{ id: 'UC1', snippet: { title: 'Dr Rao Clinic', customUrl: '@drrao', thumbnails: { default: { url: 'https://p/1' } } } }] });
  const start = async (w: World, platform: string, owner = A) => {
    const { body } = await w.api('POST', 'connect', { owner, platform, redirect_uri: CB(platform) });
    return new URL(body.url);
  };

  it('only returns to the private app', async () => {
    const w = new World();
    for (const redirect_uri of ['https://evil.test/x', 'https://app.test.evil.test/x', 'https://app.test@evil.test/', 'javascript:1', '', undefined, 'http://app.test/x']) {
      expect((await w.api('POST', 'connect', { owner: A, platform: 'youtube', redirect_uri })).status, String(redirect_uri)).toBe(400);
    }
  });

  it('connects YouTube with PKCE, hides tokens, and a state works once', async () => {
    const w = youtube(new World());
    const url = await start(w, 'youtube');
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(CB('youtube'));
    const state = url.searchParams.get('state')!;
    expect(state.length).toBeGreaterThan(40);

    const done = await w.api('POST', 'complete', { owner: A, platform: 'youtube', state, code: 'c' });
    expect(done.body.channels).toEqual([{ id: expect.any(String), platform: 'youtube', name: 'Dr Rao Clinic', handle: '@drrao', picture: 'https://p/1', status: 'ok' }]);
    const sent = new URLSearchParams(w.calls('POST https://oauth2')[0]!.body);
    expect(sent.get('redirect_uri')).toBe(CB('youtube'));
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent.get('code_verifier')!));
    expect(btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')).toBe(url.searchParams.get('code_challenge'));

    const row = await env.DB.prepare('SELECT * FROM channels').first<any>();
    expect(JSON.stringify(row)).not.toContain('yt-access');
    expect(await open(env.TOKEN_KEY, row.id, row.sealed)).toMatchObject({ access: 'yt-access', refresh: 'yt-refresh' });
    await expect(open(env.TOKEN_KEY, crypto.randomUUID(), row.sealed)).rejects.toThrow();

    expect((await w.api('POST', 'complete', { owner: A, platform: 'youtube', state, code: 'c' })).status).toBe(400);

    // connecting the same account again keeps the channel id and clears "reconnect"
    await env.DB.prepare("UPDATE channels SET status = 'reconnect'").run();
    const again = await w.api('POST', 'complete', { owner: A, platform: 'youtube', state: (await start(w, 'youtube')).searchParams.get('state'), code: 'c' });
    expect(again.body.channels[0]).toMatchObject({ id: row.id, status: 'ok' });
  });

  it('refuses an expired state, another owner and another platform, without burning it for the right owner', async () => {
    const w = youtube(new World());
    const state = (await start(w, 'youtube')).searchParams.get('state');
    expect((await w.api('POST', 'complete', { owner: B, platform: 'youtube', state, code: 'c' })).status).toBe(400);
    expect((await w.api('POST', 'complete', { owner: A, platform: 'linkedin', state, code: 'c' })).status).toBe(400);
    expect((await w.api('POST', 'complete', { owner: A, platform: 'youtube', state: 'nope', code: 'c' })).status).toBe(400);
    expect(w.seen).toHaveLength(0);
    const late = (await start(w, 'youtube')).searchParams.get('state');
    expect((await w.api('POST', 'complete', { owner: A, platform: 'youtube', state, code: 'c' })).status).toBe(200);
    w.time += 16 * MINUTE;
    expect((await w.api('POST', 'complete', { owner: A, platform: 'youtube', state: late, code: 'c' })).status).toBe(400);
  });

  it('connects Instagram and LinkedIn', async () => {
    const w = new World()
      .on('POST https://api.instagram.com/oauth/access_token', { access_token: 'short', user_id: 1, permissions: ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights'] })
      .on('GET https://graph.instagram.com/access_token', { access_token: 'long' })
      .on('GET https://graph.instagram.com/v25.0/me', { user_id: '17', username: 'drrao', name: 'Dr Rao', profile_picture_url: 'https://p/2' })
      .on('POST https://www.linkedin.com/oauth/v2/accessToken', { access_token: 'li', expires_in: 5184000, scope: 'openid,profile,w_member_social' })
      .on('GET https://api.linkedin.com/v2/userinfo', { sub: 'abc', name: 'Dr Rao', picture: 'https://p/3' });
    const ig = await start(w, 'instagram');
    expect(ig.searchParams.get('scope')).toContain('instagram_business_content_publish');
    expect((await w.api('POST', 'complete', { owner: A, platform: 'instagram', state: ig.searchParams.get('state'), code: 'c' })).body.channels[0])
      .toMatchObject({ platform: 'instagram', handle: 'drrao', picture: 'https://p/2' });
    const li = await start(w, 'linkedin');
    expect((await w.api('POST', 'complete', { owner: A, platform: 'linkedin', state: li.searchParams.get('state'), code: 'c' })).body.channels[0])
      .toMatchObject({ platform: 'linkedin', name: 'Dr Rao', picture: 'https://p/3' });
  });

  it('lets the doctor choose Facebook pages, once, and only from their own list', async () => {
    const w = new World()
      .on('GET https://graph.facebook.com/v25.0/oauth/access_token', { access_token: 'user-token' })
      .on('GET https://graph.facebook.com/v25.0/me/permissions', { data: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'].map((permission) => ({ permission, status: 'granted' })) })
      .on('GET https://graph.facebook.com/v25.0/me/accounts', { data: [
        { id: '10', name: 'Clinic', username: 'clinic', access_token: 'page-10', picture: { data: { url: 'https://p/10' } } },
        { id: '11', name: 'Hospital', access_token: 'page-11' },
        { id: '12', name: 'No access' },
      ] });
    const fb = await start(w, 'facebook');
    const { body } = await w.api('POST', 'complete', { owner: A, platform: 'facebook', state: fb.searchParams.get('state'), code: 'c' });
    expect(body.choose.options).toEqual([{ id: '10', name: 'Clinic', picture: 'https://p/10' }, { id: '11', name: 'Hospital', picture: '' }]);
    expect(JSON.stringify(body)).not.toContain('page-1');
    const { ticket } = body.choose;
    expect((await w.api('POST', 'choose', { owner: B, ticket, ids: ['10'] })).status).toBe(400);
    expect((await w.api('POST', 'choose', { owner: A, ticket, ids: ['99'] })).status).toBe(400);
    expect((await w.api('POST', 'choose', { owner: A, ticket, ids: [] })).status).toBe(400);
    const chosen = await w.api('POST', 'choose', { owner: A, ticket, ids: ['10', '11'] });
    expect(chosen.body.channels.map((c: any) => c.name)).toEqual(['Clinic', 'Hospital']);
    expect((await w.api('POST', 'choose', { owner: A, ticket, ids: ['10'] })).status).toBe(400);
  });

  it('explains missing permissions and a refused code without leaking the platform answer', async () => {
    const w = new World()
      .on('POST https://www.linkedin.com/oauth/v2/accessToken', { access_token: 'li', expires_in: 1, scope: 'openid,profile' }, new Response('{"error":"secret-detail"}', { status: 400 }));
    const one = await w.api('POST', 'complete', { owner: A, platform: 'linkedin', state: (await start(w, 'linkedin')).searchParams.get('state'), code: 'c' });
    expect(one).toEqual({ status: 400, body: { error: 'Some permissions were not allowed. Please connect LinkedIn again and allow all of them.' } });
    const two = await w.api('POST', 'complete', { owner: A, platform: 'linkedin', state: (await start(w, 'linkedin')).searchParams.get('state'), code: 'c' });
    expect(two.status).toBe(400);
    expect(JSON.stringify(two.body)).not.toContain('secret-detail');
  });
});

describe('posts', () => {
  it('is idempotent on owner + ref, before validation', async () => {
    const w = new World();
    const channel = await w.channel(A, 'linkedin');
    const media = await w.media(A, 'image/jpeg');
    const body = { owner: A, ref: 'r1', channel, kind: 'images', text: 'x', media: [media], at: '2026-12-25T10:00:00+05:30' };
    const all = await Promise.all([1, 2, 3].map(() => w.api('POST', 'posts', body)));
    expect(new Set(all.map((r) => r.body.id)).size).toBe(1);
    const { results } = await env.DB.prepare('SELECT * FROM posts').all();
    expect(results).toHaveLength(1);
    await w.api('DELETE', `channels/${channel}?owner=${A}`);
    expect((await w.api('POST', 'posts', { owner: A, ref: 'r1', kind: 'nonsense' })).body).toEqual({ id: all[0]!.body.id, state: 'cancelled' });
  });

  it('finds posts by id and by ref', async () => {
    const w = new World();
    const channel = await w.channel(A, 'linkedin');
    const one = await w.post(A, channel, { ref: 'r1', kind: 'text', at: '2026-12-25T10:00:00+05:30' });
    const two = await w.post(A, channel, { ref: 'r2', kind: 'text' });
    const get = async (q: string) => (await w.api('GET', `posts?owner=${A}&${q}`)).body.posts.map((p: any) => p.id).sort();
    expect(await get('refs=r1')).toEqual([one]);
    expect(await get(`ids=${two}`)).toEqual([two]);
    expect(await get(`ids=${two}&refs=r1,unknown`)).toEqual([one, two].sort());
    expect((await w.api('GET', `posts?owner=${A}&refs=r1`)).body.posts[0])
      .toEqual({ id: one, ref: 'r1', channel, state: 'queued', error: null, url: null, at: '2026-12-25T04:30:00.000Z' });
    expect((await w.api('GET', `posts?owner=${A}`)).status).toBe(400);
    expect((await w.api('GET', `posts?owner=${A}&ids=${'x,'.repeat(60)}&refs=${'y,'.repeat(41)}`)).status).toBe(400);
  });

  it('validates per platform in plain words', async () => {
    const w = new World();
    const [ig, yt, li, fb] = [await w.channel(A, 'instagram'), await w.channel(A, 'youtube'), await w.channel(A, 'linkedin'), await w.channel(A, 'facebook')];
    const jpg = await w.media(A, 'image/jpeg');
    const png = await w.media(A, 'image/png');
    const mp4 = await w.media(A, 'video/mp4');
    const eleven = await Promise.all(Array.from({ length: 11 }, () => w.media(A, 'image/jpeg')));
    const refuse = async (channel: string, fields: object, message: RegExp) => {
      const { status, body } = await w.api('POST', 'posts', { owner: A, ref: crypto.randomUUID(), channel, text: 'x', at: null, ...fields });
      expect(status, JSON.stringify(fields)).toBe(400);
      expect(body.error).toMatch(message);
    };
    await refuse(ig, { kind: 'text' }, /needs an image or a video/);
    await refuse(ig, { kind: 'images', media: [png] }, /JPG/);
    await refuse(ig, { kind: 'images', media: eleven }, /between 1 and 10/);
    await refuse(ig, { kind: 'images', media: [] }, /between 1 and 10/);
    await refuse(ig, { kind: 'images', media: [mp4] }, /between 1 and 10/);
    await refuse(ig, { kind: 'images', media: [jpg], text: 'x'.repeat(2201) }, /too long for Instagram/);
    await refuse(yt, { kind: 'images', media: [jpg], title: 't' }, /YouTube needs a video/);
    await refuse(yt, { kind: 'video', media: [mp4] }, /title/);
    await refuse(yt, { kind: 'video', media: [mp4], title: 'x'.repeat(101) }, /100 characters/);
    await refuse(yt, { kind: 'video', media: [mp4], title: 'BP <120' }, /< or >/);
    await refuse(yt, { kind: 'video', media: [mp4], title: 't', text: 'न'.repeat(1700) }, /too long for YouTube/);
    await refuse(li, { kind: 'text', text: 'x'.repeat(3001) }, /too long for LinkedIn/);
    await refuse(li, { kind: 'text', text: '  ' }, /write something/);
    await refuse(li, { kind: 'text', media: [jpg] }, /text post/);
    await refuse(li, { kind: 'video', media: [jpg] }, /exactly one MP4/);
    await refuse(li, { kind: 'images', media: [jpg, jpg] }, /media list/);
    await refuse(fb, { kind: 'text', text: 'x'.repeat(60001) }, /too long for Facebook/);
    await refuse(fb, { kind: 'poll' }, /post type/);
    await refuse(fb, { kind: 'text', at: 'tomorrow' }, /time/);
    await refuse(fb, { kind: 'text', at: '2026-12-25T10:00:00' }, /time/);
  });

  it('moves and cancels only while queued', async () => {
    const w = new World();
    const channel = await w.channel(A, 'linkedin');
    const id = await w.post(A, channel, { kind: 'text', at: '2026-12-25T10:00:00Z' });
    expect((await w.api('PATCH', `posts/${id}`, { owner: A, at: '2026-12-26T10:00:00Z' })).body).toEqual({ id, state: 'queued' });
    expect((await w.get(A, id)).at).toBe('2026-12-26T10:00:00.000Z');
    expect((await w.api('DELETE', `posts/${id}?owner=${A}`)).body).toEqual({ state: 'cancelled' });
    expect((await w.api('DELETE', `posts/${id}?owner=${A}`)).body).toEqual({ state: 'cancelled' });
    expect(await w.api('PATCH', `posts/${id}`, { owner: A, at: null })).toMatchObject({ status: 409, body: { state: 'cancelled' } });
    for (const state of ['publishing', 'published', 'unconfirmed']) {
      const p = await w.post(A, channel, { kind: 'text', at: '2026-12-25T10:00:00Z' });
      await env.DB.prepare('UPDATE posts SET state = ? WHERE id = ?').bind(state, p).run();
      expect(await w.api('DELETE', `posts/${p}?owner=${A}`)).toMatchObject({ status: 409, body: { state } });
      expect((await w.api('PATCH', `posts/${p}`, { owner: A, at: null })).status).toBe(409);
    }
  });

  it('deleting a channel removes its tokens and cancels its queued posts', async () => {
    const w = new World();
    const [channel, other] = [await w.channel(A, 'linkedin'), await w.channel(A, 'facebook')];
    const queued = await w.post(A, channel, { kind: 'text', at: '2026-12-25T10:00:00Z' });
    const kept = await w.post(A, other, { kind: 'text', at: '2026-12-25T10:00:00Z' });
    expect((await w.api('DELETE', `channels/${channel}?owner=${A}`)).body).toEqual({ ok: true });
    expect((await w.get(A, queued)).state).toBe('cancelled');
    expect((await w.get(A, kept)).state).toBe('queued');
    expect(await env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(channel).first()).toBeNull();
    w.time += 60 * DAY;
    await env.DB.prepare("UPDATE posts SET state = 'cancelled' WHERE id = ?").bind(kept).run();
    await w.tick();
    expect(w.seen).toHaveLength(0);
  });
});

describe('analytics', () => {
  it('maps each platform and gives no rows for LinkedIn', async () => {
    const w = new World()
      .on('GET https://graph.instagram.com/v25.0/acct/insights?metric=follower_count,reach', { data: [{ name: 'reach', values: [{ value: 3, end_time: '2026-11-29T08:00:00+0000' }, { value: 4, end_time: '2026-11-30T08:00:00+0000' }] }] })
      .on('GET https://graph.instagram.com/v25.0/acct/insights?metric_type=total_value', { data: [{ name: 'likes', total_value: { value: 9 } }] })
      .on('GET https://graph.facebook.com/v25.0/acct/insights', { data: [{ name: 'page_media_view', values: [{ value: { paid: 1, organic: 2 }, end_time: '2026-11-30T08:00:00+0000' }] }] })
      .on('GET https://youtubeanalytics.googleapis.com/v2/reports', {
        columnHeaders: ['day', 'views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'subscribersGained', 'likes', 'subscribersLost'].map((name) => ({ name })),
        rows: [['2026-11-29', 10, 5, 30, 40, 1, 2, 0], ['2026-11-30', 20, 6, 60, 45, 2, 3, 1]],
      });
    const rows = async (id: string, q = '') => (await w.api('GET', `analytics/${id}?owner=${A}${q}`)).body.rows;
    expect(await rows(await w.channel(A, 'instagram'))).toEqual([
      { label: 'Reach', total: 7, series: [{ date: '2026-11-29', total: 3 }, { date: '2026-11-30', total: 4 }] },
      { label: 'Likes', total: 9, series: [{ date: '2026-12-01', total: 9 }] },
    ]);
    expect(await rows(await w.channel(A, 'facebook'))).toEqual([{ label: 'Views', total: 3, series: [{ date: '2026-11-30', total: 3 }] }]);
    const yt = await rows(await w.channel(A, 'youtube'), '&days=7');
    expect(yt.map((r: any) => [r.label, r.total])).toEqual([
      ['Views', 30], ['Minutes watched', 11], ['Average view (seconds)', 45], ['Average view (%)', 42.5], ['New subscribers', 3], ['Lost subscribers', 1], ['Likes', 5],
    ]);
    expect(w.calls('GET https://youtubeanalytics')[0]!.url).toContain('startDate=2026-11-24');
    expect(await rows(await w.channel(A, 'linkedin'))).toEqual([]);
    const id = (await w.api('GET', `channels?owner=${A}`)).body.channels[0].id;
    expect((await w.api('GET', `analytics/${id}?owner=${A}&days=0`)).status).toBe(400);
  });

  it('refreshes once on a token error, gives no rows on a refusal, and asks to reconnect when refresh fails', async () => {
    const w = new World()
      .on('GET https://youtubeanalytics', new Response('{}', { status: 401 }), { rows: [] })
      .on('POST https://oauth2.googleapis.com/token', { access_token: 'tok-2', expires_in: 3600 }, new Response('{"error":"invalid_grant"}', { status: 400 }));
    const id = await w.channel(A, 'youtube');
    expect((await w.api('GET', `analytics/${id}?owner=${A}`)).body).toEqual({ rows: [] });
    expect(w.calls('GET https://youtubeanalytics')[1]!.headers.get('authorization')).toBe('Bearer tok-2');
    w.on('GET https://youtubeanalytics', new Response('{"error":"forbidden"}', { status: 403 }));
    expect((await w.api('GET', `analytics/${id}?owner=${A}`)).body).toEqual({ rows: [] });
    w.on('GET https://youtubeanalytics', new Response('', { status: 503 }));
    expect((await w.api('GET', `analytics/${id}?owner=${A}`)).status).toBe(502);
    w.on('GET https://youtubeanalytics', new Response('{}', { status: 401 }));
    expect((await w.api('GET', `analytics/${id}?owner=${A}`)).status).toBe(409);
    expect((await w.api('GET', `channels?owner=${A}`)).body.channels[0].status).toBe('reconnect');
  });
});
