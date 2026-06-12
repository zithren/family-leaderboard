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
 * Dates that may still be logged: today back through today - graceDays.
 * (Today is loggable for early birds, but an unanswered today is never a miss.)
 */
export function loggableDates(today, graceDays) {
  const dates = [];
  for (let i = graceDays; i >= 0; i--) dates.push(addDays(today, -i));
  return dates;
}

/**
 * Status of one question on one day.
 * entry: checkin row or undefined. key: 'bedtime_yes' | 'food_yes'.
 * Returns 'yes' | 'no' | 'pending' | 'future'.
 * Unanswered days older than the grace window lock in as 'no'.
 */
export function dayStatus(entry, date, today, graceDays, key) {
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
 *   month: {bedtime, food, perfect}, year: {...}, allTime: {...},
 *   streaks: {bedtime: {current, longest}, food: {...}, perfect: {...}},
 *   pendingDates: [YYYY-MM-DD, ...]   // loggable days not yet answered
 * }
 */
export function memberStats(member, entries, today, graceDays) {
  const byDate = new Map(entries.map((e) => [e.date, e]));
  const monthPrefix = today.slice(0, 7);
  const yearPrefix = today.slice(0, 4);

  const zero = () => ({ bedtime: 0, food: 0, perfect: 0 });
  const totals = { month: zero(), year: zero(), allTime: zero() };
  const streaks = {
    bedtime: { current: 0, longest: 0 },
    food: { current: 0, longest: 0 },
    perfect: { current: 0, longest: 0 },
  };
  const pendingDates = [];

  const start = member.start_date;
  if (start > today) return { ...totals, streaks, pendingDates };

  // Forward pass: tallies and longest streaks. Pending days neither extend
  // nor break a streak; locked-in or answered 'no' days break it.
  const run = { bedtime: 0, food: 0, perfect: 0 };
  for (let d = start; d <= today; d = addDays(d, 1)) {
    const entry = byDate.get(d);
    const bedtime = dayStatus(entry, d, today, graceDays, 'bedtime_yes');
    const food = dayStatus(entry, d, today, graceDays, 'food_yes');
    const perfect = bedtime === 'yes' && food === 'yes' ? 'yes' : bedtime === 'pending' || food === 'pending' ? 'pending' : 'no';

    if (!entry && d < today && bedtime === 'pending') pendingDates.push(d);

    for (const [key, status] of [['bedtime', bedtime], ['food', food], ['perfect', perfect]]) {
      if (status === 'yes') {
        run[key]++;
        if (run[key] > streaks[key].longest) streaks[key].longest = run[key];
        totals.allTime[key]++;
        if (d.startsWith(yearPrefix)) totals.year[key]++;
        if (d.startsWith(monthPrefix)) totals.month[key]++;
      } else if (status === 'no') {
        run[key] = 0;
      }
      // 'pending' and 'future': streak run carries over unchanged.
    }
  }

  // Backward pass: current streaks, starting from today.
  for (const key of ['bedtime', 'food', 'perfect']) {
    const statKey = key === 'bedtime' ? 'bedtime_yes' : key === 'food' ? 'food_yes' : null;
    let count = 0;
    for (let d = today; d >= start; d = addDays(d, -1)) {
      let status;
      if (statKey) {
        status = dayStatus(byDate.get(d), d, today, graceDays, statKey);
      } else {
        const b = dayStatus(byDate.get(d), d, today, graceDays, 'bedtime_yes');
        const f = dayStatus(byDate.get(d), d, today, graceDays, 'food_yes');
        status = b === 'yes' && f === 'yes' ? 'yes' : b === 'pending' || f === 'pending' ? 'pending' : 'no';
      }
      if (status === 'yes') count++;
      else if (status === 'no') break;
      // 'pending': skip and keep looking back.
    }
    streaks[key].current = count;
  }

  return { ...totals, streaks, pendingDates };
}
