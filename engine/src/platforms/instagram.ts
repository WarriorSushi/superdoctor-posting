// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Postiz v2.26.0 (https://github.com/gitroomhq/postiz-app), instagram.standalone.provider.ts and
// instagram.provider.ts (Instagram Login on graph.instagram.com; stories, trial reels, audio and collaborators left out).
import { DAY } from '../env';
import { checkScopes, day, Fail, form, need, row, type Call, type Job, type Platform, type Row, type Tokens } from './base';
import { META_GRAPH_API_VERSION } from './facebook';

const label = 'Instagram';
const GRAPH = `https://graph.instagram.com/${META_GRAPH_API_VERSION}`;
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights'];
const ME = `${GRAPH}/me?fields=user_id,username,name,profile_picture_url`;
const BLOCKED = 'Instagram blocked this post. Please check your account in the Instagram app.';
const LIFETIME = 58 * DAY;

interface Pending {
  containers: string[];
  carouselId?: string;
}

const errors: Platform['errors'] = [
  [/An unknown error occurred/, 'retry', 'Instagram had a problem. Please try again later.'],
  [/REVOKED_ACCESS_TOKEN|"error_subcode":\s*33\b/, 'refresh', 'Please reconnect your Instagram account.'],
  [/the user is not an instagram business/i, 'refresh', 'Your Instagram account is not a professional account. Please switch it to professional in Instagram, then reconnect.'],
  [/session has been invalidated/i, 'refresh', 'Instagram signed us out. Please reconnect, and wait a day or two before posting again.'],
  [/\b2207050\b/, 'bad', 'Instagram has restricted this account. Please check it in the Instagram app.'],
  [/\b2207003\b/, 'bad', 'Instagram took too long to collect the media. Please try again.'],
  [/\b2207020\b/, 'bad', 'The media expired. Please upload it again.'],
  [/\b2207032\b/, 'bad', 'Instagram could not prepare the media. Please try again.'],
  [/\b2207053\b/, 'bad', 'Instagram could not take this video. It must be under 300 MB, at most 1920 px wide and 25 Mbps. Please export a smaller version.'],
  [/\b2207052\b/, 'retry', 'Instagram could not collect the media. Please try again.'],
  [/\b2207026\b/, 'bad', 'Instagram does not support this video format.'],
  [/\b2207023\b/, 'bad', 'Instagram did not recognise the media type.'],
  [/\b2207006\b/, 'bad', 'Instagram could not find the media. Please upload it again.'],
  [/\b2207008\b/, 'bad', 'Instagram took too long over this post. Please try again.'],
  [/\b2207028\b/, 'bad', 'Instagram did not accept this set of images.'],
  [/\b2207010\b/, 'bad', 'The caption is too long for Instagram.'],
  [/\b2207004\b/, 'bad', 'The image is too large for Instagram.'],
  [/\b2207005\b/, 'bad', 'Instagram does not support this image format.'],
  [/\b2207009\b|\b36003\b/, 'bad', 'The image shape is not supported. Instagram needs between 4:5 (tall) and 1.91:1 (wide).'],
  [/Page request limit reached/, 'bad', 'Instagram has limited posting for today. Please try again tomorrow.'],
  [/\b2207042\b/, 'bad', "You have reached Instagram's limit of posts for today."],
  [/\(#200\)|Not enough permissions to post/, 'bad', 'Instagram says a permission is missing. Please reconnect and allow everything.'],
  [/You cannot access the app till you log in to|Session key is malformed/, 'disconnect', 'Please log in at instagram.com, follow its instructions, then reconnect here.'],
  [/"code":\s*190\b/, 'refresh', 'Please reconnect your Instagram account.'],
  [/\b36001\b/, 'bad', 'The image is too large for Instagram. The most it takes is 1920 x 1080.'],
  [/\b2207051\b/, 'bad', BLOCKED],
  [/\b2207001\b/, 'bad', 'Instagram thinks this post is spam. Please change it and try again.'],
  [/\b2207082\b/, 'retry', 'Instagram could not process this video. Please try again.'],
  [/\b2207085\b/, 'bad', 'Instagram could not process the video. Please check its format, length and size.'],
  [/\b2207077\b/, 'bad', 'Instagram could not download the video. Please try again.'],
  [/too little or too many attachments/, 'bad', 'Instagram needs between 2 and 10 images for a carousel.'],
  [/\b2207027\b/, 'retry', 'Instagram was not ready to publish the media. Please try again.'],
];

async function profile(call: Call, access: string) {
  const me = await (await call(`${ME}&access_token=${access}`)).json<any>();
  return { account: String(need(me.user_id, label)), name: me.name || me.username || '', handle: me.username || '', picture: me.profile_picture_url || '' };
}

const home = (job: Job) => `https://www.instagram.com/${job.handle}`;

async function containerStatus(job: Job, id: string): Promise<string> {
  const { status_code, status } = await (
    await job.call(`${GRAPH}/${id}?fields=status_code,status&access_token=${job.token}`)
  ).json<any>();
  if (status_code === 'ERROR' || status_code === 'EXPIRED') {
    const known = errors.find(([pattern]) => pattern.test(String(status || '')));
    throw new Fail(known?.[1] === 'disconnect' ? 'disconnect' : 'bad', known?.[2] ?? 'Instagram could not process the media. Please try again.');
  }
  return need(status_code as string, label);
}

/** Makes an invisible container. Form fields, because a long Hindi caption does not fit in a URL. */
async function container(job: Job, fields: Record<string, string>): Promise<string> {
  const { id } = await (await job.call(`${GRAPH}/${job.account}/media`, form({ ...fields, access_token: job.token }))).json<any>();
  return need(id, label);
}

const completed = (job: Job, postId: string, url = home(job)) => ({ status: 'completed' as const, postId, url });

export const instagram: Platform = {
  id: 'instagram',
  label,
  errors,
  client: (env) => ({ id: env.INSTAGRAM_APP_ID, secret: env.INSTAGRAM_APP_SECRET }),

  authUrl: (client, redirectUri, state) =>
    `https://www.instagram.com/oauth/authorize?${new URLSearchParams({
      enable_fb_login: '0', client_id: client.id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(','), state,
    })}`,

  async complete(client, call, { code, redirectUri, now }) {
    const body = new FormData();
    body.append('client_id', client.id);
    body.append('client_secret', client.secret);
    body.append('grant_type', 'authorization_code');
    body.append('redirect_uri', redirectUri);
    body.append('code', code);
    const short = await (await call('https://api.instagram.com/oauth/access_token', { method: 'POST', body })).json<any>();
    const long = await (
      await call(`https://graph.instagram.com/access_token?${new URLSearchParams({
        grant_type: 'ig_exchange_token', client_id: client.id, client_secret: client.secret, access_token: need(short.access_token, label),
      })}`)
    ).json<any>();
    checkScopes(label, SCOPES, short.permissions);
    const access: string = need(long.access_token, label);
    return [{ ...(await profile(call, access)), tokens: { access, refresh: access, expires: now + LIFETIME } }];
  },

  async refresh(_client, call, tokens: Tokens, now) {
    const { access_token } = await (
      await call(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${tokens.refresh}`)
    ).json<any>();
    const access: string = need(access_token, label);
    return { access, refresh: access, expires: now + LIFETIME };
  },

  async postPending(job) {
    const single = job.media.length === 1;
    const containers = await Promise.all(
      job.media.map((m) =>
        container(job, {
          ...(m.type === 'video/mp4' ? { video_url: m.url, media_type: 'REELS', thumb_offset: '0' } : { image_url: m.url }),
          ...(single ? { caption: job.text } : { is_carousel_item: 'true' }),
        })
      )
    );
    return { status: 'pending', pendingData: { containers } satisfies Pending };
  },

  async checkPostStatus(job, pendingData: Pending) {
    const ids = pendingData.carouselId ? [pendingData.carouselId] : pendingData.containers;
    for (const id of ids) {
      const status = await containerStatus(job, id);
      if (status === 'IN_PROGRESS') return { status: 'pending', pendingData };
      if (status === 'PUBLISHED' && (pendingData.carouselId || pendingData.containers.length === 1)) return completed(job, id);
    }
    return { status: 'ready', pendingData };
  },

  async finalizePost(job, pendingData: Pending) {
    if (pendingData.containers.length > 1 && !pendingData.carouselId) {
      const carouselId = await container(job, { media_type: 'CAROUSEL', children: pendingData.containers.join(','), caption: job.text });
      return { status: 'pending', pendingData: { ...pendingData, carouselId } };
    }
    const creationId = pendingData.carouselId ?? pendingData.containers[0]!;
    await job.arm();
    let mediaId: string;
    try {
      mediaId = need((await (await job.call(`${GRAPH}/${job.account}/media_publish`, form({ creation_id: creationId, access_token: job.token }))).json<any>()).id, label);
    } catch (err) {
      // Instagram sometimes answers "blocked" and still publishes: ask before calling it failed.
      if (!(err instanceof Fail) || err.message !== BLOCKED) throw err;
      const done = await instagram.recover!(job, pendingData);
      if (done) return done;
      throw err;
    }
    // The post is live; the link is only nice to have.
    const permalink = await job
      .call(`${GRAPH}/${mediaId}?fields=permalink&access_token=${job.token}`)
      .then((r) => r.json<any>())
      .then((r) => r.permalink as string)
      .catch(() => '');
    return completed(job, mediaId, permalink || home(job));
  },

  async recover(job, pendingData: Pending) {
    const id = pendingData.carouselId ?? pendingData.containers[0]!;
    return (await containerStatus(job, id)) === 'PUBLISHED' ? completed(job, id) : null;
  },

  async analytics(call, token, account, days, now) {
    const titles: Record<string, string> = {
      likes: 'Likes', reach: 'Reach', follower_count: 'New followers', views: 'Views',
      comments: 'Comments', shares: 'Shares', saves: 'Saves', replies: 'Replies',
    };
    // Instagram gives at most 30 days per question.
    const until = Math.floor(Date.parse(day(now)) / 1000);
    const since = Math.floor((now - Math.min(days, 30) * DAY) / 1000);
    const insights = (query: string) =>
      call(`${GRAPH}/${account}/insights?${query}&period=day&since=${since}&until=${until}&access_token=${token}`)
        .then((r) => r.json<any>())
        .then((r) => (r.data ?? []) as any[])
        // Small accounts have no insights: that is "no numbers", not an error.
        .catch((err) => { if (err instanceof Fail && err.kind === 'bad') return []; throw err; });
    const series = await insights('metric=follower_count,reach');
    const totals = await insights('metric_type=total_value&metric=likes,views,comments,shares,saves,replies');
    return [
      ...series.map((d): Row => row(titles[d.name] ?? d.name, (d.values ?? []).map((v: any) => ({ date: day(v.end_time), total: Number(v.value) || 0 })))),
      ...totals.map((d): Row => row(titles[d.name] ?? d.name, [{ date: day(now), total: Number(d.total_value?.value) || 0 }])),
    ];
  },
};
