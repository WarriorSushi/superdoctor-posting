// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Postiz v2.26.0 (https://github.com/gitroomhq/postiz-app), youtube.provider.ts
// (resumable upload; googleapis replaced by plain fetch; thumbnails and tags left out).
import { DAY } from '../env';
import { checkScopes, day, Fail, form, need, row, type Call, type Job, type Platform } from './base';

const label = 'YouTube';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
];
/** A multiple of 256 KB as YouTube requires, and the same as the KV piece so reads line up. */
const CHUNK = 20 * 1024 * 1024;

interface Pending {
  uploadUri: string;
  size: number;
  uploadedBytes: number;
}

const tokenCall = async (call: Call, fields: Record<string, string>) =>
  (await call('https://oauth2.googleapis.com/token', form(fields))).json<any>();

/** Asks the upload session for the truth: the finished video, or the byte to go on from. */
async function probe(job: Job, p: Pending): Promise<{ videoId: string } | { uploadedBytes: number }> {
  const res = await job.call(
    p.uploadUri,
    { method: 'PUT', headers: { authorization: `Bearer ${job.token}`, 'content-range': `bytes */${p.size}` } },
    [308, 404, 410]
  );
  if (res.status === 308) return { uploadedBytes: offset(res) ?? 0 };
  if (!res.ok) throw new Fail('bad', 'The YouTube upload expired before it finished. Please post it again.');
  return { videoId: need((await res.json<any>()).id, label) };
}

/** "bytes=0-1048575" -> 1048576 */
function offset(res: Response) {
  const last = res.headers.get('range')?.split('-')[1];
  return last === undefined ? undefined : Number(last) + 1;
}

const completed = (id: string) => ({ status: 'completed' as const, postId: id, url: `https://www.youtube.com/watch?v=${id}` });

