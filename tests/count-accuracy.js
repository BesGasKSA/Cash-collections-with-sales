// Physical count accuracy: cylinders full and empty, units, sales and purchases around the count,
// the approval cycle, what posts, and every figure afterwards. Run: TZ=Asia/Riyadh node tests/count-accuracy.js
var harness = require('./stub-harness.js');
var pass = 0, fail = 0;
function check(ok, msg) { if (ok) pass++; else { fail++; console.log('FAIL: ' + msg); } }
var c = harness.buildContext(), S = c.SHEETS, salt = c.randomSalt_();
function cl(p) { try { return c.route_(p); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }
function u(id, role) { c.writeRow(S.USERS, { id: id, name: id, email: id + '@bestgas.sa', role: role, active: true, language: 'en', salt: salt, pass: c.hashPw_('Bootstrap#1', salt), mustChangePw: false }); }
function tk(id) { return cl({ action: 'login', email: id + '@bestgas.sa', password: 'Bootstrap#1' }).token; }
['aAdm:admin', 'aBm:store_manager', 'aAm:cluster_manager', 'aOps:operations_manager', 'aFin:finance', 'aCol:collector'].forEach(function (x) { var p = x.split(':'); u(p[0], p[1]); });
var adm = tk('aAdm');
c.writeRow(S.CLUSTERS, { id: 'aA', name: 'Acc Area', clusterManagerUserId: 'aAm' });
c.writeRow(S.LOCATIONS, { id: 'aL', city: 'Riyadh', name: 'Acc Branch', clusterId: 'aA', collectorUserId: 'aCol' });
c.writeRow(S.STORES, { id: 'aS', locationId: 'aL', name: 'Acc Store', storeManagerUserId: 'aBm' });
function ent(kind, d) { var r = cl({ action: 'adminSaveEntity', token: adm, kind: kind, data: d }); check(r.ok, kind + ' ' + d.name + ' ' + (r.error || '')); return r.entity || {}; }
var iron = ent('stock_item', { name: 'Iron', kind: 'cylinder', gasCost: 20, cylinderCost: 150 });
var hose = ent('stock_item', { name: 'Hose', kind: 'unit', unitCost: 10 });
c.PropertiesService.getScriptProperties().setProperty('STOCK_ITEMS_SETUP', '1');
c.PropertiesService.getScriptProperties().setProperty('TX_NUMBERED_V1', '1');
c.setScriptProp_(c.INV_SETUP_FLAG_, 'yes'); c.resetExecMemo_();
var exch = ent('product', { name: 'Gas exchange', type: 'goods', unitPrice: 25, stockItemId: iron.id, stockEffect: 'exchange' });
var body = ent('product', { name: 'Iron body sale', type: 'goods', unitPrice: 200, stockItemId: iron.id, stockEffect: 'sell_empty' });
var hoseP = ent('product', { name: 'Hose sale', type: 'goods', unitPrice: 30, stockItemId: hose.id, stockEffect: 'unit' });
function mv(o) { o.action = 'addInventoryMove'; o.token = adm; o.locationId = 'aL'; o.supplier = o.supplier || 'Khazeen'; var r = cl(o); check(r.ok, 'move ' + o.kind + ' ' + (o.state || '') + ' ' + o.qty + ' ' + o.date + ' ' + (r.error || '')); return r; }
var sub = 0;
function day(date, ls) { var id = 'acc' + (++sub); var r = cl({ action: 'importDailyEntries', token: adm, rows: ls.map(function (l) { return { date: date, sourceType: 'store', sourceId: 'aS', submissionId: id, productId: l[0], qty: l[1], unitPrice: l[2], cashSales: l[1] * l[2] }; }) }); check(r.ok && r.created === ls.length, 'sales ' + date + ' ' + JSON.stringify(r.results || r.error)); }
function st(date) {
  var r = cl({ action: 'getInventoryReport', token: adm, dateFrom: date, dateTo: date, locationId: 'aL' }), o = {};
  (r.rows || []).forEach(function (x) { o[(x.stockItemId === iron.id ? 'iron' : 'hose') + (x.state ? '.' + x.state : '')] = x.ending; });
  return o;
}
// the story of October
mv({ stockItemId: iron.id, state: 'full', kind: 'opening', qty: 100, date: '2026-10-01' });
mv({ stockItemId: iron.id, state: 'empty', kind: 'opening', qty: 50, date: '2026-10-01' });
mv({ stockItemId: hose.id, kind: 'opening', qty: 40, date: '2026-10-01' });
mv({ stockItemId: iron.id, state: 'full', kind: 'purchase', qty: 30, date: '2026-10-02' });   // refill: full +30, empty -30
mv({ stockItemId: iron.id, state: 'empty', kind: 'purchase', qty: 10, date: '2026-10-03' });  // new cylinders: empty +10
day('2026-10-03', [[exch.id, 20, 25], [body.id, 2, 200], [hoseP.id, 5, 30]]);   // full -20 empty +20; empty -2; hose -5
var d3 = st('2026-10-03');
check(d3['iron.full'] === 110 && d3['iron.empty'] === 48 && d3.hose === 35, 'before the count the app holds full 110, empty 48, hose 35 (' + JSON.stringify(d3) + ')');
check(d3['iron.full'] + d3['iron.empty'] === 158, 'cylinders in total: 150 opening + 10 new - 2 bodies sold = 158');

var bm = tk('aBm'), am = tk('aAm'), ops = tk('aOps'), fin = tk('aFin');
// the branch counts 3 Oct: full 105 (5 short), empty 52 (4 over), hose 35 (matches)
var s = cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2026-10-03', note: 'month count',
  lines: [{ stockItemId: iron.id, state: 'full', counted: 105, system: 110 }, { stockItemId: iron.id, state: 'empty', counted: 52, system: 48 }, { stockItemId: hose.id, counted: 35, system: 35 }] });
