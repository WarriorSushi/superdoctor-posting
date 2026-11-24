// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Postiz v2.26.0 (https://github.com/gitroomhq/postiz-app), linkedin.provider.ts
// (personal profile only; PDF carousels, company pages, mentions and comments left out).
import { checkScopes, Fail, json, need, type Job, type Platform, type Tokens } from './base';

const label = 'LinkedIn';
const SCOPES = ['openid', 'profile', 'w_member_social'];
const REST = 'https://api.linkedin.com/rest';
// Postiz uses 202601, which LinkedIn switches off on 15 Jan 2027. Each version lives about a year.
const VERSION = '202611';

const headers = (token: string) => ({
  authorization: `Bearer ${token}`,
  'x-restli-protocol-version': '2.0.0',
  'linkedin-version': VERSION,
});

interface Pending {
  mediaIds: string[];
  video?: { urn: string; uploadToken: string; parts: { uploadUrl: string; firstByte: number; lastByte: number }[]; etags: string[]; processing?: boolean };
  /** Image status is not readable with a personal sign-in, so wait one check instead. */
  graceChecks: number;
  statusStalls: number;
}

const init = async (job: Job, endpoint: 'images' | 'videos', extra: object) =>
  (
    await (
      await job.call(
        `${REST}/${endpoint}?action=initializeUpload`,
        json({ initializeUploadRequest: { owner: `urn:li:person:${job.account}`, ...extra } }, headers(job.token))
      )
    ).json<any>()
  ).value;

