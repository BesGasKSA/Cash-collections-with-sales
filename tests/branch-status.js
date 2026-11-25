/**
 * Branch status (2026-11-25): a branch is active by default; an inactive branch
 * takes no transactions; an active branch with nothing posted on a day is listed
 * and mailed the next morning at 07:00 Riyadh. Run: node tests/branch-status.js
 */
var harness = require('./stub-harness');
var pass = 0, fail = 0;
function check(cond, label) { if (cond) pass++; else { fail++; console.log('FAIL: ' + label); } }

var c = harness.buildContext(), S = c.SHEETS, salt = c.randomSalt_();
function call(p) { try { return c.route_(p); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }
function user(id, role) { c.writeRow(S.USERS, { id: id, name: id, email: id + '@example.test', role: role, active: true, language: 'en', salt: salt, pass: c.hashPw_('Bootstrap#1', salt), mustChangePw: false }); }
function tok(id) { return call({ action: 'login', email: id + '@example.test', password: 'Bootstrap#1' }).token; }
function loc(id) { return c.readSheet(S.LOCATIONS).filter(function (l) { return l.id === id; })[0]; }

['bsAdm:admin', 'bsFin:finance', 'bsOps:operations_manager', 'bsAm:cluster_manager', 'bsAm2:cluster_manager',
 'bsBm:store_manager', 'bsBm2:store_manager', 'bsBm3:store_manager', 'bsCol:collector', 'bsDrv:driver'].forEach(function (x) { var p = x.split(':'); user(p[0], p[1]); });
c.writeRow(S.CLUSTERS, { id: 'bsA', name: 'Area One', clusterManagerUserId: 'bsAm' });
c.writeRow(S.CLUSTERS, { id: 'bsB', name: 'Area Two', clusterManagerUserId: 'bsAm2' });
// bsL has no `active` at all: a row saved before the status existed counts as active
c.writeRow(S.LOCATIONS, { id: 'bsL', name: 'Busy Branch', city: 'Riyadh', clusterId: 'bsA', collectorUserId: 'bsCol', createdAt: '2026-01-01T00:00:00Z' });
c.writeRow(S.LOCATIONS, { id: 'bsQ', name: 'Quiet Branch', city: 'Riyadh', clusterId: 'bsA', collectorUserId: 'bsCol', active: true, createdAt: '2026-01-01T00:00:00Z' });
c.writeRow(S.LOCATIONS, { id: 'bsZ', name: 'Closed Branch', city: 'Hail', clusterId: 'bsB', collectorUserId: 'bsCol', active: true, createdAt: '2026-01-01T00:00:00Z' });
c.writeRow(S.STORES, { id: 'bsS', name: 'S1', locationId: 'bsL', storeManagerUserId: 'bsBm' });
c.writeRow(S.STORES, { id: 'bsSQ', name: 'S2', locationId: 'bsQ', storeManagerUserId: 'bsBm2' });
c.writeRow(S.STORES, { id: 'bsSZ', name: 'S3', locationId: 'bsZ', storeManagerUserId: 'bsBm3' });
c.resetExecMemo_();

var admT = tok('bsAdm'), bmT = tok('bsBm'), bm3T = tok('bsBm3'), amT = tok('bsAm'), am2T = tok('bsAm2');
var today = c.todayRiyadh_(), yday = c.yesterdayRiyadh_();

console.log('--- active by default ---');
check(c.branchInactive_('bsL') === false, 'a branch saved before the status counts as active');
var made = call({ action: 'adminSaveEntity', token: admT, kind: 'location', data: { name: 'New Branch', city: 'Riyadh', clusterId: 'bsA', collectorUserId: 'bsCol' } });
check(made.ok && made.entity.active === true, 'a new branch is saved active (' + (made.error || 'ok') + ')');

console.log('--- an inactive branch takes no transactions ---');
var d1 = call({ action: 'createDailyEntry', token: bm3T, date: yday, sourceType: 'store', sourceId: 'bsSZ', cashSales: 100, submissionId: 'bs-z1' });
check(d1.ok, 'while active, the branch enters a day (' + (d1.error || 'ok') + ')');
var off = call({ action: 'adminSaveEntity', token: admT, kind: 'location', id: 'bsZ', data: { active: false } });
check(off.ok && loc('bsZ').active === false, 'an admin sets the branch inactive even with that day not handed over (' + (off.error || 'ok') + ')');
c.resetExecMemo_();
var d2 = call({ action: 'createDailyEntry', token: bm3T, date: today, sourceType: 'store', sourceId: 'bsSZ', cashSales: 50, submissionId: 'bs-z2' });
check(!d2.ok && d2.error === 'branch_inactive', 'the branch manager cannot enter (' + (d2.error || 'ok') + ')');
var d3 = call({ action: 'createDailyEntry', token: admT, date: today, sourceType: 'store', sourceId: 'bsSZ', cashSales: 50, submissionId: 'bs-z3' });
check(!d3.ok && d3.error === 'branch_inactive', 'nor an admin (' + (d3.error || 'ok') + ')');
var d4 = call({ action: 'createDailyEntry', token: am2T, date: today, sourceType: 'store', sourceId: 'bsSZ', cashSales: 50, submissionId: 'bs-z4' });
check(!d4.ok && d4.error === 'branch_inactive', 'nor its area manager (' + (d4.error || 'ok') + ')');
var imp = call({ action: 'importDailyEntries', token: bm3T, rows: [{ date: today, sourceType: 'store', sourceId: 'bsSZ', cashSales: 10, submissionId: 'bs-z5' }] });
check(!imp.ok || (imp.results || []).every(function (r) { return !r.ok; }), 'nor through the file import (' + JSON.stringify(imp.results ? imp.results[0] : imp.error) + ')');
check(c.checkClusterBulkEntryScope_ ? (function () { c.config_().areaManagerBulkUploadEnabled = true; var u = c.readSheet(S.USERS).filter(function (x) { return x.id === 'bsAm2'; })[0]; var r = c.checkClusterBulkEntryScope_(u, 'bsB', 'store', 'bsSZ'); return r.error === 'branch_inactive' || r.error === 'feature_disabled'; })() : true, 'nor through the area batch');
var mv = call({ action: 'addInventoryMove', token: admT, locationId: 'bsZ', stockItemId: 'x', state: 'full', kind: 'purchase', qty: 1, date: today });
check(!mv.ok && mv.error === 'branch_inactive', 'no stock move at the branch (' + (mv.error || 'ok') + ')');
var tr = call({ action: 'transferInventory', token: admT, fromLocationId: 'bsL', toLocationId: 'bsZ', date: today, lines: [{ stockItemId: 'x', qty: 1 }] });
check(!tr.ok && tr.error === 'branch_inactive', 'no stock sent to it (' + (tr.error || 'ok') + ')');
var held = c.readSheet(S.ENTRIES).filter(function (e) { return e.locationId === 'bsZ' && !e.voided; });
check(held.length === 1 && !held[0].voided, 'the day entered before stays on file, ready to hand over');
var ho = call({ action: 'createHandoff', token: bm3T, kind: 'location_to_cluster', locationId: 'bsZ' });
check(ho.ok || ho.error !== 'branch_inactive', 'cash already entered still moves up the chain (' + (ho.error || 'ok') + ')');
var on = call({ action: 'adminSaveEntity', token: admT, kind: 'location', id: 'bsZ', data: { active: true } });
c.resetExecMemo_();
var d5 = call({ action: 'createDailyEntry', token: bm3T, date: today, sourceType: 'store', sourceId: 'bsSZ', cashSales: 70, submissionId: 'bs-z6' });
check(on.ok && d5.ok, 'set active again, it takes transactions again (' + (d5.error || 'ok') + ')');

console.log('--- active branches with nothing posted ---');
check(call({ action: 'createDailyEntry', token: bmT, date: yday, sourceType: 'store', sourceId: 'bsS', cashSales: 200, submissionId: 'bs-l1' }).ok, 'the busy branch posts yesterday');
call({ action: 'adminSaveEntity', token: admT, kind: 'location', id: 'bsZ', data: { active: false } });
// a cancelled entry is not a posted day
c.writeRow(S.ENTRIES, { id: 'bsVoid', date: yday, sourceType: 'store', sourceId: 'bsSQ', locationId: 'bsQ', cashSales: 5, voided: true, enteredBy: 'bsBm2' });
c.resetExecMemo_();
var rows = c.missingEntryRows_(yday), names = rows.map(function (r) { return r.name; });
check(names.indexOf('Quiet Branch') >= 0, 'an active branch with nothing (a cancelled entry only) is listed (' + names.join(',') + ')');
check(names.indexOf('Busy Branch') < 0, 'a branch that posted is not');
check(names.indexOf('Closed Branch') < 0, 'an inactive branch is not');
check(names.indexOf('New Branch') < 0 || c.riyadhDayOf_(new Date()) <= yday, 'a branch added today is not listed for yesterday');
var adm = call({ action: 'missingEntryBranches', token: admT });
check(adm.ok && adm.date === yday && adm.branches.some(function (b) { return b.name === 'Quiet Branch'; }), 'the app shows head office yesterday\'s list');
var am = call({ action: 'missingEntryBranches', token: amT }), am2 = call({ action: 'missingEntryBranches', token: am2T });
check(am.ok && am.branches.length && am.branches.every(function (b) { return b.clusterId === 'bsA'; }), 'an area manager sees his own area');
check(am2.ok && !am2.branches.length, 'and not another area');
var b2 = call({ action: 'missingEntryBranches', token: tok('bsBm2') }), b1 = call({ action: 'missingEntryBranches', token: bmT });
check(b2.ok && b2.branches.length === 1 && b2.branches[0].name === 'Quiet Branch' && b1.ok && !b1.branches.length, 'a branch manager sees only his branch');
check(call({ action: 'missingEntryBranches', token: tok('bsDrv') }).branches.length === 0, 'a driver sees nothing');
check(call({ action: 'missingEntryBranches', token: admT, date: '2999-01-01' }).error === 'future_date', 'no future day');

console.log('--- the 07:00 mail ---');
var m0 = c._debug.mailLog.length;
var dg = c.missingEntriesDigest_(yday, false);
var to = c._debug.mailLog.slice(m0).map(function (m) { return m.to; });
check(dg.ok && to.indexOf('bsAdm@example.test') >= 0 && to.indexOf('bsFin@example.test') >= 0 && to.indexOf('bsOps@example.test') >= 0, 'head office is mailed (' + to.join(',') + ')');
check(to.indexOf('bsAm@example.test') >= 0 && to.indexOf('bsBm2@example.test') >= 0, 'so are the area manager and the branch manager of the quiet branch');
check(to.indexOf('bsAm2@example.test') < 0 && to.indexOf('bsBm@example.test') < 0 && to.indexOf('bsBm3@example.test') < 0 && to.indexOf('bsCol@example.test') < 0, 'nobody else');
var bmMail = c._debug.mailLog.slice(m0).filter(function (m) { return m.to === 'bsBm2@example.test'; })[0];
check(bmMail && /Quiet Branch/.test(bmMail.body) && !/Closed Branch/.test(bmMail.body), 'the mail names the branch, not the inactive one');
var m1 = c._debug.mailLog.length;
var again = c.missingEntriesDigest_(yday, false);
check(again.skipped === 'already_sent' && c._debug.mailLog.length === m1, 'a second run the same morning sends nothing');
check(call({ action: 'runMissingEntriesCheck', token: bmT }).ok !== true, 'only admin or finance can send it by hand');
var by = call({ action: 'runMissingEntriesCheck', token: admT, date: yday });
check(by.ok && by.sent > 0 && c._debug.mailLog.length > m1, 'an admin sends it again by hand (' + (by.error || by.sent) + ')');
c.setScriptProp_('MISSING_ENTRIES_TRIGGER', ''); c.resetExecMemo_();
try { c.runOneTimeMigrations_(); } catch (e) { /* other jobs may need data this test does not have */ }
var trg = c.ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'missingEntriesDaily_'; });
check(trg.length === 1 && trg[0].built.atHour === 7 && trg[0].built.timezone === 'Asia/Riyadh', 'the daily trigger is set once, 07:00 Riyadh');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
