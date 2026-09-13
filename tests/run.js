/**
 * End-to-end trial run against the real Code.gs/Admin.gs/Collection.gs logic
 * (loaded via stub-harness.js), covering: the xlsx net-cash formula, the full
 * four-step handoff chain, the dispute/resolve path, and every conflict-of-
 * interest / authorization guard added for this system. Run: node tests/run.js
 */
var assert = require('assert');
var harness = require('./stub-harness');

var pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + label); }
}
function close(a, b, label) {
  check(Math.abs(Number(a) - Number(b)) < 0.005, label + ' (got ' + a + ', expected ' + b + ')');
}

var ctx = harness.buildContext();
var SHEETS = ctx.SHEETS;

// mirrors doPost's own try/catch (route_ itself throws on auth/permission
// failures — doPost is what turns that into {ok:false,error:...} in prod).
function call(payload) {
  try { return ctx.route_(payload); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function bootstrapAdmin(email) {
  var salt = ctx.randomSalt_();
  var pass2 = ctx.hashPw_('Bootstrap#1', salt);
  var admin = { id: ctx.Utilities.getUuid(), name: 'Admin', email: email, role: 'admin', active: true, language: 'ar', salt: salt, pass: pass2, mustChangePw: false };
  ctx.writeRow(SHEETS.USERS, admin);
  return admin;
}

function login(email, password) {
  return call({ action: 'login', email: email, password: password });
}

function lastInviteFor(email) {
  var log = ctx._debug.mailLog;
  for (var i = log.length - 1; i >= 0; i--) {
    if (log[i].to === email) {
      var m = /Temporary password: (\S+)/.exec(log[i].body);
      if (m) return m[1];
    }
  }
  return null;
}

function acceptInvite(email) {
  var temp = lastInviteFor(email);
  check(!!temp, 'invite email captured for ' + email);
  var loginRes = login(email, temp);
  check(loginRes.ok, 'login with temp password: ' + email);
  var pwRes = call({ action: 'changePassword', token: loginRes.token, newPassword: 'RealPass#1' });
  check(pwRes.ok, 'change forced password: ' + email);
  return pwRes.token;
}

console.log('--- bootstrap ---');
var admin = bootstrapAdmin('admin@bestgas.sa');
var adminLogin = login('admin@bestgas.sa', 'Bootstrap#1');
check(adminLogin.ok, 'admin login');
var adminTok = adminLogin.token;

console.log('--- create people ---');
var sara = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Sara', email: 'sara@bestgas.sa', role: 'cluster_manager' } }).user;
var musa = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Musa', email: 'musa@bestgas.sa', role: 'collector' } }).user;
var ali = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ali', email: 'ali@bestgas.sa', role: 'store_manager' } }).user;
var hassan = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Hassan', email: 'hassan@bestgas.sa', role: 'driver' } }).user;
check(sara && musa && ali && hassan, 'four users created');

var saraTok = acceptInvite('sara@bestgas.sa');
var musaTok = acceptInvite('musa@bestgas.sa');
var aliTok = acceptInvite('ali@bestgas.sa');
var hassanTok = acceptInvite('hassan@bestgas.sa');

console.log('--- build hierarchy: cluster -> location -> store/car -> pos ---');
var cluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Central', clusterManagerUserId: sara.id, collectorUserId: musa.id } });
check(cluster.ok, 'create cluster');
var location = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Malaz', clusterId: cluster.entity.id } });
check(location.ok, 'create location');
var store = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: location.entity.id, name: 'Malaz Branch', storeManagerUserId: ali.id } });
check(store.ok, 'create store');
var car = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: location.entity.id, label: 'Truck-1', driverUserId: hassan.id } });
check(car.ok, 'create car');
var pos = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: car.entity.id, label: 'POS-1', assignedUserId: hassan.id } });
check(pos.ok, 'create pos machine on car');

console.log('--- xlsx formula check: store cash 7000 + car cash 5000 - delivery 5000 + vat-on-delivery ---');
var e1 = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-01', sourceType: 'store', sourceId: store.entity.id, cashSales: 7000 });
check(e1.ok, 'store cash entry by store manager');
var e2 = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-01', sourceType: 'car', sourceId: car.entity.id, cashSales: 5000, deliveryFeeBankAmount: 5000 });
check(e2.ok, 'car cash + delivery-fee entry by store manager');

var handoff1 = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location.entity.id });
check(handoff1.ok, 'store manager creates location handoff');
close(handoff1.handoff.amount, 7652.173913043478, 'net cash owed matches xlsx Example sheet exactly');

console.log('--- confirm chain: location -> cluster -> collector -> deposit ---');
var confirm1 = call({ action: 'confirmHandoff', token: saraTok, id: handoff1.handoff.id });
check(confirm1.ok && confirm1.handoff.status === 'confirmed', 'cluster manager confirms receipt');

var handoff2 = call({ action: 'createHandoff', token: saraTok, kind: 'cluster_to_collector', clusterId: cluster.entity.id });
check(handoff2.ok, 'cluster manager creates handoff to collector');
close(handoff2.handoff.amount, 7652.173913043478, 'cluster-to-collector amount carries forward unchanged');
check(!!handoff2.handoff.breakdown, 'cluster-to-collector handoff carries a breakdown, not just a flat amount');
close(handoff2.handoff.breakdown.storeCash, 7000, 'breakdown store cash carries forward');
close(handoff2.handoff.breakdown.carCash, 5000, 'breakdown car cash carries forward');
close(handoff2.handoff.breakdown.deliveryFee, 5000, 'breakdown delivery fee carries forward');
close(handoff2.handoff.breakdown.vatOnDelivery, 652.1739130434783, 'breakdown VAT clawback carries forward');
check(handoff2.handoff.perLocation && handoff2.handoff.perLocation.length === 1
  && handoff2.handoff.perLocation[0].locationId === location.entity.id,
  'cluster-to-collector handoff itemizes which location(s) it batches');

var confirm2 = call({ action: 'confirmHandoff', token: musaTok, id: handoff2.handoff.id });
check(confirm2.ok && confirm2.handoff.status === 'confirmed', 'collector confirms receipt');

var deposit = call({ action: 'recordDeposit', token: musaTok, bankReference: 'REF-001' });
check(deposit.ok && deposit.handoff.status === 'completed', 'collector records deposit, chain closes');
close(deposit.handoff.amount, 7652.173913043478, 'deposit amount matches the whole chain');
check(!!deposit.handoff.breakdown, 'deposit carries a breakdown too');
close(deposit.handoff.breakdown.netCashOwed, 7652.173913043478, 'deposit breakdown net matches the flat amount');
check(deposit.handoff.perCluster && deposit.handoff.perCluster.length === 1
  && deposit.handoff.perCluster[0].clusterId === cluster.entity.id,
  'deposit itemizes which cluster(s) it batches, each carrying its own perLocation trail');

console.log('--- sales report reflects the closed chain ---');
var report1 = call({ action: 'getSalesReport', token: adminTok });
close(report1.totals.netCashOwed, 7652.173913043478, 'report totals match');
close(report1.outstanding.netCashOwed, 0, 'nothing outstanding after deposit');

console.log('--- dispute path: reject ---');
var e3 = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 1000 });
check(e3.ok, 'second-round entry');
var handoff3 = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location.entity.id });
close(handoff3.handoff.amount, 1000, 'second handoff amount');
var dispute3 = call({ action: 'disputeHandoff', token: saraTok, id: handoff3.handoff.id, note: 'received only 800' });
check(dispute3.ok && dispute3.handoff.status === 'disputed', 'cluster manager disputes');
var resolve3 = call({ action: 'resolveDispute', token: adminTok, id: handoff3.handoff.id, resolution: 'reject' });
check(resolve3.ok && resolve3.handoff.status === 'rejected', 'admin rejects the disputed handoff');
var entriesAfterReject = call({ action: 'listEntries', token: adminTok, locationId: location.entity.id }).entries;
var e3After = entriesAfterReject.filter(function (e) { return e.id === e3.entry.id; })[0];
check(e3After && !e3After.consumedBy, 'rejected handoff releases its entries back to the unconsumed pool');