check(s.ok, 'the count goes in (' + (s.error || '') + ')');
var L = (s.lines || []);
function line(arr, item, state) { return arr.filter(function (l) { return l.stockItemId === item && (l.state || null) === state; })[0] || {}; }
check(line(L, iron.id, 'full').diff === -5 && line(L, iron.id, 'empty').diff === 4 && line(L, hose.id, null).diff === 0, 'differences: full -5, empty +4, hose 0');
check(line(L, iron.id, 'full').value < 0 && line(L, iron.id, 'empty').value > 0, 'a loss is valued below zero, a gain above (' + line(L, iron.id, 'full').value + ', ' + line(L, iron.id, 'empty').value + ')');
// a screen that showed an old figure is refused
check(cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2026-10-04', lines: [{ stockItemId: iron.id, state: 'full', counted: 1, system: 999 }] }).error === 'count_changed', 'a count against a figure the app no longer holds is refused');
check(cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2026-10-04', lines: [{ stockItemId: iron.id, state: 'full', counted: -1 }] }).error === 'invalid_qty', 'a count below zero is refused');
check(cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2099-01-01', lines: [{ stockItemId: iron.id, state: 'full', counted: 1 }] }).error === 'future_date', 'a count in the future is refused');
check(cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2026-10-04', lines: [{ stockItemId: iron.id, state: 'full', counted: 1 }, { stockItemId: iron.id, state: 'full', counted: 2 }] }).error === 'invalid_input', 'the same line twice is refused');
check(JSON.stringify(st('2026-10-03')) === JSON.stringify(d3), 'nothing moves while it waits');

// sales keep going while it waits: 4 Oct, 15 exchanges and 3 hoses
day('2026-10-04', [[exch.id, 15, 25], [hoseP.id, 3, 30]]);
// and a late purchase for 3 Oct that the branch forgot: 6 refills on 3 Oct
mv({ stockItemId: iron.id, state: 'full', kind: 'purchase', qty: 6, date: '2026-10-03' });
var id = s.count.id;
check(cl({ action: 'stockCountDecide', token: am, id: id, decision: 'approve' }).ok, 'area manager approves');
check(cl({ action: 'stockCountDecide', token: ops, id: id, decision: 'approve' }).ok, 'operations approves');
var pv = cl({ action: 'stockCountPreview', token: fin, id: id });
check(line(pv.lines, iron.id, 'full').systemNow === 116 && line(pv.lines, iron.id, 'full').diffNow === -11 && line(pv.lines, iron.id, 'empty').systemNow === 42 && line(pv.lines, iron.id, 'empty').diffNow === 10, 'finance sees the late refill: full 116 (-11), empty 42 (+10) (' + JSON.stringify(pv.lines) + ')');
var ex = {}; ex[iron.id + '|full'] = 116; ex[iron.id + '|empty'] = 42; ex[hose.id + '|'] = 35;
var post = cl({ action: 'stockCountDecide', token: fin, id: id, decision: 'approve', expect: ex });
check(post.ok && post.count.status === 'posted', 'finance posts (' + (post.error || '') + ')');
check((post.moves || []).length === 2, 'two movements: the hose matched (' + (post.moves || []).length + ')');
var a3 = st('2026-10-03'), a4 = st('2026-10-04');
check(a3['iron.full'] === 105 && a3['iron.empty'] === 52 && a3.hose === 35, 'the count day ends on exactly what was counted (' + JSON.stringify(a3) + ')');
check(a4['iron.full'] === 90 && a4['iron.empty'] === 67 && a4.hose === 32, 'the day after carries on from the count: full 90, empty 67, hose 32 (' + JSON.stringify(a4) + ')');
check(a4['iron.full'] + a4['iron.empty'] === 157, 'total cylinders after the count = 105 + 52 = 157, unchanged by exchanges');
// the report of the month shows the count as its own lines
var mon = cl({ action: 'getInventoryReport', token: adm, dateFrom: '2026-10-01', dateTo: '2026-10-04', locationId: 'aL' });
var rf = (mon.rows || []).filter(function (x) { return x.stockItemId === iron.id && x.state === 'full'; })[0] || {};
var re = (mon.rows || []).filter(function (x) { return x.stockItemId === iron.id && x.state === 'empty'; })[0] || {};
check(rf.countLoss === 11 && !rf.countGain && re.countGain === 10 && !re.countLoss, 'the month shows count loss 11 on full, gain 10 on empty (' + rf.countLoss + '/' + re.countGain + ')');
check(rf.ending === 90 && re.ending === 67, 'and the month ends where the days do');
// the ledger walks the same way
var lg = cl({ action: 'getStockLedger', token: adm, locationId: 'aL', stockItemId: iron.id, dateFrom: '2026-10-01', dateTo: '2026-10-04' });
var cntLines = (lg.lines || []).filter(function (x) { return /count/.test(x.kind); });
check(cntLines.length === 2, 'the ledger lists the two count lines (' + cntLines.length + ')');
check(lg.ending && lg.ending.full === 90 && lg.ending.empty === 67, 'the ledger ends at full 90, empty 67 (' + JSON.stringify(lg.ending) + ')');
// the count record keeps both figures
var rec = c.getById_(S.STOCK_COUNTS, id);
check(line(rec.lines, iron.id, 'full').system === 110 && line(rec.lines, iron.id, 'full').systemAtPost === 116 && line(rec.lines, iron.id, 'full').diffPosted === -11, 'the record keeps what the counter saw (110) and what was posted against (116)');
check(rec.history.length === 4 && rec.history.map(function (h) { return h.step; }).join(',') === 'submitted,area,ops,finance', 'and every step');
var lst = cl({ action: 'listStockCounts', token: am, dateFrom: '2026-10-01', dateTo: '2026-10-31' });
check(lst.ok && lst.counts.length === 1 && lst.counts[0].lines.length === 3, 'the count report shows it with its three lines');
// a second count later the same month: only what changed since
day('2026-10-05', [[exch.id, 10, 25]]);
var s2 = cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2026-10-05', lines: [{ stockItemId: iron.id, state: 'full', counted: 80 }, { stockItemId: iron.id, state: 'empty', counted: 77 }] });
check(s2.ok && line(s2.lines, iron.id, 'full').system === 80 && line(s2.lines, iron.id, 'full').diff === 0 && line(s2.lines, iron.id, 'empty').system === 77, 'a second count reads from the first (' + JSON.stringify(s2.lines || s2.error) + ')');
cl({ action: 'stockCountDecide', token: am, id: s2.count.id, decision: 'approve' }); cl({ action: 'stockCountDecide', token: ops, id: s2.count.id, decision: 'approve' });
var p2 = cl({ action: 'stockCountDecide', token: fin, id: s2.count.id, decision: 'approve' });
check(p2.ok && p2.moves.length === 0, 'a count that matches posts no movement');
// an earlier day can no longer be counted over a later posted one
var e = cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2026-10-02', lines: [{ stockItemId: iron.id, state: 'full', counted: 1 }] });
cl({ action: 'stockCountDecide', token: am, id: e.count.id, decision: 'approve' }); cl({ action: 'stockCountDecide', token: ops, id: e.count.id, decision: 'approve' });
check(cl({ action: 'stockCountDecide', token: fin, id: e.count.id, decision: 'approve' }).error === 'count_later_posted', 'an earlier day is not posted over a later count');
// the health check has nothing to say about the counted stock
var hc = cl({ action: 'dataHealthCheck', token: adm });
check(hc.ok && !(hc.issues || []).some(function (i) { return /^stock_/.test(i.kind) && i.locationId === 'aL'; }), 'the health check finds no stock below zero');
// a count can bring a line to zero
var z = cl({ action: 'stockCountSubmit', token: bm, locationId: 'aL', date: '2026-10-06', lines: [{ stockItemId: hose.id, counted: 0 }] });
cl({ action: 'stockCountDecide', token: am, id: z.count.id, decision: 'approve' }); cl({ action: 'stockCountDecide', token: ops, id: z.count.id, decision: 'approve' });
check(cl({ action: 'stockCountDecide', token: fin, id: z.count.id, decision: 'approve' }).ok && st('2026-10-06').hose === 0, 'a counted zero posts and the hose reads 0');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