/** LinkedIn's "little text" format: these characters must be escaped or the post is cut short. */
const fixText = (text: string) => text.replace(/[\\<>#~_|[\]*(){}@]/g, '\\$&');

async function oauth(call: Parameters<Platform['complete']>[1], fields: Record<string, string>, now: number): Promise<Tokens & { scope?: string }> {
  const t = await (
    await call('https://www.linkedin.com/oauth/v2/accessToken', { method: 'POST', body: new URLSearchParams(fields) })
  ).json<any>();
  return { access: need<string>(t.access_token, label), refresh: t.refresh_token, expires: now + Number(need(t.expires_in, label)) * 1000, scope: t.scope };
}

export const linkedin: Platform = {
  id: 'linkedin',
  label,
  client: (env) => ({ id: env.LINKEDIN_CLIENT_ID, secret: env.LINKEDIN_CLIENT_SECRET }),

  errors: [
    [/invalid_client/, 'unknown', 'LinkedIn is not set up correctly on our side. Please tell us.'],
    [/Unable to obtain activity|resource is forbidden|Service Unavailable/, 'retry', 'LinkedIn is busy right now. Please try again later.'],
    [/REVOKED_ACCESS_TOKEN|EXPIRED_ACCESS_TOKEN|INVALID_ACCESS_TOKEN/, 'refresh', 'Please reconnect your LinkedIn account.'],
    [/DUPLICATE_POST|duplicate of/i, 'bad', 'LinkedIn says you already posted this. Please change the text.'],
    [/MEDIA_ASSET_PROCESSING_FAILED/, 'bad', 'LinkedIn could not process the media. Please try another file.'],
  ],

  authUrl: (client, redirectUri, state) =>
    `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({
      response_type: 'code', client_id: client.id, redirect_uri: redirectUri, state, scope: SCOPES.join(' '),
    })}`,

  async complete(client, call, { code, redirectUri, now }) {
    const { scope, ...tokens } = await oauth(call, {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.id, client_secret: client.secret,
    }, now);
    checkScopes(label, SCOPES, scope);
    const me = await (await call('https://api.linkedin.com/v2/userinfo', { headers: { authorization: `Bearer ${tokens.access}` } })).json<any>();
    return [{ account: need<string>(me.sub, label), name: me.name || '', handle: '', picture: me.picture || '', tokens }];
  },

  /** LinkedIn gives refresh tokens only to some apps; without one the doctor reconnects every 60 days. */
  async refresh(client, call, tokens, now) {
    const { scope: _scope, ...fresh } = await oauth(call, {
      grant_type: 'refresh_token', refresh_token: tokens.refresh!, client_id: client.id, client_secret: client.secret,
    }, now);
    return { ...fresh, refresh: fresh.refresh ?? tokens.refresh };
  },

  /** Uploads the media. Nothing is visible until finalizePost creates the post. */
  async postPending(job) {
    if (job.kind === 'video') {
      const v = await init(job, 'videos', { fileSizeBytes: job.media[0]!.size, uploadCaptions: false, uploadThumbnail: false });
      const video = { urn: need<string>(v?.video, label), uploadToken: v.uploadToken ?? '', parts: need<any[]>(v.uploadInstructions, label), etags: [] };
      return { status: 'ready', pendingData: { mediaIds: [video.urn], video, graceChecks: 0, statusStalls: 0 } satisfies Pending };
    }
    const mediaIds: string[] = [];
    for (const m of job.media) {
      const v = await init(job, 'images', {});
      await job.call(need<string>(v?.uploadUrl, label), {
        method: 'PUT', headers: { ...headers(job.token), 'content-type': 'application/octet-stream' }, body: await job.read(m, 0, m.size - 1),
      });
      mediaIds.push(need<string>(v.image, label));
    }
    return { status: mediaIds.length ? 'pending' : 'ready', pendingData: { mediaIds, graceChecks: mediaIds.length ? 1 : 0, statusStalls: 0 } satisfies Pending };
  },

  async checkPostStatus(job, pendingData: Pending) {
    const { video } = pendingData;
    if (video?.processing) {
      let state: any;
      try {
        state = await (await job.call(`${REST}/videos/${encodeURIComponent(video.urn)}`, { headers: headers(job.token) })).json();
        need(state.status, label);
      } catch (err) {
        if (err instanceof Fail && (err.kind === 'refresh' || err.kind === 'disconnect')) throw err;
        if (pendingData.statusStalls >= 10) throw new Fail('bad', 'LinkedIn kept failing while preparing the video. Nothing was published, please try again.');
        return { status: 'pending', pendingData: { ...pendingData, statusStalls: pendingData.statusStalls + 1 } };
      }
      if (state.status === 'PROCESSING_FAILED') throw new Fail('bad', 'LinkedIn could not process the video. Please try another file.');
      if (state.status !== 'AVAILABLE') return { status: 'pending', pendingData: { ...pendingData, statusStalls: 0 } };
      return { status: 'ready', pendingData: { ...pendingData, video: undefined } };
    }
    if (pendingData.graceChecks > 0) return { status: 'pending', pendingData: { ...pendingData, graceChecks: pendingData.graceChecks - 1 } };
    return { status: 'ready', pendingData };
  },

  async finalizePost(job, pendingData: Pending) {
    const { video } = pendingData;
    if (video) {
      // Each part has its own address and returns an etag that the finish call needs, in order.
      const etags = [...video.etags];
      while (etags.length < video.parts.length) {
        if (!job.hasTime()) return { status: 'pending', pendingData: { ...pendingData, video: { ...video, etags } } };
        const part = video.parts[etags.length]!;
        const res = await job.call(part.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: await job.read(job.media[0]!, part.firstByte, Math.min(part.lastByte, job.media[0]!.size - 1)),
        });
        etags.push(need(res.headers.get('etag'), label).replace(/^"|"$/g, ''));
        await job.save({ ...pendingData, video: { ...video, etags } });
      }
      await job.call(
        `${REST}/videos?action=finalizeUpload`,
        json({ finalizeUploadRequest: { video: video.urn, uploadToken: video.uploadToken, uploadedPartIds: etags } }, headers(job.token))
      );
      return { status: 'pending', pendingData: { ...pendingData, video: { ...video, etags, parts: [], processing: true } } };
    }

    const { mediaIds } = pendingData;
    await job.arm();
    const res = await job.call(
      `${REST}/posts`,
      json(
        {
          author: `urn:li:person:${job.account}`,
          commentary: fixText(job.text),
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          ...(mediaIds.length === 1 ? { content: { media: { id: mediaIds[0] } } } : {}),
          ...(mediaIds.length > 1 ? { content: { multiImage: { images: mediaIds.map((id) => ({ id })) } } } : {}),
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        },
        headers(job.token)
      )
    );
    const id = need(res.headers.get('x-restli-id'), label);
    return { status: 'completed', postId: id, url: `https://www.linkedin.com/feed/update/${id}` };
  },
};
