# Superdoctor posting engine

A small multi-tenant posting service: one Cloudflare Worker, D1, R2 (or KV) and a cron that runs every minute.
It connects and posts to Instagram, Facebook Pages, YouTube and LinkedIn personal profiles.

**Licence: AGPL-3.0**, the same as the rest of this repository (see `../LICENSE`). Much of it is adapted from
[Postiz](https://github.com/gitroomhq/postiz-app) v2.26.0 by Gitroom and its contributors. Thank you.
This public repository is the source offer: whatever is deployed must be pushed here.

## Run it locally

```sh
cd engine
pnpm install
cp .dev.vars.example .dev.vars        # fill in the first five; platform pairs may stay empty
pnpm dev                              # http://localhost:3300, applies the local database migrations first
curl http://localhost:3300/cdn-cgi/handler/scheduled   # run the cron once (it does not run by itself locally)
```

`pnpm test`, `pnpm typecheck`, `pnpm deploy:check`. Tests never call a real platform: `fetch` and the clock are injected.

## Deploy

Use a Workers **Paid** plan: the Free plan's 10 ms of CPU and 1,000 KV writes a day are too small for video.

1. `pnpm exec wrangler login`
2. `pnpm exec wrangler deploy`. The first time it creates the D1 database and KV namespace and writes their ids into `wrangler.jsonc` (ids are not secret, commit them).
3. `pnpm exec wrangler d1 migrations apply DB --remote`
4. `pnpm exec wrangler secret put NAME` for each name in `.dev.vars.example` (`APP_ORIGIN` and `PUBLIC_URL` too).
5. Give it a custom domain and set that as `PUBLIC_URL`. Check `GET /v1/health`.
6. Later, for R2: switch it on in the dashboard, uncomment `r2_buckets` in `wrangler.jsonc`, deploy. Keep the KV binding for two weeks so older media still reads.

For later releases: migrations first, then deploy.

## What each platform app needs

Redirect URI, exactly: `https://<app>/api/channels/callback/<platform>` (`instagram`, `facebook`, `youtube`, `linkedin`).
It belongs to the private app, which checks who is signed in and then calls `POST /v1/complete`.

| Platform | App type | Scopes asked for |
| --- | --- | --- |
| Instagram | Instagram API with Instagram Login (professional accounts) | `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights` |
| Facebook | Facebook Login | `pages_show_list`, `pages_manage_posts`, `pages_read_engagement` (all required), `business_management`, `read_insights` |
| YouTube | Google OAuth web client; YouTube Data API v3 and YouTube Analytics API on | `youtube.upload`, `youtube.readonly`, `yt-analytics.readonly` |
| LinkedIn | Products "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" | `openid`, `profile`, `w_member_social` |

- YouTube: until Google audits the project, uploads stay private. While the consent screen is in "testing", sign-ins die after 7 days.
- LinkedIn gives refresh tokens only to approved apps; otherwise doctors reconnect every 60 days. The API version is pinned in `src/platforms/linkedin.ts` (`202611`, good for about a year).
- PKCE is used for YouTube, the only one of the four whose web sign-in supports it here.

## HTTP contract

Server to server only. Header `Authorization: Bearer <POSTING_SECRET>`, JSON. `owner` is the tenant uuid and scopes every query.
Errors are `{error: "plain English"}`; 409s on a post also carry `{state}`.

| Call | Answer |
| --- | --- |
| `GET /v1/health` | `{ok, platforms: {instagram, facebook, youtube, linkedin}}` |
| `GET /v1/channels?owner=` | `{channels: [{id, platform, name, handle, picture, status}]}`; `handle` and `picture` may be `""`; status `ok` or `reconnect` |
| `POST /v1/connect {owner, platform, redirect_uri}` | `{url}`; the state lives 15 minutes and works once |
| `POST /v1/complete {owner, platform, state, code}` | `{channels}`, or for Facebook `{choose: {ticket, options: [{id, name, picture}]}}` |
| `POST /v1/choose {owner, ticket, ids}` | `{channels}`; the ticket lives 15 minutes and works once |
| `DELETE /v1/channels/:id?owner=` | `{ok}`; cancels queued posts, deletes tokens |
| `DELETE /v1/owners/:owner` | `{ok}`; forgets channels, tokens, posts and files, 409 while a post is going out |
| `PUT /v1/media?owner=` raw body | `{id, size}`; `image/jpeg`, `image/png` (8 MB), `video/mp4` (300 MB). **`Content-Length` is required.** |
| `POST /v1/posts {owner, ref, channel, kind, text, title?, media, at}` | `{id, state}`; the same `(owner, ref)` returns the existing post before anything else is checked |
| `PATCH /v1/posts/:id {owner, at}` | `{id, state}`, only while queued |
| `DELETE /v1/posts/:id?owner=` | `{state: "cancelled"}` (queued, failed or already cancelled), else 409 |
| `GET /v1/posts?owner=&ids=&refs=` | `{posts: [{id, ref, channel, state, error, url, at}]}`; either or both lists, 1 to 100 values |
| `GET /v1/analytics/:channel?owner=&days=30` | `{rows: [{label, total, series: [{date, total}]}]}`; 1 to 90 days (Instagram at most 30), LinkedIn always empty |
| `GET /m/:id/:sig.:ext` | public signed media, with Range and HEAD |

Rules: `at` must carry a time zone (`Z` or `+05:30`); null or past means now. Images 1 to 10 on every platform, JPG only on Instagram.
Text limits: Instagram 2200, LinkedIn 3000, Facebook 60000, YouTube 5000 **bytes** (Hindi uses 3 per letter) and no `<` or `>`.
States: `queued`, `publishing`, `published`, `failed` (nothing went out), `unconfirmed` (it may have gone out: check before reposting), `cancelled`.

**Uploads over 100 MB:** Cloudflare itself refuses request bodies over 100 MB on Free and Pro zones (200 MB on Business), before this code runs.

## How publishing stays safe

- One conditional `UPDATE` claims due posts, so overlapping crons never hold the same post. Each claim is a 5 minute lease.
- Every run goes `postPending` → `checkPostStatus` → `finalizePost`, saving encrypted progress between ticks.
- Right before a call that cannot be undone the row is "armed" (which also checks the lease and that the channel still exists).
  No clear answer while armed, or a crash, means the call is never repeated: Instagram and YouTube are asked what happened, otherwise the post becomes `unconfirmed`.
- A token error refreshes once per post, then retries; a second one, or a failed refresh, marks the channel `reconnect`.
- Media is deleted 24 h after its last post finished, unused media after 14 days. Fresh KV media waits a minute before posting, because KV needs that long to appear everywhere.

## What is adapted from Postiz

| Here | From |
| --- | --- |
| `src/publish.ts` | `apps/orchestrator/src/workflows/post-workflows/post.workflow.v1.1.2.ts` (Temporal replaced by D1 + cron) |
| `src/platforms/base.ts` | `libraries/nestjs-libraries/src/integrations/social.abstract.ts` (error classes, scope check) |
| `src/platforms/instagram.ts` | `social/instagram.standalone.provider.ts`, `social/instagram.provider.ts` |
| `src/platforms/facebook.ts` | `social/facebook.provider.ts` |
| `src/platforms/youtube.ts` | `social/youtube.provider.ts` |
| `src/platforms/linkedin.ts` | `social/linkedin.provider.ts` |

Changed on purpose: Instagram captions travel as form fields, not in the URL; failed calls are not retried inside `fetch` (the cron decides);
Facebook videos are checked after upload; LinkedIn video parts each go to their own upload address with the real upload token, API version 202611;
numeric error codes match whole numbers only. The database, media store, HTTP API and tests are new.
