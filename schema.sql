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
  logged_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (member_id, date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_member_date ON checkins (member_id, date);