console.log('--- dispute path: confirm (variance accepted) ---');
var handoff3b = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location.entity.id });
check(handoff3b.ok, 're-submitted handoff after release');
var dispute3b = call({ action: 'disputeHandoff', token: saraTok, id: handoff3b.handoff.id, note: 'double checking' });
check(dispute3b.ok, 'disputed again');
var resolve3b = call({ action: 'resolveDispute', token: adminTok, id: handoff3b.handoff.id, resolution: 'confirm' });
check(resolve3b.ok && resolve3b.handoff.status === 'confirmed', 'admin confirms the disputed handoff as correct');

// close out handoff3b's chain so it isn't still sitting confirmed-and-unconsumed
// when the next cluster batch is built below (createHandoff cluster_to_collector
// sweeps up every confirmed, unconsumed location handoff in the cluster).
var closeOut = call({ action: 'createHandoff', token: saraTok, kind: 'cluster_to_collector', clusterId: cluster.entity.id });
check(closeOut.ok, 'cluster manager closes out the 1000 handoff separately');
call({ action: 'confirmHandoff', token: musaTok, id: closeOut.handoff.id, receivedAmount: closeOut.handoff.amount });
call({ action: 'recordDeposit', token: musaTok, bankReference: 'REF-CLEANUP' });

console.log('--- partial receipt: confirming with a lower amount accepts it immediately, no blocking ---');
var e4 = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-03', sourceType: 'store', sourceId: store.entity.id, cashSales: 2000 });
check(e4.ok, 'third-round entry');
var handoff4 = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location.entity.id });
close(handoff4.handoff.amount, 2000, 'third handoff declared amount');

var shortConfirm = call({ action: 'confirmHandoff', token: saraTok, id: handoff4.handoff.id, receivedAmount: 1800 });
check(shortConfirm.ok && shortConfirm.handoff.status === 'confirmed', 'confirming 1800 of 2000 confirms immediately — a shortfall is accepted, not blocked pending admin review');
close(shortConfirm.handoff.receivedAmount, 1800, 'received amount recorded');
close(shortConfirm.handoff.shortfall, 200, 'shortfall computed and recorded as data');
close(shortConfirm.handoff.amount, 1800, 'handoff amount moves to what was actually received, not the original claim');
close(shortConfirm.handoff.originalAmount, 2000, 'the original declared amount is preserved for audit');
close(shortConfirm.handoff.breakdown.netCashOwed, 1800, 'breakdown net is updated to match so downstream reports stay consistent');

var handoff4b = call({ action: 'createHandoff', token: saraTok, kind: 'cluster_to_collector', clusterId: cluster.entity.id });
check(handoff4b.ok, 'cluster manager batches the already-confirmed location handoff — no admin step was needed in between');
close(handoff4b.handoff.amount, 1800, 'cluster-to-collector amount reflects the actually-received figure, not the original overstated claim');

var exactConfirm = call({ action: 'confirmHandoff', token: musaTok, id: handoff4b.handoff.id, receivedAmount: 1800 });
check(exactConfirm.ok && exactConfirm.handoff.status === 'confirmed', 'confirming with a matching amount still confirms normally, no variance fields set');
check(exactConfirm.handoff.originalAmount === undefined, 'no variance means no originalAmount is recorded');

var deposit4 = call({ action: 'recordDeposit', token: musaTok, bankReference: 'REF-002' });
check(deposit4.ok, 'collector deposits the corrected amount');
close(deposit4.handoff.amount, 1800, 'deposit reflects the real cash collected, not the original inflated declaration');

console.log('--- shortfall accountability: attributing a handoff\'s shortfall back to whoever actually entered the cash figure ---');
var shortfallForbidden = call({ action: 'getShortfallByEntrant', token: aliTok });
check(!shortfallForbidden.ok && shortfallForbidden.error === 'forbidden', 'a store manager cannot see the accountability report — company-wide visibility only');
var shortfallReport = call({ action: 'getShortfallByEntrant', token: adminTok });
check(shortfallReport.ok, 'admin can see the accountability report');
var aliEntry = shortfallReport.byEntrant.find(function (r) { return r.userId === ali.id; });
check(!!aliEntry, 'ali (who entered the 2000 that came up 200 short) appears in the by-entrant list');
close(aliEntry.totalShortfall, 200, 'the full 200 shortfall is attributed to ali — he was the only entry bundled into that handoff');
check(aliEntry.handoffCount === 1, 'counted against exactly one flagged handoff');
var reportedHandoff = shortfallReport.handoffs.find(function (h) { return h.handoffId === handoff4.handoff.id; });
check(!!reportedHandoff && reportedHandoff.entrants.length === 1 && reportedHandoff.entrants[0].userId === ali.id,
  'the handoff-level detail traces the shortfall back to the exact entry and who entered it');

console.log('--- conflict of interest: structural guards ---');
var badCluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Bad', clusterManagerUserId: sara.id, collectorUserId: sara.id } });
check(!badCluster.ok && badCluster.error === 'conflict_of_interest', 'cluster manager cannot also be the collector for the same cluster');

var badStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: location.entity.id, name: 'Bad Branch', storeManagerUserId: sara.id } });
check(!badStore.ok && badStore.error === 'conflict_of_interest', 'the cluster manager cannot also be store manager of a store inside their own cluster');

console.log('--- conflict of interest: runtime guards ---');
// craft a handoff where the same person is on both ends, bypassing normal
// creation (which already blocks this) to prove confirm/dispute/resolve
// refuse it defensively too.
var selfHandoff = { id: ctx.Utilities.getUuid(), kind: 'location_to_cluster', fromUserId: ali.id, toUserId: ali.id, amount: 999, status: 'pending', createdAt: new Date().toISOString(), sourceEntryIds: [], sourceHandoffIds: [], consumedBy: null };
ctx.writeRow(SHEETS.HANDOFFS, selfHandoff);
var selfConfirm = call({ action: 'confirmHandoff', token: aliTok, id: selfHandoff.id });
check(!selfConfirm.ok && selfConfirm.error === 'conflict_of_interest', 'a user cannot confirm a handoff they submitted themselves');
var selfDispute = call({ action: 'disputeHandoff', token: aliTok, id: selfHandoff.id });
check(!selfDispute.ok && selfDispute.error === 'conflict_of_interest', 'a user cannot dispute a handoff they submitted themselves');

var evenAdminSelfHandoff = { id: ctx.Utilities.getUuid(), kind: 'deposit', fromUserId: admin.id, toUserId: admin.id, amount: 50, status: 'pending', createdAt: new Date().toISOString(), sourceEntryIds: [], sourceHandoffIds: [], consumedBy: null };
ctx.writeRow(SHEETS.HANDOFFS, evenAdminSelfHandoff);
var adminSelfConfirm = call({ action: 'confirmHandoff', token: adminTok, id: evenAdminSelfHandoff.id });
check(!adminSelfConfirm.ok && adminSelfConfirm.error === 'conflict_of_interest', 'even an admin cannot confirm their own submission');

var adminAsParty = { id: ctx.Utilities.getUuid(), kind: 'location_to_cluster', fromUserId: ali.id, toUserId: admin.id, amount: 10, status: 'disputed', createdAt: new Date().toISOString(), sourceEntryIds: [], sourceHandoffIds: [], consumedBy: null };
ctx.writeRow(SHEETS.HANDOFFS, adminAsParty);
var resolveByPartyAdmin = call({ action: 'resolveDispute', token: adminTok, id: adminAsParty.id, resolution: 'confirm' });
check(!resolveByPartyAdmin.ok && resolveByPartyAdmin.error === 'conflict_of_interest', 'an admin who is a party to the disputed handoff cannot resolve it');

