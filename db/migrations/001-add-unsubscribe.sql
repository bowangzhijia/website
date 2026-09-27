-- 给已存在的数据库补上退订相关字段
-- 只需执行一次：
--   npx wrangler d1 execute etf-subscribers --remote --file=db/migrations/001-add-unsubscribe.sql

ALTER TABLE subscribers ADD COLUMN token TEXT;
ALTER TABLE subscribers ADD COLUMN unsubscribed_at TEXT;

-- 给历史订阅者补发退订凭证，保证他们也能退订
UPDATE subscribers
   SET token = lower(hex(randomblob(16)))
 WHERE token IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_token
  ON subscribers (token);
