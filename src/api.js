import { todayInTZ, addDays, loggableDates, memberStats, monthTotals, dayStatus } from './stats.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const err = (message, status) => json({ error: message }, status);

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parse a JSON object body; null for anything else (bad JSON, arrays, primitives). */
async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Look up a member and verify their PIN. Returns the row, or null if denied.
 * Failed PIN attempts count toward the same per-IP rate limit as failed
 * family passwords, so PINs can't be brute-forced from inside the gate.
 */
async function authMember(env, memberId, pin, ip) {
  const id = Number(memberId);
  if (!Number.isInteger(id) || id < 1) return null;
  const member = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first();
  if (!member) return null;
  if (!member.pin_hash) return member;
  if (!pin || (await sha256Hex(String(pin))) !== member.pin_hash) {
    if (ip) {
      await env.DB.prepare('INSERT INTO auth_failures (ip, ts) VALUES (?, ?)')
        .bind(ip, Math.floor(Date.now() / 1000)).run();
    }
    return null;
  }
  return member;
}

/** Field length caps — generous for humans, hostile to pranks. */
const LIMITS = { name: 80, bedtime: 100, rule: 500, email: 254, pin: 12, password: 100, push: 4096 };
const tooLong = (s, n) => typeof s === 'string' && s.length > n;

/** Length-check the member fields accepted by the admin add/update routes.
 *  Returns an error message naming the offending field, or null. */
function memberFieldError(m) {
  const checks = [
    [m.name, LIMITS.name, 'name'],
    [m.bedtime, LIMITS.bedtime, 'bedtime'],
    [m.foodRule, LIMITS.rule, 'food goal'],
    [m.chores, LIMITS.rule, 'chores list'],
    [m.outside, LIMITS.rule, 'outside & exercise question'],
    [m.email, LIMITS.email, 'email'],
    [String(m.pin ?? ''), LIMITS.pin, 'PIN'],
  ];
  for (const [value, limit, label] of checks) {
    if (tooLong(value, limit)) return `The ${label} is too long (max ${limit} characters)`;
  }
  return null;
}

// Visible to anyone past the family-password gate (i.e. the family).
const PUBLIC_FIELDS = 'id, name, email, role, bedtime, food_rule, chores_rule, outside_rule, pin_hash IS NOT NULL AS has_pin';

