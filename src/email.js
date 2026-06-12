import { todayInTZ, addDays, loggableDates } from './stats.js';
import { leaderboard } from './api.js';

/** Send one email via Resend. No-op (with a log) if the API key isn't configured. */
async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.log(`[email skipped — RESEND_API_KEY/MAIL_FROM not set] to=${to} subject="${subject}"`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, html }),
  });
  if (!res.ok) console.error(`Resend error ${res.status} for ${to}: ${await res.text()}`);
}

/** Daily reminder: nudge anyone with unanswered days still inside the grace window. */
export async function sendDailyReminders(env) {
  const today = todayInTZ(env.FAMILY_TZ);
  const graceDays = parseInt(env.GRACE_DAYS, 10) || 3;
  const yesterday = addDays(today, -1);
  const windowStart = loggableDates(today, graceDays)[0];

  const { results: members } = await env.DB.prepare(
    'SELECT id, name, email, start_date FROM members WHERE email IS NOT NULL'
  ).all();

  for (const m of members) {
    const { results: entries } = await env.DB.prepare(
      'SELECT date FROM checkins WHERE member_id = ? AND date >= ?'
    ).bind(m.id, windowStart).all();
    const logged = new Set(entries.map((e) => e.date));
    const missing = [];
    for (let d = windowStart < m.start_date ? m.start_date : windowStart; d <= yesterday; d = addDays(d, 1)) {
      if (!logged.has(d)) missing.push(d);
    }
    if (missing.length === 0) continue;

    const expiring = missing[0] === windowStart;
    const subject = expiring
      ? `⏰ Last chance to log ${missing[0]} — it becomes a "no" tomorrow!`
      : '🛏️ How did yesterday go? Log your bedtime & food check-in';
    const html = `
      <p>Hi ${m.name},</p>
      <p>You have ${missing.length === 1 ? 'a day' : `${missing.length} days`} waiting to be logged:
      <b>${missing.join(', ')}</b>.</p>
      ${expiring ? `<p><b>Heads up:</b> ${missing[0]} locks in as a "no" after today.</p>` : ''}
      <p><a href="${env.APP_URL}">Tap here to check in</a> — it takes 10 seconds.</p>`;
    await sendEmail(env, m.email, subject, html);
  }
}

/** Weekly summary: the full leaderboard, emailed to everyone. */
export async function sendWeeklySummary(env) {
  const today = todayInTZ(env.FAMILY_TZ);
  const graceDays = parseInt(env.GRACE_DAYS, 10) || 3;
  const board = await leaderboard(env, today, graceDays);

  const sorted = [...board.members].sort(
    (a, b) => b.stats.month.perfect - a.stats.month.perfect || b.stats.month.bedtime + b.stats.month.food - (a.stats.month.bedtime + a.stats.month.food)
  );
  const medals = ['🥇', '🥈', '🥉'];
  const rows = sorted.map((m, i) => `
    <tr>
      <td style="padding:6px 12px">${medals[i] ?? ''} <b>${m.name}</b></td>
      <td style="padding:6px 12px;text-align:center">${m.stats.month.bedtime}</td>
      <td style="padding:6px 12px;text-align:center">${m.stats.month.food}</td>
      <td style="padding:6px 12px;text-align:center">${m.stats.month.perfect}</td>
      <td style="padding:6px 12px;text-align:center">🔥 ${m.stats.streaks.perfect.current}</td>
    </tr>`).join('');
  const html = `
    <h2>🏆 Family Leaderboard — week of ${today}</h2>
    <table style="border-collapse:collapse;font-family:sans-serif">
      <tr><th></th><th style="padding:6px 12px">🛏️ Bedtime</th><th style="padding:6px 12px">🥦 Food</th>
          <th style="padding:6px 12px">⭐ Perfect</th><th style="padding:6px 12px">Streak</th></tr>
      ${rows}
    </table>
    <p style="font-family:sans-serif">Counts are for this month. <a href="${env.APP_URL}">See the full board</a>.</p>`;

  const { results: members } = await env.DB.prepare(
    'SELECT email FROM members WHERE email IS NOT NULL'
  ).all();
  for (const m of members) {
    await sendEmail(env, m.email, `🏆 Family Leaderboard — weekly standings`, html);
  }
}
