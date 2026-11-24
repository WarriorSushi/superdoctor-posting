// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Postiz v2.26.0 (https://github.com/gitroomhq/postiz-app),
// apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts: the same phases
// (postPending -> checkPostStatus -> finalizePost) and the same rule that a call with an unknown
// outcome is never repeated, but driven by a cron over D1 rows instead of Temporal.
import { accessToken, markReconnect, refreshChannel, type Channel } from './channels';
import { open, seal } from './crypto';
import { MINUTE, type Deps, type Env } from './env';
import { KV_SETTLE, mediaUrl, readMedia, type Media } from './media';
import { caller, Fail, reconnectMessage, type Job, type Kind, type Result } from './platforms/base';
import { platforms } from './platforms';

const BATCH = 5;
const LEASE = 5 * MINUTE;
const MAX_ATTEMPTS = 5; // consecutive troubled steps
const MAX_CHECKS = 120; // steps in total, about two hours
const TICK_BUDGET = 45_000;
const PARTS_PER_TICK = 8;

interface Post {
  id: string;
  owner: string;
  channel: string;
  kind: Kind;
  text: string;
  title: string;
  lease: string;
  armed: number;
  refreshed: number;
  attempts: number;
  checks: number;
  sealed: string | null;
  media_count: number;
}

/** Another run owns this post now: stop without touching anything. */
class LeaseLost extends Error {}

/** Claims due posts in one UPDATE, so two overlapping crons can never hold the same post. */
async function claim(env: Env, now: number): Promise<Post[]> {
  const due = `lease_until <= ?2 AND state IN ('queued', 'publishing') AND next_at <= ?2`;
  const { results } = await env.DB.prepare(
    `UPDATE posts SET state = 'publishing', lease = ?1, lease_until = ?3, attempts = attempts + 1
     WHERE ${due} AND id IN (
       SELECT id FROM posts WHERE ${due}
       AND NOT EXISTS (SELECT 1 FROM post_media pm JOIN media m ON m.id = pm.media
                       WHERE pm.post = posts.id AND m.store = 'kv' AND m.created > ?4)
       ORDER BY next_at LIMIT ${BATCH})
     RETURNING *`
  ).bind(crypto.randomUUID(), now, now + LEASE, now - KV_SETTLE).all<Post>();
  return results;
}

export async function publishDue(env: Env, deps: Deps) {
  const posts = await claim(env, deps.now());
  const runs = await Promise.allSettled(posts.map((post) => step(env, deps, post)));
  for (const run of runs) {
    // The lease runs out on its own, and the next claim sees whether the post was armed.
    if (run.status === 'rejected' && !(run.reason instanceof LeaseLost)) console.error('step crashed', run.reason?.name);
  }
}

