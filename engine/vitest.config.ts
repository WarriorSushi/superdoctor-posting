import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        r2Buckets: ['MEDIA'],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          POSTING_SECRET: 'test-posting-secret',
          TOKEN_KEY: 'test-token-key',
          MEDIA_SIGN_KEY: 'test-media-sign-key',
          APP_ORIGIN: 'https://app.test',
          PUBLIC_URL: 'https://posting.test',
          INSTAGRAM_APP_ID: 'ig-id',
          INSTAGRAM_APP_SECRET: 'ig-secret',
          FACEBOOK_APP_ID: 'fb-id',
          FACEBOOK_APP_SECRET: 'fb-secret',
          YOUTUBE_CLIENT_ID: 'yt-id',
          YOUTUBE_CLIENT_SECRET: 'yt-secret',
          LINKEDIN_CLIENT_ID: 'li-id',
          LINKEDIN_CLIENT_SECRET: 'li-secret',
        },
      },
    })),
  ],
});