console.log('--- authorization boundaries ---');
var car2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: location.entity.id, label: 'Truck-2', driverUserId: null } }).entity;
var wrongDriverEntry = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-09-03', sourceType: 'car', sourceId: car2.id, cashSales: 100 });
check(!wrongDriverEntry.ok && wrongDriverEntry.error === 'forbidden', 'a driver cannot log cash for a car not assigned to them');

var nonAdminEntity = call({ action: 'adminSaveEntity', token: aliTok, kind: 'location', data: { city: 'X', name: 'Y' } });
check(!nonAdminEntity.ok && nonAdminEntity.error === 'forbidden', 'a store manager cannot use admin entity management');

var location2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Other' } }).entity;
var wrongLocationHandoff = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location2.id });
check(!wrongLocationHandoff.ok && wrongLocationHandoff.error === 'forbidden', 'a store manager cannot submit a handoff for a location they do not manage');

console.log('--- cluster manager report scoping ---');
var cluster2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Other Cluster' } }).entity;
var otherManager = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Nora', email: 'nora@bestgas.sa', role: 'cluster_manager' } }).user;
call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { id: cluster2.id, clusterManagerUserId: otherManager.id } });
call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { id: location2.id, clusterId: cluster2.id } });
var noraTok = acceptInvite('nora@bestgas.sa');
var noraReport = call({ action: 'getSalesReport', token: noraTok });
var sawOtherLocation = noraReport.byLocation.some(function (r) { return r.locationId === location.entity.id; });
check(noraReport.ok && !sawOtherLocation, "a cluster manager's report never includes another cluster's location");
var saraReport = call({ action: 'getSalesReport', token: saraTok });
var sawOwnLocation = saraReport.byLocation.some(function (r) { return r.locationId === location.entity.id; });
check(sawOwnLocation, "a cluster manager's report includes their own cluster's location");

console.log('--- company-wide visibility roles: accountant / operations manager ---');
var wafa = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Wafa', email: 'wafa@bestgas.sa', role: 'accountant' } }).user;
var omar = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Omar', email: 'omar@bestgas.sa', role: 'operations_manager' } }).user;
var wafaTok = acceptInvite('wafa@bestgas.sa');
var omarTok = acceptInvite('omar@bestgas.sa');

var wafaReport = call({ action: 'getSalesReport', token: wafaTok });
var adminReportNow = call({ action: 'getSalesReport', token: adminTok });
check(wafaReport.ok && wafaReport.byLocation.some(function (r) { return r.locationId === location.entity.id; }),
  'an accountant sees the Central cluster location in the sales report');
close(wafaReport.totals.netCashOwed, adminReportNow.totals.netCashOwed,
  "an accountant's report total is the full company total, not scoped to one cluster (unlike a cluster manager's)");

var omarDash = call({ action: 'listDashboard', token: omarTok });
check(omarDash.ok && omarDash.companyOutstanding !== undefined, 'an operations manager gets the company-wide dashboard fields');

var wafaAudit = call({ action: 'listAudit', token: wafaTok, limit: 5 });
check(wafaAudit.ok, 'an accountant can read the audit log');

var wafaHandoffs = call({ action: 'listHandoffs', token: wafaTok });
check(wafaHandoffs.ok && wafaHandoffs.handoffs.length >= 3, 'an accountant sees every handoff company-wide, not just their own');

var omarResolve = call({ action: 'resolveDispute', token: omarTok, id: handoff3b.handoff.id, resolution: 'confirm' });
check(!omarResolve.ok && omarResolve.error === 'forbidden', 'visibility is not authority: an operations manager cannot resolve a dispute');

var wafaEntity = call({ action: 'adminSaveEntity', token: wafaTok, kind: 'location', data: { city: 'X', name: 'Y' } });
check(!wafaEntity.ok && wafaEntity.error === 'forbidden', 'visibility is not authority: an accountant cannot manage entities');

console.log('--- product-level sales report ---');
var prodA = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cylinder 20kg' } }).entity;
var prodB = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cylinder 12kg' } }).entity;
check(prodA && prodB, 'two products created');

var peStore = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-10', sourceType: 'store', sourceId: store.entity.id, productId: prodA.id, cashSales: 300 });
var peCar = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-10', sourceType: 'car', sourceId: car.entity.id, productId: prodB.id, cashSales: 200 });
var pePos = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-10', sourceType: 'pos', sourceId: pos.entity.id, productId: prodA.id, posSales: 150 });
check(peStore.ok && peCar.ok && pePos.ok, 'product-tagged entries saved across store/car/pos channels');

var fullReport = call({ action: 'getSalesReport', token: adminTok });
var rowA = fullReport.byProduct.find(function (r) { return r.productId === prodA.id; });
var rowB = fullReport.byProduct.find(function (r) { return r.productId === prodB.id; });
check(rowA && rowA.cashAmount >= 300 && rowA.posAmount >= 150, 'product A aggregates both its cash and POS entries');
check(rowB && rowB.cashAmount >= 200, 'product B aggregates its cash entry');

var sumCashByProduct = fullReport.byProduct.reduce(function (s, r) { return s + r.cashAmount; }, 0);
var sumPosByProduct = fullReport.byProduct.reduce(function (s, r) { return s + r.posAmount; }, 0);
close(sumCashByProduct, fullReport.totals.storeCash + fullReport.totals.carCash + fullReport.totals.posCash, 'byProduct cash amounts reconcile with the report totals (store+car+pos)');
close(sumPosByProduct, fullReport.totals.posSales, 'byProduct POS amounts reconcile with the report totals');

var blockedDelete = call({ action: 'adminDeleteEntity', token: adminTok, kind: 'product', id: prodA.id });
check(!blockedDelete.ok && blockedDelete.error === 'has_children', 'a product with recorded sales cannot be deleted, only deactivated');

var deactivate = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: prodA.id, data: { active: false } });
check(deactivate.ok && deactivate.entity.active === false, 'a product can be deactivated instead');

console.log('--- bulk import (CSV/Excel entry import) ---');
var importRes = call({
  action: 'importDailyEntries', token: adminTok,
  rows: [
    { date: '2026-09-11', sourceType: 'store', sourceId: store.entity.id, cashSales: 111 },
    { date: '2026-09-11', sourceType: 'car', sourceId: car.entity.id, cashSales: 222, deliveryFeeBankAmount: 50 },
    { date: '2026-09-11', sourceType: 'store', sourceId: 'does-not-exist', cashSales: 999 },
    { date: '2026-09-11', sourceType: 'car', sourceId: car2.id, cashSales: 50 } // belongs to a different location, admin is allowed
  ]
});
check(importRes.ok, 'import call succeeds');
check(importRes.total === 4 && importRes.created === 3, 'imports the valid rows and reports the bad one separately (got created=' + importRes.created + ')');
check(importRes.results[2].ok === false && importRes.results[2].error === 'not_found', 'unknown sourceId is rejected per-row, not for the whole batch');

var nonAdminImport = call({ action: 'importDailyEntries', token: aliTok, rows: [{ date: '2026-09-11', sourceType: 'store', sourceId: store.entity.id, cashSales: 10 }] });
check(nonAdminImport.ok, 'store manager can also import within their own scope (same checkEntryScope_ as a single entry)');

var otherLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Other Branch', clusterId: cluster.entity.id } }).entity;
var otherCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: otherLocation.id, label: 'Truck-Other', driverUserId: null } }).entity;
var scopedImport = call({ action: 'importDailyEntries', token: aliTok, rows: [{ date: '2026-09-11', sourceType: 'car', sourceId: otherCar.id, cashSales: 10 }] });
check(scopedImport.ok && scopedImport.created === 0 && scopedImport.results[0].error === 'forbidden', 'store manager importing a source outside their own location is rejected per-row, same as a single entry');

