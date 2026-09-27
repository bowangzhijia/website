-- 订阅者表
-- token          退订凭证，随机生成，放在退订链接里
-- unsubscribed_at 退订时间；NULL 表示仍在订阅中
CREATE TABLE IF NOT EXISTS subscribers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT    NOT NULL UNIQUE,
  token           TEXT,
  source          TEXT,
  created_at      TEXT    NOT NULL,
  unsubscribed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscribers_created_at
  ON subscribers (created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_token
  ON subscribers (token);

-- 留言表（同时会通过邮件转发给站长，这里是一份备份）
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL,
  message    TEXT    NOT NULL,
  source     TEXT,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages (created_at DESC);

-- 发信失败记录：邮件没送出去时把原因记在这里，方便排查
CREATE TABLE IF NOT EXISTS send_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  detail     TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_send_logs_created_at
  ON send_logs (created_at DESC);
