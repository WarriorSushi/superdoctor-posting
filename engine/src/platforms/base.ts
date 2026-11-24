// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from Postiz v2.26.0 (https://github.com/gitroomhq/postiz-app), libraries/nestjs-libraries/src/integrations/social.abstract.ts
import type { Deps, Env } from '../env';
import type { Media } from '../media';

export type PlatformId = 'instagram' | 'facebook' | 'youtube' | 'linkedin';
export type Kind = 'text' | 'images' | 'video';

/**
 * bad        the platform clearly said no: nothing was published
 * refresh    the sign-in is no longer accepted
 * disconnect refreshing cannot help, the doctor must reconnect
 * retry      a clear "not now": nothing was published, safe to try again
 * unknown    no clear answer (network, 5xx): it may or may not have happened
 */
export type FailKind = 'bad' | 'refresh' | 'disconnect' | 'retry' | 'unknown';

/** Its message is shown to the doctor: plain English, never a platform body. */
export class Fail extends Error {
  constructor(public kind: FailKind, message: string) {
    super(message);
  }
}

/** Error body pattern, what it means, what the doctor reads (Postiz handleErrors). First match wins. */
export type ErrorRule = [pattern: RegExp, kind: FailKind, message: string];

export type Call = (url: string, init?: RequestInit, alsoOk?: number[]) => Promise<Response>;

export interface Tokens {
  access: string;
  refresh?: string;
  /** unix ms; null = does not expire */
  expires: number | null;
}

export interface Account {
  account: string;
  name: string;
  handle: string;
  picture: string;
  tokens: Tokens;
}

export interface Row {
  label: string;
  total: number;
  series: { date: string; total: number }[];
}

export type Result =
  | { status: 'pending' | 'ready'; pendingData: any }
  | { status: 'completed'; postId: string; url: string };

export interface Job {
  call: Call;
  token: string;
  account: string;
  handle: string;
  kind: Kind;
  text: string;
  title: string;
  media: (Media & { url: string })[];
  now: number;
  /** Must be awaited right before any call that cannot be undone. Throws if this run lost its lease. */
  arm(): Promise<void>;
  /** Saves progress, renews the lease, and records that no irreversible call is in flight. */
  save(pendingData: any): Promise<void>;
  read(m: Media, start: number, end: number): Promise<ReadableStream>;
  /** False once this tick should hand back; the next tick goes on from the saved progress. */
  hasTime(): boolean;
}

export interface Platform {
  id: PlatformId;
  label: string;
  errors: ErrorRule[];
  /** true = the doctor picks from the returned accounts (Facebook pages) */
  choose?: boolean;
  pkce?: boolean;
  client(env: Env): { id?: string; secret?: string };
  authUrl(client: Client, redirectUri: string, state: string, challenge: string): string;
  complete(client: Client, call: Call, p: { code: string; redirectUri: string; verifier: string; now: number }): Promise<Account[]>;
  refresh?(client: Client, call: Call, tokens: Tokens, now: number): Promise<Tokens>;
  /** Reversible preparation only, unless it calls job.arm(). */
  postPending(job: Job): Promise<Result>;
  /** Read only. */
  checkPostStatus(job: Job, pendingData: any): Promise<Result>;
  finalizePost(job: Job, pendingData: any): Promise<Result>;
  /** Read only: after an unknown outcome, ask what happened. null = cannot tell (the post becomes unconfirmed). */
  recover?(job: Job, pendingData: any): Promise<Result | null>;
  analytics?(call: Call, token: string, account: string, days: number, now: number): Promise<Row[]>;
}

export interface Client {
  id: string;
  secret: string;
}

export const reconnectMessage = (label: string) => `Please reconnect your ${label} account, then schedule the post again.`;

/** fetch that turns every bad answer into a Fail. It never retries: the publisher decides that. */
export function caller(deps: Deps, p: Pick<Platform, 'label' | 'errors'>): Call {
  return async (url, init = {}, alsoOk = []) => {
    let res: Response;
    try {
      res = await deps.fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new Fail('unknown', `We could not reach ${p.label}. Please try again later.`);
    }
    if (res.ok || alsoOk.includes(res.status)) return res;
    const body = (await res.text().catch(() => '')).slice(0, 20_000);
    throw classify(p, res.status, body);
  };
}

export function classify(p: Pick<Platform, 'label' | 'errors'>, status: number, body: string): Fail {
  const rule = p.errors.find(([pattern]) => pattern.test(body));
  let kind: FailKind =
    rule?.[1] ??
    (status === 429 || /rate_limit_exceeded|Rate limit/.test(body) ? 'retry'
      : status === 401 ? 'refresh'
      : status >= 500 ? 'unknown'
      : 'bad');
  if (kind === 'retry' && status >= 500) kind = 'unknown';
  // Only numbers and short codes are logged, never the body: it can echo tokens or the post.
  const codes = [...body.matchAll(/"(?:code|error_subcode|reason|serviceErrorCode)"\s*:\s*"?([\w.-]{1,40})/g)].map((m) => m[1]);
  console.warn('platform error', p.label, status, kind, codes.join(','));
  if (rule) return new Fail(kind, rule[2]);
  return new Fail(
    kind,
    kind === 'refresh' ? reconnectMessage(p.label)
      : kind === 'retry' ? `${p.label} is asking us to slow down. Please try again later.`
      : kind === 'unknown' ? `${p.label} is having trouble right now. Please try again later.`
      : `${p.label} did not accept this. Please check the post and your account, then try again.`
  );
}

/** A success answer without the field we need is an unknown outcome, not a success. */
export function need<T>(value: T | undefined | null | '', label: string): T {
  if (value === undefined || value === null || value === '') throw new Fail('unknown', `${label} gave an answer we could not read.`);
  return value;
}

export function checkScopes(label: string, required: string[], got: unknown) {
  const list = Array.isArray(got) ? got.map(String) : decodeURIComponent(String(got ?? '')).split(/[,\s]+/);
  if (!required.every((scope) => list.includes(scope))) {
    throw new Fail('bad', `Some permissions were not allowed. Please connect ${label} again and allow all of them.`);
  }
}

export const form = (fields: Record<string, string>): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields) });

export const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export const day = (ms: number | string) => new Date(ms).toISOString().slice(0, 10);

export function row(label: string, series: { date: string; total: number }[], average = false): Row {
  const sum = series.reduce((n, p) => n + p.total, 0);
  return { label, total: average && series.length ? Math.round((sum / series.length) * 10) / 10 : sum, series };
}
