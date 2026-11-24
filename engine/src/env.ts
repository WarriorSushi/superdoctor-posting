export interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  MEDIA_KV?: KVNamespace;
  POSTING_SECRET: string;
  TOKEN_KEY: string;
  MEDIA_SIGN_KEY: string;
  APP_ORIGIN: string;
  PUBLIC_URL: string;
  INSTAGRAM_APP_ID?: string;
  INSTAGRAM_APP_SECRET?: string;
  FACEBOOK_APP_ID?: string;
  FACEBOOK_APP_SECRET?: string;
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
}

/** Outside world, injected so tests can script the platforms and the clock. */
export interface Deps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
}

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;

/** An error whose message is safe to show to a doctor. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
