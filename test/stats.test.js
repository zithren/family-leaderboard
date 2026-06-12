import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, loggableDates, dayStatus, memberStats, prevMonthPrefix } from '../src/stats.js';

const TODAY = '2026-06-11';
const GRACE = 3;
const member = { start_date: '2026-06-01' };
const entry = (date, bedtime, food, chores = true) =>
  ({ date, bedtime_yes: bedtime ? 1 : 0, food_yes: food ? 1 : 0, chores_yes: chores ? 1 : 0, vacation: 0 });
const vacation = (date) => ({ date, bedtime_yes: 0, food_yes: 0, chores_yes: 0, vacation: 1 });

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
