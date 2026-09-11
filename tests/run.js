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
close(sumCashByProduct, fullReport.totals.storeCash + fullReport.totals.carCash, 'byProduct cash amounts reconcile with the report totals (store+car)');
close(sumPosByProduct, fullReport.totals.posSales, 'byProduct POS amounts reconcile with the report totals');

var blockedDelete = call({ action: 'adminDeleteEntity', token: adminTok, kind: 'product', id: prodA.id });
check(!blockedDelete.ok && blockedDelete.error === 'has_children', 'a product with recorded sales cannot be deleted, only deactivated');

var deactivate = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: prodA.id, data: { active: false } });
check(deactivate.ok && deactivate.entity.active === false, 'a product can be deactivated instead');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