console.log('--- zones: pure geography, separate from cluster (employee assignment) ---');
var zoneRiyadhEast = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { city: 'Riyadh', name: 'East' } });
check(zoneRiyadhEast.ok, 'admin creates a zone');
var zoneNoCity = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { name: 'No city' } });
check(!zoneNoCity.ok && zoneNoCity.error === 'invalid_input', 'zone requires both city and name');

var zonedLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Yasmeen Branch', clusterId: cluster.entity.id, zoneId: zoneRiyadhEast.entity.id } });
check(zonedLocation.ok && zonedLocation.entity.zoneId === zoneRiyadhEast.entity.id, 'a location can optionally carry a zoneId, independent of its clusterId (cluster still the money-chain assignment)');

var zonedStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: zonedLocation.entity.id, name: 'Yasmeen Store' } });
check(zonedStore.ok, 'store created under the zoned location');
var zonedEntry = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-12', sourceType: 'store', sourceId: zonedStore.entity.id, cashSales: 777 });
check(zonedEntry.ok, 'entry recorded against the zoned location (admin, since Ali already manages a different store)');

var zoneFilteredReport = call({ action: 'getSalesReport', token: adminTok, zoneId: zoneRiyadhEast.entity.id });
check(zoneFilteredReport.ok && zoneFilteredReport.totals.storeCash === 777, 'sales report filters by zoneId to just that zone\'s entries');

var blockedZoneDelete = call({ action: 'adminDeleteEntity', token: adminTok, kind: 'zone', id: zoneRiyadhEast.entity.id });
check(!blockedZoneDelete.ok && blockedZoneDelete.error === 'has_children', 'a zone referenced by a location cannot be deleted');

console.log('--- products: goods vs services classification ---');
var goodsProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cylinder Refill', type: 'goods' } });
check(goodsProduct.ok && goodsProduct.entity.type === 'goods', 'product saved with type=goods');
var servicesProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Installation Service', type: 'services' } });
check(servicesProduct.ok && servicesProduct.entity.type === 'services', 'product saved with type=services');

console.log('--- POS machines: cash sales and delivery fee count toward net cash owed, same as a car ---');
var posEntry = call({
  action: 'createDailyEntry', token: aliTok, date: '2026-09-13',
  sourceType: 'pos', sourceId: pos.entity.id, cashSales: 400, deliveryFeeBankAmount: 100, posSales: 250
});
check(posEntry.ok, 'store manager records a POS entry with cash + delivery fee + card sales together');

var posReport = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2026-09-13', dateTo: '2026-09-13' });
close(posReport.totals.posCash, 400, 'POS cash sales are tracked separately from card/bank posSales');
close(posReport.totals.posSales, 250, 'POS card/bank sales still tracked as before, no cash risk');
var posVat = (100 / 1.15) * 0.15;
close(posReport.totals.deliveryFee, 100, 'POS delivery fee counted in the total delivery fee, same as a car');
close(posReport.totals.netCashOwed, 400 - 100 + posVat, 'POS cash + its own delivery-fee deduction + VAT clawback feed net cash owed exactly like a car');

console.log('--- a car with its own mounted POS terminal can report card/bank sales too, not just cash ---');
var carPosEntry = call({
  action: 'createDailyEntry', token: hassanTok, date: '2026-09-14',
  sourceType: 'car', sourceId: car.entity.id, cashSales: 300, deliveryFeeBankAmount: 50, posSales: 120
});
check(carPosEntry.ok, 'driver records a car entry with cash + delivery fee + its own POS card sales together');
var carPosReport = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2026-09-14', dateTo: '2026-09-14' });
close(carPosReport.totals.carCash, 300, 'car cash sales unaffected by the new posSales field');
close(carPosReport.totals.posSales, 120, "a car's own card/bank sales now count toward posSales, previously silently dropped");
var carPosVat = (50 / 1.15) * 0.15;
close(carPosReport.totals.netCashOwed, 300 - 50 + carPosVat, "posSales carries no cash risk — net cash owed still comes only from the car's cash and delivery fee");
var carPosProductRow = carPosReport.byProduct.find(function (r) { return r.productId === null; });
check(carPosProductRow && carPosProductRow.posAmount >= 120, "a car's posSales also counts in the per-product POS breakdown, same as a dedicated pos entry");

console.log('--- a store branch with its own mounted POS terminal can report card/bank sales too, not just cash ---');
var storePosEntry = call({
  action: 'createDailyEntry', token: aliTok, date: '2026-09-15',
  sourceType: 'store', sourceId: store.entity.id, cashSales: 500, posSales: 200
});
check(storePosEntry.ok, 'store manager records a store entry with cash + its own POS card sales together');
var storePosReport = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2026-09-15', dateTo: '2026-09-15' });
close(storePosReport.totals.storeCash, 500, 'store cash sales unaffected by the new posSales field');
close(storePosReport.totals.posSales, 200, "a store's own card/bank sales now count toward posSales, previously silently dropped");
close(storePosReport.totals.deliveryFee, 0, 'a store has no delivery fee concept — unaffected');
close(storePosReport.totals.netCashOwed, 500, "posSales carries no cash risk — net cash owed still comes only from the store's cash");
var storePosProductRow = storePosReport.byProduct.find(function (r) { return r.productId === null; });
check(storePosProductRow && storePosProductRow.posAmount >= 200, "a store's posSales also counts in the per-product POS breakdown");

console.log('--- bank reconciliation: matching declared deposits against the real bank statement ---');
var finance = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Fatima (Finance)', email: 'fatima@bestgas.sa', role: 'finance' } }).user;
var financeTok = acceptInvite('fatima@bestgas.sa');

// A fresh location/cluster pair, isolated from every earlier test's
// leftover unconsumed entries, so the deposit amount here is known exactly
// rather than inherited from whatever else this shared cluster is still
// holding by this point in the file.
var reconCluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'ReconCluster', clusterManagerUserId: sara.id, collectorUserId: musa.id } }).entity;
var reconLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Recon Location', clusterId: reconCluster.id } }).entity;
var reconStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: reconLocation.id, name: 'Recon Branch' } }).entity;
var reconEntry = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-14', sourceType: 'store', sourceId: reconStore.id, cashSales: 555 });
check(reconEntry.ok, 'entry for reconciliation scenario');
var reconHandoff1 = call({ action: 'createHandoff', token: adminTok, kind: 'location_to_cluster', locationId: reconLocation.id });
close(reconHandoff1.handoff.amount, 555, 'fresh location, so the handoff amount is exactly the one entry');
call({ action: 'confirmHandoff', token: saraTok, id: reconHandoff1.handoff.id });
var reconHandoff2 = call({ action: 'createHandoff', token: saraTok, kind: 'cluster_to_collector', clusterId: reconCluster.id });
call({ action: 'confirmHandoff', token: musaTok, id: reconHandoff2.handoff.id });
var reconDeposit = call({ action: 'recordDeposit', token: musaTok, bankReference: 'BANKREF-555' });
check(reconDeposit.ok, 'deposit recorded for reconciliation scenario');
close(reconDeposit.handoff.amount, 555, 'deposit amount is exactly the entry amount (store-only, no VAT/delivery)');

var nonFinanceRecon = call({ action: 'getReconciliation', token: aliTok });
check(!nonFinanceRecon.ok && nonFinanceRecon.error === 'forbidden', 'a store manager cannot access reconciliation');

var beforeImport = call({ action: 'getReconciliation', token: financeTok });
check(beforeImport.ok, 'finance role can access reconciliation');
check(beforeImport.unmatchedDeposits.some(function (d) { return d.id === reconDeposit.handoff.id; }), 'the fresh deposit starts out unmatched');

