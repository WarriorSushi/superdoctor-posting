// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Postiz v2.26.0 (https://github.com/gitroomhq/postiz-app), facebook.provider.ts
// (feed posts, photos and videos on Pages; stories, comments and background presets left out).
import { DAY } from '../env';
import { checkScopes, day, Fail, json, need, row, type Account, type Platform } from './base';

export const META_GRAPH_API_VERSION = 'v25.0';

const label = 'Facebook';
const GRAPH = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
// business_management lets Pages owned by a Business Portfolio appear; read_insights is only for analytics.
const REQUIRED = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'];
const SCOPES = [...REQUIRED, 'business_management', 'read_insights'];

type Pending = { photos: string[] } | { videoId: string; sent: true };

export const facebook: Platform = {
  id: 'facebook',
  label,
  choose: true,
  client: (env) => ({ id: env.FACEBOOK_APP_ID, secret: env.FACEBOOK_APP_SECRET }),

  errors: [
    [/Error validating access token|REVOKED_ACCESS_TOKEN|"code":\s*190\b/, 'refresh', 'Please reconnect your Facebook Page.'],
    [/Unpublished posts must be posted to a page as the page itself/, 'refresh', 'We are not allowed to post as this Page. Please reconnect it.'],
    [/\b1404078\b/, 'refresh', 'Facebook needs the Page to be authorised for publishing. Please do that in Facebook, then reconnect.'],
    [/must be granted before impersonating/, 'refresh', 'Facebook Page permissions are missing. Please reconnect and allow everything.'],
    [/"error_subcode":\s*459\b/, 'bad', 'Facebook wants a security check. Please log in at facebook.com, complete it, then try again.'],
    [/"error_subcode":\s*492\b/, 'bad', 'You no longer have a role on this Page. Ask a Page admin to add you, then reconnect.'],
    [/\(#200\)/, 'bad', 'Facebook says a permission is missing. Make sure you have full content access to the Page, then reconnect.'],
    [/\b1366046\b/, 'bad', 'The photo is too large for Facebook. Please use a JPG or PNG under 4 MB.'],
    [/\b1390008\b/, 'retry', 'Facebook says you are posting too fast. Please slow down.'],
    [/\b1346003\b/, 'bad', 'Facebook flagged this content as abusive.'],
    [/\b2069019\b/, 'bad', 'Facebook could not use this file.'],
    [/\b1404102\b/, 'bad', 'Facebook says this goes against its Community Standards.'],
    [/\b1366051\b/, 'bad', 'These photos were already posted on Facebook.'],
    [/\b1609008\b/, 'bad', 'Facebook does not allow facebook.com links here.'],
    [/\b2061006\b/, 'bad', 'A link in the post is not valid.'],
    [/\b1349125\b/, 'bad', 'Facebook did not accept this post.'],
    [/\b1404112\b/, 'bad', 'Facebook has limited this account for a few days for security reasons.'],
    [/Name parameter too long/, 'bad', 'The post is too long for Facebook.'],
    [/\b1363047\b|\b1609010\b/, 'bad', 'Facebook is temporarily unavailable. Please try again later.'],
    [/\b4854002\b/, 'bad', 'Please confirm your identity in the Facebook app before posting as this Page.'],
    [/No permission to publish the video/, 'bad', 'Facebook says this Page may not publish the video.'],
    [/"error_subcode":\s*33\b[\s\S]*does not exist|does not exist[\s\S]*"error_subcode":\s*33\b/, 'bad', 'This Facebook Page no longer exists. Please reconnect and schedule again.'],
    [/Sorry, something went wrong/, 'retry', 'Facebook is temporarily unavailable. Please try again later.'],
    [/"(?:code|error_subcode)":\s*490\b/, 'refresh', 'Please reconnect your Facebook Page.'],
  ],

  authUrl: (client, redirectUri, state) =>
    `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth?${new URLSearchParams({
      client_id: client.id, redirect_uri: redirectUri, state, scope: SCOPES.join(','),
    })}`,

  /** Returns every Page the doctor shared; `choose` lets them pick. Page tokens do not expire. */
  async complete(client, call, { code, redirectUri }) {
    const token = async (fields: Record<string, string>): Promise<string> =>
      need((await (await call(`${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: client.id, client_secret: client.secret, ...fields })}`)).json<any>()).access_token, label);
    const short = await token({ redirect_uri: redirectUri, code });
    const access = await token({ grant_type: 'fb_exchange_token', fb_exchange_token: short });

    const { data } = await (await call(`${GRAPH}/me/permissions?access_token=${access}`)).json<any>();
    checkScopes(label, REQUIRED, (data ?? []).filter((d: any) => d.status === 'granted').map((d: any) => d.permission));

    const pages: Account[] = [];
    let next: string | undefined = `${GRAPH}/me/accounts?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${access}`;
    // Only the first 500 pages, and only ever on Facebook's own host.
    for (let i = 0; next?.startsWith('https://graph.facebook.com/') && i < 5; i++) {
      const page: any = await (await call(next)).json();
      for (const p of page.data ?? []) {
        if (!p.access_token || pages.some((x) => x.account === String(p.id))) continue;
        pages.push({
          account: String(p.id), name: p.name || '', handle: p.username || '', picture: p.picture?.data?.url || '',
          tokens: { access: p.access_token, expires: null },
        });
      }
      next = page.paging?.next;
    }
    if (!pages.length) throw new Fail('bad', 'No Facebook Page was shared. Please connect again and pick a Page you manage.');
    return pages;
  },

  async postPending(job) {
    if (job.kind === 'video') {
      await job.arm();
      const { id } = await (
        await job.call(
          `${GRAPH}/${job.account}/videos?access_token=${job.token}&fields=id,permalink_url`,
          json({ file_url: job.media[0]!.url, description: job.text, ...(job.title ? { title: job.title } : {}), published: true })
        )
      ).json<any>();
      // Facebook took the video and now processes it; the checks below find out if that worked.
      return { status: 'pending', pendingData: { videoId: String(need(id, label)), sent: true } satisfies Pending };
    }
    const photos = await Promise.all(
      job.media.map(async (m): Promise<string> =>
        need((await (await job.call(`${GRAPH}/${job.account}/photos?access_token=${job.token}`, json({ url: m.url, published: false }))).json<any>()).id, label)
      )
    );
    return { status: 'ready', pendingData: { photos } satisfies Pending };
  },

  async checkPostStatus(job, pendingData: Pending) {
    if (!('videoId' in pendingData)) return { status: 'ready', pendingData };
    const { status } = await (await job.call(`${GRAPH}/${pendingData.videoId}?fields=status&access_token=${job.token}`)).json<any>();
    const state = status?.video_status || 'in_progress';
    if (state === 'error') throw new Fail('bad', 'Facebook could not process the video. Please try another file.');
    if (state !== 'ready' && state !== 'upload_complete') return { status: 'pending', pendingData };
    return { status: 'completed', postId: pendingData.videoId, url: `https://www.facebook.com/reel/${pendingData.videoId}` };
  },

  async finalizePost(job, pendingData: Pending) {
    const photos = 'photos' in pendingData ? pendingData.photos : [];
    await job.arm();
    const { id, permalink_url } = await (
      await job.call(
        `${GRAPH}/${job.account}/feed?access_token=${job.token}&fields=id,permalink_url`,
        json({ ...(photos.length ? { attached_media: photos.map((media_fbid) => ({ media_fbid })) } : {}), message: job.text, published: true })
      )
    ).json<any>();
    return { status: 'completed', postId: need(id, label), url: permalink_url || `https://www.facebook.com/${id}` };
  },

  async analytics(call, token, account, days, now) {
    const titles: Record<string, string> = {
      page_total_media_view_unique: 'Reach', page_media_view: 'Views', page_post_engagements: 'Engagement', page_daily_follows: 'New followers',
    };
    // Values can be split (paid / organic): add the parts.
    const sum = (v: any): number => (v && typeof v === 'object' ? Object.values(v).reduce((n: number, x) => n + (Number(x) || 0), 0) : Number(v) || 0);
    const until = Math.floor((Date.parse(day(now)) + DAY - 1) / 1000);
    const since = Math.floor((now - days * DAY) / 1000);
    const { data } = await (
      await call(`${GRAPH}/${account}/insights?metric=${Object.keys(titles).join(',')}&period=day&since=${since}&until=${until}&access_token=${token}`)
    ).json<any>();
    return (data ?? []).map((d: any) => row(titles[d.name] ?? d.name, (d.values ?? []).map((v: any) => ({ date: day(v.end_time), total: sum(v.value) }))));
  },
};