export const youtube: Platform = {
  id: 'youtube',
  label,
  pkce: true,
  client: (env) => ({ id: env.YOUTUBE_CLIENT_ID, secret: env.YOUTUBE_CLIENT_SECRET }),

  errors: [
    [/invalid_client/, 'unknown', 'YouTube is not set up correctly on our side. Please tell us.'],
    [/invalidTitle/, 'bad', 'YouTube did not accept the title.'],
    [/invalidDescription/, 'bad', 'YouTube did not accept the description. It may be too long or contain < or >.'],
    [/invalidVideoMetadata/, 'bad', 'YouTube did not accept the title or description. Please review them.'],
    [/mediaBodyRequired/, 'bad', 'YouTube could not read the video. Please upload it again.'],
    [/defaultVideoInsertPerDayPerProject|quotaExceeded/, 'bad', "Today's YouTube upload allowance is used up. Please reschedule for tomorrow."],
    [/rateLimitExceeded/, 'bad', 'YouTube is asking us to slow down. Please try again in a little while.'],
    [/uploadLimitExceeded/, 'bad', 'You have reached your daily YouTube upload limit. Please try again tomorrow.'],
    [/youtubeSignupRequired/, 'bad', 'This Google account has no YouTube channel yet. Please create one first.'],
    [/Unauthorized|UNAUTHENTICATED|invalid_grant/, 'refresh', 'Please reconnect your YouTube account.'],
  ],

  authUrl: (client, redirectUri, state, challenge) =>
    `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: client.id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), state,
      access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256',
    })}`,

  async complete(client, call, { code, redirectUri, verifier, now }) {
    const t = await tokenCall(call, {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
      client_id: client.id, client_secret: client.secret,
    });
    checkScopes(label, SCOPES, t.scope);
    const tokens = { access: need<string>(t.access_token, label), refresh: need<string>(t.refresh_token, label), expires: now + Number(t.expires_in) * 1000 };
    const { items } = await (
      await call('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${tokens.access}` } })
    ).json<any>();
    if (!items?.length) throw new Fail('bad', 'This Google account has no YouTube channel yet. Please create one, then connect again.');
    // Google has already asked which channel, so there is exactly one.
    const c = items[0];
    return [{ account: c.id, name: c.snippet?.title || '', handle: c.snippet?.customUrl || '', picture: c.snippet?.thumbnails?.default?.url || '', tokens }];
  },

  async refresh(client, call, tokens, now) {
    const t = await tokenCall(call, { grant_type: 'refresh_token', refresh_token: tokens.refresh!, client_id: client.id, client_secret: client.secret });
    return { access: need<string>(t.access_token, label), refresh: t.refresh_token ?? tokens.refresh, expires: now + Number(t.expires_in) * 1000 };
  },

  /** Opens an upload session. No video exists until YouTube has the last byte. */
  async postPending(job) {
    const size = job.media[0]!.size;
    const session = await job.call('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=id,snippet,status&notifySubscribers=true', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${job.token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'video/mp4',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({
        snippet: { title: job.title, description: job.text },
        status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
      }),
    });
    const uploadUri = need(session.headers.get('location'), label);
    return { status: 'ready', pendingData: { uploadUri, size, uploadedBytes: 0 } satisfies Pending };
  },

  async checkPostStatus(job, pendingData: Pending) {
    const p = await probe(job, pendingData);
    return 'videoId' in p ? completed(p.videoId) : { status: 'ready', pendingData: { ...pendingData, uploadedBytes: p.uploadedBytes } };
  },

  async finalizePost(job, pendingData: Pending) {
    const { uploadUri, size } = pendingData;
    let { uploadedBytes } = pendingData;
    while (uploadedBytes < size) {
      if (!job.hasTime()) break;
      const end = Math.min(uploadedBytes + CHUNK, size) - 1;
      const body = await job.read(job.media[0]!, uploadedBytes, end);
      // Only the last piece creates the video.
      if (end === size - 1) await job.arm();
      const res = await job.call(
        uploadUri,
        {
          method: 'PUT',
          headers: { authorization: `Bearer ${job.token}`, 'content-type': 'video/mp4', 'content-range': `bytes ${uploadedBytes}-${end}/${size}` },
          body,
        },
        [308]
      );
      if (res.status !== 308) return completed(need((await res.json<any>()).id, label));
      const next = offset(res);
      // No progress reported, or the last piece was not enough: let the next check find the truth.
      if (next === undefined || next <= uploadedBytes || end === size - 1) break;
      uploadedBytes = next;
      await job.save({ ...pendingData, uploadedBytes });
    }
    return { status: 'pending', pendingData: { ...pendingData, uploadedBytes } };
  },

  /** The session always knows, and going on from its own offset can never make a second video. */
  recover: (job, pendingData: Pending) => youtube.checkPostStatus(job, pendingData).then((r) => (r.status === 'completed' ? r : { status: 'pending', pendingData })),

  async analytics(call, token, _account, days, now) {
    const query = new URLSearchParams({
      ids: 'channel==MINE', startDate: day(now - days * DAY), endDate: day(now), dimensions: 'day', sort: 'day',
      metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,subscribersLost',
    });
    const data = await (await call(`https://youtubeanalytics.googleapis.com/v2/reports?${query}`, { headers: { authorization: `Bearer ${token}` } })).json<any>();
    const columns: string[] = (data.columnHeaders ?? []).map((c: any) => c.name);
    const rows: any[][] = data.rows ?? [];
    if (!rows.length) return [];
    const metric = (title: string, name: string, average = false) =>
      row(title, rows.map((r) => ({ date: String(r[columns.indexOf('day')]), total: Number(r[columns.indexOf(name)]) || 0 })), average);
    return [
      metric('Views', 'views'),
      metric('Minutes watched', 'estimatedMinutesWatched'),
      metric('Average view (seconds)', 'averageViewDuration', true),
      metric('Average view (%)', 'averageViewPercentage', true),
      metric('New subscribers', 'subscribersGained'),
      metric('Lost subscribers', 'subscribersLost'),
      metric('Likes', 'likes'),
    ];
  },
};