export async function handleApi(request, env) {
  // Every API route requires the shared family password. The hash lives in
  // the settings table once the admin changes it in-app; the FAMILY_KEY_HASH
  // secret is the bootstrap value. Fail closed if neither is configured.
  const override = await env.DB.prepare(
    "SELECT value FROM settings WHERE key = 'family_key_hash'"
  ).first().catch(() => null);
  const keyHash = override?.value ?? env.FAMILY_KEY_HASH;
  if (!keyHash) {
    return err('Server not configured: set the FAMILY_KEY_HASH secret (see README)', 503);
  }
  // Rate-limit password guessing: after 20 failures from one IP in 10 minutes,
  // refuse even correct attempts until the window passes.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Math.floor(Date.now() / 1000);
  const { cnt } = await env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM auth_failures WHERE ip = ? AND ts > ?'
  ).bind(ip, now - 600).first();
  if (cnt >= 20) return err('Too many attempts — try again in a few minutes', 429);

  const familyKey = request.headers.get('X-Family-Key');
  if (!familyKey || (await sha256Hex(familyKey)) !== keyHash.toLowerCase()) {
    await env.DB.prepare('INSERT INTO auth_failures (ip, ts) VALUES (?, ?)').bind(ip, now).run();
    await env.DB.prepare('DELETE FROM auth_failures WHERE ts < ?').bind(now - 3600).run();
    return err('Family password required', 401);
  }

  const url = new URL(request.url);
  const path = url.pathname;
  const today = todayInTZ(env.FAMILY_TZ);
  const graceDays = parseInt(env.GRACE_DAYS, 10) || 3;

  try {
    if (request.method === 'GET' && path === '/api/members') {
      const { results } = await env.DB.prepare(`SELECT ${PUBLIC_FIELDS} FROM members ORDER BY id`).all();
      return json(results);
    }

    if (request.method === 'GET' && path === '/api/leaderboard') {
      return json(await leaderboard(env, today, graceDays));
    }

    if (request.method === 'GET' && path === '/api/vapid') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY ?? null });
    }

    // Monthly awards: per-category winners for any completed (or current) month.
    if (request.method === 'GET' && path === '/api/awards') {
      const month = url.searchParams.get('month') ?? today.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month) || month > today.slice(0, 7)) return err('Invalid month', 400);
      return json(await monthlyAwards(env, month, today, graceDays));
    }

    if (request.method === 'GET' && path === '/api/me') {
      // PIN arrives as a header (preferred — keeps it out of URLs/logs) or query param.
      const member = await authMember(
        env, url.searchParams.get('memberId'),
        request.headers.get('X-Member-Pin') ?? url.searchParams.get('pin'), ip
      );
      if (!member) return err('Wrong PIN', 403);
      const dates = loggableDates(today, graceDays);
      const { results: entries } = await env.DB.prepare(
        'SELECT date, bedtime_yes, bedtime_minutes_late, food_yes, chores_yes, outside_yes, vacation FROM checkins WHERE member_id = ? AND date >= ?'
      ).bind(member.id, dates[0]).all();
      const byDate = Object.fromEntries(entries.map((e) => [e.date, e]));
      // Clamp: SQLite's date('now') is UTC, so a freshly seeded start_date can
      // be "tomorrow" in the family timezone — never let it hide today's card.
      const start = member.start_date > today ? today : member.start_date;
      return json({
        id: member.id,
        name: member.name,
        role: member.role,
        bedtime: member.bedtime,
        food_rule: member.food_rule,
        chores_rule: member.chores_rule,
        outside_rule: member.outside_rule,
        email: member.email,
        push: !!member.push_subscription,
        today,
        days: dates.filter((d) => d >= start).map((d) => ({ date: d, entry: byDate[d] ?? null })),
      });
    }

    if (request.method === 'POST' && path === '/api/checkin') {
      const body = await readBody(request);
      if (!body) return err('Invalid request body', 400);
      const member = await authMember(env, body.memberId, body.pin, ip);
      if (!member) return err('Wrong PIN', 403);
      const { date } = body;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return err('Invalid date', 400);
      if (date >= today) return err('A day can be logged once it is over — come back tomorrow', 400);
      if (date < addDays(today, -graceDays)) {
        return err(`That day can no longer be logged (grace window is ${graceDays} days)`, 400);
      }
      if (date < member.start_date) return err('Date is before your start date', 400);
      return saveCheckin(env, member.id, date, body);
    }

    if (request.method === 'POST' && path === '/api/profile') {
      const body = await readBody(request);
      if (!body) return err('Invalid request body', 400);
      const member = await authMember(env, body.memberId, body.pin, ip);
      if (!member) return err('Wrong PIN', 403);

      // Validate everything before writing anything, so a rejected field
      // can't leave a half-applied update behind.
      const foodRule = typeof body.foodRule === 'string' ? body.foodRule.trim() : null;
      const bedtime = typeof body.bedtime === 'string' ? body.bedtime.trim() : null;
      const chores = typeof body.chores === 'string' ? body.chores.trim() : null;
      const outside = typeof body.outside === 'string' ? body.outside.trim() : null;
      if (tooLong(foodRule, LIMITS.rule)) return err(`Your food goal is too long (max ${LIMITS.rule} characters)`, 400);
      if (tooLong(chores, LIMITS.rule)) return err(`Your chores text is too long (max ${LIMITS.rule} characters)`, 400);
      if (tooLong(outside, LIMITS.rule)) return err(`Your outside & exercise question is too long (max ${LIMITS.rule} characters)`, 400);
      if (tooLong(bedtime, LIMITS.bedtime)) return err(`Your bedtime is too long (max ${LIMITS.bedtime} characters)`, 400);
      if (bedtime && member.role === 'kid') return err('Only a parent can change your bedtime', 403);
      if (chores && member.role === 'kid') return err('Only a parent can change your chores', 403);
      if (outside && member.role === 'kid') return err('Only a parent can change your outside goal', 403);
      let email;
      if (typeof body.email === 'string') {
        email = body.email.trim();
        if (email && (email.length > LIMITS.email || !/^\S+@\S+\.\S+$/.test(email))) {
          return err('That email does not look right', 400);
        }
      }
      let pushValue;
      if ('pushSubscription' in body) {
        pushValue = null;
        if (body.pushSubscription) {
          try {
            if (body.pushSubscription.length > LIMITS.push) throw new Error();
            const endpoint = JSON.parse(body.pushSubscription)?.endpoint;
            if (!endpoint || !endpoint.startsWith('https://')) throw new Error();
            pushValue = body.pushSubscription;
          } catch {
            return err('Invalid push subscription', 400);
          }
        }
      }

      if (foodRule) {
        await env.DB.prepare('UPDATE members SET food_rule = ? WHERE id = ?').bind(foodRule, member.id).run();
      }
      if (bedtime) {
        await env.DB.prepare('UPDATE members SET bedtime = ? WHERE id = ?').bind(bedtime, member.id).run();
      }
      if (chores) {
        await env.DB.prepare('UPDATE members SET chores_rule = ? WHERE id = ?').bind(chores, member.id).run();
      }
      if (outside) {
        await env.DB.prepare('UPDATE members SET outside_rule = ? WHERE id = ?').bind(outside, member.id).run();
      }
      if (email !== undefined) {
        await env.DB.prepare('UPDATE members SET email = ? WHERE id = ?').bind(email || null, member.id).run();
      }
      if (pushValue !== undefined) {
        await env.DB.prepare('UPDATE members SET push_subscription = ? WHERE id = ?').bind(pushValue, member.id).run();
      }
      return json({ ok: true });
    }

    // Admin changes the shared family password from the app; the new hash is
    // stored in settings and overrides the bootstrap FAMILY_KEY_HASH secret.
    if (request.method === 'POST' && path === '/api/admin/familykey') {
      const body = await readBody(request);
      if (!body) return err('Invalid request body', 400);
      const actor = await authMember(env, body.adminId, body.pin, ip);
      if (!actor || actor.role !== 'admin') return err('Admin access required', 403);
      const newKey = String(body.newKey ?? '');
      if (newKey.length < 6) return err('Family password must be at least 6 characters', 400);
      if (newKey.length > LIMITS.password) return err('Family password is too long', 400);
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('family_key_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      ).bind(await sha256Hex(newKey)).run();
      return json({ ok: true });
    }

    // Admin corrections: edit any member's day, including beyond the grace window.
    if (request.method === 'POST' && path === '/api/admin/checkin') {
      const body = await readBody(request);
      if (!body) return err('Invalid request body', 400);
      const actor = await authMember(env, body.adminId, body.pin, ip);
      if (!actor || actor.role !== 'admin') return err('Admin access required', 403);
      const target = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(body.memberId).first();
      if (!target) return err('No such member', 404);
      const { date } = body;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return err('Invalid date', 400);
      if (date >= today) return err('Only past days can be edited', 400);
      if (date < target.start_date) return err(`That is before ${target.name}'s start date`, 400);
      return saveCheckin(env, target.id, date, body);
    }

    // Month of day-by-day history for one member (whole family can view).
    if (request.method === 'GET' && path === '/api/history') {
      const member = await env.DB.prepare('SELECT * FROM members WHERE id = ?')
        .bind(url.searchParams.get('memberId')).first();
      if (!member) return err('No such member', 404);
      const month = url.searchParams.get('month') ?? today.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) return err('Invalid month', 400);
      const { results: entries } = await env.DB.prepare(
        "SELECT date, bedtime_yes, bedtime_minutes_late, food_yes, chores_yes, outside_yes, vacation FROM checkins WHERE member_id = ? AND date LIKE ?"
      ).bind(member.id, month + '-%').all();
      const byDate = new Map(entries.map((e) => [e.date, e]));
      const [y, m] = month.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const days = [];
      for (let i = 1; i <= lastDay; i++) {
        const d = `${month}-${String(i).padStart(2, '0')}`;
        const entry = byDate.get(d);
        const statuses = {
          bedtime: dayStatus(entry, d, today, graceDays, 'bedtime_yes'),
          food: dayStatus(entry, d, today, graceDays, 'food_yes'),
          chores: dayStatus(entry, d, today, graceDays, 'chores_yes'),
          outside: dayStatus(entry, d, today, graceDays, 'outside_yes'),
        };
        days.push({
          date: d,
          preStart: d < member.start_date,
          vacation: !!entry?.vacation,
          logged: !!entry,
          entry: entry && !entry.vacation
            ? { bedtime: !!entry.bedtime_yes, bedtimeMinutesLate: entry.bedtime_minutes_late ?? null,
                food: !!entry.food_yes, chores: !!entry.chores_yes, outside: !!entry.outside_yes }
            : null,
          statuses,
        });
      }
      return json({ member: { id: member.id, name: member.name }, month, today, days });
    }

    if (request.method === 'POST' && path === '/api/admin/member') {
      const body = await readBody(request);
      if (!body) return err('Invalid request body', 400);
      const actor = await authMember(env, body.adminId, body.pin, ip);
      if (!actor || actor.role === 'kid') return err('Admin access required', 403);
      const m = body.member ?? {};

      // Only the admin can edit other members. Adults manage their own goals
      // through /api/profile; kids' goals are admin-set.
      if (actor.role !== 'admin') return err('Admin access required', 403);

      const fieldError = memberFieldError(m);
      if (fieldError) return err(fieldError, 400);

      if (body.action === 'add') {
        if (!m.name?.trim() || !['admin', 'adult', 'kid'].includes(m.role)) {
          return err('A name and a valid role are required', 400);
        }
        try {
          await env.DB.prepare(
            'INSERT INTO members (name, email, role, bedtime, food_rule, chores_rule, outside_rule, pin_hash, start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
          ).bind(
            m.name.trim(), m.email ?? null, m.role,
            m.bedtime?.trim() || '9:00 PM', m.foodRule?.trim() || 'junk food',
            m.chores?.trim() || 'daily chores',
            m.outside?.trim() || 'Went outside for 30+ minutes',
            m.pin ? await sha256Hex(String(m.pin)) : null,
            addDays(today, -1)   // starts yesterday, so there's a card to log right away
          ).run();
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) return err('That name is already taken', 400);
          throw e;
        }
        return json({ ok: true });
      }

      if (body.action === 'delete') {
        const target = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(m.id).first();
        if (!target) return err('No such member', 404);
        if (target.role === 'admin' && (await adminCount(env)) <= 1) {
          return err('Cannot remove the only admin', 400);
        }
        await env.DB.prepare('DELETE FROM checkins WHERE member_id = ?').bind(m.id).run();
        await env.DB.prepare('DELETE FROM members WHERE id = ?').bind(m.id).run();
        return json({ ok: true });
      }

      if (body.action === 'update') {
        const target = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(m.id).first();
        if (!target) return err('No such member', 404);
        if (
          target.role === 'admin' &&
          ['adult', 'kid'].includes(m.role) &&
          (await adminCount(env)) <= 1
        ) {
          return err('Cannot demote the only admin', 400);
        }
        const updates = {
          name: m.name?.trim() || target.name,
          email: m.email !== undefined ? m.email : target.email,
          role: ['admin', 'adult', 'kid'].includes(m.role) ? m.role : target.role,
          bedtime: m.bedtime?.trim() || target.bedtime,
          food_rule: m.foodRule?.trim() || target.food_rule,
          chores_rule: m.chores?.trim() || target.chores_rule,
          outside_rule: m.outside?.trim() || target.outside_rule,
          // clearPin removes the PIN entirely; otherwise a new pin replaces, blank keeps.
          pin_hash: m.clearPin ? null : m.pin ? await sha256Hex(String(m.pin)) : target.pin_hash,
        };
        try {
          await env.DB.prepare(
            'UPDATE members SET name = ?, email = ?, role = ?, bedtime = ?, food_rule = ?, chores_rule = ?, outside_rule = ?, pin_hash = ? WHERE id = ?'
          ).bind(updates.name, updates.email, updates.role, updates.bedtime, updates.food_rule, updates.chores_rule, updates.outside_rule, updates.pin_hash, m.id).run();
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) return err('That name is already taken', 400);
          throw e;
        }
        return json({ ok: true });
      }

      return err('Unknown action', 400);
    }

    return err('Not found', 404);
  } catch (e) {
    if (e instanceof SyntaxError) return err('Invalid JSON body', 400);
    throw e;
  }
}

