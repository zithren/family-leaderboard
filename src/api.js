import { todayInTZ, addDays, loggableDates, memberStats, dayStatus } from './stats.js';

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

/** Look up a member and verify their PIN. Returns the row, or null if denied. */
async function authMember(env, memberId, pin) {
  const member = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(memberId).first();
  if (!member) return null;
  if (!member.pin_hash) return member;
  if (!pin || (await sha256Hex(String(pin))) !== member.pin_hash) return null;
  return member;
}

// Visible to anyone past the family-password gate (i.e. the family).
const PUBLIC_FIELDS = 'id, name, email, role, bedtime, food_rule, chores_rule, pin_hash IS NOT NULL AS has_pin';

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
  const familyKey = request.headers.get('X-Family-Key');
  if (!familyKey || (await sha256Hex(familyKey)) !== keyHash.toLowerCase()) {
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

    if (request.method === 'GET' && path === '/api/me') {
      const member = await authMember(env, url.searchParams.get('memberId'), url.searchParams.get('pin'));
      if (!member) return err('Wrong PIN', 403);
      const dates = loggableDates(today, graceDays);
      const { results: entries } = await env.DB.prepare(
        'SELECT date, bedtime_yes, food_yes, chores_yes, outside_yes, vacation FROM checkins WHERE member_id = ? AND date >= ?'
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
        email: member.email,
        push: !!member.push_subscription,
        today,
        days: dates.filter((d) => d >= start).map((d) => ({ date: d, entry: byDate[d] ?? null })),
      });
    }

    if (request.method === 'POST' && path === '/api/checkin') {
      const body = await request.json();
      const member = await authMember(env, body.memberId, body.pin);
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
      const body = await request.json();
      const member = await authMember(env, body.memberId, body.pin);
      if (!member) return err('Wrong PIN', 403);
      if (typeof body.foodRule === 'string' && body.foodRule.trim()) {
        await env.DB.prepare('UPDATE members SET food_rule = ? WHERE id = ?')
          .bind(body.foodRule.trim(), member.id).run();
      }
      if (typeof body.bedtime === 'string' && body.bedtime.trim()) {
        if (member.role === 'kid') return err('Only a parent can change your bedtime', 403);
        await env.DB.prepare('UPDATE members SET bedtime = ? WHERE id = ?')
          .bind(body.bedtime.trim(), member.id).run();
      }
      if (typeof body.chores === 'string' && body.chores.trim()) {
        if (member.role === 'kid') return err('Only a parent can change your chores', 403);
        await env.DB.prepare('UPDATE members SET chores_rule = ? WHERE id = ?')
          .bind(body.chores.trim(), member.id).run();
      }
      if (typeof body.email === 'string') {
        const email = body.email.trim();
        if (email && !/^\S+@\S+\.\S+$/.test(email)) return err('That email does not look right', 400);
        await env.DB.prepare('UPDATE members SET email = ? WHERE id = ?')
          .bind(email || null, member.id).run();
      }
      if ('pushSubscription' in body) {
        let value = null;
        if (body.pushSubscription) {
          try {
            if (!JSON.parse(body.pushSubscription)?.endpoint) throw new Error();
            value = body.pushSubscription;
          } catch {
            return err('Invalid push subscription', 400);
          }
        }
        await env.DB.prepare('UPDATE members SET push_subscription = ? WHERE id = ?')
          .bind(value, member.id).run();
      }
      return json({ ok: true });
    }

    // Admin changes the shared family password from the app; the new hash is
    // stored in settings and overrides the bootstrap FAMILY_KEY_HASH secret.
    if (request.method === 'POST' && path === '/api/admin/familykey') {
      const body = await request.json();
      const actor = await authMember(env, body.adminId, body.pin);
      if (!actor || actor.role !== 'admin') return err('Admin access required', 403);
      const newKey = String(body.newKey ?? '');
      if (newKey.length < 6) return err('Family password must be at least 6 characters', 400);
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('family_key_hash', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
      ).bind(await sha256Hex(newKey)).run();
      return json({ ok: true });
    }

    // Admin corrections: edit any member's day, including beyond the grace window.
    if (request.method === 'POST' && path === '/api/admin/checkin') {
      const body = await request.json();
      const actor = await authMember(env, body.adminId, body.pin);
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
        "SELECT date, bedtime_yes, food_yes, chores_yes, outside_yes, vacation FROM checkins WHERE member_id = ? AND date LIKE ?"
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
            ? { bedtime: !!entry.bedtime_yes, food: !!entry.food_yes, chores: !!entry.chores_yes, outside: !!entry.outside_yes }
            : null,
          statuses,
        });
      }
      return json({ member: { id: member.id, name: member.name }, month, today, days });
    }

    if (request.method === 'POST' && path === '/api/admin/member') {
      const body = await request.json();
      const actor = await authMember(env, body.adminId, body.pin);
      if (!actor || actor.role === 'kid') return err('Admin access required', 403);
      const m = body.member ?? {};

      // Non-admin adults get exactly one power here: setting a kid's chores.
      if (actor.role === 'adult') {
        if (body.action !== 'update') return err('Admin access required', 403);
        const target = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(m.id).first();
        if (!target) return err('No such member', 404);
        if (target.role !== 'kid') return err("Adults can only edit kids' chores", 403);
        if (!m.chores?.trim()) return err('No chores provided', 400);
        await env.DB.prepare('UPDATE members SET chores_rule = ? WHERE id = ?')
          .bind(m.chores.trim(), m.id).run();
        return json({ ok: true });
      }

      if (body.action === 'add') {
        if (!m.name?.trim() || !['admin', 'adult', 'kid'].includes(m.role)) {
          return err('A name and a valid role are required', 400);
        }
        await env.DB.prepare(
          'INSERT INTO members (name, email, role, bedtime, food_rule, chores_rule, pin_hash, start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          m.name.trim(), m.email ?? null, m.role,
          m.bedtime?.trim() || '9:00 PM', m.foodRule?.trim() || 'junk food',
          m.chores?.trim() || 'daily chores',
          m.pin ? await sha256Hex(String(m.pin)) : null,
          addDays(today, -graceDays)   // open the full grace window from day one
        ).run();
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
          // clearPin removes the PIN entirely; otherwise a new pin replaces, blank keeps.
          pin_hash: m.clearPin ? null : m.pin ? await sha256Hex(String(m.pin)) : target.pin_hash,
        };
        await env.DB.prepare(
          'UPDATE members SET name = ?, email = ?, role = ?, bedtime = ?, food_rule = ?, chores_rule = ?, pin_hash = ? WHERE id = ?'
        ).bind(updates.name, updates.email, updates.role, updates.bedtime, updates.food_rule, updates.chores_rule, updates.pin_hash, m.id).run();
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
  await env.DB.prepare(
    `INSERT INTO checkins (member_id, date, bedtime_yes, food_yes, chores_yes, outside_yes, vacation) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id, date) DO UPDATE SET
       bedtime_yes = excluded.bedtime_yes, food_yes = excluded.food_yes,
       chores_yes = excluded.chores_yes, outside_yes = excluded.outside_yes,
       vacation = excluded.vacation, logged_at = datetime('now')`
  ).bind(
    memberId, date,
    !vacation && body.bedtimeYes ? 1 : 0,
    !vacation && body.foodYes ? 1 : 0,
    !vacation && body.choresYes ? 1 : 0,
    !vacation && body.outsideYes ? 1 : 0,
    vacation ? 1 : 0
  ).run();
  return json({ ok: true });
}

async function adminCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM members WHERE role = 'admin'").first();
  return row.cnt;
}

/** Leaderboard data for every member; also used by the weekly summary email. */
export async function leaderboard(env, today, graceDays) {
  const { results: members } = await env.DB.prepare('SELECT * FROM members ORDER BY id').all();
  const { results: entries } = await env.DB.prepare(
    'SELECT member_id, date, bedtime_yes, food_yes, chores_yes, outside_yes, vacation FROM checkins'
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
