import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, loggableDates, dayStatus, bedtimeScore, memberStats, monthTotals, prevMonthPrefix } from '../src/stats.js';

const TODAY = '2026-06-11';
const GRACE = 3;
const member = { start_date: '2026-06-01' };
const entry = (date, bedtime, food, chores = true, outside = true) =>
  ({ date, bedtime_yes: bedtime ? 1 : 0, food_yes: food ? 1 : 0, chores_yes: chores ? 1 : 0, outside_yes: outside ? 1 : 0, vacation: 0 });
const vacation = (date) => ({ date, bedtime_yes: 0, food_yes: 0, chores_yes: 0, outside_yes: 0, vacation: 1 });
// bedtime "no" with N minutes late
const lateEntry = (date, minutes) =>
  ({ date, bedtime_yes: 0, bedtime_minutes_late: minutes, food_yes: 1, chores_yes: 1, outside_yes: 1, vacation: 0 });

test('bedtimeScore: on time = 1, late loses 1/6 per 5 min, 30+ = 0, no minutes = 0', () => {
  assert.equal(bedtimeScore(entry('2026-06-05', true, true), '2026-06-05', TODAY, GRACE), 1);
  assert.equal(bedtimeScore(lateEntry('2026-06-05', 5), '2026-06-05', TODAY, GRACE), 1 - 5 / 30);
  assert.equal(bedtimeScore(lateEntry('2026-06-05', 15), '2026-06-05', TODAY, GRACE), 0.5);
  assert.equal(bedtimeScore(lateEntry('2026-06-05', 30), '2026-06-05', TODAY, GRACE), 0);
  assert.equal(bedtimeScore(lateEntry('2026-06-05', 45), '2026-06-05', TODAY, GRACE), 0);
  assert.equal(bedtimeScore(entry('2026-06-05', false, true), '2026-06-05', TODAY, GRACE), 0); // no minutes
  assert.equal(bedtimeScore(undefined, '2026-06-05', TODAY, GRACE), 0); // locked-in miss
  assert.equal(bedtimeScore(vacation('2026-06-05'), '2026-06-05', TODAY, GRACE), null); // away day
});

test('bedtime tally sums fractional points; lateness breaks the bedtime streak', () => {
  const entries = [
    entry('2026-06-08', true, true),     // 1.0, streak start
    entry('2026-06-09', true, true),     // 1.0
    lateEntry('2026-06-10', 10),         // 1 - 10/30 = 0.6667, streak breaks
  ];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.ok(Math.abs(s.month.bedtime - (2 + (1 - 10 / 30))) < 1e-9);
  assert.equal(s.streaks.bedtime.current, 0);   // last day was late
  assert.equal(s.streaks.bedtime.longest, 2);
});

test('a late bedtime disqualifies the perfect day even with partial credit', () => {
  const entries = [lateEntry('2026-06-10', 5)]; // food/chores/outside all yes, bedtime 5 min late
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.month.perfect, 0);
  assert.equal(s.streaks.perfect.current, 0);
  assert.ok(s.month.bedtime > 0); // but bedtime still earns partial credit
});

test('monthTotals: fractional bedtime points and per-category longest runs', () => {
  const m = { start_date: '2026-05-01' };
  const entries = [
    entry('2026-05-02', true, true),   // perfect, all streaks at 1
    entry('2026-05-03', true, true),   // perfect, all streaks at 2
    lateEntry('2026-05-04', 15),       // bedtime 0.5 + breaks bedtime/perfect run; food/chores/outside continue
    entry('2026-05-05', true, false),  // bedtime back on, food breaks
  ];
  const t = monthTotals(m, entries.filter((e) => e.date.startsWith('2026-05')), '2026-05', TODAY, GRACE);
  assert.ok(Math.abs(t.bedtime - (1 + 1 + 0.5 + 1)) < 1e-9);
  assert.equal(t.streakBedtime, 2);   // 05-02, 05-03
  assert.equal(t.streakFood, 3);      // 05-02..05-04
  assert.equal(t.streakOutside, 4);   // all four days
  assert.equal(t.longestRun, 2);      // perfect run 05-02, 05-03
});

test('addDays crosses month boundaries', () => {
  assert.equal(addDays('2026-06-01', -1), '2026-05-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

test('loggable window is yesterday back through grace days; today excluded', () => {
  assert.deepEqual(loggableDates(TODAY, GRACE), ['2026-06-08', '2026-06-09', '2026-06-10']);
});

test('unanswered day inside grace window is pending, outside locks to no', () => {
  assert.equal(dayStatus(undefined, '2026-06-09', TODAY, GRACE, 'bedtime_yes'), 'pending');
  assert.equal(dayStatus(undefined, '2026-06-08', TODAY, GRACE, 'bedtime_yes'), 'pending');
  assert.equal(dayStatus(undefined, '2026-06-07', TODAY, GRACE, 'bedtime_yes'), 'no');
});

test('tallies count yes days per question and perfect days', () => {
  const entries = [
    entry('2026-06-01', true, true),   // perfect
    entry('2026-06-02', true, false),  // bedtime only
    entry('2026-06-03', false, true),  // food only
  ];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.month.bedtime, 2);
  assert.equal(s.month.food, 2);
  assert.equal(s.month.chores, 3);
  assert.equal(s.month.perfect, 1);
  assert.equal(s.allTime.bedtime, 2);
});

test('a chores miss sinks the perfect day and its streak', () => {
  const entries = [
    entry('2026-06-09', true, true, true),
    entry('2026-06-10', true, true, false), // chores skipped yesterday
  ];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.month.chores, 1);
  assert.equal(s.month.perfect, 1);
  assert.equal(s.streaks.chores.current, 0);
  assert.equal(s.streaks.bedtime.current, 2);
  assert.equal(s.streaks.perfect.current, 0);
});

test('days before start_date never count as misses', () => {
  const late = { start_date: '2026-06-10' };
  const s = memberStats(late, [entry('2026-06-10', true, true)], TODAY, GRACE);
  assert.equal(s.streaks.bedtime.current, 1);
  assert.equal(s.allTime.perfect, 1);
});

test('current streak: pending days are skipped, locked misses break it', () => {
  // Yes on 06-06..06-07, nothing after. 06-08..06-10 are pending (skipped),
  // but 06-06/07 connect through. 06-05 unanswered = locked no, breaks streak.
  const entries = [entry('2026-06-06', true, true), entry('2026-06-07', true, true)];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.streaks.bedtime.current, 2);
  assert.equal(s.streaks.perfect.current, 2);
});

