# 🏆 Family Habit Leaderboard

A zero-cost, self-hosted leaderboard for families: every day, each family member logs
whether they **went to bed by their bedtime**, **avoided the foods they're trying to
avoid**, and **finished their chores**. The app tallies yes-days per month, year, and
all-time, tracks streaks, and emails a weekly standings summary.

Built for [Cloudflare Workers](https://workers.cloudflare.com/) (free tier) with a
[D1](https://developers.cloudflare.com/d1/) SQLite database — runs comfortably free
for a family.

## Features

- 📱 **Mobile-first web app** — each person adds it to their phone's home screen
- 🎯 **Personal goals** — everyone has their own bedtime, their own definition of foods to avoid, and their own chore list (one grouped yes/no question)
- 👨‍👩‍👧‍👦 **Roles** — the admin sets kids' bedtimes and can remove anyone's PIN; adults manage their own goals and can set kids' chores; kids own only their food goal
- ⏳ **Grace window** — a day becomes loggable once it's over (you log *yesterday*), and stays editable for 3 days; after that it locks in as a "no"
- 🔥 **Streaks** — current and longest streaks per goal, plus "perfect days" (both goals met)
- 📧 **Reminders** — daily email nudge for unanswered days and a weekly leaderboard email (via [Resend](https://resend.com), free tier), both optional
- 🔒 **Privacy** — all personal data lives only in *your* database; this repo contains none

## Quick start (local)

Requires Node 20+.

```sh
npm install
cp .dev.vars.example .dev.vars   # local family password is "example"
npm run db:schema     # create tables in a local D1 database
npm run db:seed       # load the fictional example family
npm run dev           # http://localhost:8787
```

Family password: `example`. Example PINs: Alex `1111`, Bailey `2222`, all kids `0000`.

Run the logic tests with `npm test`.

## Deploy to Cloudflare (free)

1. Create a free Cloudflare account, then:
   ```sh
   npx wrangler login
   npx wrangler d1 create family-leaderboard
   ```
2. Copy the printed `database_id` into `wrangler.toml`.
3. Set your family in a **gitignored** seed file:
   ```sh
   cp seed.example.sql seed.local.sql
   # edit seed.local.sql with your family's names, emails, roles, bedtimes, food rules.
   # pin_hash is the SHA-256 of the PIN:  echo -n "1234" | shasum -a 256
   ```
4. Set the shared family password (required — the API refuses to serve anything
   without it). Hash it and store it as a secret:
   ```sh
   echo -n "your-family-password" | shasum -a 256   # copy the hex
   npx wrangler secret put FAMILY_KEY_HASH           # paste the hex
   ```
5. Set your timezone in `wrangler.toml` (`FAMILY_TZ`), then:
   ```sh
   npm run db:schema:remote
   npm run db:seed:local:remote
   npm run deploy
   ```
6. Update `APP_URL` in `wrangler.toml` to your `*.workers.dev` URL and deploy again.
7. Everyone opens the URL on their phone, enters the family password once,
   then Share → **Add to Home Screen**.

### Optional: email reminders

1. Create a free [Resend](https://resend.com) account and API key.
2. ```sh
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put MAIL_FROM   # e.g. "Leaderboard <onboarding@resend.dev>"
   ```
3. Cron schedules live in `wrangler.toml` (`[triggers]`): daily reminder + Sunday summary.
   Adjust the UTC hours to suit your timezone. Without the secrets set, emails are
   skipped silently — the app works fine without them.

## How scoring works

- A day counts toward the tally only when the answer was **yes**.
- Today is never loggable — you don't know the answers until the day is over.
- Unanswered days within the 3-day grace window are *pending* — they don't break streaks yet.
- Unanswered days older than the grace window count as **no** (honor system, but no hoarding!).
- "Perfect days" ⭐ = all three questions answered yes on the same day. Streaks shown on the board count perfect days.
- Days before a member's `start_date` are ignored, so late joiners aren't penalized.

## Privacy & access model

- **Repo**: ships only with fictional example data (`seed.example.sql`). Real names,
  emails, bedtimes, PINs, and food rules go in `seed.local.sql` and `.dev.vars`, both
  gitignored — they exist only on your machine and in your Cloudflare database.
- **Deployed app**: every API route requires the shared family password, verified
  server-side against a hash stored as a Worker secret (`FAMILY_KEY_HASH`). Without
  it, strangers who find the URL get a lock screen and `401`s — no names, no data.
  The server fails closed if the secret isn't configured. The static page itself
  contains no personal data, is marked `noindex`, and `robots.txt` blocks crawlers.
- **Database**: D1 is only reachable through the Worker; there is no public endpoint.
  Traffic is HTTPS end to end.
- **PINs** distinguish family members from each other (sibling-proofing); the family
  password keeps outsiders away. Both are stored as SHA-256 hashes, suitable for a
  family scoreboard — this is deliberately not bank-grade auth. If you want stronger
  protection, put the Worker behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
  (free for up to 50 users) for email-verified logins.

## License

MIT
