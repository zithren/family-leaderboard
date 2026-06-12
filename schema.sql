-- Family Habit Leaderboard schema.
-- All personal data lives in the database only; nothing here is family-specific.

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'adult', 'kid')),
  bedtime TEXT NOT NULL DEFAULT '9:00 PM',
  food_rule TEXT NOT NULL DEFAULT 'junk food',
  chores_rule TEXT NOT NULL DEFAULT 'daily chores',
  -- The outside/exercise question, stored as the question text itself,
  -- e.g. "Went outside for 30+ minutes" or "Walk Merlin".
  outside_rule TEXT NOT NULL DEFAULT 'Went outside for 30+ minutes',
  pin_hash TEXT,
  push_subscription TEXT,
  -- Days before start_date never count as missed days.
  start_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  member_id INTEGER NOT NULL REFERENCES members(id),
  date TEXT NOT NULL,            -- YYYY-MM-DD in the family timezone
  bedtime_yes INTEGER NOT NULL CHECK (bedtime_yes IN (0, 1)),
  food_yes INTEGER NOT NULL CHECK (food_yes IN (0, 1)),
  chores_yes INTEGER NOT NULL CHECK (chores_yes IN (0, 1)),
  outside_yes INTEGER NOT NULL CHECK (outside_yes IN (0, 1)),
  -- Vacation days don't count for or against anyone (travel, sleepovers, holidays).
  vacation INTEGER NOT NULL DEFAULT 0 CHECK (vacation IN (0, 1)),
  logged_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (member_id, date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_member_date ON checkins (member_id, date);

-- App settings (e.g. family_key_hash once the admin changes the password in-app).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Failed family-password attempts, for rate limiting brute force.
CREATE TABLE IF NOT EXISTS auth_failures (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_failures ON auth_failures (ip, ts);
