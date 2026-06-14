// Pure date/tally/streak logic. No database or Worker APIs here so it can be
// unit-tested with `node --test`.

/** Current date as YYYY-MM-DD in the given IANA timezone. */
export function todayInTZ(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Add n days (may be negative) to a YYYY-MM-DD string. */
export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Dates that may still be logged: yesterday back through today - graceDays.
 * Today is excluded — you can't know the answers until the day is over.
 */
export function loggableDates(today, graceDays) {
  const dates = [];
  for (let i = graceDays; i >= 1; i--) dates.push(addDays(today, -i));
  return dates;
}

/**
 * One member's totals within a single month (YYYY-MM), for awards:
 * per-question tallies (bedtime is fractional points; others are yes-counts),
 * perfect-day count, and the longest run of consecutive full-credit days inside
 * that month for each category and for perfect days (pending/skip days bridge).
 */
export function monthTotals(member, entries, month, today, graceDays) {
  const byDate = new Map(entries.map((e) => [e.date, e]));
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const totals = {
    bedtime: 0, food: 0, chores: 0, outside: 0, perfect: 0,
    // longest consecutive full-credit run this month, per category + perfect
    longestRun: 0, // perfect run (kept for backward compatibility)
    streakBedtime: 0, streakFood: 0, streakChores: 0, streakOutside: 0,
  };
  const run = { bedtime: 0, food: 0, chores: 0, outside: 0, perfect: 0 };
  const bumpRun = (key, status, longestKey) => {
    if (status === 'yes') {
      run[key]++;
      if (run[key] > totals[longestKey]) totals[longestKey] = run[key];
    } else if (status === 'no') {
      run[key] = 0;
    }
    // pending/skip: the run carries over.
  };
  for (let i = 1; i <= lastDay; i++) {
    const d = `${month}-${String(i).padStart(2, '0')}`;
    if (d < member.start_date || d > today) continue;
    const entry = byDate.get(d);
    const statuses = Object.entries(QUESTION_KEYS).map(
      ([name, key]) => [name, dayStatus(entry, d, today, graceDays, key)]
    );
    // Bedtime tally is fractional; the others are yes-counts.
    const score = bedtimeScore(entry, d, today, graceDays);
    if (score !== null) totals.bedtime += score;
    for (const [name, status] of statuses) {
      if (name !== 'bedtime' && status === 'yes') totals[name]++;
    }
    const longestKeys = { bedtime: 'streakBedtime', food: 'streakFood', chores: 'streakChores', outside: 'streakOutside' };
    for (const [name, status] of statuses) bumpRun(name, status, longestKeys[name]);

    const perfect = perfectStatus(statuses.map(([, s]) => s));
    if (perfect === 'yes') totals.perfect++;
    bumpRun('perfect', perfect, 'longestRun');
  }
  return totals;
}

/** The YYYY-MM prefix of the month before the given date's month. */
export function prevMonthPrefix(today) {
  const [y, m] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/**
 * Status of one question on one day.
 * entry: checkin row or undefined. key: 'bedtime_yes' | 'food_yes' | 'chores_yes'.
 * Returns 'yes' | 'no' | 'skip' | 'pending' | 'future'.
 * Vacation days are 'skip' — they never count for or against anyone.
 * Unanswered days older than the grace window lock in as 'no'.
 */
export function dayStatus(entry, date, today, graceDays, key) {
  if (entry?.vacation) return 'skip';
  if (entry) return entry[key] ? 'yes' : 'no';
  if (date > today) return 'future';
  if (date >= addDays(today, -graceDays)) return 'pending';
  return 'no';
}

/**
 * Tallies and streaks for one member.
 * entries: array of checkin rows ({date, bedtime_yes, food_yes}).
 * Returns:
 * {
 *   month: {bedtime, food, chores, perfect}, year: {...}, allTime: {...},
 *   streaks: {bedtime: {current, longest}, food: {...}, chores: {...}, perfect: {...}},
 *   pendingDates: [YYYY-MM-DD, ...]   // loggable days not yet answered
 * }
 */
const QUESTION_KEYS = { bedtime: 'bedtime_yes', food: 'food_yes', chores: 'chores_yes', outside: 'outside_yes' };

/** Perfect = every question yes; any answered/locked no sinks the day. */
function perfectStatus(statuses) {
  if (statuses[0] === 'skip') return 'skip'; // vacation flags the whole day
  if (statuses.every((s) => s === 'yes')) return 'yes';
  if (statuses.includes('no')) return 'no';
  return 'pending';
}

/**
 * Fractional bedtime points for one day (tallies & awards only — streaks and
 * perfect days still use the binary dayStatus).
 *   on time          → 1
 *   late N minutes    → max(0, 1 − N/30)   (N is a multiple of 5: 5min=5/6, 30min+=0)
 *   late, no minutes  → 0
 * Returns null for days that don't count (vacation, pending, future).
 */
export function bedtimeScore(entry, date, today, graceDays) {
  const status = dayStatus(entry, date, today, graceDays, 'bedtime_yes');
  if (status === 'yes') return 1;
  if (status !== 'no') return null; // skip / pending / future
  const minutes = entry?.bedtime_minutes_late;
  if (typeof minutes !== 'number' || minutes <= 0) return 0;
  return Math.max(0, 1 - minutes / 30);
}

export function memberStats(member, entries, today, graceDays) {
  const byDate = new Map(entries.map((e) => [e.date, e]));
  const monthPrefix = today.slice(0, 7);
  const lastMonth = prevMonthPrefix(today);
  const yearPrefix = today.slice(0, 4);

  const zero = () => ({ bedtime: 0, food: 0, chores: 0, outside: 0, perfect: 0 });
  const totals = { month: zero(), lastMonth: zero(), year: zero(), allTime: zero() };
  const streaks = {
    bedtime: { current: 0, longest: 0 },
    food: { current: 0, longest: 0 },
    chores: { current: 0, longest: 0 },
    outside: { current: 0, longest: 0 },
    perfect: { current: 0, longest: 0 },
  };
  const pendingDates = [];

  const start = member.start_date;
  if (start > today) return { ...totals, streaks, pendingDates };

  // Forward pass: tallies and longest streaks. Pending days neither extend
  // nor break a streak; locked-in or answered 'no' days break it.
  const run = { bedtime: 0, food: 0, chores: 0, outside: 0, perfect: 0 };
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const entry = byDate.get(d);
    const statuses = Object.entries(QUESTION_KEYS).map(
      ([name, key]) => [name, dayStatus(entry, d, today, graceDays, key)]
    );
    const perfect = perfectStatus(statuses.map(([, s]) => s));

    if (!entry && d < today && statuses[0][1] === 'pending') pendingDates.push(d);

    // Bedtime tally is fractional points (added on yes *and* late days); all
    // other tallies are yes-counts. Streaks stay binary for every category.
    const score = bedtimeScore(entry, d, today, graceDays);
    if (score !== null) {
      totals.allTime.bedtime += score;
      if (d.startsWith(yearPrefix)) totals.year.bedtime += score;
      if (d.startsWith(monthPrefix)) totals.month.bedtime += score;
      if (d.startsWith(lastMonth)) totals.lastMonth.bedtime += score;
    }

    for (const [key, status] of [...statuses, ['perfect', perfect]]) {
      if (status === 'yes') {
        run[key]++;
        if (run[key] > streaks[key].longest) streaks[key].longest = run[key];
        if (key !== 'bedtime') {
          totals.allTime[key]++;
          if (d.startsWith(yearPrefix)) totals.year[key]++;
          if (d.startsWith(monthPrefix)) totals.month[key]++;
          if (d.startsWith(lastMonth)) totals.lastMonth[key]++;
        }
      } else if (status === 'no') {
        run[key] = 0;
      }
      // 'pending', 'skip' (vacation) and 'future': streak run carries over unchanged.
    }
  }

  // Backward pass: current streaks, starting from today.
  for (const key of [...Object.keys(QUESTION_KEYS), 'perfect']) {
    let count = 0;
    for (let d = today; d >= start; d = addDays(d, -1)) {
      const entry = byDate.get(d);
      const status = key === 'perfect'
        ? perfectStatus(Object.values(QUESTION_KEYS).map((k) => dayStatus(entry, d, today, graceDays, k)))
        : dayStatus(entry, d, today, graceDays, QUESTION_KEYS[key]);
      if (status === 'yes') count++;
      else if (status === 'no') break;
      // 'pending': skip and keep looking back.
    }
    streaks[key].current = count;
  }

  return { ...totals, streaks, pendingDates };
}