var importRes = call({
  action: 'importBankStatement', token: financeTok,
  rows: [
    { date: '2026-09-14', amount: 555, reference: 'BANKREF-555' },
    { date: '2026-09-14', amount: 999999, reference: 'unrelated-noise' }
  ]
});
check(importRes.ok && importRes.imported === 2, 'both statement rows imported');
check(importRes.autoMatched === 1, 'the matching row (same amount, same day) auto-matched, the unrelated one did not');

var afterImport = call({ action: 'getReconciliation', token: financeTok });
check(!afterImport.unmatchedDeposits.some(function (d) { return d.id === reconDeposit.handoff.id; }), 'the deposit is no longer in the unmatched list after auto-match');
check(afterImport.unmatchedLines.length === 1 && afterImport.unmatchedLines[0].amount === 999999, 'the unrelated statement line stays unmatched, waiting for a human');
check(afterImport.reconciledCount === 1, 'reconciled count reflects the one auto-matched deposit');

var matchedLineId = null;
(function () {
  var all = call({ action: 'getReconciliation', token: financeTok });
  // the matched line isn't in unmatchedLines by definition — fetch it via the deposit's own reconciledLineId
  var dep = call({ action: 'listHandoffs', token: financeTok, kind: 'deposit' }).handoffs.find(function (h) { return h.id === reconDeposit.handoff.id; });
  matchedLineId = dep && dep.reconciledLineId;
})();
check(!!matchedLineId, 'the deposit records which statement line it was matched to');

var unmatchRes = call({ action: 'unmatchReconciliation', token: financeTok, lineId: matchedLineId });
check(unmatchRes.ok, 'a match can be undone');
var afterUnmatch = call({ action: 'getReconciliation', token: financeTok });
check(afterUnmatch.unmatchedDeposits.some(function (d) { return d.id === reconDeposit.handoff.id; }), 'the deposit is back in the unmatched list after undoing the match');

var manualRes = call({ action: 'manualMatchReconciliation', token: adminTok, lineId: matchedLineId, handoffId: reconDeposit.handoff.id });
check(manualRes.ok, 'admin can manually re-link the same line and deposit');
var afterManual = call({ action: 'getReconciliation', token: financeTok });
check(!afterManual.unmatchedDeposits.some(function (d) { return d.id === reconDeposit.handoff.id; }), 'manual match clears the deposit from the unmatched list again');

console.log('--- LPG cylinder exchange tracking: full delivered vs empty returned, independent of the cash formula ---');
var cylProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cylinder 20kg', type: 'goods' } }).entity;
var cylLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Dammam', name: 'Cylinder Depot', clusterId: cluster.entity.id } }).entity;
var cylStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: cylLocation.id, name: 'Cylinder Store' } }).entity;

var cylEntry1 = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-15', sourceType: 'store', sourceId: cylStore.id, productId: cylProduct.id, cashSales: 100, cylindersOut: 30, cylindersIn: 22 });
check(cylEntry1.ok, 'entry with cylinder counts saved');
check(cylEntry1.entry.cylindersOut === 30 && cylEntry1.entry.cylindersIn === 22, 'cylinder counts stored exactly as entered');

var cylEntry2 = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-16', sourceType: 'store', sourceId: cylStore.id, productId: cylProduct.id, cashSales: 50, cylindersOut: 10, cylindersIn: 10 });
check(cylEntry2.ok, 'second cylinder entry saved (balanced this time)');

var cylReport = call({ action: 'getSalesReport', token: adminTok, locationId: cylLocation.id });
close(cylReport.totals.netCashOwed, 150, 'cylinder counts never touch the cash formula — net owed is just the cash (100+50)');
var cylProductRow = cylReport.byProduct.find(function (r) { return r.productId === cylProduct.id; });
check(!!cylProductRow, 'the cylinder product appears in byProduct');
check(cylProductRow.cylindersOut === 40 && cylProductRow.cylindersIn === 32 && cylProductRow.cylinderBalance === 8, 'byProduct sums cylinders out/in across both entries and nets the balance (40-32=8 still owed back)');

var cylByLoc = cylReport.cylinderByLocation.find(function (r) { return r.locationId === cylLocation.id && r.productId === cylProduct.id; });
check(!!cylByLoc && cylByLoc.cylinderBalance === 8, 'cylinderByLocation gives the same balance at the location level, the actual operational question ("who owes empties back")');

var cylEntryNoProduct = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-16', sourceType: 'store', sourceId: cylStore.id, cashSales: 20, cylindersOut: 5 });
check(cylEntryNoProduct.ok, 'an entry without a product can still be saved');
var cylReport2 = call({ action: 'getSalesReport', token: adminTok, locationId: cylLocation.id });
check(cylReport2.cylinderByLocation.length === 1, 'an entry with no productId is excluded from cylinderByLocation — cylinder tracking is meaningless without knowing which cylinder type');

console.log('--- SLA escalation: a handoff left pending too long gets flagged, once ---');
var slaLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'SLA Test', clusterId: cluster.entity.id } }).entity;
var slaStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: slaLocation.id, name: 'SLA Store' } }).entity;
call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-13', sourceType: 'store', sourceId: slaStore.id, cashSales: 200 });
var slaHandoff = call({ action: 'createHandoff', token: adminTok, kind: 'location_to_cluster', locationId: slaLocation.id }).handoff;
// backdate it directly (createHandoff always stamps "now") so the
// threshold check has something real to trip on, without waiting hours
var slaRow = ctx.getById_(SHEETS.HANDOFFS, slaHandoff.id);
slaRow.createdAt = new Date(Date.now() - 48 * 3600000).toISOString();
ctx.writeRow(SHEETS.HANDOFFS, slaRow);

var mailBefore = ctx._debug.mailLog.length;
var runRes = call({ action: 'runStaleCheck', token: adminTok });
check(runRes.ok && runRes.escalated >= 1, 'stale check escalates the 48h-old pending handoff (default threshold 24h)');
check(ctx._debug.mailLog.length > mailBefore, 'an escalation email actually went out');
var slaRowAfter = ctx.getById_(SHEETS.HANDOFFS, slaHandoff.id);
check(!!slaRowAfter.staleEscalatedAt, 'the handoff is marked so it is not re-escalated every run');

var mailBefore2 = ctx._debug.mailLog.length;
var runRes2 = call({ action: 'runStaleCheck', token: adminTok });
check(runRes2.ok && runRes2.escalated === 0, 'running the check again finds nothing new to escalate (already flagged)');
check(ctx._debug.mailLog.length === mailBefore2, 'no duplicate email on the second run');

var storeManagerStaleCheck = call({ action: 'runStaleCheck', token: aliTok });
check(!storeManagerStaleCheck.ok && storeManagerStaleCheck.error === 'forbidden', 'a store manager cannot trigger the stale check');

var installRes = call({ action: 'adminInstallStaleTrigger', token: adminTok });
check(installRes.ok && installRes.alreadyInstalled === false, 'admin installs the daily trigger');
var installAgain = call({ action: 'adminInstallStaleTrigger', token: adminTok });
check(installAgain.ok && installAgain.alreadyInstalled === true, 'installing again is a safe no-op, not a duplicate trigger');

console.log('--- large-amount second approval: non-blocking four-eyes on big handoffs ---');
call({ action: 'adminSetConfig', token: adminTok, data: { secondApprovalThreshold: 5000, staleThresholdHours: 48 } });
var metaAfterConfig = call({ action: 'listMeta', token: adminTok });
check(metaAfterConfig.ok && metaAfterConfig.config.secondApprovalThreshold === 5000 && metaAfterConfig.config.staleThresholdHours === 48,
  'listMeta reflects the saved SLA/second-approval config, not just vatRate — the Settings screen reads this on every load');

var bigLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Big Amount Test', clusterId: cluster.entity.id } }).entity;
var bigStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: bigLocation.id, name: 'Big Store' } }).entity;
call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-13', sourceType: 'store', sourceId: bigStore.id, cashSales: 6000 });
var bigHandoff = call({ action: 'createHandoff', token: adminTok, kind: 'location_to_cluster', locationId: bigLocation.id }).handoff;
var mailBefore3 = ctx._debug.mailLog.length;
var bigConfirm = call({ action: 'confirmHandoff', token: saraTok, id: bigHandoff.id });
check(bigConfirm.ok && bigConfirm.handoff.status === 'confirmed', 'confirmation still lands immediately — the flag never blocks the chain');
check(bigConfirm.handoff.requiresSecondApproval === true, 'a 6,000 handoff against a 5,000 threshold is flagged for a second sign-off');
var largeAmountMail = ctx._debug.mailLog.slice(mailBefore3);
check(largeAmountMail.length > 0, 'admin/finance got emailed about the large amount');
check(largeAmountMail.some(function (m) { return m.to === sara.email; }) && largeAmountMail.some(function (m) { return m.to === musa.email; }),
  'the cluster\'s own manager and collector are also notified, same recipient set as the shortfall/stale escalations — not just admin/finance');

var smallLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Small Amount Test', clusterId: cluster.entity.id } }).entity;
var smallStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: smallLocation.id, name: 'Small Store' } }).entity;
call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-13', sourceType: 'store', sourceId: smallStore.id, cashSales: 300 });
var smallHandoff = call({ action: 'createHandoff', token: adminTok, kind: 'location_to_cluster', locationId: smallLocation.id }).handoff;
var smallConfirm = call({ action: 'confirmHandoff', token: saraTok, id: smallHandoff.id });
check(!smallConfirm.handoff.requiresSecondApproval, 'a 300 handoff stays under the threshold — not flagged');

var ackByStoreManager = call({ action: 'acknowledgeSecondApproval', token: aliTok, id: bigHandoff.id });
check(!ackByStoreManager.ok && ackByStoreManager.error === 'forbidden', 'a store manager cannot acknowledge a second approval');
var ack = call({ action: 'acknowledgeSecondApproval', token: adminTok, id: bigHandoff.id });
check(ack.ok && !!ack.handoff.secondApprovedBy, 'admin acknowledges the large handoff');
var ackAgain = call({ action: 'acknowledgeSecondApproval', token: adminTok, id: bigHandoff.id });
check(!ackAgain.ok && ackAgain.error === 'already_acknowledged', 'acknowledging twice is rejected, not silently repeated');

console.log('--- second approval: four eyes means two different people, even when the receiver is admin/finance ---');
// Nothing structurally stops an admin/finance account from also being the
// assigned cluster manager/collector for a cluster (validateEntity_ only
// checks the two chain roles differ from each other, not that either
// differs from every admin/finance account) — so a real setup where, say,
// Finance also acts as a cluster's collector is entirely possible. That
// person genuinely receiving a large handoff (no conflict — they're not
// declaring and approving their own submission) must still not be able to
// also acknowledge their own second-approval sign-off; that has to be a
// different person, exactly like resolving a dispute you're a party to.
var selfAckCluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Self-Ack Cluster', clusterManagerUserId: admin.id, collectorUserId: musa.id } }).entity;
var selfAckManager = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Self-Ack Store Manager', email: 'selfack@bestgas.sa', role: 'store_manager' } }).user;
var selfAckManagerTok = acceptInvite('selfack@bestgas.sa');
var selfAckLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Self-Ack Test', clusterId: selfAckCluster.id } }).entity;
var selfAckStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: selfAckLocation.id, name: 'Self-Ack Store', storeManagerUserId: selfAckManager.id } }).entity;
call({ action: 'createDailyEntry', token: selfAckManagerTok, date: '2026-09-13', sourceType: 'store', sourceId: selfAckStore.id, cashSales: 7000 });
var selfAckHandoff = call({ action: 'createHandoff', token: selfAckManagerTok, kind: 'location_to_cluster', locationId: selfAckLocation.id }).handoff;
check(selfAckHandoff.toUserId === admin.id, 'this handoff genuinely routes to admin as the cluster manager (not an on-behalf-of confirmation)');
var selfConfirm = call({ action: 'confirmHandoff', token: adminTok, id: selfAckHandoff.id });
check(selfConfirm.ok && selfConfirm.handoff.requiresSecondApproval, 'admin, genuinely the receiver here, confirms — still flagged for second approval');
var selfAck = call({ action: 'acknowledgeSecondApproval', token: adminTok, id: selfAckHandoff.id });
check(!selfAck.ok && selfAck.error === 'conflict_of_interest', 'the same admin who confirmed it cannot also acknowledge their own second approval');
var otherAck = call({ action: 'acknowledgeSecondApproval', token: financeTok, id: selfAckHandoff.id });
check(otherAck.ok && otherAck.handoff.secondApprovedBy === finance.id, 'a different admin/finance account can still acknowledge it — four eyes intact');

console.log('--- risk / complaint register ---');
var riskItem = call({ action: 'createRiskItem', token: aliTok, type: 'risk', title: 'Leaking valve reported', description: 'Driver flagged a valve leak on Truck-1', severity: 'high' });
check(riskItem.ok, 'any authenticated user (a store manager here) can report a risk');
var complaintItem = call({ action: 'createRiskItem', token: hassanTok, type: 'complaint', title: 'Customer complaint', description: 'Late delivery', severity: 'low' });
check(complaintItem.ok, 'a driver can report a complaint too');
var badType = call({ action: 'createRiskItem', token: adminTok, type: 'not-a-type', title: 'x' });
check(!badType.ok && badType.error === 'invalid_type', 'an invalid type is rejected');

var listByStoreManager = call({ action: 'listRiskItems', token: aliTok });
check(!listByStoreManager.ok && listByStoreManager.error === 'forbidden', 'a store manager can report but not browse the register (company-wide roles only)');
var listByAdmin = call({ action: 'listRiskItems', token: adminTok });
check(listByAdmin.ok && listByAdmin.items.some(function (i) { return i.id === riskItem.item.id; }), 'admin sees the full register, including the store manager\'s report');
check(ctx._debug.mailLog.some(function (m) { return m.subject.indexOf('High-severity risk') >= 0; }), 'the high-severity risk triggered an immediate email; the low-severity complaint did not need to');

var resolveByStoreManager = call({ action: 'updateRiskItemStatus', token: aliTok, id: riskItem.item.id, status: 'resolved' });
check(!resolveByStoreManager.ok && resolveByStoreManager.error === 'forbidden', 'only admin/finance can change a risk item\'s status');
var resolve = call({ action: 'updateRiskItemStatus', token: adminTok, id: riskItem.item.id, status: 'resolved', resolutionNote: 'Valve replaced' });
check(resolve.ok && resolve.item.status === 'resolved' && !!resolve.item.resolvedAt, 'admin resolves the risk item with a note');

console.log('--- security: crafted __proto__/constructor keys cannot pollute objects or bypass lookup tables ---');
// Every for...in merge loop over client-supplied JSON, and every object used
// as a lookup table keyed by client input (action names, entity kinds), is a
// potential prototype-pollution / lookup-bypass surface. JSON.parse creates
// a "__proto__" key as a genuine own property (not real prototype mutation),
// but a later `obj[k] = value` assignment with k === '__proto__' *does*
// invoke the real setter — so the attack has to be built exactly the way a
// real attacker's JSON body would arrive: parsed from a string, not an
// object literal (an object literal's __proto__ key is special-cased by the
// parser itself and never reaches this code path the same way).
var pollutedData = JSON.parse('{"city":"Riyadh","name":"Proto Test","__proto__":{"polluted":"yes"}}');
var pollutedSave = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: pollutedData });
check(pollutedSave.ok, 'entity still saves normally despite the crafted key');
check(pollutedSave.entity.polluted === undefined, 'the saved entity does not carry the injected field');
check(({}).polluted === undefined, "Object.prototype itself was never touched — a later {} doesn't inherit 'polluted'");

