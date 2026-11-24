-- Times are unix milliseconds. Columns named "sealed" hold AES-GCM ciphertext.
CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  platform TEXT NOT NULL,
  account TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  picture TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'reconnect')),
  sealed TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  check_at INTEGER NOT NULL,
  created INTEGER NOT NULL,
  UNIQUE (owner, platform, account)
);
CREATE INDEX channels_check ON channels (check_at);

-- Unfinished sign-ins: the OAuth state, then (Facebook) the page choice ticket.
CREATE TABLE flows (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('state', 'ticket')),
  owner TEXT NOT NULL,
  platform TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  sealed TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  store TEXT NOT NULL CHECK (store IN ('r2', 'kv')),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'ready', 'deleting')),
  created INTEGER NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  ref TEXT NOT NULL,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'images', 'video')),
  text TEXT NOT NULL,
  title TEXT NOT NULL,
  media_count INTEGER NOT NULL,
  at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'publishing', 'published', 'failed', 'unconfirmed', 'cancelled')),
  error TEXT,
  url TEXT,
  platform_id TEXT,
  -- publishing machinery
  next_at INTEGER NOT NULL,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  armed INTEGER NOT NULL DEFAULT 0,     -- 1 = an irreversible call may be in flight
  refreshed INTEGER NOT NULL DEFAULT 0, -- 1 = the token was already refreshed for this post
  attempts INTEGER NOT NULL DEFAULT 0,  -- consecutive claims without a clean step
  checks INTEGER NOT NULL DEFAULT 0,
  sealed TEXT,                          -- pendingData
  created INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (owner, ref)
);
CREATE INDEX posts_due ON posts (state, next_at);
CREATE INDEX posts_channel ON posts (channel, state);

CREATE TABLE post_media (
  post TEXT NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  media TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
  pos INTEGER NOT NULL,
  PRIMARY KEY (post, media)
);
CREATE INDEX post_media_media ON post_media (media);
