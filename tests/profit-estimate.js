/**
 * Ledger actuals and the daily estimate (2026-11-25): a month loaded from the
 * ledger is that month's real cost and replaces running lines of the same item;
 * a later month with no ledger yet takes each item's daily average of the last
 * loaded month on every day. Run: node tests/profit-estimate.js
 */
var harness = require('./stub-harness');
var pass = 0, fail = 0;
function check(cond, label) { if (cond) pass++; else { fail++; console.log('FAIL: ' + label); } }
function near(a, b, label) { check(Math.abs(Number(a) - Number(b)) < 0.02, label + ' (got ' + a + ', expected ' + b + ')'); }

var c = harness.buildContext(), S = c.SHEETS, salt = c.randomSalt_();
function call(p) { try { return c.route_(p); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }
c.writeRow(S.USERS, { id: 'peAdm', name: 'peAdm', email: 'peadm@example.test', role: 'admin', active: true, language: 'en', salt: salt, pass: c.hashPw_('Bootstrap#1', salt), mustChangePw: false });
c.writeRow(S.USERS, { id: 'peBm', name: 'peBm', email: 'pebm@example.test', role: 'store_manager', active: true, language: 'en', salt: salt, pass: c.hashPw_('Bootstrap#1', salt), mustChangePw: false });
c.writeRow(S.CLUSTERS, { id: 'peA', name: 'A', clusterManagerUserId: 'peAdm' });
c.writeRow(S.LOCATIONS, { id: 'peL', name: 'Branch', city: 'Riyadh', clusterId: 'peA', collectorUserId: 'peAdm' });
c.writeRow(S.STORES, { id: 'peS', name: 'Store', locationId: 'peL', storeManagerUserId: 'peBm' });
c.seedCostTypesOnce_(); c.resetExecMemo_();
var types = c.readSheet(S.COST_TYPES).filter(function (t) { return t.active !== false; });
var T1 = types[0].id, T2 = types[1].id, T3 = types[2].id;
var tok = call({ action: 'login', email: 'peadm@example.test', password: 'Bootstrap#1' }).token;

// a lease running all year on the branch (item T1), and an item never in the ledger (T3) on the store
check(call({ action: 'saveCostLine', token: tok, centreType: 'location', centreId: 'peL', typeId: T1, amount: 5000, fromMonth: '2026-01' }).ok, 'a running lease line');
check(call({ action: 'saveCostLine', token: tok, centreType: 'store', centreId: 'peS', typeId: T3, amount: 3000, fromMonth: '2026-01' }).ok, 'a running store line of another item');
// October from the ledger: the branch's rent (T1) and head office's item (T2)
var imp = call({ action: 'importCostLines', token: tok, month: '2026-10', oneOff: true, actual: true, rows: [
  { centreType: 'location', centreId: 'peL', typeId: T1, amount: 3100 },
  { centreType: 'company', centreId: 'company', typeId: T2, amount: 6200 }] });
check(imp.ok && imp.created === 2 && imp.lines.every(function (l) { return l.actual === true && l.oneOff === true; }), 'October goes in as ledger actuals (' + (imp.error || imp.created) + ')');
check(call({ action: 'importCostLines', token: tok, month: '2026-10', oneOff: false, actual: true, rows: [{ centreType: 'company', centreId: 'company', typeId: T2, amount: 1 }] }).error === 'invalid_input', 'actuals must be one-month lines');
// a sale every day so every unit has weight
['2026-10-05', '2026-11-03'].forEach(function (d, i) { c.writeRow(S.ENTRIES, { id: 'peE' + i, date: d, sourceType: 'store', sourceId: 'peS', locationId: 'peL', cashSales: 1150, enteredBy: 'peBm' }); });
c.resetExecMemo_();

function rep(from, to) { return call({ action: 'getProfitReport', token: tok, dateFrom: from, dateTo: to }); }
function company(r) { return r.nodes.filter(function (n) { return n.key === 'company'; })[0].T; }

console.log('--- October: the ledger month ---');
var oct = rep('2026-10-01', '2026-10-31'), To = company(oct);
near(To.ovh, 9300, 'the ledger rent replaces the lease, plus head office: overheads');
near(To.fixed, 3000, 'the store\'s other item still runs');
near(To.estimated, 0, 'nothing is estimated in a ledger month');
check(!oct.estimate['2026-10'] && oct.actualMonths.indexOf('2026-10') >= 0, 'October is reported as a ledger month');

console.log('--- November: estimated from October ---');
var nov = rep('2026-11-01', '2026-11-10'), Tn = company(nov);
near(Tn.ovh, (3100 + 6200) / 31 * 10, 'ten days of October\'s daily average, no lease on top');
near(Tn.estimated, (3100 + 6200) / 31 * 10, 'all of it marked estimated');
near(Tn.fixed, 3000 / 30 * 10, 'an item not in the ledger keeps its own monthly line');
check(nov.estimate['2026-11'] === '2026-10', 'November names October as its basis');
var day = 0; nov.units.forEach(function (u) { day += u.series.ovh[0]; });
near(day, (3100 + 6200) / 31, 'each day carries one day of the average');
var est0 = 0; nov.units.forEach(function (u) { est0 += u.series.est[0]; });
near(est0, (3100 + 6200) / 31, 'the day series says how much was estimated');
near(Tn.profit, Tn.cm - Tn.ovh, 'net profit takes the estimate off');

console.log('--- November loaded: December follows November ---');
check(call({ action: 'importCostLines', token: tok, month: '2026-11', oneOff: true, actual: true, rows: [{ centreType: 'location', centreId: 'peL', typeId: T1, amount: 3000 }] }).ok, 'November from the ledger');
c.resetExecMemo_();
var nov2 = company(rep('2026-11-01', '2026-11-30'));
near(nov2.ovh, 3000, 'November is now its own actuals (no estimate, no lease)');
near(nov2.estimated, 0, 'and nothing estimated');
var dec = rep('2026-12-01', '2026-12-31'), Td = company(dec);
near(Td.ovh, 3000 / 30 * 31, 'December: November\'s daily average on 31 days');
check(dec.estimate['2026-12'] === '2026-11', 'December names November');

console.log('--- before any ledger month: nothing changes ---');
var sep = company(rep('2026-09-01', '2026-09-30'));
near(sep.ovh, 5000, 'September keeps the lease as before');
near(sep.estimated, 0, 'and no estimate');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
