# 🏆 Family Habit Leaderboard

A zero-cost, self-hosted leaderboard for families: every day, each family member logs
whether they **went to bed by their bedtime** and **avoided the foods they're trying to
avoid**. The app tallies yes-days per month, year, and all-time, tracks streaks, and
emails a weekly standings summary.

Built for [Cloudflare Workers](https://workers.cloudflare.com/) (free tier) with a
[D1](https://developers.cloudflare.com/d1/) SQLite database — runs comfortably free
for a family.

## Features

- 📱 **Mobile-first web app** — each person adds it to their phone's home screen
- 🎯 **Personal goals** — everyone has their own bedtime and their own definition of foods to avoid
- 👨‍👩‍👧‍👦 **Roles** — the admin sets kids' bedtimes; adults manage their own; everyone owns their food goal
- ⏳ **Grace window** — answers can be logged up to 3 days late; after that the day locks in as a "no"
- 🔥 **Streaks** — current and longest streaks per goal, plus "perfect days" (both goals met)
- 📧 **Reminders** — daily email nudge for unanswered days and a weekly leaderboard email (via [Resend](https://resend.com), free tier), both optional
- 🔒 **Privacy** — all personal data lives only in *your* database; this repo contains none

## Quick start (local)

Requires Node 20+.

```sh
npm install
npm run db:schema     # create tables in a local D1 database
npm run db:seed       # load the fictional example family
npm run dev           # http://localhost:8787
```

Example PINs: Alex `1111`, Bailey `2222`, all kids `0000`.

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
4. Set your timezone in `wrangler.toml` (`FAMILY_TZ`), then:
   ```sh
   npm run db:schema:remote
   npm run db:seed:local:remote
   npm run deploy
   ```
5. Update `APP_URL` in `wrangler.toml` to your `*.workers.dev` URL and deploy again.
6. Everyone opens the URL on their phone → Share → **Add to Home Screen**.

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
- Unanswered days within the 3-day grace window are *pending* — they don't break streaks yet.
- Unanswered days older than the grace window count as **no** (honor system, but no hoarding!).
- "Perfect days" ⭐ = both questions answered yes on the same day. Streaks shown on the board count perfect days.
- Days before a member's `start_date` are ignored, so late joiners aren't penalized.

## Privacy model

The repo ships only with fictional example data (`seed.example.sql`). Real names,
emails, bedtimes, PINs, and food rules go in `seed.local.sql` and `.dev.vars`, both
gitignored — they exist only on your machine and in your Cloudflare database. PINs are
stored as SHA-256 hashes; they're a sibling-proofing measure, not bank-grade security.

## License

MIT