var protoAction = call({ action: '__proto__', token: adminTok });
check(!protoAction.ok && protoAction.error === 'unknown_action', 'action:"__proto__" is rejected as unknown, not resolved to an inherited Object.prototype member');
var ctorAction = call({ action: 'constructor', token: adminTok });
check(!ctorAction.ok && ctorAction.error === 'unknown_action', 'action:"constructor" is rejected the same way');

var protoKind = call({ action: 'adminSaveEntity', token: adminTok, kind: '__proto__', data: { name: 'x' } });
check(!protoKind.ok && protoKind.error === 'invalid_kind', 'entity kind:"__proto__" is rejected as invalid, not resolved to an inherited member of ENTITY_SHEET');
var protoDeleteKind = call({ action: 'adminDeleteEntity', token: adminTok, kind: 'constructor', id: 'x' });
check(!protoDeleteKind.ok && protoDeleteKind.error === 'invalid_kind', 'same for adminDeleteEntity with kind:"constructor"');

console.log('--- dashboard period comparison: last 7 days vs. the 7 days before ---');
function isoOffset(daysAgo) { var d = new Date(); d.setDate(d.getDate() - daysAgo); return d.toISOString().slice(0, 10); }
var cmpLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Comparison Test', clusterId: cluster.entity.id } }).entity;
var cmpStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: cmpLocation.id, name: 'Comparison Store' } }).entity;
call({ action: 'createDailyEntry', token: adminTok, date: isoOffset(0), sourceType: 'store', sourceId: cmpStore.id, cashSales: 400 });
call({ action: 'createDailyEntry', token: adminTok, date: isoOffset(9), sourceType: 'store', sourceId: cmpStore.id, cashSales: 300 });
var cmpForbidden = call({ action: 'getDashboardComparison', token: aliTok });
check(!cmpForbidden.ok && cmpForbidden.error === 'forbidden', 'a store manager cannot see the comparison — company-wide visibility only');
var cmp = call({ action: 'getDashboardComparison', token: adminTok });
check(cmp.ok, 'admin can see the comparison');
check(cmp.current.gross >= 400, "today's entry counted in the current 7-day window");
check(cmp.previous.gross >= 300, "the 9-days-ago entry counted in the previous 7-day window, not the current one");

console.log('--- held cash by person trend: a day-by-day snapshot of who is currently holding cash ---');
var trendEntry = call({ action: 'createDailyEntry', token: aliTok, date: isoOffset(0), sourceType: 'store', sourceId: store.entity.id, cashSales: 500 });
var trendHandoff = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location.entity.id });
var trendConfirm = call({ action: 'confirmHandoff', token: saraTok, id: trendHandoff.handoff.id });

var trendForbidden = call({ action: 'getHeldCashTrend', token: aliTok });
check(!trendForbidden.ok && trendForbidden.error === 'forbidden', 'a store manager cannot see the held-cash trend — company-wide visibility only');

var trend = call({ action: 'getHeldCashTrend', token: adminTok });
check(trend.ok, 'admin can see the held-cash trend');
check(trend.dates.length === 14, 'the trend covers a 14-day window');
check(trend.dates[trend.dates.length - 1] === isoOffset(0), "the trend's last day is today");
var todaySnapshot = trend.series[trend.series.length - 1];
check(todaySnapshot.byHolder[sara.id] >= 500, "today's snapshot shows Sara currently holding the newly confirmed cash");
var yesterdaySnapshot = trend.series[trend.series.length - 2];
check(!yesterdaySnapshot.byHolder[sara.id], "yesterday's snapshot does not include cash confirmed only today");

console.log('--- sales report filters: city, entered-by, product, and amount range narrow results independently ---');
var filterLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Filter Test', clusterId: cluster.entity.id } }).entity;
var filterStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: filterLoc.id, name: 'Filter Store' } }).entity;
call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-11', sourceType: 'store', sourceId: filterStore.id, productId: prodA.id, cashSales: 900 });

var cityReport = call({ action: 'getSalesReport', token: adminTok, city: 'Jeddah' });
check(cityReport.ok && cityReport.totals.netCashOwed >= 900, 'city filter includes the Jeddah entry');
check(!cityReport.byLocation.some(function (r) { return r.city === 'Riyadh'; }), 'city filter excludes Riyadh locations');

var productReport = call({ action: 'getSalesReport', token: adminTok, productId: prodA.id });
check(productReport.ok && productReport.entries.every(function (e) { return e.productId === prodA.id; }), 'product filter only returns entries tagged with that product');

var entererReport = call({ action: 'getSalesReport', token: adminTok, enteredBy: admin.id });
check(entererReport.ok && entererReport.entries.every(function (e) { return e.enteredBy === admin.id; }), 'entered-by filter only returns entries submitted by that person');

var amountMinReport = call({ action: 'getSalesReport', token: adminTok, amountMin: 901 });
check(amountMinReport.ok && !amountMinReport.entries.some(function (e) { return e.sourceId === filterStore.id; }), 'amountMin above the entry excludes it');
var amountMaxReport = call({ action: 'getSalesReport', token: adminTok, amountMax: 800 });
check(amountMaxReport.ok && !amountMaxReport.entries.some(function (e) { return e.sourceId === filterStore.id; }), 'amountMax below the entry excludes it');
var amountRangeReport = call({ action: 'getSalesReport', token: adminTok, amountMin: 900, amountMax: 900 });
check(amountRangeReport.ok && amountRangeReport.entries.some(function (e) { return e.sourceId === filterStore.id; }), 'amount range exactly matching the entry includes it');

console.log("--- the missed cycle: a car's cash must clear its own driver -> store-manager handoff before the location can sweep it up ---");
// a fresh store manager, not ali — storeOfManager_ resolves a user's FIRST
// matching store row, and ali already manages Malaz Branch from the very
// top of this suite, so reusing ali here would silently resolve back to
// that store instead of this test's own.
var layla = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Layla', email: 'layla@bestgas.sa', role: 'store_manager' } }).user;
var laylaTok = acceptInvite('layla@bestgas.sa');
var carCycleLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Car Cycle Test', clusterId: cluster.entity.id } }).entity;
var carCycleStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: carCycleLocation.id, name: 'Car Cycle Store', storeManagerUserId: layla.id } }).entity;
var carCycleCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: carCycleLocation.id, label: 'Truck-CycleTest', driverUserId: hassan.id } }).entity;

var driverEntry = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-09-05', sourceType: 'car', sourceId: carCycleCar.id, cashSales: 1200, deliveryFeeBankAmount: 200 });
check(driverEntry.ok, 'driver records their own car entry');
var storeEntry = call({ action: 'createDailyEntry', token: laylaTok, date: '2026-09-05', sourceType: 'store', sourceId: carCycleStore.id, cashSales: 300 });
check(storeEntry.ok, 'store manager records their own store entry the same day');

var earlyLocationHandoff = call({ action: 'createHandoff', token: laylaTok, kind: 'location_to_cluster', locationId: carCycleLocation.id });
check(earlyLocationHandoff.ok, 'store manager can still submit before the car handoff clears');
close(earlyLocationHandoff.handoff.amount, 300, "the driver's car cash is excluded until its own handoff is confirmed — only the store's own 300 goes up");

var bogusCarHandoff = call({ action: 'createHandoff', token: hassanTok, kind: 'car_to_location', carId: 'not-a-real-car' });
check(!bogusCarHandoff.ok && bogusCarHandoff.error === 'not_found', 'a bogus car id is rejected');

var wrongDriverHandoff = call({ action: 'createHandoff', token: laylaTok, kind: 'car_to_location', carId: carCycleCar.id });
check(!wrongDriverHandoff.ok && wrongDriverHandoff.error === 'forbidden', "only the car's own driver (or admin) can hand its cash to the store manager");