/**
 * Shared by self check-ins and admin corrections (date already validated):
 * clear wipes the day, vacation marks it as not counting, otherwise all
 * three answers are required.
 */
async function saveCheckin(env, memberId, date, body) {
  if (body.clear === true) {
    await env.DB.prepare('DELETE FROM checkins WHERE member_id = ? AND date = ?').bind(memberId, date).run();
    return json({ ok: true });
  }
  const vacation = body.vacation === true;
  if (!vacation && [body.bedtimeYes, body.foodYes, body.choresYes, body.outsideYes].some((v) => typeof v !== 'boolean')) {
    return err('bedtimeYes, foodYes, choresYes and outsideYes must be true or false', 400);
  }
  // Minutes late only applies when bedtime is "no"; must be a non-negative
  // multiple of 5 if given. Stored NULL otherwise (full point or N/A).
  let minutesLate = null;
  if (!vacation && body.bedtimeYes === false && body.bedtimeMinutesLate != null) {
    const n = Number(body.bedtimeMinutesLate);
    if (!Number.isInteger(n) || n < 0 || n % 5 !== 0) {
      return err('Minutes late must be a whole number of minutes in multiples of 5', 400);
    }
    minutesLate = n;
  }
  await env.DB.prepare(
    `INSERT INTO checkins (member_id, date, bedtime_yes, bedtime_minutes_late, food_yes, chores_yes, outside_yes, vacation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id, date) DO UPDATE SET
       bedtime_yes = excluded.bedtime_yes, bedtime_minutes_late = excluded.bedtime_minutes_late,
       food_yes = excluded.food_yes, chores_yes = excluded.chores_yes,
       outside_yes = excluded.outside_yes, vacation = excluded.vacation, logged_at = datetime('now')`
  ).bind(
    memberId, date,
    !vacation && body.bedtimeYes ? 1 : 0,
    minutesLate,
    !vacation && body.foodYes ? 1 : 0,
    !vacation && body.choresYes ? 1 : 0,
    !vacation && body.outsideYes ? 1 : 0,
    vacation ? 1 : 0
  ).run();
  return json({ ok: true });
}