async function step(env: Env, deps: Deps, post: Post) {
  const started = deps.now();

  const update = async (set: string, ...values: unknown[]) => {
    const { meta } = await env.DB.prepare(`UPDATE posts SET ${set} WHERE id = ? AND lease = ? AND state = 'publishing'`)
      .bind(...values, post.id, post.lease).run();
    if (!meta.changes) throw new LeaseLost();
  };
  const end = (state: 'published' | 'failed' | 'unconfirmed', error: string | null, url: string | null = null, platformId: string | null = null) =>
    update('state = ?, error = ?, url = ?, platform_id = ?, sealed = NULL, armed = 0, lease = NULL, lease_until = 0, finished_at = ?', state, error, url, platformId, deps.now());
  const later = async (pendingData: any, clean: boolean, waitMs: number) =>
    update(
      'sealed = ?, armed = ?, checks = checks + 1, attempts = ?, next_at = ?, lease = NULL, lease_until = 0',
      pendingData ? await seal(env.TOKEN_KEY, post.id, pendingData) : null, post.armed, clean ? 0 : post.attempts, deps.now() + waitMs
    );

  let pending: any = post.sealed ? await open(env.TOKEN_KEY, post.id, post.sealed) : null;
  const channel = await env.DB.prepare('SELECT * FROM channels WHERE id = ? AND owner = ?').bind(post.channel, post.owner).first<Channel>();
  const label = channel ? platforms[channel.platform].label : 'the platform';

  /** Gives up: "failed" only when we know nothing went out. */
  const stop = (message: string) =>
    post.armed || pending?.sent
      ? end('unconfirmed', `We sent this to ${label} but could not confirm it was published. Please check your account before posting again.`)
      : end('failed', message);

  if (!channel) return stop('This account was disconnected before the post went out.');
  const platform = platforms[channel.platform];
  if (channel.status !== 'ok') return stop(reconnectMessage(label));
  if (post.attempts > MAX_ATTEMPTS) return stop(`${label} could not be reached after several tries. Nothing was published.`);
  if (post.checks >= MAX_CHECKS) return stop(`${label} took too long to prepare this post. Nothing was published.`);
  // Armed but no way to ask what happened: never call again.
  if (post.armed && !platform.recover) return stop('');

  const { results: media } = await env.DB.prepare(
    "SELECT m.* FROM post_media pm JOIN media m ON m.id = pm.media WHERE pm.post = ? AND m.owner = ? AND m.state = 'ready' ORDER BY pm.pos"
  ).bind(post.id, post.owner).all<Media>();
  if (media.length !== post.media_count) return stop('The media for this post is no longer stored. Please upload it again.');

  let parts = 0;
  const job: Job = {
    call: caller(deps, platform),
    token: '',
    account: channel.account,
    handle: channel.handle,
    kind: post.kind,
    text: post.text,
    title: post.title,
    media: await Promise.all(media.map(async (m) => ({ ...m, url: await mediaUrl(env, m) }))),
    now: started,
    async arm() {
      // Also refuses if the doctor removed the account a moment ago.
      const { meta } = await env.DB.prepare(
        `UPDATE posts SET armed = 1, lease_until = ? WHERE id = ? AND lease = ? AND state = 'publishing'
         AND EXISTS (SELECT 1 FROM channels WHERE id = posts.channel)`
      ).bind(deps.now() + LEASE, post.id, post.lease).run();
      if (!meta.changes) throw new LeaseLost();
      post.armed = 1;
    },
    async save(pendingData) {
      await update('sealed = ?, armed = 0, lease_until = ?', await seal(env.TOKEN_KEY, post.id, pendingData), deps.now() + LEASE);
      pending = pendingData;
      post.armed = 0;
    },
    read: (m, start, stopAt) => readMedia(env, m, start, stopAt),
    hasTime: () => parts++ < PARTS_PER_TICK && deps.now() - started < TICK_BUDGET,
  };

  for (;;) {
    const recovering = post.armed === 1;
    try {
      job.token ||= await accessToken(env, deps, channel);
      let result: Result | null;
      if (recovering) {
        result = await platform.recover!(job, pending);
        if (!result) return await stop('');
      } else {
        result = pending ? await platform.checkPostStatus(job, pending) : await platform.postPending(job);
        if (result.status === 'ready') {
          await job.save(result.pendingData);
          result = await platform.finalizePost(job, result.pendingData);
        }
      }
      if (result.status === 'completed') return await end('published', null, result.url, result.postId);
      post.armed = 0;
      return await later(result.pendingData, true, 20_000);
    } catch (err) {
      if (err instanceof LeaseLost) throw err;
      if (!(err instanceof Fail)) console.error('step error', channel.platform, (err as Error)?.name);
      const fail = err instanceof Fail ? err : new Fail('unknown', 'Something went wrong on our side. Please try again.');

      // A clear answer to the irreversible call itself means it did not happen.
      if (post.armed && !recovering && fail.kind !== 'unknown') post.armed = 0;

      if (fail.kind === 'refresh') {
        if (post.refreshed) {
          await markReconnect(env, channel);
          return stop(fail.message);
        }
        try {
          job.token = await refreshChannel(env, deps, channel);
        } catch (refreshError) {
          if (refreshError instanceof Fail && refreshError.kind === 'disconnect') return stop(fail.message);
          return later(pending, false, MINUTE);
        }
        post.refreshed = 1;
        await update('refreshed = 1, armed = ?', post.armed);
        continue;
      }
      if (fail.kind === 'disconnect') {
        await markReconnect(env, channel);
        return stop(fail.message);
      }
      if (fail.kind === 'bad') return recovering ? stop('') : end('failed', fail.message);
      // retry / unknown
      if (post.armed && !platform.recover) return stop('');
      if (post.attempts >= MAX_ATTEMPTS) return stop(fail.message);
      return later(pending, false, MINUTE * post.attempts);
    }
  }
}