var carHandoff = call({ action: 'createHandoff', token: hassanTok, kind: 'car_to_location', carId: carCycleCar.id });
check(carHandoff.ok, 'driver hands their car cash to the store manager');
var carVat = (200 / 1.15) * 0.15;
close(carHandoff.handoff.amount, 1200 - 200 + carVat, 'the driver nets it out himself before handing anything over — cash minus the delivery fee plus the VAT clawback, not the raw cash figure');
check(carHandoff.handoff.toUserId === layla.id, "addressed to the location's store manager");

var driverConfirmOwn = call({ action: 'confirmHandoff', token: hassanTok, id: carHandoff.handoff.id });
check(!driverConfirmOwn.ok && driverConfirmOwn.error === 'conflict_of_interest', 'the driver cannot confirm their own submission');

var carConfirm = call({ action: 'confirmHandoff', token: laylaTok, id: carHandoff.handoff.id });
check(carConfirm.ok && carConfirm.handoff.status === 'confirmed', 'store manager confirms receiving the car cash');

var secondLocationHandoff = call({ action: 'createHandoff', token: laylaTok, kind: 'location_to_cluster', locationId: carCycleLocation.id });
check(secondLocationHandoff.ok, 'store manager batches the location handoff again, now that the car handoff cleared');
close(secondLocationHandoff.handoff.amount, 1200 - 200 + carVat, "the confirmed car handoff's netted breakdown (cash - delivery fee + VAT clawback) is folded in, exactly like the xlsx formula");
check(secondLocationHandoff.handoff.sourceHandoffIds.indexOf(carHandoff.handoff.id) >= 0, 'the location handoff records the car handoff as one of its sources, for dispute-release and audit');

call({ action: 'confirmHandoff', token: saraTok, id: earlyLocationHandoff.handoff.id });
call({ action: 'confirmHandoff', token: saraTok, id: secondLocationHandoff.handoff.id });

console.log('--- the same-person exception: a store manager who is also the store sales rep can enter a car themself with no extra handoff ---');
var selfCarEntry = call({ action: 'createDailyEntry', token: laylaTok, date: '2026-09-06', sourceType: 'car', sourceId: carCycleCar.id, cashSales: 400 });
check(selfCarEntry.ok, 'store manager enters a car figure directly (e.g. no separate driver account for this car)');
var selfCarHandoff = call({ action: 'createHandoff', token: laylaTok, kind: 'location_to_cluster', locationId: carCycleLocation.id });
check(selfCarHandoff.ok, 'location handoff includes the self-entered car cash with no car_to_location step in between');
close(selfCarHandoff.handoff.amount, 400, "self-entered car cash flows straight through, since it was never anyone else's cash to hand over");
call({ action: 'confirmHandoff', token: saraTok, id: selfCarHandoff.handoff.id });

console.log('--- car_to_location shortfall attributes directly to the driver, no proportional split needed ---');
var shortfallCarEntry = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-09-07', sourceType: 'car', sourceId: carCycleCar.id, cashSales: 500 });
var shortfallCarHandoff = call({ action: 'createHandoff', token: hassanTok, kind: 'car_to_location', carId: carCycleCar.id });
var shortfallCarConfirm = call({ action: 'confirmHandoff', token: laylaTok, id: shortfallCarHandoff.handoff.id, receivedAmount: 450 });
check(shortfallCarConfirm.ok && shortfallCarConfirm.handoff.shortfall === 50, 'store manager confirms 450 of the declared 500');
var carShortfallReport = call({ action: 'getShortfallByEntrant', token: adminTok });
var hassanShortfall = carShortfallReport.byEntrant.find(function (r) { return r.userId === hassan.id; });
check(hassanShortfall && hassanShortfall.totalShortfall >= 50, "the driver's own shortfall is attributed to them directly, not split proportionally");
// leave this car handoff (and its downstream location handoff) unconsumed —
// it doubles as fixture data for the held-cash-aging test right below.

console.log('--- held-cash aging alert: a CONFIRMED handoff nobody has moved further gets escalated too, separately from a still-pending one ---');
call({ action: 'adminSetConfig', token: adminTok, data: { heldThresholdHours: 24 } });
var heldMetaCheck = call({ action: 'listMeta', token: adminTok });
check(heldMetaCheck.ok && heldMetaCheck.config.heldThresholdHours === 24, 'listMeta reflects the saved held-threshold config');

// backdate the confirmation of the shortfall car handoff above so it reads
// as held for 48h — same backdate-then-run pattern as the pending-handoff
// SLA test, just on confirmedAt instead of createdAt.
var heldRow = ctx.getById_(SHEETS.HANDOFFS, shortfallCarHandoff.handoff.id);
heldRow.confirmedAt = new Date(Date.now() - 48 * 3600000).toISOString();
ctx.writeRow(SHEETS.HANDOFFS, heldRow);

var heldMailBefore = ctx._debug.mailLog.length;
var heldRunRes = call({ action: 'runStaleCheck', token: adminTok });
check(heldRunRes.ok && heldRunRes.heldEscalated >= 1, 'the held-too-long check escalates the 48h-held confirmed handoff (threshold 24h)');
check(ctx._debug.mailLog.length > heldMailBefore, 'a held-cash-aging email actually went out');
var heldRowAfter = ctx.getById_(SHEETS.HANDOFFS, shortfallCarHandoff.handoff.id);
check(!!heldRowAfter.heldEscalatedAt, 'the handoff is marked so it is not re-escalated every run');

var heldMailBefore2 = ctx._debug.mailLog.length;
var heldRunRes2 = call({ action: 'runStaleCheck', token: adminTok });
check(heldRunRes2.ok && heldRunRes2.heldEscalated === 0, 'running the check again finds nothing new to escalate for the held check (already flagged)');
check(ctx._debug.mailLog.length === heldMailBefore2, 'no duplicate held-cash email on the second run');

// clear the fixture so it doesn't skew the held-cash-trend test above if
// suite ordering ever changes.
call({ action: 'createHandoff', token: laylaTok, kind: 'location_to_cluster', locationId: carCycleLocation.id });

console.log('--- admin can edit a user\'s full profile, not just toggle active/inactive ---');
var editTarget = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Edit Target', email: 'edittarget@bestgas.sa', role: 'driver' } }).user;
var profileEdit = call({
  action: 'adminUpdateUser', token: adminTok, id: editTarget.id,
  data: { name: 'Edit Target Renamed', email: 'edittarget-new@bestgas.sa', role: 'collector', language: 'en', active: true }
});
check(profileEdit.ok, 'admin edits name, email, role, and language together');
check(profileEdit.user.name === 'Edit Target Renamed', 'name updated');
check(profileEdit.user.email === 'edittarget-new@bestgas.sa', 'email updated');
check(profileEdit.user.role === 'collector', 'role updated');
check(profileEdit.user.language === 'en', 'language updated');

var emailConflict = call({ action: 'adminUpdateUser', token: adminTok, id: editTarget.id, data: { email: 'ali@bestgas.sa' } });
check(!emailConflict.ok && emailConflict.error === 'email_exists', "editing a user's email to one already in use is rejected");

var selfEmailNoop = call({ action: 'adminUpdateUser', token: adminTok, id: editTarget.id, data: { email: 'edittarget-new@bestgas.sa' } });
check(selfEmailNoop.ok, 'saving a user with their own unchanged email is not treated as a conflict with themself');

var blankNameRejected = call({ action: 'adminUpdateUser', token: adminTok, id: editTarget.id, data: { name: '   ' } });
check(!blankNameRejected.ok && blankNameRejected.error === 'invalid_input', 'a blank name is rejected, not silently saved');

var storeManagerEditUser = call({ action: 'adminUpdateUser', token: aliTok, id: editTarget.id, data: { name: 'Hijack' } });
check(!storeManagerEditUser.ok && storeManagerEditUser.error === 'forbidden', 'only admin can edit another user\'s profile');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
