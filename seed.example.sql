-- EXAMPLE seed data with a fictional family. Safe to commit.
-- For your real family, copy this to seed.local.sql (gitignored), edit it,
-- and apply it with:  npm run db:seed:local   (or db:seed:local:remote)
--
-- PINs: pin_hash is the SHA-256 hex of the PIN string. Generate one with:
--   echo -n "1234" | shasum -a 256
-- The example PINs below are: Alex 1111, Bailey 2222, kids 0000.
-- Leave pin_hash NULL for no PIN.

INSERT INTO members (name, email, role, bedtime, food_rule, chores_rule, pin_hash, start_date) VALUES
  ('Alex Example',   'alex@example.com',   'admin', '10:30 PM', 'no ultraprocessed food or cane sugar', 'dishes and laundry',    '0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c', date('now', '-1 day')),
  ('Bailey Example', 'bailey@example.com', 'adult', '10:45 PM', 'no junk food after dinner',            'kitchen cleanup',       'edee29f882543b956620b26d0ee0e7e950399b1c4222f5de05e06425b4c995e9', date('now', '-1 day')),
  ('Casey Example',  'casey@example.com',  'kid',   '9:00 PM',  'no candy or soda',                     'make bed, feed cat',    '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0', date('now', '-1 day')),
  ('Drew Example',   'drew@example.com',   'kid',   '9:00 PM',  'no candy or chips',                    'take out trash',        '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0', date('now', '-1 day')),
  ('Emery Example',  'emery@example.com',  'kid',   '8:30 PM',  'no dessert on weekdays',               'tidy room',             '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0', date('now', '-1 day')),
  ('Finley Example', 'finley@example.com', 'kid',   '8:30 PM',  'no sugary cereal',                     'set the table',         '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0', date('now', '-1 day'));
