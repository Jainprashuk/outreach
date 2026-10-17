// Proves the Naukri schedule (lib/naukriSchedule.js): single-time schedules
// fire exactly as before, extra slots add times with their own run kinds, and
// catch-up picks the latest missed slot only.
// Run with:  node scripts/test-naukri-schedule.js
//
// No database, no network — the schedule is pure.

const S = require('../lib/naukriSchedule');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// 2026-10-19 is a Monday. IST = UTC+5:30, so 09:30 IST = 04:00Z, 14:00 IST = 08:30Z.
const at = (iso) => new Date(iso);
const base = {
  enabled: true, days: [1, 2, 3, 4, 5], time: '09:30', timezone: 'Asia/Kolkata',
  catchUpHours: 6, lastFiredAt: null, runRefresh: true, runHarvest: true, runApply: false,
};
const two = { ...base, extraSlots: [{ time: '14:00', runRefresh: false, runHarvest: false, runApply: true }] };

console.log('\nsingle time (unchanged behaviour)');
eq('next is Monday 09:30 IST', S.nextOccurrence(base, at('2026-10-19T00:00:00Z')).toISOString(), '2026-10-19T04:00:00.000Z');
eq('due right after', S.dueOccurrence(base, at('2026-10-19T04:05:00Z')).toISOString(), '2026-10-19T04:00:00.000Z');
eq('kinds from the toggles', S.dueSlot(base, at('2026-10-19T04:05:00Z')).kinds, ['refresh', 'harvest']);
eq('not due once fired', S.dueOccurrence({ ...base, lastFiredAt: at('2026-10-19T04:00:00Z') }, at('2026-10-19T05:00:00Z')), null);
eq('not due after the catch-up window', S.dueOccurrence(base, at('2026-10-19T11:00:00Z')), null);
eq('skips the weekend', S.nextOccurrence(base, at('2026-10-24T05:00:00Z')).toISOString(), '2026-10-26T04:00:00.000Z');
eq('no kinds → not valid', S.nextOccurrence({ ...base, runRefresh: false, runHarvest: false }, at('2026-10-19T00:00:00Z')), null);

console.log('\nextra slots');
eq('two slots listed', S.slotsOf(two).map(s => s.time), ['09:30', '14:00']);
eq('upcoming lists both, in order', S.upcomingSlots(two, at('2026-10-19T00:00:00Z'), 3).map(o => [o.at.toISOString(), o.kinds]), [
  ['2026-10-19T04:00:00.000Z', ['refresh', 'harvest']],
  ['2026-10-19T08:30:00.000Z', ['apply']],
  ['2026-10-20T04:00:00.000Z', ['refresh', 'harvest']],
]);
eq('14:00 slot due with its own kinds', S.dueSlot({ ...two, lastFiredAt: at('2026-10-19T04:00:00Z') }, at('2026-10-19T08:31:00Z')).kinds, ['apply']);
eq('slept through both → only the latest fires', S.dueSlot(two, at('2026-10-19T09:00:00Z')).at.toISOString(), '2026-10-19T08:30:00.000Z');
eq('after the 14:00 fired, nothing until tomorrow', S.dueSlot({ ...two, lastFiredAt: at('2026-10-19T08:30:00Z') }, at('2026-10-19T12:00:00Z')), null);
eq('a slot with no kinds is ignored', S.slotsOf({ ...base, extraSlots: [{ time: '14:00' }] }).length, 1);
eq('a bad time is ignored', S.slotsOf({ ...base, extraSlots: [{ time: '25:00', runApply: true }] }).length, 1);
eq('never more than three', S.slotsOf({ ...base, extraSlots: ['11:00', '12:00', '13:00'].map(time => ({ time, runApply: true })) }).length, 3);
ok('only extra slots valid still schedules', !!S.nextOccurrence({ ...two, runRefresh: false, runHarvest: false }, at('2026-10-19T00:00:00Z')));

console.log('\nstartOfDayIn');
eq('IST midnight', S.startOfDayIn('Asia/Kolkata', at('2026-10-19T10:00:00Z')).toISOString(), '2026-10-18T18:30:00.000Z');
eq('IST midnight just after it', S.startOfDayIn('Asia/Kolkata', at('2026-10-18T19:00:00Z')).toISOString(), '2026-10-18T18:30:00.000Z');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