test('current streak is zero after an answered no', () => {
  const entries = [
    entry('2026-06-08', true, true),
    entry('2026-06-09', true, true),
    entry('2026-06-10', false, true), // bedtime missed yesterday
  ];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.streaks.bedtime.current, 0);
  assert.equal(s.streaks.food.current, 3);
  assert.equal(s.streaks.perfect.current, 0);
});

test('longest streak survives a later break', () => {
  const entries = [
    entry('2026-06-01', true, true),
    entry('2026-06-02', true, true),
    entry('2026-06-03', true, true),
    entry('2026-06-04', false, false),
    entry('2026-06-05', true, true),
    entry('2026-06-06', true, true),
    entry('2026-06-07', true, true),
    entry('2026-06-08', true, true),
    entry('2026-06-09', true, true),
    entry('2026-06-10', true, true),
  ];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.streaks.perfect.longest, 6);
  assert.equal(s.streaks.perfect.current, 6);
});

test('pendingDates lists unanswered loggable past days, not today', () => {
  const entries = [entry('2026-06-09', true, true)];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.deepEqual(s.pendingDates, ['2026-06-08', '2026-06-10']);
});

test('an outside miss sinks the perfect day but not other streaks', () => {
  const entries = [
    entry('2026-06-09', true, true, true, true),
    entry('2026-06-10', true, true, true, false), // stayed in yesterday
  ];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.month.outside, 1);
  assert.equal(s.month.perfect, 1);
  assert.equal(s.streaks.outside.current, 0);
  assert.equal(s.streaks.bedtime.current, 2);
  assert.equal(s.streaks.perfect.current, 0);
});

test('vacation days bridge streaks and count for nothing', () => {
  const entries = [
    entry('2026-06-08', true, true),
    vacation('2026-06-09'),
    entry('2026-06-10', true, true),
  ];
  const s = memberStats(member, entries, TODAY, GRACE);
  assert.equal(s.month.perfect, 2);          // vacation adds nothing
  assert.equal(s.streaks.perfect.current, 2); // ...but doesn't break the chain
  assert.equal(s.streaks.perfect.longest, 2);
  assert.deepEqual(s.pendingDates, []);       // a vacation day is settled, not pending
});

test('vacation status reported as skip', () => {
  assert.equal(dayStatus(vacation('2026-06-09'), '2026-06-09', TODAY, GRACE, 'bedtime_yes'), 'skip');
});

test('lastMonth tally counts only the previous month', () => {
  const m = { start_date: '2026-05-20' };
  const entries = [
    entry('2026-05-25', true, true),
    entry('2026-05-26', true, true),
    entry('2026-06-01', true, true),
  ];
  const s = memberStats(m, entries, TODAY, GRACE);
  assert.equal(s.lastMonth.perfect, 2);
  assert.equal(s.month.perfect, 1);
});

test('monthTotals counts per-question yes days and the longest perfect run in the month', () => {
  const m = { start_date: '2026-05-01' };
  const entries = [
    entry('2026-05-02', true, true),            // perfect
    entry('2026-05-03', true, true),            // perfect (run of 2)
    entry('2026-05-04', true, false),           // bedtime only — breaks run
    entry('2026-05-10', true, true),            // perfect
    entry('2026-06-01', true, true),            // next month, ignored
  ];
  const t = monthTotals(m, entries.filter((e) => e.date.startsWith('2026-05')), '2026-05', TODAY, GRACE);
  assert.equal(t.bedtime, 4);
  assert.equal(t.food, 3);
  assert.equal(t.perfect, 3);
  assert.equal(t.longestRun, 2);
});

test('monthTotals: away days bridge the perfect run', () => {
  const m = { start_date: '2026-05-01' };
  const entries = [
    entry('2026-05-02', true, true),
    vacation('2026-05-03'),
    entry('2026-05-04', true, true),
  ];
  const t = monthTotals(m, entries, '2026-05', TODAY, GRACE);
  assert.equal(t.longestRun, 2);
  assert.equal(t.perfect, 2);
});

test('prevMonthPrefix crosses year boundaries', () => {
  assert.equal(prevMonthPrefix('2026-06-11'), '2026-05');
  assert.equal(prevMonthPrefix('2026-01-05'), '2025-12');
});

test('month tally only counts current month', () => {
  const m = { start_date: '2026-05-28' };
  const entries = [
    entry('2026-05-30', true, true), // last month
    entry('2026-06-01', true, true),
  ];
  const s = memberStats(m, entries, TODAY, GRACE);
  assert.equal(s.month.perfect, 1);
  assert.equal(s.allTime.perfect, 2);
});
