import { todayInTZ, addDays, loggableDates, memberStats } from './stats.js';

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

const PUBLIC_FIELDS = 'id, name, role, bedtime, food_rule, chores_rule, pin_hash IS NOT NULL AS has_pin';

export async function handleApi(request, env) {
  // Every API route requires the shared family password (sent as a header,
  // checked against a hash stored as a Worker secret). Fail closed if the
  // secret was never configured.
  if (!env.FAMILY_KEY_HASH) {
    return err('Server not configured: set the FAMILY_KEY_HASH secret (see README)', 503);
  }
  const familyKey = request.headers.get('X-Family-Key');
  if (!familyKey || (await sha256Hex(familyKey)) !== env.FAMILY_KEY_HASH.toLowerCase()) {
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

    if (request.method === 'GET' && path === '/api/me') {
      const member = await authMember(env, url.searchParams.get('memberId'), url.searchParams.get('pin'));
      if (!member) return err('Wrong PIN', 403);
      const dates = loggableDates(today, graceDays);
      const { results: entries } = await env.DB.prepare(
        'SELECT date, bedtime_yes, food_yes, chores_yes FROM checkins WHERE member_id = ? AND date >= ?'
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
      if ([body.bedtimeYes, body.foodYes, body.choresYes].some((v) => typeof v !== 'boolean')) {
        return err('bedtimeYes, foodYes and choresYes must be true or false', 400);
      }
      await env.DB.prepare(
        `INSERT INTO checkins (member_id, date, bedtime_yes, food_yes, chores_yes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (member_id, date) DO UPDATE SET
           bedtime_yes = excluded.bedtime_yes, food_yes = excluded.food_yes,
           chores_yes = excluded.chores_yes, logged_at = datetime('now')`
      ).bind(member.id, date, body.bedtimeYes ? 1 : 0, body.foodYes ? 1 : 0, body.choresYes ? 1 : 0).run();
      return json({ ok: true });
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
      return json({ ok: true });
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

async function adminCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM members WHERE role = 'admin'").first();
  return row.cnt;
}

/** Leaderboard data for every member; also used by the weekly summary email. */
export async function leaderboard(env, today, graceDays) {
  const { results: members } = await env.DB.prepare('SELECT * FROM members ORDER BY id').all();
  const { results: entries } = await env.DB.prepare(
    'SELECT member_id, date, bedtime_yes, food_yes, chores_yes FROM checkins'
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