const AWARD_CATEGORIES = [
  { key: 'bedtime', label: '🛏️ Bedtime champion', unit: 'points' },
  { key: 'food', label: '🥩 Food goal champion', unit: 'days' },
  { key: 'chores', label: '🧹 Chores champion', unit: 'days' },
  { key: 'outside', label: '🌳 Outside & exercise champion', unit: 'days' },
  { key: 'perfect', label: '⭐ Star status (most perfect days)', unit: 'days' },
  { key: 'longestRun', label: '🔥 Longest perfect-day streak', unit: 'days in a row' },
  { key: 'streakBedtime', label: '🔥🛏️ Longest bedtime streak', unit: 'days in a row' },
  { key: 'streakFood', label: '🔥🥩 Longest food streak', unit: 'days in a row' },
  { key: 'streakChores', label: '🔥🧹 Longest chores streak', unit: 'days in a row' },
  { key: 'streakOutside', label: '🔥🌳 Longest outside streak', unit: 'days in a row' },
];

/** Round a tally for display (bedtime is fractional; one decimal is plenty). */
const round1 = (n) => Math.round(n * 10) / 10;

/** Compute each category's winner(s) for one month. */
export async function monthlyAwards(env, month, today, graceDays) {
  const { results: members } = await env.DB.prepare('SELECT * FROM members ORDER BY id').all();
  const { results: entries } = await env.DB.prepare(
    'SELECT member_id, date, bedtime_yes, bedtime_minutes_late, food_yes, chores_yes, outside_yes, vacation FROM checkins WHERE date LIKE ?'
  ).bind(month + '-%').all();
  const byMember = new Map();
  for (const e of entries) {
    if (!byMember.has(e.member_id)) byMember.set(e.member_id, []);
    byMember.get(e.member_id).push(e);
  }
  const totals = members.map((m) => ({
    name: m.name,
    totals: monthTotals(m, byMember.get(m.id) ?? [], month, today, graceDays),
  }));
  return {
    month,
    categories: AWARD_CATEGORIES.map(({ key, label, unit }) => {
      const best = Math.max(0, ...totals.map((t) => t.totals[key]));
      return {
        key, label, unit, best: round1(best),
        // small epsilon so float bedtime points tie cleanly
        winners: best > 0 ? totals.filter((t) => Math.abs(t.totals[key] - best) < 1e-9).map((t) => t.name) : [],
      };
    }),
  };
}

async function adminCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM members WHERE role = 'admin'").first();
  return row.cnt;
}

/** Leaderboard data for every member; also used by the weekly summary email. */
export async function leaderboard(env, today, graceDays) {
  const { results: members } = await env.DB.prepare('SELECT * FROM members ORDER BY id').all();
  const { results: entries } = await env.DB.prepare(
    'SELECT member_id, date, bedtime_yes, bedtime_minutes_late, food_yes, chores_yes, outside_yes, vacation FROM checkins'
  ).all();
  const byMember = new Map();
  for (const e of entries) {
    if (!byMember.has(e.member_id)) byMember.set(e.member_id, []);
    byMember.get(e.member_id).push(e);
  }
  return {
    today,
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      bedtime: m.bedtime,
      food_rule: m.food_rule,
      chores_rule: m.chores_rule,
      stats: memberStats(m, byMember.get(m.id) ?? [], today, graceDays),
    })),
  };
}
