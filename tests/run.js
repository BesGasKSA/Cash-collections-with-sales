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

// Invitations carry a single-use link (?invite=TOKEN), not a password.
function lastInviteFor(email) {
  var log = ctx._debug.mailLog;
  for (var i = log.length - 1; i >= 0; i--) {
    if (log[i].to === email) {
      var m = /[?&]invite=([A-Za-z0-9]+)/.exec(log[i].body);
      if (m) return m[1];
    }
  }
  return null;
}

function acceptInvite(email) {
  var token = lastInviteFor(email);
  check(!!token, 'invitation email captured for ' + email);
  var acc = call({ action: 'acceptInvite', inviteToken: token, password: 'RealPass#1' });
  check(acc.ok, 'accept invitation: ' + email);
  var loginRes = login(email, 'RealPass#1');
  check(loginRes.ok, 'login after accepting: ' + email);
  return loginRes.token;
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
// credit sales name a registered customer: the ones the tests below use
call({ action: 'adminImportCustomers', token: adminTok, rows: ['Al-Rashid Trading', 'Nakheel Restaurant', 'A', 'B'] });
// The Deputy Operations Manager validates every area manager -> collector
// handover before the collector sees it; this one does that for the flows below.
var walid = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Walid (Deputy)', email: 'walid@bestgas.sa', role: 'deputy_operations_manager' } }).user;
var walidTok = acceptInvite('walid@bestgas.sa');
function deputyValidates(res) {
  if (!res || !res.ok) return res;
  check(res.handoff.status === 'pending_deputy', 'the area manager\'s handover waits for the deputy first');
  var v = call({ action: 'deputyValidateHandoff', token: walidTok, id: res.handoff.id });
  check(v.ok && v.handoff.status === 'pending', 'the deputy validates it, and only then does it reach the collector');
  return res;
}

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
// A الموازنة line names the branch's POS device (when it has one) and carries
// a photo uploaded first by the person entering it.
function slip(tok, row) {
  var up = call({ action: 'uploadEntryPhoto', token: tok, fileBase64: 'iVBORw0KGgo=', fileName: 'slip.png', fileMime: 'image/png' });
  row.directDepositPhotoId = up.fileId;
  var loc = ctx.resolveSourceLocation_(row.sourceType, row.sourceId);
  var dev = ctx.readSheet(ctx.SHEETS.POS).filter(function (m) { return m.active !== false && ctx.resolveSourceLocation_('pos', m.id) === loc; })[0];
  if (dev) row.directDepositPosId = dev.id;
  return row;
}

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

var handoff2 = deputyValidates(call({ action: 'createHandoff', token: saraTok, kind: 'cluster_to_collector', clusterId: cluster.entity.id }));
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
var closeOut = deputyValidates(call({ action: 'createHandoff', token: saraTok, kind: 'cluster_to_collector', clusterId: cluster.entity.id }));
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

var handoff4b = deputyValidates(call({ action: 'createHandoff', token: saraTok, kind: 'cluster_to_collector', clusterId: cluster.entity.id }));
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
// every car has a driver now, so 'not your car' means another driver's car
var driver2 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Bilal', email: 'bilal@bestgas.sa', role: 'driver' } }).user;
var car2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: location.entity.id, label: 'Truck-2', driverUserId: driver2.id } }).entity;
var wrongDriverEntry = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-09-03', sourceType: 'car', sourceId: car2.id, cashSales: 100 });
check(!wrongDriverEntry.ok && wrongDriverEntry.error === 'forbidden', 'a driver cannot log cash for a car not assigned to them');

var nonAdminEntity = call({ action: 'adminSaveEntity', token: aliTok, kind: 'location', data: { city: 'X', name: 'Y' } });
check(!nonAdminEntity.ok && nonAdminEntity.error === 'forbidden', 'a store manager cannot use admin entity management');

// a branch hands its cash to its own collector
var loc2Collector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Other Branch Collector', email: 'loc2col.fx@bestgas.sa', role: 'collector' } }).user;
var location2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Other', collectorUserId: loc2Collector.id } }).entity;
var wrongLocationHandoff = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location2.id });
check(!wrongLocationHandoff.ok && wrongLocationHandoff.error === 'forbidden', 'a store manager cannot submit a handoff for a location they do not manage');

console.log('--- cluster manager report scoping ---');
// an area is created with both ends of its hop assigned
var otherManager = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Nora', email: 'nora@bestgas.sa', role: 'cluster_manager' } }).user;
var otherCollector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Rakan', email: 'rakan@bestgas.sa', role: 'collector' } }).user;
var cluster2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Other Cluster', clusterManagerUserId: otherManager.id, collectorUserId: otherCollector.id } }).entity;
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
var otherCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: otherLocation.id, label: 'Truck-Other', driverUserId: driver2.id } }).entity;
var scopedImport = call({ action: 'importDailyEntries', token: aliTok, rows: [{ date: '2026-09-11', sourceType: 'car', sourceId: otherCar.id, cashSales: 10 }] });
check(scopedImport.ok && scopedImport.created === 0 && scopedImport.results[0].error === 'forbidden', 'store manager importing a source outside their own location is rejected per-row, same as a single entry');

console.log('--- zones: pure geography, separate from cluster (employee assignment) ---');
var zoneRiyadhEast = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { city: 'Riyadh', name: 'East' } });
check(zoneRiyadhEast.ok, 'admin creates a zone');
var zoneNoCity = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { name: 'No city' } });
check(!zoneNoCity.ok && zoneNoCity.error === 'invalid_input', 'zone requires both city and name');

var zonedLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Yasmeen Branch', clusterId: cluster.entity.id, zoneId: zoneRiyadhEast.entity.id } });
check(zonedLocation.ok && zonedLocation.entity.zoneId === zoneRiyadhEast.entity.id, 'a location can optionally carry a zoneId, independent of its clusterId (cluster still the money-chain assignment)');

var mgr1 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Yasmeen Store Manager', email: 'mgr1.fx@bestgas.sa', role: 'store_manager' } }).user;
var zonedStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: zonedLocation.entity.id, name: 'Yasmeen Store', storeManagerUserId: mgr1.id } });
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
// its own people too: nobody may serve two areas
var reconMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Recon Area Manager', email: 'reconmgr.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var reconCol = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Recon Collector', email: 'reconcol.fx@bestgas.sa', role: 'collector' } }).user;
var reconMgrTok = acceptInvite('reconmgr.fx@bestgas.sa');
var reconColTok = acceptInvite('reconcol.fx@bestgas.sa');
var reconCluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'ReconCluster', clusterManagerUserId: reconMgr.id, collectorUserId: reconCol.id } }).entity;
var reconLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Recon Location', clusterId: reconCluster.id } }).entity;
var mgr2 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Recon Branch Manager', email: 'mgr2.fx@bestgas.sa', role: 'store_manager' } }).user;
var reconStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: reconLocation.id, name: 'Recon Branch', storeManagerUserId: mgr2.id } }).entity;
var reconEntry = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-14', sourceType: 'store', sourceId: reconStore.id, cashSales: 555 });
check(reconEntry.ok, 'entry for reconciliation scenario');
var reconHandoff1 = call({ action: 'createHandoff', token: adminTok, kind: 'location_to_cluster', locationId: reconLocation.id });
close(reconHandoff1.handoff.amount, 555, 'fresh location, so the handoff amount is exactly the one entry');
call({ action: 'confirmHandoff', token: reconMgrTok, id: reconHandoff1.handoff.id });
var reconHandoff2 = deputyValidates(call({ action: 'createHandoff', token: reconMgrTok, kind: 'cluster_to_collector', clusterId: reconCluster.id }));
call({ action: 'confirmHandoff', token: reconColTok, id: reconHandoff2.handoff.id });
var reconDeposit = call({ action: 'recordDeposit', token: reconColTok, bankReference: 'BANKREF-555' });
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
    // Statement date must be "today": auto-match only pairs a deposit with a
    // statement line within RECON_DATE_WINDOW_DAYS of when it was confirmed,
    // and the deposit above is confirmed at test run time, not on a fixed date.
    { date: isoOffset(0), amount: 555, reference: 'BANKREF-555' },
    { date: isoOffset(0), amount: 999999, reference: 'unrelated-noise' }
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
var mgr3 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Cylinder Store Manager', email: 'mgr3.fx@bestgas.sa', role: 'store_manager' } }).user;
var cylStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: cylLocation.id, name: 'Cylinder Store', storeManagerUserId: mgr3.id } }).entity;

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
var mgr4 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'SLA Store Manager', email: 'mgr4.fx@bestgas.sa', role: 'store_manager' } }).user;
var slaStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: slaLocation.id, name: 'SLA Store', storeManagerUserId: mgr4.id } }).entity;
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
var mgr5 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Big Store Manager', email: 'mgr5.fx@bestgas.sa', role: 'store_manager' } }).user;
var bigStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: bigLocation.id, name: 'Big Store', storeManagerUserId: mgr5.id } }).entity;
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
var mgr6 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Small Store Manager', email: 'mgr6.fx@bestgas.sa', role: 'store_manager' } }).user;
var smallStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: smallLocation.id, name: 'Small Store', storeManagerUserId: mgr6.id } }).entity;
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
var selfAckCollector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Self-Ack Collector', email: 'selfackcol.fx@bestgas.sa', role: 'collector' } }).user;
var selfAckCluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Self-Ack Cluster', clusterManagerUserId: admin.id, collectorUserId: selfAckCollector.id } }).entity;
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

console.log('--- getDashboardAll: one combined call returns the same data as the three separate calls it replaces ---');
var separateReport = call({ action: 'getSalesReport', token: adminTok });
var separateHandoffs = call({ action: 'listHandoffs', token: adminTok });
var separateDash = call({ action: 'listDashboard', token: adminTok });
var combined = call({ action: 'getDashboardAll', token: adminTok });
check(combined.ok, 'getDashboardAll succeeds for a company-wide role');
close(combined.report.totals.netCashOwed, separateReport.totals.netCashOwed, 'bundled report.totals matches the separate getSalesReport call');
check(combined.handoffs.handoffs.length === separateHandoffs.handoffs.length, 'bundled handoffs list matches the separate listHandoffs call');
close(combined.dashboard.companyOutstanding, separateDash.companyOutstanding, 'bundled dashboard.companyOutstanding matches the separate listDashboard call');
// A branch manager may now read their own branch's report, so the bundle
// succeeds for them — but still only with their own branch's rows, and the
// bundle must not show them anything the separate call would not.
var combinedStore = call({ action: 'getDashboardAll', token: aliTok });
var separateStoreReport = call({ action: 'getSalesReport', token: aliTok });
check(combinedStore.ok && combinedStore.report.entries.length === separateStoreReport.entries.length,
  'the bundle gives a branch manager exactly what the separate getSalesReport call gives them -- it does not loosen any individual permission check');
check(combinedStore.report.entries.every(function (e) { return e.locationId === location.entity.id; }),
  'and only rows from their own branch');
check(call({ action: 'getSalesReport', token: musaTok }).error === 'forbidden', 'a collector still gets no report at all');

console.log('--- dashboard period comparison: last 7 days vs. the 7 days before ---');
function isoOffset(daysAgo) { var d = new Date(); d.setDate(d.getDate() - daysAgo); return d.toISOString().slice(0, 10); }
var cmpLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Comparison Test', clusterId: cluster.entity.id } }).entity;
var mgr7 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Comparison Store Manager', email: 'mgr7.fx@bestgas.sa', role: 'store_manager' } }).user;
var cmpStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: cmpLocation.id, name: 'Comparison Store', storeManagerUserId: mgr7.id } }).entity;
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
var mgr8 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Filter Store Manager', email: 'mgr8.fx@bestgas.sa', role: 'store_manager' } }).user;
var filterStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: filterLoc.id, name: 'Filter Store', storeManagerUserId: mgr8.id } }).entity;
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

console.log('--- iqamaId (employee) and posId/posConfig (POS machine) round-trip as plain profile fields ---');
var iqamaCreate = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Iqama Test', email: 'iqamatest@bestgas.sa', role: 'driver', iqamaId: '2345678901' } });
check(iqamaCreate.ok && iqamaCreate.user.iqamaId === '2345678901', 'iqamaId is accepted and returned on user creation');
var iqamaMeta = call({ action: 'listMeta', token: adminTok }).users.filter(function (u) { return u.id === iqamaCreate.user.id; })[0];
check(iqamaMeta && iqamaMeta.iqamaId === '2345678901', 'listMeta carries iqamaId through publicUser_, same as every other profile field');
var iqamaUpdate = call({ action: 'adminUpdateUser', token: adminTok, id: iqamaCreate.user.id, data: { iqamaId: '1122334455' } });
check(iqamaUpdate.ok && iqamaUpdate.user.iqamaId === '1122334455', 'iqamaId can be edited afterward, same as name/email/role');
var iqamaUntouched = call({ action: 'adminUpdateUser', token: adminTok, id: iqamaCreate.user.id, data: { name: 'Iqama Test Renamed' } });
check(iqamaUntouched.ok && iqamaUntouched.user.iqamaId === '1122334455', 'editing an unrelated field leaves iqamaId alone');

var posWithId = call({
  action: 'adminSaveEntity', token: adminTok, kind: 'pos',
  data: { ownerType: 'car', ownerId: car.entity.id, label: 'POS-iqama-test', assignedUserId: hassan.id, posId: 'DEV-7788', posConfig: 'merchantId=99120044;terminal=T1' }
});
check(posWithId.ok && posWithId.entity.posId === 'DEV-7788' && posWithId.entity.posConfig === 'merchantId=99120044;terminal=T1',
  'posId/posConfig are plain pass-through fields on the pos entity, no backend whitelist blocks them (actionAdminSaveEntity_ merges any field in req.data)');

// Uses a fixed date in the past on purpose: this block filters a report by
// date, and a hardcoded date that eventually equals today picks up entries
// other tests create 'today' at the same store (it did, once the clock
// reached 2026-09-20).
console.log('--- product-level entry: qty x unit price is stored as informational passthrough, never touches the cash formula ---');
var qtyEntry = call({ action: 'createDailyEntry', token: aliTok, date: '2020-02-29', sourceType: 'store', sourceId: store.entity.id, cashSales: 300, qty: 3, unitPrice: 100 });
check(qtyEntry.ok, 'entry with qty/unitPrice saves successfully');
check(qtyEntry.entry.qty === 3 && qtyEntry.entry.unitPrice === 100, 'qty and unitPrice are stored on the entry exactly as sent');

var noQtyEntry = call({ action: 'createDailyEntry', token: aliTok, date: '2020-02-29', sourceType: 'store', sourceId: store.entity.id, cashSales: 50 });
check(noQtyEntry.ok && noQtyEntry.entry.qty === null && noQtyEntry.entry.unitPrice === null, 'qty/unitPrice default to null when omitted — direct-amount entries are unaffected');

var bulkQtyImport = call({ action: 'importDailyEntries', token: adminTok, rows: [
  { date: '2020-02-29', sourceType: 'store', sourceId: store.entity.id, cashSales: 200, qty: 2, unitPrice: 100 },
  { date: '2020-02-29', sourceType: 'store', sourceId: store.entity.id, cashSales: 75 }
] });
check(bulkQtyImport.ok && bulkQtyImport.created === 2, 'bulk import accepts rows with and without qty/unitPrice in the same batch');
var bulkQtyEntries = call({ action: 'listEntries', token: adminTok, locationId: location.entity.id, date: '2020-02-29' }).entries;
var withQty = bulkQtyEntries.filter(function (e) { return e.cashSales === 200; })[0];
check(withQty && withQty.qty === 2 && withQty.unitPrice === 100, 'the bulk-imported row with qty/unitPrice carries them through to the stored entry');

var qtyReport = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2020-02-29', dateTo: '2020-02-29' });
close(qtyReport.totals.storeCash, 300 + 50 + 200 + 75, 'qty/unitPrice never leak into the cash formula — totals still come from cashSales alone');

console.log('--- a delivery fee can never stand alone: it must accompany a cash/POS sale (same source and date) ---');
var deliveryAloneEntry = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-09-21', sourceType: 'car', sourceId: car.entity.id, deliveryFeeBankAmount: 500 });
check(!deliveryAloneEntry.ok && deliveryAloneEntry.error === 'delivery_without_sale', 'a delivery fee with no cash/POS sale that day, and no prior sale on file, is rejected');

var saleFirst = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-09-21', sourceType: 'car', sourceId: car.entity.id, cashSales: 300 });
check(saleFirst.ok, 'the cash sale itself saves fine');

var deliveryAfterSale = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-09-21', sourceType: 'car', sourceId: car.entity.id, deliveryFeeBankAmount: 500 });
check(deliveryAfterSale.ok, 'now that a same-day sale is on file for this exact car, a separate delivery-fee-only entry is accepted');

var bulkSaleAndDelivery = call({ action: 'importDailyEntries', token: adminTok, rows: [
  { date: '2026-09-22', sourceType: 'car', sourceId: car.entity.id, deliveryFeeBankAmount: 200 },
  { date: '2026-09-22', sourceType: 'car', sourceId: car.entity.id, cashSales: 150 }
] });
check(bulkSaleAndDelivery.ok && bulkSaleAndDelivery.created === 2, "product-mode's split rows (a delivery line plus a cash line in the same batch) both succeed, regardless of order");

var bulkDeliveryOnly = call({ action: 'importDailyEntries', token: adminTok, rows: [
  { date: '2026-09-23', sourceType: 'car', sourceId: car.entity.id, deliveryFeeBankAmount: 400 }
] });
check(bulkDeliveryOnly.ok && bulkDeliveryOnly.created === 0 && bulkDeliveryOnly.results[0].error === 'delivery_without_sale',
  'a lone delivery-only row with no sibling sale in the batch, and no prior sale that day, is rejected');

console.log('--- credit sales: counted in total sales, DEDUCTED from the cash owed, and satisfies the delivery-needs-a-sale rule ---');
var creditNetBefore = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2026-09-24', dateTo: '2026-09-24' }).totals.netCashOwed;
var creditOnlyEntry = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-24', sourceType: 'store', sourceId: store.entity.id, creditSales: 900, creditCustomer: 'Al-Rashid Trading' });
check(creditOnlyEntry.ok, 'a store entry with only creditSales (no cash/POS) saves fine — credit alone is a valid entry');
check(creditOnlyEntry.entry.creditSales === 900, 'creditSales is stored on the entry exactly as sent');

var creditReport = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2026-09-24', dateTo: '2026-09-24' });
close(creditReport.totals.netCashOwed, creditNetBefore - 900, 'a credit sale comes back out of the cash owed: the sales figure includes it, but no cash arrived');
close(creditReport.totals.creditSales, 900, 'the report totals track creditSales separately, alongside cashSales/posSales');

var creditMixedEntry = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-24', sourceType: 'store', sourceId: store.entity.id, cashSales: 200, creditSales: 300, creditCustomer: 'Al-Rashid Trading' });
check(creditMixedEntry.ok, 'an entry can carry both cashSales and creditSales together');
var creditMixedReport = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2026-09-24', dateTo: '2026-09-24' });
close(creditMixedReport.totals.netCashOwed, creditNetBefore - 900 + 200 - 300, 'a mixed cash+credit entry adds its cash and deducts its credit');
close(creditMixedReport.totals.creditSales, 900 + 300, 'and creditSales is still tracked on its own, so the deduction can always be explained');

var creditProductRow = creditMixedReport.byProduct.filter(function (r) { return r.productId === null; })[0];
check(creditProductRow && creditProductRow.creditAmount >= 1200, 'the by-product breakdown carries a creditAmount bucket, summed like cashAmount/posAmount');

// Delivery-without-sale, revisited: a credit sale is a real sale (goods or
// services genuinely changed hands, payment just hasn't landed yet), so it
// must satisfy the same "delivery needs an accompanying sale" rule that
// cash/POS already do — see deliveryNeedsSale_ in Collection.gs.
var creditDeliveryAlone = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-08-25', sourceType: 'car', sourceId: car.entity.id, deliveryFeeBankAmount: 500 });
check(!creditDeliveryAlone.ok && creditDeliveryAlone.error === 'delivery_without_sale', 'still rejected with no sale of any kind on file that day');

var creditSaleFirst = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-08-25', sourceType: 'car', sourceId: car.entity.id, creditSales: 250, creditCustomer: 'Al-Rashid Trading' });
check(creditSaleFirst.ok, 'a credit-only sale saves fine on its own');

var creditDeliveryAfter = call({ action: 'createDailyEntry', token: hassanTok, date: '2026-08-25', sourceType: 'car', sourceId: car.entity.id, deliveryFeeBankAmount: 500 });
check(creditDeliveryAfter.ok, 'a delivery fee is now accepted — a same-day credit sale on file counts as "a sale" just like cash/POS would');

var bulkCreditAndDelivery = call({ action: 'importDailyEntries', token: adminTok, rows: [
  { date: '2026-08-26', sourceType: 'car', sourceId: car.entity.id, deliveryFeeBankAmount: 200 },
  { date: '2026-08-26', sourceType: 'car', sourceId: car.entity.id, creditSales: 150, creditCustomer: 'Al-Rashid Trading' }
] });
check(bulkCreditAndDelivery.ok && bulkCreditAndDelivery.created === 2, 'product-mode\'s split rows (a delivery line plus a credit-tagged line in the same batch) both succeed, regardless of order');

console.log('--- area-manager bulk upload -> Deputy Operations Manager approval ---');

console.log('--- deputy role creation ---');
var deputy = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Deputy', email: 'deputy@bestgas.sa', role: 'deputy_operations_manager' } });
check(deputy.ok, 'admin can create a deputy_operations_manager user');
var deputyTok = acceptInvite('deputy@bestgas.sa');
var badRole = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Bad', email: 'bad@bestgas.sa', role: 'made_up_role' } });
check(!badRole.ok && badRole.error === 'invalid_input', 'validRole_ still rejects a garbage role — no regression from adding the new one');

console.log('--- toggle gating, both directions ---');
var metaOff = call({ action: 'listMeta', token: adminTok });
check(metaOff.config.areaManagerBulkUploadEnabled === false, 'the feature defaults to off');
var blockedWhileOff = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [{ date: '2026-08-27', sourceType: 'store', sourceId: store.entity.id, cashSales: 500 }]
});
check(!blockedWhileOff.ok && blockedWhileOff.error === 'feature_disabled', 'submitting a bulk batch while the toggle is off is rejected, even with otherwise-valid input');

var toggleOn = call({ action: 'adminSetConfig', token: adminTok, data: { areaManagerBulkUploadEnabled: true } });
check(toggleOn.ok && toggleOn.config.areaManagerBulkUploadEnabled === true, 'admin flips the toggle on');
var metaOn = call({ action: 'listMeta', token: adminTok });
check(metaOn.config.areaManagerBulkUploadEnabled === true, 'listMeta reflects the change immediately — same bug class CLAUDE.md Trap #3 already documents for the other two flags');

console.log('--- cluster-scoped entry check ---');
var otherLocation = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Rawdah', clusterId: cluster2.id } }).entity;
var rawdahMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Rawdah Manager', email: 'rawdah.fx@bestgas.sa', role: 'store_manager' } }).user;
var otherStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: otherLocation.id, name: 'Rawdah Branch', storeManagerUserId: rawdahMgr.id } }).entity;
var crossClusterSubmit = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [{ date: '2026-08-27', sourceType: 'store', sourceId: otherStore.id, cashSales: 500 }]
});
check(!crossClusterSubmit.ok && crossClusterSubmit.error === 'invalid_rows' && crossClusterSubmit.results[0].error === 'forbidden',
  "a cluster manager submitting a row for a location outside their own cluster is rejected — the whole batch, all-or-nothing");
var storeManagerBulkAttempt = call({
  action: 'bulkSubmitAreaBatch', token: aliTok, clusterId: cluster.entity.id,
  rows: [{ date: '2026-08-27', sourceType: 'store', sourceId: store.entity.id, cashSales: 500 }]
});
check(!storeManagerBulkAttempt.ok && storeManagerBulkAttempt.error === 'forbidden', 'a store manager (not a cluster manager) cannot call the bulk action at all');

console.log('--- dry-run preview: area manager sees the real computed breakdown before anything is written ---');
var beforeDryRunEntries = call({ action: 'listEntries', token: adminTok, locationId: location.entity.id, date: '2026-08-27' }).entries.length;
var dryRun = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, dryRun: true,
  rows: [
    { date: '2026-08-27', sourceType: 'store', sourceId: store.entity.id, cashSales: 7000, posSales: 4000 },
    { date: '2026-08-27', sourceType: 'car', sourceId: car.entity.id, cashSales: 5000, deliveryFeeBankAmount: 5000, posSales: 6000 }
  ]
});
check(dryRun.ok && dryRun.dryRun === true, 'a dryRun request succeeds and is flagged as a dry run');
close(dryRun.batch.breakdown.netCashOwed, 7652.17, 'the dry-run breakdown matches the real xlsx-example formula exactly');
var afterDryRunEntries = call({ action: 'listEntries', token: adminTok, locationId: location.entity.id, date: '2026-08-27' }).entries.length;
check(afterDryRunEntries === beforeDryRunEntries, 'a dry run writes no entries at all');
var afterDryRunBatches = call({ action: 'listAreaBulkBatches', token: deputyTok }).batches.filter(function (b) { return b.id === dryRun.batch.id; });
check(afterDryRunBatches.length === 0, 'a dry run writes no area_bulk_batches row either — the Deputy never sees it');
var realAfterDryRun = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [
    { date: '2026-08-27', sourceType: 'store', sourceId: store.entity.id, cashSales: 7000, posSales: 4000 },
    { date: '2026-08-27', sourceType: 'car', sourceId: car.entity.id, cashSales: 5000, deliveryFeeBankAmount: 5000, posSales: 6000 }
  ]
});
check(realAfterDryRun.ok && !realAfterDryRun.dryRun, 'submitting for real right after (identical payload, no dryRun flag) succeeds normally');
close(realAfterDryRun.batch.breakdown.netCashOwed, dryRun.batch.breakdown.netCashOwed, 'the real submission computes the identical figure the dry run already showed — no drift between preview and reality');

// The client now sends one row per product/service line (qty x unitPrice,
// one payment method) instead of one row per source/day totalling every
// payment method at once — actionBulkSubmitAreaBatch_ already accepted
// productId/qty/unitPrice per row (same shape actionImportEntries_ uses for
// renderEntries' product mode), so no backend change was needed for this;
// these tests just prove the existing action really does carry that shape
// through end to end for the area-bulk path too.
console.log('--- product-level bulk rows: qty x unitPrice per line, multiple lines per source/date ---');
var productDryRun = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, dryRun: true,
  rows: [
    { date: '2026-08-28', sourceType: 'store', sourceId: store.entity.id, productId: cylProduct.id, qty: 10, unitPrice: 100, cashSales: 1000 },
    { date: '2026-08-28', sourceType: 'car', sourceId: car.entity.id, productId: cylProduct.id, qty: 5, unitPrice: 100, cashSales: 500 },
    { date: '2026-08-28', sourceType: 'car', sourceId: car.entity.id, productId: servicesProduct.entity.id, qty: 1, unitPrice: 115, deliveryFeeBankAmount: 115 }
  ]
});
check(productDryRun.ok && productDryRun.dryRun === true, 'a batch of product-level lines (one line per product x payment method) dry-runs successfully');
var expectedProductNet = 1000 + 500 - 115 + (115 / 1.15 * 0.15);
close(productDryRun.batch.breakdown.netCashOwed, expectedProductNet, 'multiple product lines for the same and different sources sum into the same computeNet_ formula flat-amount rows already used — the VAT-on-delivery reclaim is untouched by the product split');

var productSubmit = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [
    { date: '2026-08-28', sourceType: 'store', sourceId: store.entity.id, productId: cylProduct.id, qty: 10, unitPrice: 100, cashSales: 1000 },
    { date: '2026-08-28', sourceType: 'car', sourceId: car.entity.id, productId: cylProduct.id, qty: 5, unitPrice: 100, cashSales: 500 },
    { date: '2026-08-28', sourceType: 'car', sourceId: car.entity.id, productId: servicesProduct.entity.id, qty: 1, unitPrice: 115, deliveryFeeBankAmount: 115 }
  ]
});
check(productSubmit.ok, 'the same product-level batch submits for real');
var productEntries = call({ action: 'listEntries', token: adminTok, locationId: location.entity.id, date: '2026-08-28' }).entries;
var storeProductLine = productEntries.filter(function (e) { return e.sourceType === 'store'; })[0];
check(storeProductLine && storeProductLine.productId === cylProduct.id && storeProductLine.qty === 10 && storeProductLine.unitPrice === 100,
  'the store product line carries productId/qty/unitPrice through to the stored entry, same as a single-location product-mode entry would');
var carDeliveryLine = productEntries.filter(function (e) { return e.sourceType === 'car' && e.deliveryFeeBankAmount > 0; })[0];
check(carDeliveryLine && carDeliveryLine.productId === servicesProduct.entity.id, 'the delivery product line is stored against the services-type product, not the goods product');

console.log('--- product-level rows still need a sibling sale for a delivery line (batch-wide, not just same source+date already on file) ---');
var deliveryOnlyProductBatch = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, dryRun: true,
  rows: [
    { date: '2026-08-29', sourceType: 'car', sourceId: car.entity.id, productId: servicesProduct.entity.id, qty: 1, unitPrice: 115, deliveryFeeBankAmount: 115 }
  ]
});
check(!deliveryOnlyProductBatch.ok && deliveryOnlyProductBatch.error === 'invalid_rows' && deliveryOnlyProductBatch.results[0].error === 'delivery_without_sale',
  'a lone delivery product-line with no sibling cash/pos/credit line in the batch, and no prior sale that day, is rejected — same rule flat-amount rows already follow');
var deliveryWithSiblingProductBatch = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, dryRun: true,
  rows: [
    { date: '2026-08-29', sourceType: 'car', sourceId: car.entity.id, productId: cylProduct.id, qty: 2, unitPrice: 100, cashSales: 200 },
    { date: '2026-08-29', sourceType: 'car', sourceId: car.entity.id, productId: servicesProduct.entity.id, qty: 1, unitPrice: 115, deliveryFeeBankAmount: 115 }
  ]
});
check(deliveryWithSiblingProductBatch.ok, 'adding a sibling cash product-line in the same batch, same source+date, satisfies the delivery-needs-a-sale rule');

console.log('--- full happy path: multi-location upload -> pending_deputy -> deputy approves -> cluster_to_collector handoff ---');
var happyBatch = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [
    { date: '2026-07-28', sourceType: 'store', sourceId: store.entity.id, cashSales: 4000, posSales: 500 },
    { date: '2026-07-28', sourceType: 'car', sourceId: car.entity.id, cashSales: 3000, deliveryFeeBankAmount: 1000 }
  ]
});
check(happyBatch.ok && happyBatch.batch.status === 'pending_deputy', 'a clean multi-location batch is created and lands pending_deputy');
close(happyBatch.batch.breakdown.storeCash, 4000, 'batch breakdown storeCash matches the uploaded rows');
close(happyBatch.batch.breakdown.carCash, 3000, 'batch breakdown carCash matches the uploaded rows');

var deputyApprove = call({ action: 'deputyApproveBatch', token: deputyTok, id: happyBatch.batch.id });
check(deputyApprove.ok, 'the deputy approves the batch');
check(deputyApprove.handoff.kind === 'cluster_to_collector' && deputyApprove.handoff.status === 'pending' && deputyApprove.handoff.toUserId === musa.id,
  'approval creates a real cluster_to_collector handoff addressed to the cluster\'s collector');
close(deputyApprove.handoff.amount, deputyApprove.batch.breakdown.netCashOwed, "the handoff's amount matches computeNet_ summed across the batch's locations");
var entryAfterApprove = call({ action: 'listEntries', token: adminTok, locationId: location.entity.id, date: '2026-07-28' }).entries[0];
check(entryAfterApprove.consumedBy === deputyApprove.handoff.id, "each entry's consumedBy now points at the real handoff, not the batch");

var collectorConfirm = call({ action: 'confirmHandoff', token: musaTok, id: deputyApprove.handoff.id, receivedAmount: deputyApprove.handoff.amount });
check(collectorConfirm.ok, 'the collector can confirm a bulk-originated handoff exactly like a normal one');
var deposit = call({ action: 'recordDeposit', token: musaTok, bankReference: 'BULK-DEP-1' });
check(deposit.ok, 'and deposit it — the rest of the chain is completely unmodified for a bulk-originated handoff');

console.log('--- areaBulkBatchDetail: the product-level VAT breakdown survives after submission, not just during the dry-run preview ---');
var productBatch = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [
    { date: '2026-08-30', sourceType: 'store', sourceId: store.entity.id, productId: cylProduct.id, qty: 10, unitPrice: 100, cashSales: 1000 },
    { date: '2026-08-30', sourceType: 'car', sourceId: car.entity.id, productId: cylProduct.id, qty: 5, unitPrice: 100, cashSales: 500 },
    { date: '2026-08-30', sourceType: 'car', sourceId: car.entity.id, productId: servicesProduct.entity.id, qty: 1, unitPrice: 115, deliveryFeeBankAmount: 115 }
  ]
});
check(productBatch.ok, 'a product-level batch (qty/unitPrice per row) submits fine, same as any other');
var ownerDetail = call({ action: 'areaBulkBatchDetail', token: saraTok, id: productBatch.batch.id });
check(ownerDetail.ok, 'the uploading cluster manager can check their own batch\'s product-level detail after submission');
var cylRow = ownerDetail.byProduct.filter(function (r) { return r.productId === cylProduct.id; })[0];
check(!!cylRow && cylRow.qty === 15, 'goods product line aggregates qty (10+5) across both store and car rows');
close(cylRow.subtotal, 1500, 'and subtotal (1000+500) across both rows');
close(cylRow.base, 1500 / 1.15, 'base excl. VAT is derived the same way as the dry-run preview (subtotal / (1+vatRate))');
close(cylRow.vat, (1500 / 1.15) * 0.15, 'VAT amount matches subtotal - base, same formula as the pre-submit preview');
var deliveryRow = ownerDetail.byProduct.filter(function (r) { return r.productId === servicesProduct.entity.id; })[0];
check(!!deliveryRow && deliveryRow.type === 'services', 'the delivery-fee line is correctly typed as services, separate from the goods line');
close(deliveryRow.subtotal, 115, 'and keeps its own subtotal');

var strangerDetail = call({ action: 'areaBulkBatchDetail', token: aliTok, id: productBatch.batch.id });
check(!strangerDetail.ok && strangerDetail.error === 'forbidden', 'a store manager (not the uploader, not deputy/company-wide) cannot check another cluster manager\'s batch detail');
var deputyDetail = call({ action: 'areaBulkBatchDetail', token: deputyTok, id: productBatch.batch.id });
check(deputyDetail.ok, 'the deputy can check product-level detail for any batch, same visibility as listAreaBulkBatches');
var missingDetail = call({ action: 'areaBulkBatchDetail', token: adminTok, id: 'not-a-real-batch-id' });
check(!missingDetail.ok && missingDetail.error === 'not_found', 'a bogus batch id is rejected cleanly');

console.log('--- reject-and-resubmit ---');
var rejectBatch = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [{ date: '2026-08-29', sourceType: 'store', sourceId: store.entity.id, cashSales: 900 }]
});
check(rejectBatch.ok, 'a second batch is submitted');
var deputyReject = call({ action: 'deputyRejectBatch', token: deputyTok, id: rejectBatch.batch.id, note: 'wrong figure, please recheck' });
check(deputyReject.ok && deputyReject.batch.status === 'deputy_rejected' && deputyReject.batch.rejectionNote === 'wrong figure, please recheck',
  'the deputy rejects with a note');
var voidedEntry = call({ action: 'listEntries', token: adminTok, locationId: location.entity.id, date: '2026-08-29' }).entries[0];
check(voidedEntry.voided === true && !voidedEntry.consumedBy, 'the rejected entry is marked voided, not just released back to unconsumed');
var resubmitBatch = call({
  action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id,
  rows: [{ date: '2026-08-29', sourceType: 'store', sourceId: store.entity.id, cashSales: 950 }]
});
check(resubmitBatch.ok, 'the area manager resubmits a corrected batch for the same date/source');
var resubmitApprove = call({ action: 'deputyApproveBatch', token: deputyTok, id: resubmitBatch.batch.id });
close(resubmitApprove.handoff.breakdown.storeCash, 950, "the corrected batch's handoff reflects only the resubmitted 950 — the voided 900 from the rejected batch is never double-counted");

console.log('--- conflict-of-interest / role checks specific to this flow ---');
var clusterManagerApproveAttempt = call({ action: 'deputyApproveBatch', token: saraTok, id: happyBatch.batch.id });
check(!clusterManagerApproveAttempt.ok && clusterManagerApproveAttempt.error === 'forbidden', 'a cluster manager cannot call deputyApproveBatch directly');
var clusterManagerRejectAttempt = call({ action: 'deputyRejectBatch', token: saraTok, id: happyBatch.batch.id });
check(!clusterManagerRejectAttempt.ok && clusterManagerRejectAttempt.error === 'forbidden', 'a cluster manager cannot call deputyRejectBatch directly');
var alreadyActedBatch = call({ action: 'deputyApproveBatch', token: deputyTok, id: happyBatch.batch.id });
check(!alreadyActedBatch.ok && alreadyActedBatch.error === 'not_pending', 'approving an already-approved batch a second time is rejected');

console.log('--- visibility vs. authority for the new role (mirrors the existing company-wide-roles assertions) ---');
var deputyDashboard = call({ action: 'listDashboard', token: deputyTok });
check(deputyDashboard.ok && deputyDashboard.companyOutstanding != null, 'the deputy has full company-wide dashboard visibility, same tier as accountant/operations manager');
var deputyReport = call({ action: 'getSalesReport', token: deputyTok });
check(deputyReport.ok, 'and full sales-report visibility');
var deputyAudit = call({ action: 'listAudit', token: deputyTok, limit: 5 });
check(deputyAudit.ok, 'and audit-log visibility');
var deputyResolveAttempt = call({ action: 'resolveDispute', token: deputyTok, id: happyBatch.batch.id, resolution: 'confirm' });
check(!deputyResolveAttempt.ok, 'but the deputy still cannot resolve a dispute — that authority stays admin/finance-only, exactly like accountant/operations manager');
var deputyManageAttempt = call({ action: 'adminSaveEntity', token: deputyTok, kind: 'location', data: { city: 'X', name: 'Y', clusterId: cluster.entity.id } });
check(!deputyManageAttempt.ok && deputyManageAttempt.error === 'forbidden', 'and cannot manage entities either — visibility is not authority');

console.log('--- sendMail_: Microsoft 365 (Graph) when configured, MailApp fallback otherwise ---');
var mailLog = ctx._debug.mailLog;
var urlFetch = ctx._debug.urlFetch;
var props = ctx._debug.scriptProps;

var mailBefore = mailLog.length;
check(ctx.sendMail_('a@bestgas.sa', 'subj', 'body') === 'mailapp', 'with no GRAPH_* properties set, mail still goes through MailApp exactly as before');
check(mailLog.length === mailBefore + 1 && urlFetch.log.length === 0, 'and Microsoft is never contacted');

props.GRAPH_TENANT_ID = 'tenant-123';
props.GRAPH_CLIENT_ID = 'client-abc';
props.GRAPH_CLIENT_SECRET = 'secret-xyz';
props.GRAPH_SENDER = 'm.mahdi@bestgas.sa';
urlFetch.responder = function (url) {
  if (url.indexOf('login.microsoftonline.com') >= 0) return { code: 200, body: JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) };
  if (url.indexOf('graph.microsoft.com') >= 0) return { code: 202, body: '' };
  return { code: 404, body: '{}' };
};
mailBefore = mailLog.length;
check(ctx.sendMail_('b@bestgas.sa', 'Shortfall', 'Declared 100 / received 90') === 'graph', 'with all GRAPH_* properties set, mail goes through Microsoft Graph');
check(mailLog.length === mailBefore, 'and does not also go out through MailApp (no duplicate email)');
var sendCall = urlFetch.log.filter(function (r) { return r.url.indexOf('/sendMail') >= 0; }).pop();
check(sendCall.url.indexOf('/users/m.mahdi%40bestgas.sa/sendMail') >= 0, 'sends from the configured bestgas.sa mailbox');
check(sendCall.options.headers.Authorization === 'Bearer tok-1', 'using the access token Microsoft issued');
var sentPayload = JSON.parse(sendCall.options.payload);
check(sentPayload.message.toRecipients[0].emailAddress.address === 'b@bestgas.sa' && sentPayload.message.subject === 'Shortfall', 'to the right recipient with the right subject');
var tokenCallsBefore = urlFetch.log.filter(function (r) { return r.url.indexOf('login.microsoftonline.com') >= 0; }).length;
ctx.sendMail_('c@bestgas.sa', 's2', 'b2');
var tokenCallsAfter = urlFetch.log.filter(function (r) { return r.url.indexOf('login.microsoftonline.com') >= 0; }).length;
check(tokenCallsAfter === tokenCallsBefore, 'a second email reuses the cached token instead of asking Microsoft for a new one each time');

urlFetch.responder = function (url) {
  if (url.indexOf('graph.microsoft.com') >= 0) return { code: 403, body: '{"error":{"code":"ErrorAccessDenied"}}' };
  return { code: 200, body: JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) };
};
mailBefore = mailLog.length;
var origConsoleError = console.error;
console.error = function () {};
var fallbackResult = ctx.sendMail_('d@bestgas.sa', 'Shortfall', 'x');
console.error = origConsoleError;
check(fallbackResult === 'mailapp' && mailLog.length === mailBefore + 1, 'if Microsoft rejects the send (e.g. expired secret), the email still goes out through MailApp -- a shortfall alert is never lost');

delete props.GRAPH_TENANT_ID; delete props.GRAPH_CLIENT_ID; delete props.GRAPH_CLIENT_SECRET; delete props.GRAPH_SENDER;

console.log('--- speed: fewer round trips to Google services per request ---');
var svc = ctx._debug.svcCalls;
function resetSvc() { svc.getProperty = 0; svc.getProperties = 0; svc.cacheGet = 0; svc.sheetRead = 0; }

resetSvc();
var fastLogin = login('admin@bestgas.sa', 'Bootstrap#1');
check(fastLogin.ok, 'login still works');
check(svc.getProperty === 0 && svc.getProperties <= 1, 'login reads script properties at most once (was 120+ times: once per password-hashing round), got getProperty=' + svc.getProperty + ' getProperties=' + svc.getProperties);
check(fastLogin.meta && fastLogin.meta.ok && Array.isArray(fastLogin.meta.locations), 'login reply carries the reference data, so the client needs no separate listMeta round trip');

var boot = call({ action: 'bootstrap', token: fastLogin.token });
check(boot.ok && boot.user && boot.user.id === admin.id && boot.meta && Array.isArray(boot.meta.users), 'bootstrap returns the user and reference data in one call (replaces whoami + listMeta)');

call({ action: 'listMeta', token: fastLogin.token });
resetSvc();
call({ action: 'listMeta', token: fastLogin.token });
check(svc.sheetRead === 0, 'a repeat listMeta with no writes in between is served entirely from cache: zero sheet reads, got ' + svc.sheetRead);

var bigText = new Array(260001).join('ب'); // 260,000 two-byte chars: far past the 100KB single-value cache limit
var chunkCache = ctx.CacheService.getScriptCache();
ctx.cachePutBig_(chunkCache, 'perf_test_key', bigText, 600);
check(ctx.cacheGetBig_(chunkCache, 'perf_test_key') === bigText, 'a value far larger than the 100KB cache limit is split into chunks and read back exactly');

for (var bi = 0; bi < 120; bi++) {
  ctx.writeRow('perf_big_sheet', { note: new Array(1501).join('x') + bi });
}
ctx.resetExecMemo_();
ctx.readSheet('perf_big_sheet');
ctx.resetExecMemo_();
resetSvc();
var bigRows = ctx.readSheet('perf_big_sheet');
check(bigRows.length === 120 && svc.sheetRead === 0, 'a sheet over 100KB is still served from cache on the next request (old code silently skipped caching it and re-read the sheet every time), sheet reads=' + svc.sheetRead);

ctx.resetExecMemo_();
var memoA = ctx.readSheet('perf_big_sheet');
memoA[0].note = 'mutated by a caller';
var memoB = ctx.readSheet('perf_big_sheet');
check(memoB[0].note !== 'mutated by a caller', 'each readSheet call still returns fresh objects, so one caller mutating its rows cannot leak into another');

ctx.resetExecMemo_();
ctx.readSheet('perf_big_sheet');
ctx.writeRow('perf_big_sheet', { note: 'written after a read in the same request' });
var afterWrite = ctx.readSheet('perf_big_sheet');
check(afterWrite.length === 121, 'a read after a write in the same request sees the new row, not the memoized pre-write copy');

var v1 = ctx.version_('perf_big_sheet');
ctx.bumpVersion_('perf_big_sheet');
var v2 = ctx.version_('perf_big_sheet');
check(v1 !== v2, 'every write changes the sheet version, so no two writers can land on the same cache key');

console.log('--- invitations: invited -> accepted -> active, with last login ---');
var invMailBefore = ctx._debug.mailLog.length;
var inv = call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://besgasksa.github.io/Cash-collections-with-sales/', data: { name: 'Invitee Person', email: 'invitee@bestgas.sa', role: 'store_manager' } });
check(inv.ok && inv.inviteSent === true, 'creating a user sends an invitation');
check(inv.user.status === 'invited' && !!inv.user.invitedAt && !!inv.user.inviteExpiresAt, 'a new user starts as "invited", with the send time and expiry recorded');
check(inv.user.lastLoginAt === null, 'and has no last login yet');
var invMail = ctx._debug.mailLog.slice(invMailBefore).filter(function (m) { return m.to === 'invitee@bestgas.sa'; }).pop();
check(!!invMail && !!invMail.html, 'the invitation is a formatted (HTML) email');
check(invMail.html.indexOf('قبول الدعوة') >= 0 && invMail.html.indexOf('dir="rtl"') >= 0 && invMail.html.indexOf('Accept invitation') < 0,
  'an Arabic user gets the invitation in Arabic, once, not every line twice');
check(invMail.html.indexOf('أهلاً Invitee') >= 0 && invMail.html.indexOf('مدير فرع') >= 0 && invMail.html.indexOf(String(inv.user.inviteExpiresAt).slice(0, 10)) >= 0,
  'it greets them by first name and says their role and the last day the link works');
check(invMail.html.indexOf('width="600"') < 0 && invMail.html.indexOf('max-width:560px') >= 0, 'the email is fluid: nothing is cut off on a phone');
check(!/letter-spacing:\s*[1-9]/.test(invMail.html), 'no letter-spacing that would break the Arabic letters apart');
check(invMail.html.indexOf('\u2014') < 0, 'and no em dashes in the copy');
var invEn = call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://besgasksa.github.io/Cash-collections-with-sales/', data: { name: 'Nadia Karim', email: 'invitee.en@bestgas.sa', role: 'collector', language: 'en' } });
var invEnMail = ctx._debug.mailLog.filter(function (m) { return m.to === 'invitee.en@bestgas.sa'; }).pop();
check(invEn.ok && invEnMail && invEnMail.html.indexOf('Accept invitation') >= 0 && invEnMail.html.indexOf('dir="ltr"') >= 0 && /invited/i.test(invEnMail.subject) && invEnMail.html.indexOf('Hello Nadia') >= 0,
  'an English user gets it in English');
var invUr = call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://besgasksa.github.io/Cash-collections-with-sales/', data: { name: 'Imran Shah', email: 'invitee.ur@bestgas.sa', role: 'driver', language: 'ur' } });
var invUrMail = ctx._debug.mailLog.filter(function (m) { return m.to === 'invitee.ur@bestgas.sa'; }).pop();
check(invUr.ok && invUrMail && invUrMail.html.indexOf('دعوت قبول کریں') >= 0 && invUrMail.html.indexOf('ڈرائیور') >= 0, 'an Urdu user gets it in Urdu, with the role in Urdu');
check(/[?&]invite=/.test(invEnMail.body) && /[?&]invite=/.test(invUrMail.body), 'every plain-text version carries the link too');
check(invMail.html.indexOf('href="https://besgasksa.github.io/Cash-collections-with-sales/?invite=') >= 0, 'and the button links back to the app the admin is using');
check(!/Temporary password/.test(invMail.body), 'no temporary password is emailed any more');
var invToken = lastInviteFor('invitee@bestgas.sa');
var invInfo = call({ action: 'inviteInfo', inviteToken: invToken });
check(invInfo.ok && invInfo.status === 'valid' && invInfo.inviterName === 'Admin', 'the invitation page can say who invited them');
var storedInvitee = ctx.userByEmail_('invitee@bestgas.sa');
check(storedInvitee.inviteTokenHash && storedInvitee.inviteTokenHash.indexOf(invToken) < 0, 'only a keyed hash of the invitation token is stored, never the token itself');

check(login('invitee@bestgas.sa', 'anything').error === 'invite_pending', 'signing in before accepting says the invitation is still pending');
var info = call({ action: 'inviteInfo', inviteToken: invToken });
check(info.ok && info.status === 'valid' && info.name === 'Invitee Person' && info.role === 'store_manager', 'the accept page can greet the invitee without a session');
check(call({ action: 'inviteInfo', inviteToken: 'x'.repeat(40) }).status === 'invalid', 'a made-up token is reported as invalid');
check(call({ action: 'acceptInvite', inviteToken: invToken, password: 'short' }).error === 'weak_password', 'accepting needs a password of at least 8 characters');

var listAs = function () { return call({ action: 'listMeta', token: adminTok }).users.filter(function (u) { return u.email === 'invitee@bestgas.sa'; })[0]; };
var acc = call({ action: 'acceptInvite', inviteToken: invToken, password: 'Invitee#123' });
check(acc.ok && acc.email === 'invitee@bestgas.sa', 'the invitee accepts and sets their own password');
check(listAs().status === 'accepted' && !!listAs().acceptedAt, 'admin now sees "accepted"');
check(call({ action: 'acceptInvite', inviteToken: invToken, password: 'Another#123' }).error === 'invite_used', 'the link works once only');
check(call({ action: 'inviteInfo', inviteToken: invToken }).status === 'used', 'reopening the link says it was already used');
check(call({ action: 'adminResendInvite', token: adminTok, id: inv.user.id }).error === 'already_accepted', 'cannot resend to someone who already accepted');

var invLogin = login('invitee@bestgas.sa', 'Invitee#123');
check(invLogin.ok && !invLogin.user.mustChangePw, 'signs in with the password they chose, no forced change');
var afterLogin = listAs();
check(afterLogin.status === 'active' && !!afterLogin.activatedAt, 'first sign-in makes them "active"');
check(!!afterLogin.lastLoginAt, 'and admin can see their last login');

console.log('--- invitations: resend, expiry, disabled, forgot-password ---');
var inv2 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Late', email: 'late@bestgas.sa', role: 'driver' } }).user;
var firstToken = lastInviteFor('late@bestgas.sa');
var resend = call({ action: 'adminResendInvite', token: adminTok, id: inv2.id });
check(resend.ok && resend.inviteSent, 'admin can resend an invitation');
var secondToken = lastInviteFor('late@bestgas.sa');
check(secondToken && secondToken !== firstToken, 'the resend carries a new link');
check(call({ action: 'inviteInfo', inviteToken: firstToken }).status === 'invalid', 'and the old link stops working');
var lateRow = ctx.userByEmail_('late@bestgas.sa');
lateRow.inviteExpiresAt = new Date(Date.now() - 1000).toISOString();
ctx.writeRow(SHEETS.USERS, lateRow);
check(call({ action: 'listMeta', token: adminTok }).users.filter(function (u) { return u.id === inv2.id; })[0].status === 'invite_expired', 'an invitation past 7 days shows as expired');
check(call({ action: 'acceptInvite', inviteToken: secondToken, password: 'LatePass#1' }).error === 'invite_expired', 'an expired link cannot be accepted');
var resetOnInvited = call({ action: 'adminResetPassword', token: adminTok, id: inv2.id });
check(resetOnInvited.ok && resetOnInvited.user && resetOnInvited.user.status === 'invited', '"reset password" on someone who never accepted re-sends the invitation instead');
var fpMailBefore = ctx._debug.mailLog.length;
call({ action: 'forgotPassword', email: 'late@bestgas.sa' });
var fpMail = ctx._debug.mailLog.slice(fpMailBefore).pop();
check(fpMail && /[?&]invite=/.test(fpMail.body) && !/Temporary password/.test(fpMail.body), 'forgot-password for an un-accepted invitation re-sends the invitation link');
call({ action: 'adminUpdateUser', token: adminTok, id: inv2.id, data: { active: false } });
check(call({ action: 'listMeta', token: adminTok }).users.filter(function (u) { return u.id === inv2.id; })[0].status === 'disabled', 'a deactivated user shows as disabled');
check(call({ action: 'inviteInfo', inviteToken: lastInviteFor('late@bestgas.sa') }).status === 'invalid', 'and their pending link no longer works');
check(call({ action: 'adminResendInvite', token: adminTok, id: inv2.id }).error === 'user_inactive', 'no resending to a disabled user');
check(call({ action: 'adminResendInvite', token: aliTok, id: inv2.id }).error === 'forbidden', 'only admin can resend invitations');
var visibleToManager = call({ action: 'listMeta', token: aliTok }).users.filter(function (u) { return u.id === inv.user.id; })[0];
check(visibleToManager && visibleToManager.lastLoginAt === undefined && visibleToManager.status === undefined, 'non-company-wide users do not see anyone\'s status or last login');
check(ctx.inviteAppUrl_({ appUrl: 'javascript:alert(1)' }) === ctx.DEFAULT_APP_URL && ctx.inviteAppUrl_({ appUrl: 'https://besgasksa.github.io/Cash-collections-with-sales/index.html?y=1' }) === 'https://besgasksa.github.io/Cash-collections-with-sales/', 'the link base only accepts a clean app address');

console.log('--- master data: non-sales collection items and expense items ---');
var incomeItem = call({ action: 'adminSaveEntity', token: adminTok, kind: 'income_item', data: { name: 'تحصيل مبيعات آجلة' } });
var expenseItem = call({ action: 'adminSaveEntity', token: adminTok, kind: 'expense_item', data: { name: 'وقود' } });
check(incomeItem.ok && expenseItem.ok, 'admin can create a collection item and an expense item');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'income_item', data: { name: '' } }).error === 'invalid_input', 'an item needs a name');
check(call({ action: 'adminSaveEntity', token: aliTok, kind: 'expense_item', data: { name: 'Sneaky' } }).error === 'forbidden', 'only admin keeps the master data');
var incomeId = incomeItem.entity.id, expenseId = expenseItem.entity.id;

console.log('--- product price: fixed or editable per product ---');
var fixedProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'أسطوانة 12.5kg', type: 'goods', unitPrice: 45, priceLocked: true } });
check(fixedProduct.ok && fixedProduct.entity.priceLocked === true && fixedProduct.entity.unitPrice === 45, 'a product can carry a fixed price');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Bad', priceLocked: true } }).error === 'invalid_input', 'a price cannot be locked when there is no price to lock');
var openProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'خدمة توصيل', type: 'services', unitPrice: 20 } });
check(openProduct.ok && !openProduct.entity.priceLocked, 'and a product can keep an editable suggested price');

console.log('--- a branch store has delivery fees too ---');
var branchDelivery = call({ action: 'createDailyEntry', token: aliTok, date: '2026-07-01', sourceType: 'store', sourceId: store.entity.id, cashSales: 1000, deliveryFeeBankAmount: 115 });
check(branchDelivery.ok, 'a branch store entry accepts a delivery fee');
var branchNet = ctx.computeNet_([branchDelivery.entry]);
close(branchNet.deliveryFee, 115, 'the fee is counted');
close(branchNet.vatOnDelivery, 15, 'its VAT is credited back');
close(branchNet.netCashOwed, 900, 'and the branch owes the cash minus the delivery fee before VAT');

console.log('--- non-sales collections, expenses and direct deposits ---');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-07-02', sourceType: 'store', sourceId: store.entity.id, otherCash: 200 }).error === 'invalid_income_item', 'money collected outside sales must name an item from the master data');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-07-02', sourceType: 'store', sourceId: store.entity.id, otherCash: 200, otherCashItemId: incomeId }).error === 'reason_required', 'and must say why');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-07-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, expenseAmount: 50, expenseItemId: 'nope', expenseReason: 'x' }).error === 'invalid_expense_item', 'a cash expense must name an item from the master data');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-07-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, expenseAmount: 50, expenseItemId: expenseId }).error === 'reason_required', 'and must say why too');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-07-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, directDepositAmount: 50 }).error === 'deposit_needs_reference', 'cash banked at the source needs a bank reference');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-07-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, directDepositAmount: 500, directDepositRef: 'REF-1' }).error === 'deposit_exceeds_cash', 'and can never exceed the cash that entry actually produced');

var depositsBefore = ctx.readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.kind === 'deposit'; }).length;
var mixed = call(slip(aliTok, { action: 'createDailyEntry', token: aliTok, date: '2026-07-03', sourceType: 'store', sourceId: store.entity.id,
  cashSales: 1000, deliveryFeeBankAmount: 115,
  otherCash: 200, otherCashItemId: incomeId, otherCashReason: 'سداد فاتورة آجلة لعميل',
  expenseAmount: 50, expenseItemId: expenseId, expenseReason: 'تعبئة وقود السيارة',
  directDepositAmount: 300, directDepositRef: 'BANK-99' }));
check(mixed.ok, 'one entry can carry a sale, a collection, an expense and a direct deposit');
var mixedNet = ctx.computeNet_([mixed.entry]);
close(mixedNet.otherCash, 200, 'the collection is tracked on its own');
close(mixedNet.expenses, 50, 'so is the expense');
close(mixedNet.directDeposit, 300, 'so is the amount already banked');
// 1000 cash + 200 collected - 115 delivery + 15 VAT back - 50 spent - 300 banked
close(mixedNet.netCashOwed, 750, 'and only the remainder is still owed to the chain');

var deposits = ctx.readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.kind === 'deposit'; });
check(deposits.length === depositsBefore + 1, 'banking cash at the source writes a deposit record');
var direct = deposits[deposits.length - 1];
check(direct.direct === true && direct.status === 'completed' && direct.bankReference === 'BANK-99', 'marked as a direct deposit, completed, with its reference');
check(direct.sourceEntryIds.length === 1 && direct.sourceEntryIds[0] === mixed.entry.id, 'and linked back to the entry it came from');
check(direct.amount === 300 && mixed.deposit && mixed.deposit.id === direct.id, 'for the amount deposited');
var recon = call({ action: 'getReconciliation', token: adminTok });
check(recon.ok && recon.unmatchedDeposits.some(function (d) { return d.id === direct.id; }), 'and the bank reconciliation sees it like any other deposit');

console.log('--- the remainder still travels the normal chain ---');
var restHandoff = call({ action: 'createHandoff', token: aliTok, kind: 'location_to_cluster', locationId: location.entity.id });
check(restHandoff.ok, 'the branch hands over what is left');
// the two 2026-07 entries above are the only unconsumed ones for this location
close(restHandoff.handoff.amount, restHandoff.handoff.breakdown.netCashOwed, 'and the amount handed over is exactly what its own breakdown adds up to');
close(restHandoff.handoff.breakdown.otherCash, 200, 'the collection shows in the handoff breakdown');
close(restHandoff.handoff.breakdown.expenses, 50, 'the expense shows too');
close(restHandoff.handoff.breakdown.directDeposit, 300, 'and so does the amount already banked');

console.log('--- an area manager enters data for every branch in their own area ---');
var amStore = call({ action: 'createDailyEntry', token: saraTok, date: '2026-07-10', sourceType: 'store', sourceId: store.entity.id, cashSales: 500, deliveryFeeBankAmount: 57.5 });
check(amStore.ok, 'the area manager can enter a branch store day, delivery fee included');
var amStoreNet = ctx.computeNet_([amStore.entry]);
close(amStoreNet.netCashOwed, 450, 'and the branch delivery fee is deducted before VAT, same as a car');
var amCar = call({ action: 'createDailyEntry', token: saraTok, date: '2026-07-10', sourceType: 'car', sourceId: car.entity.id, cashSales: 300 });
check(amCar.ok, 'and a car in that branch');
var amPos = call({ action: 'createDailyEntry', token: saraTok, date: '2026-07-10', sourceType: 'pos', sourceId: pos.entity.id, cashSales: 100, deliveryFeeBankAmount: 23 });
check(amPos.ok, 'and a POS machine in that branch');
var farMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Far Area Manager', email: 'farmgr.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var farCollector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Far Collector', email: 'farcol.fx@bestgas.sa', role: 'collector' } }).user;
var outsideStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Far Area', clusterManagerUserId: farMgr.id, collectorUserId: farCollector.id } });
var outsideLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Far Branch', clusterId: outsideStore.entity.id } });
var mgr9 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Far Store Manager', email: 'mgr9.fx@bestgas.sa', role: 'store_manager' } }).user;
var outsideBranchStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: outsideLoc.entity.id, name: 'Far Store', storeManagerUserId: mgr9.id } });
check(call({ action: 'createDailyEntry', token: saraTok, date: '2026-07-10', sourceType: 'store', sourceId: outsideBranchStore.entity.id, cashSales: 10 }).error === 'forbidden',
  'but never for a branch outside their own area');
check(call({ action: 'createDailyEntry', token: musaTok, date: '2026-07-10', sourceType: 'store', sourceId: store.entity.id, cashSales: 10 }).error === 'forbidden',
  'and a collector still cannot enter sales at all');
var amImport = call({ action: 'importDailyEntries', token: saraTok, rows: [
  { date: '2026-07-11', sourceType: 'store', sourceId: store.entity.id, cashSales: 200, deliveryFeeBankAmount: 11.5 },
  { date: '2026-07-11', sourceType: 'store', sourceId: outsideBranchStore.entity.id, cashSales: 200 }
] });
check(amImport.ok && amImport.created === 1 && amImport.results[1].error === 'forbidden',
  'a CSV import by the area manager takes their own branches and refuses the rest');

console.log('--- a deposit is checked against the whole submission, not one row of it ---');
// The same real day split across two product lines, with the deposit riding
// on the first one -- exactly what the Entries screen's product mode sends.
var splitRows = call({ action: 'importDailyEntries', token: aliTok, rows: [
  slip(aliTok, { date: '2026-08-05', sourceType: 'store', sourceId: store.entity.id, cashSales: 200, directDepositAmount: 500, directDepositRef: 'SPLIT-1' }),
  { date: '2026-08-05', sourceType: 'store', sourceId: store.entity.id, cashSales: 400 }
] });
check(splitRows.ok && splitRows.created === 2, 'a deposit larger than its own row but covered by the day is accepted');
var tooBig = call({ action: 'importDailyEntries', token: aliTok, rows: [
  { date: '2026-08-06', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, directDepositAmount: 900, directDepositRef: 'SPLIT-2' },
  { date: '2026-08-06', sourceType: 'store', sourceId: store.entity.id, cashSales: 200 }
] });
check(tooBig.results[0].error === 'deposit_exceeds_cash', 'a deposit larger than the whole day is still refused');
var otherDay = call({ action: 'importDailyEntries', token: aliTok, rows: [
  { date: '2026-08-07', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, directDepositAmount: 500, directDepositRef: 'SPLIT-3' },
  { date: '2026-08-08', sourceType: 'store', sourceId: store.entity.id, cashSales: 900 }
] });
check(otherDay.results[0].error === 'deposit_exceeds_cash', 'and cash from a different day never counts towards it');

console.log('--- a direct deposit (موازنة) carries its own description ---');
var mawazana = call(slip(aliTok, { action: 'createDailyEntry', token: aliTok, date: '2026-08-12', sourceType: 'store', sourceId: store.entity.id,
  cashSales: 900, directDepositAmount: 400, directDepositRef: 'MZN-55', directDepositNote: 'موازنة مبيعات يوم الخميس' }));
check(mawazana.ok && mawazana.entry.directDepositNote === 'موازنة مبيعات يوم الخميس', 'the description is stored on the entry');
check(mawazana.deposit && mawazana.deposit.note === 'موازنة مبيعات يوم الخميس', 'and travels onto the deposit record itself, next to the bank reference');
var noAmount = call({ action: 'createDailyEntry', token: aliTok, date: '2026-08-12', sourceType: 'store', sourceId: store.entity.id,
  cashSales: 100, directDepositNote: 'stray text' });
check(noAmount.ok && noAmount.entry.directDepositNote === '' && !noAmount.deposit, 'a description with no deposit behind it is dropped, not stored');

console.log('--- whole-response cache: a repeated read costs no sheet reads at all ---');
var svc2 = ctx._debug.svcCalls;
function resetSvc2() { svc2.getProperty = 0; svc2.getProperties = 0; svc2.cacheGet = 0; svc2.sheetRead = 0; }

var firstDash = call({ action: 'getDashboardAll', token: adminTok });
resetSvc2();
var secondDash = call({ action: 'getDashboardAll', token: adminTok });
check(secondDash.ok && svc2.sheetRead === 0, 'the second identical dashboard request reads no sheet at all');
close(secondDash.report.totals.netCashOwed, firstDash.report.totals.netCashOwed, 'and answers with the same figures');
check(secondDash.token && secondDash.token !== firstDash.token, 'while still issuing a fresh session token — the token is never served from cache');

var reportA = call({ action: 'getSalesReport', token: adminTok, sourceType: 'store' });
resetSvc2();
var reportB = call({ action: 'getSalesReport', token: adminTok, sourceType: 'car' });
check(reportB.entries.every(function (e) { return e.sourceType === 'car'; }), 'a different filter is a different request: it answers with car rows, not the cached store ones');
check(reportA.entries.every(function (e) { return e.sourceType === 'store'; }), 'and each filter keeps its own cached copy');

// a write anywhere has to invalidate it, without each action declaring what it reads
var cachedBefore = call({ action: 'getSalesReport', token: adminTok, sourceType: 'store' });
call({ action: 'createDailyEntry', token: aliTok, date: '2026-08-20', sourceType: 'store', sourceId: store.entity.id, cashSales: 777 });
resetSvc2();
var afterWrite = call({ action: 'getSalesReport', token: adminTok, sourceType: 'store' });
check(svc2.sheetRead > 0, 'after any write the next read runs for real again');
close(afterWrite.totals.storeCash, cachedBefore.totals.storeCash + 777, 'and sees the new entry, never a stale total');

var asManager = call({ action: 'getSalesReport', token: aliTok, sourceType: 'store' });
check(asManager.ok && asManager.entries.length <= afterWrite.entries.length, 'the cache is per user — a branch manager never receives the admin\'s cached copy');

console.log('--- credit sales deduct like an expense or a موازنة ---');
var creditDay = call(slip(aliTok, { action: 'createDailyEntry', token: aliTok, date: '2026-08-25', sourceType: 'store', sourceId: store.entity.id,
  cashSales: 5000, creditSales: 1200, creditCustomer: 'Al-Rashid Trading',
  expenseAmount: 300, expenseItemId: expenseId, expenseReason: 'وقود',
  directDepositAmount: 1000, directDepositRef: 'MZN-CR-1', directDepositNote: 'موازنة' }));
check(creditDay.ok, 'a day with cash, credit, an expense and a موازنة saves');
var creditNet = ctx.computeNet_([creditDay.entry]);
// 5,000 takings − 1,200 sold on credit − 300 spent − 1,000 already banked
close(creditNet.netCashOwed, 2500, 'the credit part comes out of the cash owed, alongside the expense and the موازنة');
close(creditNet.creditSales, 1200, 'and stays visible on its own line so the deduction can be explained');

check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-08-26', sourceType: 'store', sourceId: store.entity.id,
  cashSales: 1000, creditSales: 900, creditCustomer: 'Al-Rashid Trading', directDepositAmount: 500, directDepositRef: 'X' }).error === 'deposit_exceeds_cash',
  'and a موازنة can no longer exceed the cash once the credit part is taken out');

console.log('--- an admin write answers with the fresh reference data, saving a round trip ---');
var beforeClusters = call({ action: 'listMeta', token: adminTok }).clusters.length;
var eastMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Eastern Area Manager', email: 'eastmgr.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var eastCollector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Eastern Collector', email: 'eastcol.fx@bestgas.sa', role: 'collector' } }).user;
var newArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Eastern Area', clusterManagerUserId: eastMgr.id, collectorUserId: eastCollector.id } });
check(newArea.ok && newArea.meta && newArea.meta.ok, 'saving an area returns the reference data with it');
check(newArea.meta.clusters.length === beforeClusters + 1, 'and that data already contains the area just created — no second call needed');
check(newArea.meta.clusters.some(function (c) { return c.id === newArea.entity.id; }), 'including its id, so the screen can redraw straight away');

var newUser2 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Meta Rider', email: 'metarider@bestgas.sa', role: 'driver' } });
check(newUser2.ok && newUser2.meta && newUser2.meta.users.some(function (u) { return u.email === 'metarider@bestgas.sa'; }),
  'inviting a user does the same');
var del = call({ action: 'adminDeleteEntity', token: adminTok, kind: 'cluster', id: newArea.entity.id });
check(del.ok && del.meta && !del.meta.clusters.some(function (c) { return c.id === newArea.entity.id; }),
  'and so does deleting one — the response already reflects the deletion');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: '' } }).meta === undefined,
  'a rejected write carries no reference data — there is nothing new to show');

console.log('--- controls: what can change, by whom, and when it locks ---');
// A branch of its own, so nothing earlier in the file is in flight here.
var ctlMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ctl Area Manager', email: 'ctlmgr.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var ctlCol = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ctl Collector', email: 'ctlcol.fx@bestgas.sa', role: 'collector' } }).user;
var ctlBm = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ctl Branch Manager', email: 'ctlbm.fx@bestgas.sa', role: 'store_manager' } }).user;
var ctlDrv = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ctl Driver', email: 'ctldrv.fx@bestgas.sa', role: 'driver' } }).user;
var ctlMgrTok = acceptInvite('ctlmgr.fx@bestgas.sa'), ctlColTok = acceptInvite('ctlcol.fx@bestgas.sa');
var ctlBmTok = acceptInvite('ctlbm.fx@bestgas.sa'), ctlDrvTok = acceptInvite('ctldrv.fx@bestgas.sa');
var ctlArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Ctl Area', clusterManagerUserId: ctlMgr.id, collectorUserId: ctlCol.id } }).entity;
var ctlLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Dammam', name: 'Ctl Branch', clusterId: ctlArea.id } }).entity;
var ctlStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: ctlLoc.id, name: 'Ctl Store', storeManagerUserId: ctlBm.id } }).entity;
var ctlCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: ctlLoc.id, label: 'Ctl Truck', driverUserId: ctlDrv.id } }).entity;
var today = ctx.todayRiyadh_();
var yd = new Date(today + 'T12:00:00Z'); yd.setUTCDate(yd.getUTCDate() - 1); var yesterday = yd.toISOString().slice(0, 10);
var fd = new Date(today + 'T12:00:00Z'); fd.setUTCDate(fd.getUTCDate() + 2); var future = fd.toISOString().slice(0, 10);

// --- dates and figures ---
var fut = call({ action: 'createDailyEntry', token: ctlBmTok, date: future, sourceType: 'store', sourceId: ctlStore.id, cashSales: 100 });
check(!fut.ok && fut.error === 'future_date', 'an entry dated in the future is refused');
var neg = call({ action: 'createDailyEntry', token: ctlBmTok, date: today, sourceType: 'store', sourceId: ctlStore.id, cashSales: -500 });
check(!neg.ok && neg.error === 'invalid_input', 'a negative sale is refused (it would quietly cut what is owed)');
var badDate = call({ action: 'createDailyEntry', token: ctlBmTok, date: '24/09/2026', sourceType: 'store', sourceId: ctlStore.id, cashSales: 100 });
check(!badDate.ok && badDate.error === 'invalid_date', 'a malformed date is refused');

// --- cancelling before handover ---
var y1 = call({ action: 'createDailyEntry', token: ctlBmTok, date: yesterday, sourceType: 'store', sourceId: ctlStore.id, cashSales: 1000, submissionId: 'sub-1' });
check(y1.ok && y1.entry.submissionId === 'sub-1', 'an entry saves, carrying its submission id');
var voidNoReason = call({ action: 'voidEntries', token: ctlBmTok, ids: [y1.entry.id] });
check(!voidNoReason.ok && voidNoReason.error === 'reason_required', 'cancelling needs a reason');
var voidByAdmin = call({ action: 'voidEntries', token: adminTok, ids: [y1.entry.id], reason: 'x' });
check(!voidByAdmin.ok && voidByAdmin.error === 'not_your_entry', 'not even an admin can cancel someone else\'s entry');
var voidByMgr = call({ action: 'voidEntries', token: ctlMgrTok, ids: [y1.entry.id], reason: 'x' });
check(!voidByMgr.ok && voidByMgr.error === 'not_your_entry', 'nor can the area manager');
var voidOwn = call({ action: 'voidEntries', token: ctlBmTok, ids: [y1.entry.id], reason: 'typed 1000 instead of 100' });
check(voidOwn.ok && voidOwn.voided === 1, 'the author cancels their own entry before handing it over');
var voidedRow = ctx.readSheet(SHEETS.ENTRIES).filter(function (e) { return e.id === y1.entry.id; })[0];
check(voidedRow && voidedRow.voided === true && voidedRow.voidReason === 'typed 1000 instead of 100', 'the row stays on file, marked cancelled with its reason — nothing is deleted');
check(call({ action: 'voidEntries', token: ctlBmTok, ids: [y1.entry.id], reason: 'again' }).error === 'already_voided', 'a cancelled entry cannot be cancelled twice');
var noEntriesAfterVoid = call({ action: 'createHandoff', token: ctlBmTok, kind: 'location_to_cluster', locationId: ctlLoc.id });
check(!noEntriesAfterVoid.ok, 'a cancelled entry is not handed over');

// --- the lock: once handed over, nobody changes it ---
var y2 = call({ action: 'createDailyEntry', token: ctlBmTok, date: yesterday, sourceType: 'store', sourceId: ctlStore.id, cashSales: 100 });
var hand = call({ action: 'createHandoff', token: ctlBmTok, kind: 'location_to_cluster', locationId: ctlLoc.id });
check(hand.ok && hand.handoff.amount === 100, 'the corrected entry is handed over');
var voidLocked = call({ action: 'voidEntries', token: ctlBmTok, ids: [y2.entry.id], reason: 'changed my mind' });
check(!voidLocked.ok && voidLocked.error === 'entry_locked', 'once handed over, even its author cannot cancel it');
function ctlState(id, tok) { return call({ action: 'listEntries', token: tok || ctlBmTok }).entries.filter(function (e) { return e.id === id; })[0]; }
check(ctlState(y1.entry.id).lockState === 'voided' && ctlState(y1.entry.id).canVoid === false, 'the list shows the cancelled entry as cancelled');
check(ctlState(y2.entry.id).lockState === 'submitted' && ctlState(y2.entry.id).canVoid === false, 'and the handed-over one as waiting for approval, locked');
var backdate = call({ action: 'createDailyEntry', token: ctlBmTok, date: yesterday, sourceType: 'store', sourceId: ctlStore.id, cashSales: 0,
  expenseAmount: 60, expenseItemId: expenseId, expenseReason: 'late fuel' });
check(!backdate.ok && backdate.error === 'day_closed', 'nothing can be added to a day already handed over (an expense there would cut accepted cash)');
var sameDay = call({ action: 'createDailyEntry', token: ctlBmTok, date: today, sourceType: 'store', sourceId: ctlStore.id, cashSales: 40 });
check(sameDay.ok, 'today stays open for a second handover');

// --- receipt: the receiver only ---
var onBehalf = call({ action: 'confirmHandoff', token: adminTok, id: hand.handoff.id });
check(!onBehalf.ok && onBehalf.error === 'receiver_only', 'an admin cannot confirm a receipt on the receiver\'s behalf');
var byOther = call({ action: 'confirmHandoff', token: ctlColTok, id: hand.handoff.id });
check(!byOther.ok && byOther.error === 'receiver_only', 'nor can anyone else in the chain');
var flagOnBehalf = call({ action: 'disputeHandoff', token: adminTok, id: hand.handoff.id, note: 'area manager on leave' });
check(flagOnBehalf.ok && flagOnBehalf.handoff.status === 'disputed', 'an admin can still flag (dispute) it for someone absent — that moves no money');
// the dispute is settled by someone else, who can record a shortage
var settle = call({ action: 'resolveDispute', token: financeTok, id: hand.handoff.id, resolution: 'confirm', receivedAmount: 80, note: 'counted 80' });
check(settle.ok && settle.handoff.confirmedBy === finance.id && settle.handoff.confirmedViaDispute === true,
  'a dispute settled as confirmed names the person who settled it, not the receiver');
check(settle.handoff.amount === 80 && settle.handoff.shortfall === 20, 'and records the amount actually received, with the shortfall');
check(ctlState(y2.entry.id).lockState === 'approved', 'once the next level has confirmed, the list shows it approved');
var adminSettlesOwn = call({ action: 'disputeHandoff', token: adminTok, id: sameDay.entry.id });
check(!adminSettlesOwn.ok, 'a dispute needs a real handoff');

// an admin starting a handoff names the real holder as the giver
var todayCar = call({ action: 'createDailyEntry', token: ctlDrvTok, date: today, sourceType: 'car', sourceId: ctlCar.id, cashSales: 300 });
var carHand = call({ action: 'createHandoff', token: adminTok, kind: 'car_to_location', carId: ctlCar.id });
check(carHand.ok && carHand.handoff.fromUserId === ctlDrv.id && carHand.handoff.createdBy === admin.id,
  'a handoff an admin starts names the driver who holds the cash, and records the admin as who pressed the button');

// --- nobody moves while cash is in flight ---
var otherBm = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ctl Branch Manager 2', email: 'ctlbm2.fx@bestgas.sa', role: 'store_manager' } }).user;
var swapBm = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', id: ctlStore.id, data: { storeManagerUserId: otherBm.id } });
check(!swapBm.ok && swapBm.error === 'person_holds_cash', 'the branch manager cannot be replaced while holding cash or an open handover');
var otherDrv = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ctl Driver 2', email: 'ctldrv2.fx@bestgas.sa', role: 'driver' } }).user;
var swapDrv = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', id: ctlCar.id, data: { driverUserId: otherDrv.id } });
check(!swapDrv.ok && swapDrv.error === 'person_holds_cash', 'nor the driver while their handover is open');
var moveBranch = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', id: ctlLoc.id, data: { clusterId: cluster.entity.id } });
check(!moveBranch.ok && moveBranch.error === 'cash_in_flight', 'a branch cannot move to another area while its cash is in flight');
var renameOk = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', id: ctlStore.id, data: { name: 'Ctl Store (renamed)' } });
check(renameOk.ok, 'a harmless change (a name) still saves while cash is in flight');
var disableHolder = call({ action: 'adminUpdateUser', token: adminTok, id: ctlDrv.id, data: { active: false } });
check(!disableHolder.ok && disableHolder.error === 'person_holds_cash', 'a person holding cash cannot be disabled');
var roleAssigned = call({ action: 'adminUpdateUser', token: adminTok, id: otherBm.id, data: { role: 'driver' } });
check(roleAssigned.ok, 'an unassigned person with nothing in flight can change role');
var roleOfAssigned = call({ action: 'adminUpdateUser', token: adminTok, id: ctlMgr.id, data: { role: 'collector' } });
check(!roleOfAssigned.ok && (roleOfAssigned.error === 'user_has_assignments' || roleOfAssigned.error === 'person_holds_cash'),
  'someone named on a link cannot be given another role until the link is reassigned');

// --- admins cannot lock the company out ---
check(call({ action: 'adminUpdateUser', token: adminTok, id: admin.id, data: { active: false } }).error === 'cannot_change_self', 'an admin cannot disable themselves');
check(call({ action: 'adminUpdateUser', token: adminTok, id: admin.id, data: { role: 'finance' } }).error === 'cannot_change_self', 'nor demote themselves');

// --- settings ---
check(call({ action: 'adminSetConfig', token: adminTok, data: { vatRate: 15 } }).error === 'invalid_input', 'a VAT rate of 15 (meant 0.15) is refused');
check(call({ action: 'adminSetConfig', token: adminTok, data: { secondApprovalThreshold: -1 } }).error === 'invalid_input', 'a negative threshold is refused');
call({ action: 'adminSetConfig', token: adminTok, data: { staleThresholdHours: 30 } });
check(ctx.readSheet(SHEETS.AUDIT).some(function (a) { return a.action === 'admin_set_config' && /staleThresholdHours: \S+ → 30/.test(a.detail || ''); }),
  'a settings change is audited with what changed, from what to what');

console.log('--- the deputy checks the area manager -> collector handover ---');
// a fresh area so the amounts are known
var dpMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Dp Area Manager', email: 'dpmgr.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var dpCol = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Dp Collector', email: 'dpcol.fx@bestgas.sa', role: 'collector' } }).user;
var dpBm = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Dp Branch Manager', email: 'dpbm.fx@bestgas.sa', role: 'store_manager' } }).user;
var dpMgrTok = acceptInvite('dpmgr.fx@bestgas.sa'), dpColTok = acceptInvite('dpcol.fx@bestgas.sa'), dpBmTok = acceptInvite('dpbm.fx@bestgas.sa');
var dpArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Dp Area', clusterManagerUserId: dpMgr.id, collectorUserId: dpCol.id } }).entity;
var dpLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Khobar', name: 'Dp Branch', clusterId: dpArea.id } }).entity;
var dpStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: dpLoc.id, name: 'Dp Store', storeManagerUserId: dpBm.id } }).entity;
call({ action: 'createDailyEntry', token: dpBmTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: dpStore.id, cashSales: 2500 });
var dpL = call({ action: 'createHandoff', token: dpBmTok, kind: 'location_to_cluster', locationId: dpLoc.id });
call({ action: 'confirmHandoff', token: dpMgrTok, id: dpL.handoff.id });
var dpC = call({ action: 'createHandoff', token: dpMgrTok, kind: 'cluster_to_collector', clusterId: dpArea.id });
check(dpC.ok && dpC.handoff.status === 'pending_deputy' && dpC.handoff.amount === 2500, 'the area manager\'s request opens waiting for the deputy');
check(call({ action: 'confirmHandoff', token: dpColTok, id: dpC.handoff.id }).error === 'not_pending', 'the collector cannot confirm it before the deputy validates');
check(call({ action: 'listDashboard', token: walidTok }).pendingForMe.some(function (h) { return h.id === dpC.handoff.id; }), 'it is on the deputy\'s list of things to act on');
check(call({ action: 'deputyValidateHandoff', token: dpMgrTok, id: dpC.handoff.id }).error === 'forbidden', 'the area manager cannot validate their own request');
check(call({ action: 'deputyValidateHandoff', token: financeTok, id: dpC.handoff.id }).error === 'forbidden', 'nor can Finance — this is the deputy\'s authority');
check(call({ action: 'deputyReturnHandoff', token: walidTok, id: dpC.handoff.id }).error === 'reason_required', 'sending it back needs a reason');
var dpRet = call({ action: 'deputyReturnHandoff', token: walidTok, id: dpC.handoff.id, reason: 'Branch Dp deposit slip missing' });
check(dpRet.ok && dpRet.handoff.status === 'returned' && dpRet.handoff.returnReason === 'Branch Dp deposit slip missing', 'the deputy sends it back to the area manager with the reason');
check(ctx._debug.mailLog.some(function (m) { return m.to === 'dpmgr.fx@bestgas.sa' && /deposit slip missing/.test(m.body); }), 'and the area manager is told why by email');
check(call({ action: 'deputyValidateHandoff', token: walidTok, id: dpC.handoff.id }).error === 'not_pending', 'a returned request cannot be validated afterwards');
var dpC2 = call({ action: 'createHandoff', token: dpMgrTok, kind: 'cluster_to_collector', clusterId: dpArea.id });
check(dpC2.ok && dpC2.handoff.amount === 2500, 'the branch cash went back to the area manager, who sends a corrected request');
var dpV = call({ action: 'deputyValidateHandoff', token: walidTok, id: dpC2.handoff.id, note: 'slip attached' });
check(dpV.ok && dpV.handoff.status === 'pending' && dpV.handoff.deputyValidatedBy === walid.id, 'the deputy validates the corrected request');
var dpConf = call({ action: 'confirmHandoff', token: dpColTok, id: dpC2.handoff.id });
check(dpConf.ok && dpConf.handoff.status === 'confirmed', 'and the collector can now confirm receiving it');
check(ctx.readSheet(SHEETS.AUDIT).some(function (a) { return a.action === 'deputy_return_handoff' && a.detail === dpC.handoff.id; }) &&
  ctx.readSheet(SHEETS.AUDIT).some(function (a) { return a.action === 'deputy_validate_handoff' && a.detail === dpC2.handoff.id; }),
  'both decisions are in the audit trail');

console.log('--- the deputy sees everything, acts only in their own step ---');
var dEntries = call({ action: 'listEntries', token: walidTok });
check(dEntries.ok && dEntries.entries.length === call({ action: 'listEntries', token: adminTok }).entries.length, 'the deputy sees every branch\'s entries');
check(call({ action: 'listHandoffs', token: walidTok }).handoffs.length === call({ action: 'listHandoffs', token: adminTok }).handoffs.length, 'and every handover');
check(call({ action: 'getSalesReport', token: walidTok }).ok && call({ action: 'getDashboardAll', token: walidTok }).ok, 'and every report and dashboard');
check(call({ action: 'getReconciliation', token: walidTok }).ok, 'and the bank reconciliation');
check(call({ action: 'importBankStatement', token: walidTok, rows: [{ date: '2026-08-01', amount: 1, reference: 'x' }] }).error === 'forbidden', 'but cannot import bank statements');
check(call({ action: 'adminSetConfig', token: walidTok, data: { vatRate: 0.2 } }).error === 'forbidden', 'nor touch the settings');
check(call({ action: 'adminSaveEntity', token: walidTok, kind: 'zone', data: { city: 'X', name: 'Y' } }).error === 'forbidden', 'nor the master data');
check(call({ action: 'createDailyEntry', token: walidTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: store.entity.id, cashSales: 1 }).error === 'forbidden', 'nor enter figures');

console.log('--- a day the area manager enters himself travels in his own request ---');
var amMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Am Area Manager', email: 'ammgr.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var amCol = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Am Collector', email: 'amcol.fx@bestgas.sa', role: 'collector' } }).user;
var amBm = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Am Branch Manager', email: 'ambm.fx@bestgas.sa', role: 'store_manager' } }).user;
var amMgrTok = acceptInvite('ammgr.fx@bestgas.sa'), amColTok = acceptInvite('amcol.fx@bestgas.sa'), amBmTok = acceptInvite('ambm.fx@bestgas.sa');
var amArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Am Area', clusterManagerUserId: amMgr.id, collectorUserId: amCol.id } }).entity;
var amLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Taif', name: 'Am Branch', clusterId: amArea.id } }).entity;
var amStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: amLoc.id, name: 'Am Store', storeManagerUserId: amBm.id } }).entity;
var amEntry = call({ action: 'createDailyEntry', token: amMgrTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: amStore.id, cashSales: 1800 });
check(amEntry.ok, 'the area manager enters a branch day himself');
var bmTries = call({ action: 'createHandoff', token: amBmTok, kind: 'location_to_cluster', locationId: amLoc.id });
check(!bmTries.ok && bmTries.error === 'no_entries', 'the branch manager cannot hand over cash the area manager collected and entered');
var amReq = call({ action: 'createHandoff', token: amMgrTok, kind: 'cluster_to_collector', clusterId: amArea.id });
check(amReq.ok && amReq.handoff.amount === 1800 && amReq.handoff.status === 'pending_deputy' && amReq.handoff.sourceEntryIds.indexOf(amEntry.entry.id) >= 0,
  'it goes into the area manager\'s own request, which waits for the deputy');
check(call({ action: 'listEntries', token: amMgrTok }).entries.filter(function (e) { return e.id === amEntry.entry.id; })[0].lockState === 'submitted',
  'and the entry is locked from that moment');
var amRet = call({ action: 'deputyReturnHandoff', token: walidTok, id: amReq.handoff.id, reason: 'check the branch figure' });
check(amRet.ok && call({ action: 'listEntries', token: amMgrTok }).entries.filter(function (e) { return e.id === amEntry.entry.id; })[0].lockState === 'open',
  'sent back by the deputy, the entry is open again for the area manager to correct');
var amReq2 = call({ action: 'createHandoff', token: amMgrTok, kind: 'cluster_to_collector', clusterId: amArea.id });
call({ action: 'deputyValidateHandoff', token: walidTok, id: amReq2.handoff.id });
var amConf = call({ action: 'confirmHandoff', token: amColTok, id: amReq2.handoff.id });
check(amConf.ok && amConf.handoff.amount === 1800, 'validated by the deputy, the collector confirms it');
check(call({ action: 'listEntries', token: amMgrTok }).entries.filter(function (e) { return e.id === amEntry.entry.id; })[0].lockState === 'approved',
  'and the area manager\'s entry is approved and locked for good');

console.log('--- an open day with a الموازنة can be cancelled, and the الموازنة goes with it ---');
function depOf(entryId) {
  return ctx.readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.kind === 'deposit' && h.direct && (h.sourceEntryIds || []).indexOf(entryId) >= 0; })[0];
}
function listed(id) { return call({ action: 'listEntries', token: ctlBmTok }).entries.filter(function (e) { return e.id === id; })[0]; }
var dDay = call(slip(ctlBmTok, { action: 'createDailyEntry', token: ctlBmTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: ctlStore.id,
  cashSales: 900, directDepositAmount: 400, directDepositRef: 'DD-VOID-1', directDepositNote: 'typed in error' }));
check(dDay.ok && depOf(dDay.entry.id) && depOf(dDay.entry.id).status === 'completed', 'a day with a الموازنة records its bank deposit');
check(listed(dDay.entry.id).canVoid === true, 'while open, its author is offered the cancel');
var dVoid = call({ action: 'voidEntries', token: ctlBmTok, ids: [dDay.entry.id], reason: 'wrong branch' });
check(dVoid.ok, 'the author cancels it');
check(depOf(dDay.entry.id).status === 'voided' && depOf(dDay.entry.id).voidReason === 'wrong branch', 'and its الموازنة is cancelled with it, with the same reason, kept on file');
check(!call({ action: 'getReconciliation', token: financeTok }).unmatchedDeposits.some(function (d) { return d.id === depOf(dDay.entry.id).id; }),
  'a cancelled الموازنة no longer waits for a bank match');

var mDay = call(slip(ctlBmTok, { action: 'createDailyEntry', token: ctlBmTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: ctlStore.id,
  cashSales: 800, directDepositAmount: 333, directDepositRef: 'DD-MATCH-333' }));
var mDep = depOf(mDay.entry.id);
var mImport = call({ action: 'importBankStatement', token: financeTok, rows: [{ date: ctx.todayRiyadh_(), amount: 333, reference: 'DD-MATCH-333' }] });
if (!depOf(mDay.entry.id).reconciled) {
  var line = call({ action: 'getReconciliation', token: financeTok }).unmatchedLines.filter(function (l) { return l.reference === 'DD-MATCH-333'; })[0];
  call({ action: 'manualMatchReconciliation', token: financeTok, lineId: line.id, handoffId: mDep.id });
}
check(depOf(mDay.entry.id).reconciled === true, 'Finance matches a second الموازنة to the bank statement');
check(listed(mDay.entry.id).canVoid === false && listed(mDay.entry.id).voidBlock === 'deposit_reconciled', 'that day is no longer offered the cancel, and says why');
var mVoid = call({ action: 'voidEntries', token: ctlBmTok, ids: [mDay.entry.id], reason: 'x' });
check(!mVoid.ok && mVoid.error === 'deposit_reconciled', 'the bank has confirmed it, so it cannot be cancelled');

console.log('--- taking a legacy two-area manager off the area that has nothing in flight ---');
// Rows saved before the one-person-one-area rule: one manager on two areas.
var twMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Tw Two-Area Manager', email: 'twmgr.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var twColN = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Tw North Collector', email: 'twcoln.fx@bestgas.sa', role: 'collector' } }).user;
var twColS = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Tw South Collector', email: 'twcols.fx@bestgas.sa', role: 'collector' } }).user;
var twNew = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Tw New South Manager', email: 'twnew.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var twMgrTok = acceptInvite('twmgr.fx@bestgas.sa');
var twNorth = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Tw North', clusterManagerUserId: twMgr.id, collectorUserId: twColN.id } }).entity;
var twSouth = ctx.writeRow(SHEETS.CLUSTERS, { id: 'tw-south-legacy', name: 'Tw South', clusterManagerUserId: twMgr.id, collectorUserId: twColS.id, active: true });
ctx.bumpVersion_(SHEETS.CLUSTERS);
var twLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Tw North Branch', clusterId: twNorth.id } }).entity;
var twBm = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Tw Branch Manager', email: 'twbm.fx@bestgas.sa', role: 'store_manager' } }).user;
var twStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: twLoc.id, name: 'Tw North Store', storeManagerUserId: twBm.id } }).entity;
// he has an open day in the NORTH area
check(call({ action: 'createDailyEntry', token: twMgrTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: twStore.id, cashSales: 700 }).ok,
  'the two-area manager has an open day in his northern area');
var offSouth = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', id: 'tw-south-legacy', data: { clusterManagerUserId: twNew.id } });
check(offSouth.ok && offSouth.entity.clusterManagerUserId === twNew.id,
  'he can be taken off the southern area, where nothing of his is in flight');
var twNew2 = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Tw New North Manager', email: 'twnew2.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var offNorth = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', id: twNorth.id, data: { clusterManagerUserId: twNew2.id } });
check(!offNorth.ok && offNorth.error === 'person_holds_cash', 'but not off the northern area while his open day there is in flight');

console.log('--- POS sales in the entry screen are off until the admin switches them on ---');
check(call({ action: 'listMeta', token: aliTok }).config.posSalesEnabled === false, 'by default the entry screen offers cash sales only');
var posOn = call({ action: 'adminSetConfig', token: adminTok, data: { posSalesEnabled: true } });
check(posOn.ok && call({ action: 'listMeta', token: aliTok }).config.posSalesEnabled === true, 'the admin can switch POS sales back on');
check(ctx.readSheet(SHEETS.AUDIT).some(function (a) { return a.action === 'admin_set_config' && /posSalesEnabled/.test(a.detail || ''); }), 'and the switch is audited');
call({ action: 'adminSetConfig', token: adminTok, data: { posSalesEnabled: false } });
check(call({ action: 'listMeta', token: aliTok }).config.posSalesEnabled === false, 'and off again');

console.log('--- collectors belong to branches: one area, two collectors ---');
function mk(name, email, role) { return call({ action: 'adminCreateUser', token: adminTok, data: { name: name, email: email, role: role } }).user; }
var bcMgr = mk('Bc Area Manager', 'bcmgr.fx@bestgas.sa', 'cluster_manager');
var bcColA = mk('Bc Collector A', 'bccola.fx@bestgas.sa', 'collector');
var bcColB = mk('Bc Collector B', 'bccolb.fx@bestgas.sa', 'collector');
var bcBmA = mk('Bc Branch Manager A', 'bcbma.fx@bestgas.sa', 'store_manager');
var bcBmB = mk('Bc Branch Manager B', 'bcbmb.fx@bestgas.sa', 'store_manager');
var bcMgrTok = acceptInvite('bcmgr.fx@bestgas.sa'), bcColATok = acceptInvite('bccola.fx@bestgas.sa'), bcColBTok = acceptInvite('bccolb.fx@bestgas.sa');
var bcBmATok = acceptInvite('bcbma.fx@bestgas.sa'), bcBmBTok = acceptInvite('bcbmb.fx@bestgas.sa');
var bcAreaRes = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Bc Area', clusterManagerUserId: bcMgr.id } });
check(bcAreaRes.ok, 'an area needs only its manager now — collectors belong to branches');
var bcArea = bcAreaRes.entity;
var bcNoCol = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Bc No Collector', clusterId: bcArea.id } });
check(!bcNoCol.ok && bcNoCol.error === 'collector_required', 'a branch cannot be saved without the collector its cash goes to');
var bcLocA = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Bc Branch A', clusterId: bcArea.id, collectorUserId: bcColA.id } }).entity;
var bcLocB = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Bc Branch B', clusterId: bcArea.id, collectorUserId: bcColB.id } }).entity;
check(bcLocA && bcLocB && bcLocA.collectorUserId === bcColA.id && bcLocB.collectorUserId === bcColB.id, 'two branches of one area, each with its own collector');
check(ctx.branchCollector_(bcLocA.id) === bcColA.id, 'a branch resolves to its own collector');
check(ctx.branchCollector_(location.entity.id) === musa.id, 'a branch saved before this change still resolves to its area\'s collector');
var bcWrongRole = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Bc Wrong', clusterId: bcArea.id, collectorUserId: bcBmA.id } });
check(!bcWrongRole.ok && bcWrongRole.error === 'wrong_role', 'the collector has to hold the collector role');
// a collector may serve branches in any number of areas (2026-09-29)
var bcCrossArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Bc Elsewhere', clusterId: cluster2.id, collectorUserId: bcColA.id } });
check(bcCrossArea.ok, 'a collector can serve a branch in another area too');
check(ctx.branchCollector_(bcCrossArea.entity.id) === bcColA.id && ctx.branchCollector_(bcLocA.id) === bcColA.id, 'and collects for both areas\' branches');
var bcAreaMgrAsCol = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Bc Mgr Col', clusterId: cluster2.id, collectorUserId: sara.id } });
check(!bcAreaMgrAsCol.ok, 'an area manager still cannot be a branch\'s collector');
var bcStoreA = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: bcLocA.id, name: 'Bc Store A', storeManagerUserId: bcBmA.id } }).entity;
var bcStoreB = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: bcLocB.id, name: 'Bc Store B', storeManagerUserId: bcBmB.id } }).entity;
check(bcStoreA && bcStoreB, 'each branch has its store and manager');

// both branches hand their day to the area manager
var bcToday = ctx.todayRiyadh_();
call({ action: 'createDailyEntry', token: bcBmATok, date: bcToday, sourceType: 'store', sourceId: bcStoreA.id, cashSales: 1000 });
call({ action: 'createDailyEntry', token: bcBmBTok, date: bcToday, sourceType: 'store', sourceId: bcStoreB.id, cashSales: 2000 });
var bcHA = call({ action: 'createHandoff', token: bcBmATok, kind: 'location_to_cluster', locationId: bcLocA.id });
var bcHB = call({ action: 'createHandoff', token: bcBmBTok, kind: 'location_to_cluster', locationId: bcLocB.id });
call({ action: 'confirmHandoff', token: bcMgrTok, id: bcHA.handoff.id });
call({ action: 'confirmHandoff', token: bcMgrTok, id: bcHB.handoff.id });
// branch A alone
var bcReqA = call({ action: 'createHandoff', token: bcMgrTok, kind: 'cluster_to_collector', clusterId: bcArea.id, locationId: bcLocA.id });
check(bcReqA.ok && bcReqA.handoffs && bcReqA.handoffs.length === 1, 'the area manager sends branch A on its own');
var rA = bcReqA.handoff;
check(rA.locationId === bcLocA.id && rA.toUserId === bcColA.id && rA.amount === 1000 && rA.status === 'pending_deputy',
  'the request carries branch A\'s cash only, addressed to branch A\'s collector, waiting for the deputy');
// the rest
var bcReqRest = call({ action: 'createHandoff', token: bcMgrTok, kind: 'cluster_to_collector', clusterId: bcArea.id });
check(bcReqRest.ok && bcReqRest.handoffs.length === 1 && bcReqRest.handoff.locationId === bcLocB.id && bcReqRest.handoff.toUserId === bcColB.id && bcReqRest.handoff.amount === 2000,
  'sending the rest creates branch B\'s request, to branch B\'s collector — branch A is not swept in again');
var rB = bcReqRest.handoff;
check(call({ action: 'createHandoff', token: bcMgrTok, kind: 'cluster_to_collector', clusterId: bcArea.id }).error === 'no_held_cash', 'nothing is left to send');
check(call({ action: 'deputyValidateHandoff', token: walidTok, id: rA.id }).ok && call({ action: 'deputyValidateHandoff', token: walidTok, id: rB.id }).ok, 'the deputy validates each branch\'s request');
var bcSwap = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', id: bcLocA.id, data: Object.assign({}, bcLocA, { collectorUserId: bcColB.id }) });
check(!bcSwap.ok && bcSwap.error === 'person_holds_cash', 'branch A\'s collector cannot be swapped while its request is on the way to them');
check(call({ action: 'createHandoff', token: bcMgrTok, kind: 'cluster_to_collector', clusterId: bcArea.id, locationId: location2.entity ? location2.entity.id : location2.id }).error === 'not_found', 'a branch of another area cannot be sent from this one');
check(call({ action: 'confirmHandoff', token: bcColBTok, id: rA.id }).error === 'receiver_only', 'collector B cannot confirm branch A\'s cash');
check(call({ action: 'confirmHandoff', token: bcColATok, id: rA.id }).ok && call({ action: 'confirmHandoff', token: bcColBTok, id: rB.id }).ok, 'each collector confirms their own branch');
var depA = call({ action: 'recordDeposit', token: bcColATok, bankReference: 'BC-A-1' });
check(depA.ok && depA.handoff.amount === 1000, 'and banks only what they received');

// a CSV batch spanning both branches splits the same way on the deputy's approval
var bcBatch = call({ action: 'bulkSubmitAreaBatch', token: bcMgrTok, clusterId: bcArea.id, rows: [
  { date: '2026-09-21', sourceType: 'store', sourceId: bcStoreA.id, cashSales: 700 },
  { date: '2026-09-21', sourceType: 'store', sourceId: bcStoreB.id, cashSales: 400 }
] });
check(bcBatch.ok, 'the area manager uploads a day covering both branches');
var bcApprove = call({ action: 'deputyApproveBatch', token: walidTok, id: bcBatch.batch.id });
var bcBh = (bcApprove.handoffs || []);
var bcBhA = bcBh.filter(function (h) { return h.locationId === bcLocA.id; })[0];
var bcBhB = bcBh.filter(function (h) { return h.locationId === bcLocB.id; })[0];
check(bcApprove.ok && bcBh.length === 2 && bcBhA && bcBhB, 'the deputy\'s approval makes one handover per branch');
check(bcBhA && bcBhA.toUserId === bcColA.id && bcBhA.amount === 700 && bcBhA.status === 'pending'
  && bcBhB && bcBhB.toUserId === bcColB.id && bcBhB.amount === 400,
  'each to its own branch\'s collector, with that branch\'s cash only');
var bcBatchRow = ctx.getById_(ctx.SHEETS.AREA_BULK_BATCHES, bcBatch.batch.id);
check(bcBatchRow.resultHandoffIds && bcBatchRow.resultHandoffIds.length === 2, 'the batch records every handover it produced');
check(bcBhA && bcBhA.sourceEntryIds.every(function (id) { return ctx.getById_(ctx.SHEETS.ENTRIES, id).locationId === bcLocA.id && ctx.getById_(ctx.SHEETS.ENTRIES, id).consumedBy === bcBhA.id; }),
  'branch A\'s entries belong to branch A\'s handover');
check(call({ action: 'confirmHandoff', token: bcColATok, id: bcBhB.id }).error === 'receiver_only', 'collector A cannot confirm branch B\'s batch cash');

// a branch that banked its whole day itself has nothing to hand over
var bcBatch2 = call({ action: 'bulkSubmitAreaBatch', token: bcMgrTok, clusterId: bcArea.id, rows: [
  { date: '2026-09-22', sourceType: 'store', sourceId: bcStoreA.id, cashSales: 300 },
  { date: '2026-09-22', sourceType: 'store', sourceId: bcStoreB.id, cashSales: 250, directDepositAmount: 250, directDepositRef: 'BC-B-DD' }
] });
var bcApprove2 = call({ action: 'deputyApproveBatch', token: walidTok, id: bcBatch2.batch.id });
check(bcApprove2.ok && bcApprove2.handoffs.length === 1 && bcApprove2.handoffs[0].locationId === bcLocA.id && bcApprove2.handoffs[0].amount === 300,
  'a branch that banked its whole day directly sends no handover — only branch A goes to its collector');
var bcB2Entry = call({ action: 'listEntries', token: bcMgrTok }).entries.filter(function (e) { return e.locationId === bcLocB.id && e.date === '2026-09-22'; })[0];
check(bcB2Entry && bcB2Entry.lockState === 'approved' && !bcB2Entry.canVoid, 'and its day shows approved and locked, not stuck waiting');

// escalations reach the branch's own collector, not the other branch's
var bcMailFrom = ctx._debug.mailLog.length;
ctx.escalateStaleHandoff_(ctx.getById_(ctx.SHEETS.HANDOFFS, bcHA.handoff.id), 50);
var bcMails = ctx._debug.mailLog.slice(bcMailFrom).map(function (m) { return String(m.to); }).join(',');
check(bcMails.indexOf('bccola.fx@bestgas.sa') >= 0 && bcMails.indexOf('bccolb.fx@bestgas.sa') < 0, 'a stale branch-A handover alerts branch A\'s collector only');
bcMailFrom = ctx._debug.mailLog.length;
ctx.escalateShortfall_(ctx.getById_(ctx.SHEETS.HANDOFFS, bcHB.handoff.id));
bcMails = ctx._debug.mailLog.slice(bcMailFrom).map(function (m) { return String(m.to); }).join(',');
check(bcMails.indexOf('bccolb.fx@bestgas.sa') >= 0 && bcMails.indexOf('bccola.fx@bestgas.sa') < 0, 'a branch-B shortfall alerts branch B\'s collector only');


console.log('--- starting a fresh test round archives movement, and keeps the org ---');
check(call({ action: 'adminArchiveTransactions', token: adminTok }).error === 'confirm_required',
  'archiving needs the confirmation word, so it can never be one stray tap');
check(call({ action: 'adminArchiveTransactions', token: aliTok, confirm: 'ARCHIVE' }).error === 'forbidden',
  'and only an admin may do it');

var beforeEntries = call({ action: 'listEntries', token: adminTok }).entries.length;
var beforeUsers = call({ action: 'listMeta', token: adminTok }).users.length;
var beforeProducts = call({ action: 'listMeta', token: adminTok }).products.length;
check(beforeEntries > 0 && beforeUsers > 0, 'there is movement and an org to begin with');

var arch = call({ action: 'adminArchiveTransactions', token: adminTok, confirm: 'ARCHIVE' });
check(arch.ok && arch.archived.length > 0, 'the archive runs and reports what it moved');
check(arch.archived.every(function (a) { return a.archivedAs.indexOf(a.sheet + '_archive_') === 0 && a.rows > 0; }),
  'each moved tab keeps its name plus a dated suffix, and its row count is reported');

check(call({ action: 'listEntries', token: adminTok }).entries.length === 0, 'the entries are gone from the system');
check(call({ action: 'listHandoffs', token: adminTok }).handoffs.length === 0, 'so are the handoffs and deposits');
var metaAfter = call({ action: 'listMeta', token: adminTok });
check(metaAfter.users.length === beforeUsers, 'every user is still there');
check(metaAfter.products.length === beforeProducts, 'so is the product master data');
check(metaAfter.locations.length > 0 && metaAfter.clusters.length > 0, 'and the branches and areas the org is built from');

// the rows are not destroyed: they are sitting in the workbook under the new name
var movedSheet = arch.archived[0].archivedAs;
check(ctx.readSheet(movedSheet).length === arch.archived[0].rows, 'the archived rows are still readable under the new tab name — nothing was deleted');
check(ctx.readSheet(SHEETS.AUDIT).some(function (a) { return a.action === 'admin_archive_transactions'; }),
  'and the fresh audit trail opens with the archive itself');

// A second round started within the same minute: the audit tab always holds
// the first archive's own line, so its dated name was about to be reused.
call({ action: 'createDailyEntry', token: aliTok, date: '2026-08-28', sourceType: 'store', sourceId: store.entity.id, cashSales: 10 });
var arch2 = call({ action: 'adminArchiveTransactions', token: adminTok, confirm: 'ARCHIVE' });
check(arch2.ok && arch2.archived.length >= 2, 'a second fresh start straight after the first still works');
var names2 = arch2.archived.map(function (a) { return a.archivedAs; });
check(names2.every(function (n) { return arch.archived.map(function (a) { return a.archivedAs; }).indexOf(n) < 0; }),
  'and never reuses (or overwrites) the first round\'s archive tab names');
check(ctx.readSheet(movedSheet).length === arch.archived[0].rows, 'the first round\'s archive is untouched by the second');
check(call({ action: 'listEntries', token: adminTok }).entries.length === 0, 'and the system is empty again');

console.log('--- every link in the chain must name its person ---');
function saveErr(kind, data, id) { return call({ action: 'adminSaveEntity', token: adminTok, kind: kind, id: id, data: data }).error; }
check(saveErr('store', { locationId: location.entity.id, name: 'Nobody Branch' }) === 'manager_required',
  'a branch cannot be saved without its branch manager');
check(saveErr('store', { locationId: location.entity.id, name: 'Driver-run Branch', storeManagerUserId: hassan.id }) === 'wrong_role',
  'and the manager has to actually be a branch manager, not a driver');
check(saveErr('car', { locationId: location.entity.id, label: 'Truck-X' }) === 'driver_required',
  'a car cannot be saved without its driver');
check(saveErr('car', { locationId: location.entity.id, label: 'Truck-Y', driverUserId: ali.id }) === 'wrong_role',
  'and the driver has to be a driver');
check(saveErr('pos', { ownerType: 'car', ownerId: car.entity.id, label: 'POS-X' }) === 'holder_required',
  'a POS machine cannot be saved without the person who carries it');
check(saveErr('cluster', { name: 'Headless Area' }) === 'manager_required',
  'an area cannot be saved without its area manager');
check(saveErr('cluster', { name: 'No-bank Area', clusterManagerUserId: otherManager.id }) !== 'collector_required',
  'an area is no longer refused for having no collector — collectors belong to its branches');
var standIn = call({ action: 'listMeta', token: adminTok }).users.filter(function (u) { return u.role === 'admin'; })[0];
var standInStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: location.entity.id, name: 'Admin-held Branch', storeManagerUserId: standIn.id } });
check(standInStore.ok, 'an admin may stand in on a link while the real person is being hired');
check(saveErr('store', { locationId: location.entity.id, name: 'Admin-held Branch', storeManagerUserId: '' }, standInStore.entity.id) === 'manager_required',
  'and editing an existing branch cannot blank its manager either');

console.log('--- credit and delivery are deductions with their own lines, not payment methods ---');
var noCustomer = call({ action: 'createDailyEntry', token: aliTok, date: '2021-03-01', sourceType: 'store', sourceId: store.entity.id, cashSales: 1000, creditSales: 200 });
check(!noCustomer.ok && noCustomer.error === 'customer_required', 'a credit sale without the customer who owes it is refused');
var creditRow = call({ action: 'createDailyEntry', token: aliTok, date: '2021-03-01', sourceType: 'store', sourceId: store.entity.id,
  cashSales: 1000, creditSales: 200, creditCustomer: 'Nakheel Restaurant', deliveryFeeBankAmount: 46, deliveryNote: 'Two deliveries, Al-Narjis' });
check(creditRow.ok && creditRow.entry.creditCustomer === 'Nakheel Restaurant' && creditRow.entry.deliveryNote === 'Two deliveries, Al-Narjis',
  'the customer and the delivery description are kept on the entry');
// the day is one sale of 1000 in cash, 200 of it on credit and 46 of delivery fees paid to the bank:
// every line is counted once, as sold, and each deduction taken once
var net = ctx.computeNet_([creditRow.entry]).netCashOwed;
close(net, 1000 - 46 + (46 / 1.15) * 0.15 - 200, 'the entry nets to cash, less delivery (VAT back), less credit — each taken once');
// extra lines ride as their own rows in one submission, as expenses do
var multi = call({ action: 'importDailyEntries', token: aliTok, rows: [
  { date: '2021-03-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 900, creditSales: 100, creditCustomer: 'A', deliveryFeeBankAmount: 23, deliveryNote: 'first' },
  { date: '2021-03-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 0, creditSales: 50, creditCustomer: 'B', deliveryFeeBankAmount: 23, deliveryNote: 'second' }
] });
check(multi.ok && multi.created === 2, 'a second credit line and a second delivery line save as a sibling row of the same day');
var byMove = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2021-03-01', dateTo: '2021-03-02', movementType: 'credit' });
check(byMove.ok && byMove.entries.length === 3 && byMove.entries.every(function (e) { return e.creditSales > 0; }),
  'the report filters on movement type separately from payment method');
var byPay = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2021-03-01', dateTo: '2021-03-02', paymentMethod: 'cash', movementType: 'delivery' });
check(byPay.ok && byPay.entries.length === 2, 'and the two filters combine (cash sales that also carry a delivery fee)');

console.log('--- one person, one area ---');
var dupMgr = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Twin Area', clusterManagerUserId: sara.id, collectorUserId: farCollector.id } });
check(!dupMgr.ok && dupMgr.error === 'user_in_other_area', 'an area manager already running an area cannot be given a second one');
var soloMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Solo Area Manager', email: 'solo.fx@bestgas.sa', role: 'cluster_manager' } }).user;
var dupCol = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Twin Area', clusterManagerUserId: soloMgr.id, collectorUserId: musa.id } });
check(dupCol.ok, 'a collector who already collects for another area can collect for this one too');
if (dupCol.ok) call({ action: 'adminDeleteEntity', token: adminTok, kind: 'cluster', id: dupCol.entity.id });
var soloCol = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Solo Collector', email: 'solocol.fx@bestgas.sa', role: 'collector' } }).user;
var twin = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Twin Area', clusterManagerUserId: soloMgr.id, collectorUserId: soloCol.id } });
check(twin.ok, 'two people nobody else uses make a valid area');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', id: twin.entity.id, data: { name: 'Twin Area (renamed)' } }).ok,
  'editing an area keeps its own people — it is not counted against itself');

console.log('--- going live switches "start fresh" off for good ---');
var goLive = call({ action: 'adminSetConfig', token: adminTok, data: { liveLocked: true } });
check(goLive.ok && goLive.config.liveLocked === true, 'the admin switches the system to live');
check(call({ action: 'listMeta', token: adminTok }).config.liveLocked === true, 'listMeta carries the live flag, so the settings screen shows it');
var archAfterLive = call({ action: 'adminArchiveTransactions', token: adminTok, confirm: 'ARCHIVE' });
check(!archAfterLive.ok && archAfterLive.error === 'live_locked', 'once live, starting a fresh round is refused');
var unlock = call({ action: 'adminSetConfig', token: adminTok, data: { liveLocked: false } });
check(!unlock.ok && unlock.error === 'live_locked', 'and the switch cannot be turned back off from the app');

console.log('--- credit customers: numbered by the system, one record per customer ---');
function saveCustomer(data, id) { return call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', id: id, data: data }); }
var cu1 = saveCustomer({ name: 'Zeta Trading Co' });
var cu2 = saveCustomer({ name: 'Omega Foods' });
check(cu1.ok && /^CUS-\d{4}$/.test(cu1.entity.code) && cu2.ok && Number(cu2.entity.code.slice(4)) === Number(cu1.entity.code.slice(4)) + 1,
  'each new customer gets the next internal number, CUS-0001 style');
var cuEdit = saveCustomer({ name: 'Zeta Trading Co', code: 'CUS-9999', phone: '0501234567' }, cu1.entity.id);
check(cuEdit.ok && cuEdit.entity.code === cu1.entity.code && cuEdit.entity.phone === '0501234567', 'the number cannot be changed by an edit');
var cuDup = saveCustomer({ name: '  zeta   trading co ' });
check(!cuDup.ok && cuDup.error === 'duplicate_customer' && cuDup.code === cu1.entity.code, 'the same name typed differently is refused, and names the customer already on file');
var cuAr = saveCustomer({ name: 'مؤسسة واحة الملامة للمقاولات' });
var cuArDup = saveCustomer({ name: 'موسسة  واحه الملامه للمقاولات' });
check(cuAr.ok && !cuArDup.ok && cuArDup.error === 'duplicate_customer', 'Arabic spellings with a different alef, ta marbuta or spacing count as the same customer');
check(!saveCustomer({ name: '   ' }).ok, 'a customer needs a name');
var cuImport = call({ action: 'adminImportCustomers', token: adminTok, rows: [{ name: 'Delta Bakery' }, { name: 'delta  bakery' }, { name: 'Omega Foods' }, { name: 'Sigma Cafe', phone: '0550000000' }] });
check(cuImport.ok && cuImport.created.length === 2 && cuImport.skipped.length === 2 &&
  cuImport.skipped.some(function (k) { return k.reason === 'duplicate' && k.code === cu2.entity.code; }),
  'an imported list creates the new names and skips repeats — within the list and against the file');
check(call({ action: 'adminImportCustomers', token: aliTok, rows: [{ name: 'X' }] }).ok !== true, 'only the admin imports customers');
var cuMeta = call({ action: 'listMeta', token: aliTok });
check(Array.isArray(cuMeta.customers) && cuMeta.customers.some(function (c) { return c.id === cu1.entity.id; }), 'everyone who enters data gets the customer list');
check(ctx.findCustomer_(cu1.entity.code.toLowerCase()).id === cu1.entity.id && ctx.findCustomer_('ZETA trading co').id === cu1.entity.id && !ctx.findCustomer_('nobody'),
  'a customer is found by number or by name');
var cuDel = call({ action: 'adminDeleteEntity', token: adminTok, kind: 'customer', id: cuImport.created[1].id });
check(cuDel.ok, 'a customer with no history can be deleted');
var cuNext = saveCustomer({ name: 'Tau Kitchen' });
check(Number(cuNext.entity.code.slice(4)) > Number(cuImport.created[1].code.slice(4)), 'and its number is never handed out again');

console.log('--- cities: one list, picked, never typed ---');
var ciMeta = call({ action: 'listMeta', token: adminTok });
check(Array.isArray(ciMeta.cities) && ciMeta.cities.some(function (c) { return c.name === 'الرياض'; }), 'the city list starts with the Saudi cities');
var ciAdded = ctx.seedCities_();
var ciNames = ctx.readSheet(ctx.SHEETS.CITIES).map(function (c) { return c.name; });
check(ciAdded >= 1 && ciNames.indexOf('Jeddah') >= 0 && ciNames.indexOf('Riyadh') >= 0, 'and takes in every city the branches already use');
check(ctx.seedCities_() === 0, 'running it again adds nothing');
var ciNew = call({ action: 'adminSaveEntity', token: adminTok, kind: 'city', data: { name: 'Umluj' } });
check(ciNew.ok && call({ action: 'adminSaveEntity', token: adminTok, kind: 'city', data: { name: ' umluj ' } }).error === 'duplicate_city', 'a city is on the list once');
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'city', id: ctx.readSheet(ctx.SHEETS.CITIES).filter(function (c) { return c.name === 'Jeddah'; })[0].id }).error === 'has_children',
  'a city a branch uses cannot be deleted');
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'city', id: ciNew.entity.id }).ok, 'an unused one can');

console.log('--- the customer list ships once, from the Apps Script project only ---');
var seedBefore = ctx.readSheet(ctx.SHEETS.CUSTOMERS).length;
ctx.CUSTOMER_SEED_ = ['Seed Customer One', 'Seed Customer Two', 'seed customer one', 'Zeta Trading Co'];
call({ action: 'listMeta', token: adminTok });
var seedAfter = ctx.readSheet(ctx.SHEETS.CUSTOMERS).length;
check(seedAfter === seedBefore + 2, 'the seed adds each new name once and skips the ones already on file');
call({ action: 'listMeta', token: adminTok });
check(ctx.readSheet(ctx.SHEETS.CUSTOMERS).length === seedAfter, 'and never runs twice');
delete ctx.CUSTOMER_SEED_;

console.log('--- a credit sale names a registered customer, and may list what was taken ---');
var ccCust = saveCustomer({ name: 'Credit Test Customer' }).entity;
var ccOff = saveCustomer({ name: 'Closed Account Customer' }).entity;
saveCustomer({ active: false }, ccOff.id);
var ccLocked = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cyl Locked Test', type: 'goods', unitPrice: 20, priceLocked: true, active: true } }).entity;
var ccFree = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Regulator Test', type: 'goods', unitPrice: 35, active: true } }).entity;
var ccDay = ctx.todayRiyadh_();
function ccEntry(extra) {
  var p = { action: 'createDailyEntry', token: aliTok, date: ccDay, sourceType: 'store', sourceId: store.entity.id, cashSales: 500 };
  Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
  return call(p);
}
var ccById = ccEntry({ creditSales: 60, creditCustomerId: ccCust.id });
check(ccById.ok && ccById.entry.creditCustomerId === ccCust.id && ccById.entry.creditCustomer === 'Credit Test Customer', 'a credit line picked from the list carries the customer and a copy of the name');
var ccByCode = ccEntry({ creditSales: 50, creditCustomer: ccCust.code.toLowerCase() });
check(ccByCode.ok && ccByCode.entry.creditCustomerId === ccCust.id, 'a row that gives the customer number finds the customer (the CSV path)');
check(ccEntry({ creditSales: 50, creditCustomer: 'Nobody By This Name' }).error === 'unknown_customer', 'a name that is not on the list is refused');
check(ccEntry({ creditSales: 50 }).error === 'customer_required', 'a credit sale without a customer is refused');
check(ccEntry({ creditSales: 50, creditCustomerId: ccOff.id }).error === 'invalid_customer', 'a deactivated customer cannot take new credit');
var ccItems = ccEntry({ creditSales: 95, creditCustomerId: ccCust.id, creditItems: [{ productId: ccLocked.id, qty: 3, unitPrice: 20 }, { productId: ccFree.id, qty: 1, unitPrice: 35 }] });
check(ccItems.ok && ccItems.entry.creditSales === 95 && ccItems.entry.creditItems.length === 2 && ccItems.entry.creditItems[0].amount === 60,
  'a credit sale can list its products; each line keeps quantity, price and amount');
var ccDerived = ccEntry({ creditCustomerId: ccCust.id, creditItems: [{ productId: ccFree.id, qty: 2, unitPrice: 30 }] });
check(ccDerived.ok && ccDerived.entry.creditSales === 60, 'with items and no amount, the amount is their total');
check(ccEntry({ creditSales: 70, creditCustomerId: ccCust.id, creditItems: [{ productId: ccLocked.id, qty: 3, unitPrice: 20 }] }).error === 'credit_items_mismatch',
  'an amount that disagrees with the items is refused');
check(ccEntry({ creditSales: 75, creditCustomerId: ccCust.id, creditItems: [{ productId: ccLocked.id, qty: 3, unitPrice: 25 }] }).error === 'price_locked',
  'a fixed-price product cannot be put on credit at another price');
check(ccEntry({ creditSales: 10, creditCustomerId: ccCust.id, creditItems: [{ productId: 'no-such-product', qty: 1, unitPrice: 10 }] }).error === 'invalid_product',
  'an unknown product is refused');
check(ctx.computeNet_([ccItems.entry]).netCashOwed === ctx.computeNet_([{ sourceType: 'store', cashSales: 500, creditSales: 95 }]).netCashOwed,
  'listing the products changes nothing in the cash owed');
var ccImport = call({ action: 'importDailyEntries', token: aliTok, rows: [
  { date: ccDay, sourceType: 'store', sourceId: store.entity.id, cashSales: 200, creditSales: 40, creditCustomer: 'credit   test customer' }
] });
check(ccImport.ok && ccImport.created === 1, 'the file import resolves the customer by name too');
var ccRep = call({ action: 'getSalesReport', token: adminTok, customerId: ccCust.id });
check(ccRep.ok && ccRep.entries.length === 5 && ccRep.entries.every(function (e) { return e.creditCustomerId === ccCust.id; }), 'the report filters to one customer');
var ccRow = (ccRep.byCustomer || []).filter(function (r) { return r.customerId === ccCust.id; })[0];
check(ccRow && ccRow.creditSales === 60 + 50 + 95 + 60 + 40 && ccRow.code === ccCust.code, 'and totals the credit each customer owes');
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'customer', id: ccCust.id }).error === 'has_children', 'a customer with credit history cannot be deleted');

console.log('--- every record gets a system number with its own prefix ---');
var sqPrefix = { location: 'BR', cluster: 'AR', city: 'CT', zone: 'ZN', store: 'ST', car: 'CR', pos: 'POS', product: 'PR', income_item: 'INC', expense_item: 'EXP', customer: 'CUS' };
var sqArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Seq Area', clusterManagerUserId: mk('Seq Manager', 'seqmgr.fx@bestgas.sa', 'cluster_manager').id } }).entity;
var sqColl = mk('Seq Collector', 'seqcol.fx@bestgas.sa', 'collector');
var sqLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Seq Branch', clusterId: sqArea.id, collectorUserId: sqColl.id } }).entity;
var sqZone = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { city: 'Riyadh', name: 'Seq Zone' } }).entity;
var sqCity = call({ action: 'adminSaveEntity', token: adminTok, kind: 'city', data: { name: 'Seq City' } }).entity;
var sqProd = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Seq Product', active: true } }).entity;
var sqInc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'income_item', data: { name: 'Seq Income', active: true } }).entity;
var sqExp = call({ action: 'adminSaveEntity', token: adminTok, kind: 'expense_item', data: { name: 'Seq Expense', active: true } }).entity;
var sqStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: sqLoc.id, name: 'Seq Store', storeManagerUserId: mk('Seq BM', 'seqbm.fx@bestgas.sa', 'store_manager').id } }).entity;
var sqCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: sqLoc.id, label: 'Seq Car', driverUserId: mk('Seq Driver', 'seqdr.fx@bestgas.sa', 'driver').id } }).entity;
var sqPos = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: sqCar.id, label: 'Seq POS', assignedUserId: sqCar.driverUserId } }).entity;
var sqAll = { location: sqLoc, cluster: sqArea, city: sqCity, zone: sqZone, store: sqStore, car: sqCar, pos: sqPos, product: sqProd, income_item: sqInc, expense_item: sqExp };
check(Object.keys(sqAll).every(function (k) { return sqAll[k] && new RegExp('^' + sqPrefix[k] + '-\\d{4}$').test(sqAll[k].code); }),
  'branches BR-, areas AR-, cities CT-, zones ZN-, stores ST-, cars CR-, POS POS-, products PR-, collection items INC-, expense items EXP-');
var sqLoc2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Seq Branch 2', clusterId: sqArea.id, collectorUserId: sqColl.id } }).entity;
check(Number(sqLoc2.code.slice(3)) === Number(sqLoc.code.slice(3)) + 1, 'each module counts on its own');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', id: sqLoc.id, data: { code: 'BR-0000', name: 'Seq Branch' } }).entity.code === sqLoc.code, 'an edit cannot change a number');
var sqUser = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Seq Employee', email: 'seqemp.fx@bestgas.sa', role: 'driver' } }).user;
check(sqUser && /^EMP-\d{4}$/.test(sqUser.code), 'a new user gets an employee number');
ctx.writeRow(ctx.SHEETS.ZONES, { id: 'legacy-zone-sq', city: 'Riyadh', name: 'Legacy Zone', active: true });
var sqFilled = ctx.backfillCodes_();
check(sqFilled >= 1 && /^ZN-\d{4}$/.test(ctx.getById_(ctx.SHEETS.ZONES, 'legacy-zone-sq').code), 'records saved before numbering get theirs');
check(ctx.backfillCodes_() === 0 && ctx.getById_(ctx.SHEETS.LOCATIONS, sqLoc.id).code === sqLoc.code, 'running it again changes nothing, and never renumbers');
check(ctx.readSheet(ctx.SHEETS.USERS).every(function (u) { return /^EMP-\d{4}$/.test(u.code); }), 'every user, old or new, carries an employee number');
check(ctx.readSheet(ctx.SHEETS.CITIES).every(function (c) { return /^CT-\d{4}$/.test(c.code); }), 'every city on the seeded list is numbered');

console.log('--- a branch can carry its map position ---');
var geoLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', id: location.entity.id, data: { lat: 24.7136, lng: 46.6753 } });
check(geoLoc.ok && geoLoc.entity.lat === 24.7136 && geoLoc.entity.lng === 46.6753, 'a branch saves its latitude and longitude');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', id: location.entity.id, data: { lat: 95, lng: 46 } }).error === 'invalid_coordinates', 'a latitude past 90 is refused');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', id: location.entity.id, data: { lat: 24.7, lng: '' } }).error === 'invalid_coordinates', 'and so is half a position');

console.log('--- review fixes: numbers and names under concurrent saves ---');
var fxAdmin = ctx.userByEmail_('admin@bestgas.sa');
// two saves whose requests both started before either took the lock
ctx.resetExecMemo_();
ctx.readSheet(ctx.SHEETS.CUSTOMERS);
ctx.resetExecMemo_();
ctx.scriptProps_(); ctx.readSheet(ctx.SHEETS.USERS); ctx.readSheet(ctx.SHEETS.CUSTOMERS);
var fxMemoB = ctx.EXEC_;
ctx.EXEC_ = null;
var fxA = ctx.actionAdminSaveEntity_({ kind: 'customer', data: { name: 'مؤسسة النور للتجارة' } }, fxAdmin);
ctx.EXEC_ = fxMemoB;
var fxB = ctx.actionAdminSaveEntity_({ kind: 'customer', data: { name: 'موسسه النور للتجاره' } }, fxAdmin);
check(fxA.ok && !fxB.ok && fxB.error === 'duplicate_customer', 'a save that waited for the lock still sees the customer the other admin just added');
ctx.resetExecMemo_();
ctx.scriptProps_(); ctx.readSheet(ctx.SHEETS.CUSTOMERS);
var fxMemoD = ctx.EXEC_;
ctx.EXEC_ = null;
var fxC = ctx.actionAdminSaveEntity_({ kind: 'customer', data: { name: 'Race Customer One' } }, fxAdmin);
ctx.EXEC_ = fxMemoD;
var fxD = ctx.actionAdminSaveEntity_({ kind: 'customer', data: { name: 'Race Customer Two' } }, fxAdmin);
check(fxC.ok && fxD.ok && fxC.entity.code !== fxD.entity.code, 'and two different customers saved at once get two different numbers');
ctx.resetExecMemo_();
check(ctx._debug.lock && ctx._debug.lock.held === false, 'a save leaves the lock free');
var fxLock = ctx.LockService.getScriptLock(); fxLock.waitLock(1000);
ctx.writeRow(ctx.SHEETS.CITIES, { id: 'fx-city', name: 'Fx City', active: true });
check(ctx._debug.lock.held === true, 'writeRow does not release a lock its caller holds');
fxLock.releaseLock();

console.log('--- review fixes: one-time jobs run once even when two requests overlap ---');
ctx.resetExecMemo_();
ctx.setScriptProp_('SEEDED_CUSTOMERS', '');
ctx.setScriptProp_('SEEDED_CUSTOMERS_CLAIM', '');
var fxBefore = ctx.readSheet(ctx.SHEETS.CUSTOMERS).length;
ctx.CUSTOMER_SEED_ = ['Overlap Seed One', 'Overlap Seed Two'];
ctx.resetExecMemo_();
ctx.scriptProps_(); ctx.readSheet(ctx.SHEETS.CUSTOMERS);
var fxMemoR = ctx.EXEC_;
ctx.EXEC_ = null;
ctx.runOneTimeMigrations_();
ctx.EXEC_ = fxMemoR;
ctx.runOneTimeMigrations_();
ctx.resetExecMemo_();
check(ctx.readSheet(ctx.SHEETS.CUSTOMERS).length === fxBefore + 2, 'two overlapping first runs add the seed once, not twice');
delete ctx.CUSTOMER_SEED_;
ctx.resetExecMemo_();
ctx.setScriptProp_('FX_JOB', '');
ctx.setScriptProp_('FX_JOB_CLAIM', new Date().toISOString());
var fxRan = 0;
ctx.runOnce_('FX_JOB', function () { fxRan++; });
check(fxRan === 0, 'a job another request has just claimed is not started again');
ctx.setScriptProp_('FX_JOB_CLAIM', new Date(Date.now() - 20 * 60000).toISOString());
ctx.resetExecMemo_();
ctx.runOnce_('FX_JOB', function () { fxRan++; });
ctx.runOnce_('FX_JOB', function () { fxRan++; });
check(fxRan === 1, 'a claim left by a run that died is taken over, and the job then runs once');

console.log('--- review fixes: a stale copy never erases a record number ---');
ctx.resetExecMemo_();
var fxStale = JSON.parse(JSON.stringify(ctx.getById_(ctx.SHEETS.CUSTOMERS, fxA.entity.id)));
delete fxStale.code;
fxStale.phone = '0500000001';
ctx.writeRow(ctx.SHEETS.CUSTOMERS, fxStale);
ctx.resetExecMemo_();
var fxAfter = ctx.getById_(ctx.SHEETS.CUSTOMERS, fxA.entity.id);
check(fxAfter.code === fxA.entity.code && fxAfter.phone === '0500000001', 'a write from a copy read before numbering keeps the number and still saves its change');

console.log('--- review fixes: names ---');
check(!saveCustomer({ name: 'مؤسسة النور للتجارة\u200f' }).ok, 'an invisible direction mark does not make a new customer');
saveCustomer({ name: 'شركة الخليج المتحدة' });
check(saveCustomer({ name: 'شرکة الخلیج المتحدة' }).error === 'duplicate_customer', 'nor does typing it on an Urdu or Persian keyboard');
call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://x.test/', data: { name: 'عبد الله القحطاني', email: 'fx.abd@bestgas.sa', role: 'driver' } });
var fxAbd = ctx._debug.mailLog.filter(function (m) { return m.to === 'fx.abd@bestgas.sa'; }).pop();
check(fxAbd && fxAbd.html.indexOf('أهلاً عبد الله،') >= 0, 'the invitation greets عبد الله as عبد الله, not عبد');
call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://x.test/', data: { name: 'أبو فهد', email: 'fx.abu@bestgas.sa', role: 'driver' } });
var fxAbu = ctx._debug.mailLog.filter(function (m) { return m.to === 'fx.abu@bestgas.sa'; }).pop();
check(fxAbu && fxAbu.html.indexOf('أهلاً أبو فهد،') >= 0, 'and a kunya stays whole');

console.log('--- review fixes: what each role is sent ---');
var fxMeta = call({ action: 'listMeta', token: aliTok });
check(fxMeta.customers.length > 0 && fxMeta.customers.every(function (c) { return c.phone === undefined && c.code && c.name; }), 'a branch manager gets customers\' numbers and names, not their phones');
check(call({ action: 'adminImportCustomers', token: adminTok, rows: new Array(501).join('x,').split(',') }).error === 'too_many_rows', 'an import is capped where it can finish in one run');

console.log('--- the app is called Best Gas Collections ---');
ctx.resetExecMemo_();
var rnCfg = ctx.config_(); rnCfg.senderName = 'Best Gas Cash Collection'; ctx.writeRow(ctx.SHEETS.CONFIG, rnCfg);
ctx.setScriptProp_('SENDER_RENAMED', ''); ctx.setScriptProp_('SENDER_RENAMED_CLAIM', '');
ctx.resetExecMemo_(); ctx.runOneTimeMigrations_(); ctx.resetExecMemo_();
check(ctx.config_().senderName === 'Best Gas Collections', 'emails that still carried the old default sender name now say Best Gas Collections');
rnCfg = ctx.config_(); rnCfg.senderName = 'Best Gas Finance'; ctx.writeRow(ctx.SHEETS.CONFIG, rnCfg);
ctx.setScriptProp_('SENDER_RENAMED', ''); ctx.setScriptProp_('SENDER_RENAMED_CLAIM', '');
ctx.resetExecMemo_(); ctx.runOneTimeMigrations_(); ctx.resetExecMemo_();
check(ctx.config_().senderName === 'Best Gas Finance', 'a sender name someone chose is left alone');

console.log('--- an area\'s collector moves onto its branches, once ---');
var mgCol = mk('Mg Area Collector', 'mgcol.fx@bestgas.sa', 'collector');
var mgCol2 = mk('Mg Branch Collector', 'mgcol2.fx@bestgas.sa', 'collector');
var mgMgr = mk('Mg Area Manager', 'mgmgr.fx@bestgas.sa', 'cluster_manager');
var mgArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Mg Legacy Area', clusterManagerUserId: mgMgr.id, collectorUserId: mgCol.id } }).entity;
var mgL1 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Dammam', name: 'Mg One', clusterId: mgArea.id } }).entity;
var mgL2 = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Dammam', name: 'Mg Two', clusterId: mgArea.id, collectorUserId: mgCol2.id } }).entity;
check(mgArea && mgL1 && mgL2 && !mgL1.collectorUserId, 'an area saved the old way, with a branch that leans on the area\'s collector');
call({ action: 'listMeta', token: adminTok });
check(ctx.getById_(ctx.SHEETS.CLUSTERS, mgArea.id).collectorUserId === mgCol.id, 'the move ran once, on the first request after the update — not on every request');
var mgMoved = ctx.migrateBranchCollectors_();
var mgL1After = ctx.getById_(ctx.SHEETS.LOCATIONS, mgL1.id), mgL2After = ctx.getById_(ctx.SHEETS.LOCATIONS, mgL2.id);
check(mgMoved >= 1 && mgL1After.collectorUserId === mgCol.id, 'the branch that leaned on the area now names that same collector itself');
check(mgL2After.collectorUserId === mgCol2.id, 'a branch with its own collector keeps them');
check(!ctx.getById_(ctx.SHEETS.CLUSTERS, mgArea.id).collectorUserId, 'and the area no longer holds a collector of its own');
check(ctx.branchCollector_(mgL1.id) === mgCol.id && ctx.branchCollector_(mgL2.id) === mgCol2.id, 'nobody\'s cash changes hands: every branch still goes to the same collector');
check(ctx.migrateBranchCollectors_() === 0, 'running it again changes nothing');

console.log('--- total sales counts a credit sale once: it is already inside the typed sales figure ---');
var stLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Jeddah', name: 'Sales Total Branch', clusterId: cluster.entity.id, collectorUserId: musa.id } }).entity;
var stMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Sales Total Manager', email: 'stmgr.fx@bestgas.sa', role: 'store_manager' } }).user;
var stStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: stLoc.id, name: 'Sales Total Store', storeManagerUserId: stMgr.id } }).entity;
var stCust = call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', data: { name: 'Sales Total Customer', city: 'Jeddah' } }).entity;
var stEntry = call({ action: 'createDailyEntry', token: adminTok, date: '2026-08-02', sourceType: 'store', sourceId: stStore.id, productId: prodA.id, cashSales: 900, creditSales: 300, creditCustomerId: stCust.id });
check(stEntry.ok, 'a day of 900 sold, 300 of it on credit, is saved');
var stDay = call({ action: 'getSalesReport', token: adminTok, dateFrom: '2026-08-02', dateTo: '2026-08-02' });
var stTrend = (stDay.byDate || []).filter(function (d) { return d.date === '2026-08-02'; })[0];
close(stTrend ? Number(stTrend.gross != null ? stTrend.gross : stTrend.total != null ? stTrend.total : stTrend.amount) : NaN, 900, 'the daily sales trend shows 900 for that day, not 1,200');
var stMax = call({ action: 'getSalesReport', token: adminTok, amountMin: 900, amountMax: 900 });
check(stMax.ok && stMax.entries.some(function (e) { return e.sourceId === stStore.id; }), 'the amount filter sees the entry as a 900 sale');
close(stDay.totals.netCashOwed, 600, 'and the cash owed is still 900 less the 300 on credit');

console.log('--- forgot password cannot be turned against someone ---');
var fpInv = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Fp Invitee', email: 'fpvictim.fx@bestgas.sa', role: 'finance' } }).user;
check(!!fpInv, 'set up: someone invited who has not accepted yet');
var fpBefore = ctx._debug.mailLog.length;
call({ action: 'forgotPassword', email: 'fpvictim.fx@bestgas.sa', appUrl: 'https://attacker.example/' });
var fpMail2 = ctx._debug.mailLog.slice(fpBefore).pop();
var fpAll = fpMail2 ? String(fpMail2.body) + String(fpMail2.html || '') : '';
check(fpMail2 && fpAll.indexOf('attacker.example') < 0, 'a stranger cannot point the invitation email at their own site');
check(fpMail2 && fpAll.indexOf(ctx.DEFAULT_APP_URL) >= 0, 'the invitation links to the live app');
check(ctx.inviteAppUrl_({ appUrl: 'https://x.example/app/' }) === ctx.DEFAULT_APP_URL, 'another https site is not accepted as a link base');
check(ctx.inviteAppUrl_({ appUrl: 'http://localhost:8905/' }) === 'http://localhost:8905/', 'a local preview still is');

var fpAct = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Fp Active', email: 'fpactive.fx@bestgas.sa', role: 'accountant' } }).user;
call({ action: 'acceptInvite', inviteToken: lastInviteFor('fpactive.fx@bestgas.sa'), password: 'Original#123' });
check(call({ action: 'login', email: 'fpactive.fx@bestgas.sa', password: 'Original#123' }).ok, 'set up: the person signs in with their own password');
function fpTemp() {
  var log = ctx._debug.mailLog;
  for (var i = log.length - 1; i >= 0; i--) {
    var m = log[i].to === 'fpactive.fx@bestgas.sa' && /Temporary password: (\S+)/.exec(log[i].body);
    if (m) return m[1];
  }
  return null;
}
function fpAsk() { delete ctx._debug.cache['fpwait_fpactive.fx@bestgas.sa']; call({ action: 'forgotPassword', email: 'fpactive.fx@bestgas.sa' }); return fpTemp(); }
var fpT1 = fpAsk();
check(!!fpT1, 'asking for a reset emails a temporary password');
check(call({ action: 'login', email: 'fpactive.fx@bestgas.sa', password: 'Original#123' }).ok, 'someone else asking for a reset does not lock the person out: their own password still works');
check(!call({ action: 'login', email: 'fpactive.fx@bestgas.sa', password: fpT1 }).ok, 'and once they sign in with it, the unused temporary password stops working');
var fpT2 = fpAsk();
var fpViaTemp = call({ action: 'login', email: 'fpactive.fx@bestgas.sa', password: fpT2 });
check(fpViaTemp.ok && fpViaTemp.user.mustChangePw === true, 'the temporary password signs in, and asks for a new password');
check(!call({ action: 'login', email: 'fpactive.fx@bestgas.sa', password: 'Original#123' }).ok, 'after a reset is used, the old password is gone');
var fpT3 = fpAsk();
var fpU = ctx.getById_(ctx.SHEETS.USERS, fpAct.id); fpU.resetExpires = Date.now() - 1000; ctx.writeRow(ctx.SHEETS.USERS, fpU);
check(!call({ action: 'login', email: 'fpactive.fx@bestgas.sa', password: fpT3 }).ok, 'a temporary password expires after an hour');
check(!('resetPass' in fpViaTemp.user) && !('resetSalt' in fpViaTemp.user), 'the reset secret never leaves the server');

console.log('--- a slip photo keeps a plain file type ---');
check(ctx.slipMime_('image/png') === 'image/png' && ctx.slipMime_('application/pdf') === 'application/pdf', 'photos and PDFs keep their type');
check(ctx.slipMime_('image/png" onerror="alert(1)') === 'image/jpeg' && ctx.slipMime_('text/html') === 'image/jpeg', 'anything else is stored as a JPEG photo, never as page markup');

console.log('--- customers\' bank transfers come off the cash, one transfer per line ---');
var btNet = ctx.computeNet_([{ sourceType: 'store', cashSales: 1000, bankTransferAmount: 250 }]);
close(btNet.netCashOwed, 750, 'a 250 transfer from a customer comes off a 1,000 day');
close(btNet.bankTransfers, 250, 'and is shown on its own line');
close(ctx.sumBreakdowns_([btNet, btNet]).bankTransfers, 500, 'transfers add up when handoffs are combined');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-01', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, bankTransferAmount: -5 }).error === 'invalid_input', 'a negative transfer is refused');
var btRows = call({ action: 'importDailyEntries', token: aliTok, rows: [
  { date: '2026-09-01', sourceType: 'store', sourceId: store.entity.id, cashSales: 1000, bankTransferAmount: 300 },
  { date: '2026-09-01', sourceType: 'store', sourceId: store.entity.id, bankTransferAmount: 200 }
] });
check(btRows.ok && btRows.created === 2, 'two transfers on one day save as two lines');
var btDay = ctx.readSheet(ctx.SHEETS.ENTRIES).filter(function (e) { return btRows.results.some(function (r) { return r.id === e.id; }); });
close(ctx.computeNet_(btDay).netCashOwed, 500, 'and the day owes 1,000 less 500 transferred');
var btOver = call({ action: 'importDailyEntries', token: aliTok, rows: [
  slip(aliTok, { date: '2026-09-02', sourceType: 'store', sourceId: store.entity.id, cashSales: 1000, bankTransferAmount: 700, directDepositAmount: 400, directDepositRef: 'BT-X' })
] });
check(btOver.results[0].error === 'deposit_exceeds_cash', 'a الموازنة cannot bank cash that a customer transferred instead');

console.log('--- الموازنات: one line per POS device, each with its photo ---');
var ph = call({ action: 'uploadEntryPhoto', token: aliTok, fileBase64: 'iVBORw0KGgo=', fileName: 'mz.png', fileMime: 'image/png' });
check(ph.ok && !!ph.fileId, 'the person entering uploads the photo first');
check(call({ action: 'uploadEntryPhoto', fileBase64: 'iVBORw0KGgo=' }).ok === false, 'nobody signed out can upload');
var mzBase = { action: 'createDailyEntry', token: aliTok, date: '2026-09-03', sourceType: 'store', sourceId: store.entity.id, cashSales: 800, directDepositAmount: 300, directDepositRef: 'MZ-1' };
function mz(extra) { var o = {}; Object.keys(mzBase).forEach(function (k) { o[k] = mzBase[k]; }); Object.keys(extra).forEach(function (k) { o[k] = extra[k]; }); return o; }
check(call(mz({ directDepositPosId: pos.entity.id })).error === 'deposit_needs_photo', 'a الموازنة without its photo is refused');
check(call(mz({ directDepositPhotoId: ph.fileId })).error === 'deposit_needs_pos', 'and one that does not say which POS device, where the branch has one');
var otherBranchPos = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'store', ownerId: filterStore.id, label: 'Jeddah POS', assignedUserId: mgr8.id } }).entity;
check(call(mz({ directDepositPhotoId: ph.fileId, directDepositPosId: otherBranchPos.id })).error === 'invalid_pos', 'a POS device from another branch is refused');
var phOther = call({ action: 'uploadEntryPhoto', token: adminTok, fileBase64: 'iVBORw0KGgo=', fileName: 'x.png', fileMime: 'image/png' });
check(call(mz({ directDepositPhotoId: phOther.fileId, directDepositPosId: pos.entity.id })).error === 'invalid_photo', 'a photo someone else uploaded cannot be used');
var mzOk = call(mz({ directDepositPhotoId: ph.fileId, directDepositPosId: pos.entity.id }));
check(mzOk.ok && mzOk.entry.directDepositPosId === pos.entity.id, 'with its device and photo it saves');
check(mzOk.deposit && mzOk.deposit.attachmentId === ph.fileId && mzOk.deposit.posId === pos.entity.id, 'and the bank deposit it records carries the photo and the device');
check(call(mz({ directDepositPhotoId: ph.fileId, directDepositPosId: pos.entity.id, directDepositRef: 'MZ-2' })).error === 'invalid_photo', 'one photo serves one الموازنة only');
check(call({ action: 'getFile', token: financeTok, fileId: ph.fileId }).ok, 'finance can open the photo');
var mzLines = call({ action: 'importDailyEntries', token: aliTok, rows: [
  slip(aliTok, { date: '2026-09-04', sourceType: 'store', sourceId: store.entity.id, cashSales: 1000, directDepositAmount: 600, directDepositRef: 'MZ-A' }),
  slip(aliTok, { date: '2026-09-04', sourceType: 'store', sourceId: store.entity.id, directDepositAmount: 600, directDepositRef: 'MZ-B' })
] });
check(mzLines.results[0].ok !== mzLines.results[1].ok || !mzLines.results[0].ok, 'two الموازنات on one day cannot bank more than the day\'s cash between them');

console.log('--- a credit customer carries a delivery fee per unit, worked out and deducted by itself ---');
var cdCust = call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', data: { name: 'Delivery Fee Customer', city: 'Riyadh' } }).entity;
var cdSaved = call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', id: cdCust.id, data: {
  deliveryFees: (function () { var p = {}; p[fixedProduct.entity.id] = 2; return p; })(),
  commissions: (function () { var p = {}; p[fixedProduct.entity.id] = 1; return p; })() } });
check(cdSaved.ok && cdSaved.entity.commissions[fixedProduct.entity.id] === 1, 'and the driver\'s commission per unit');
check(cdSaved.ok && cdSaved.entity.deliveryFees[fixedProduct.entity.id] === 2, 'the admin sets the customer\'s delivery fee per unit of a product');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', id: cdCust.id, data: { deliveryFees: { nope: 5 } } }).error === 'invalid_product', 'only for products that exist');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', id: cdCust.id, data: { deliveryFees: (function () { var p = {}; p[fixedProduct.entity.id] = -1; return p; })() } }).error === 'invalid_input', 'and never below zero');
function cdLine(custId, qty, price, extra) {
  var o = { action: 'createDailyEntry', token: aliTok, date: '2026-09-06', sourceType: 'store', sourceId: store.entity.id, cashSales: 5000,
    creditCustomerId: custId, creditItems: [{ productId: fixedProduct.entity.id, qty: qty, unitPrice: price }] };
  Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
  return call(o);
}
var cdOk = cdLine(cdCust.id, 50, 45);
check(cdOk.ok && cdOk.entry.creditSales === 2250, 'the credit is the items at their usual price: 50 x 45');
check(cdOk.ok && cdOk.entry.creditDeliveryFee === 100, 'and the customer\'s delivery fee is worked out on its own: 50 x 2');
check(cdLine(cdCust.id, 50, 45, { creditDeliveryFee: 1 }).entry.creditDeliveryFee === 100, 'a fee sent by the client is ignored: the server works it out');
check(cdOk.ok && cdOk.entry.creditCommission === 50, 'the driver\'s commission is worked out too: 50 x 1');
var cdNet = ctx.computeNet_([cdOk.entry]);
close(cdNet.creditDeliveryFees, 100, 'the delivery fee is an addition, on its own line');
close(cdNet.creditCommissions, 50, 'the commission is a deduction, on its own line');
// the customer owes the fee on account with the goods, so the fee adds no
// cash; the commission the driver keeps comes off
// the fee is only ever added (the user, 2026-09-29); the commission comes off
close(cdNet.netCashOwed, 5000 - 2250 + 100 - 50, 'the cash to hand over: sales, less the credit, plus the delivery fee, less the commission');
check(cdLine(cdCust.id, 2, 42).error === 'price_locked', 'there are no special prices: a fixed price stays fixed for everyone');
var cdPlain = call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', data: { name: 'No Fee Customer', city: 'Riyadh' } }).entity;
var cdNone = cdLine(cdPlain.id, 10, 45);
check(cdNone.ok && !cdNone.entry.creditDeliveryFee, 'a customer without a fee has none');
var cdMeta = call({ action: 'listMeta', token: aliTok }).customers.filter(function (c) { return c.id === cdCust.id; })[0];
check(cdMeta && cdMeta.deliveryFees && cdMeta.deliveryFees[fixedProduct.entity.id] === 2, 'the branch sees the fees, so the form can show them as it fills in');
close(ctx.sumBreakdowns_([cdNet, cdNet]).creditDeliveryFees, 200, 'the fee adds up when handoffs are combined');
close(ctx.sumBreakdowns_([cdNet, cdNet]).creditCommissions, 100, 'and so does the commission');
check(cdMeta.commissions && cdMeta.commissions[fixedProduct.entity.id] === 1, 'the branch sees the commissions too');

console.log('--- a sales channel (Souq Gas) carries its own delivery fee and driver commission per unit ---');
var chRates = function (v) { var p = {}; p[fixedProduct.entity.id] = v; return p; };
var souq = call({ action: 'adminSaveEntity', token: adminTok, kind: 'channel', data: { name: 'Souq Gas', deliveryFees: chRates(4), commissions: chRates(1.5) } });
check(souq.ok && /^CH-\d+$/.test(souq.entity.code || ''), 'the admin adds Souq Gas as a sales channel, with its own number');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'channel', data: { name: '' } }).error === 'invalid_input', 'a channel needs a name');
var chDay = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-07', sourceType: 'store', sourceId: store.entity.id,
  productId: fixedProduct.entity.id, qty: 30, unitPrice: 45, cashSales: 1350, channelId: souq.entity.id, channelDeliveryFee: 1 });
check(chDay.ok && chDay.entry.channelId === souq.entity.id, 'a sale is recorded through the channel');
check(chDay.ok && chDay.entry.channelDeliveryFee === 120 && chDay.entry.channelCommission === 45, 'the server works out the fee (30 x 4) and the commission (30 x 1.5); what the client sent is ignored');
var chNet = ctx.computeNet_([chDay.entry]);
close(chNet.channelDeliveryFees, 120, 'the channel fee shows on its own line');
close(chNet.channelCommissions, 45, 'and so does the channel commission');
close(chNet.netCashOwed, 1350 + 120 - 45, 'the fee is added and the commission comes off');
close(ctx.sumBreakdowns_([chNet, chNet]).channelDeliveryFees, 240, 'channel figures add up across handoffs');
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-07', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, channelId: 'nope' }).error === 'invalid_channel', 'an unknown channel is refused');
var plainDay = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-07', sourceType: 'store', sourceId: store.entity.id, productId: fixedProduct.entity.id, qty: 5, unitPrice: 45, cashSales: 225 });
check(plainDay.ok && !plainDay.entry.channelDeliveryFee && !plainDay.entry.channelCommission, 'a normal sale carries no channel fee');
check((call({ action: 'listMeta', token: aliTok }).channels || []).some(function (c) { return c.id === souq.entity.id && c.deliveryFees; }), 'every branch sees the channels and their rates');

console.log('--- one line, part of it through Souq Gas: the fee and commission follow that part only ---');
var mixQ = {}; mixQ[souq.entity.id] = 30;
var mixDay = call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-08', sourceType: 'store', sourceId: store.entity.id,
  productId: fixedProduct.entity.id, qty: 100, unitPrice: 45, cashSales: 4500, channelQtys: mixQ });
check(mixDay.ok && mixDay.entry.qty === 100 && mixDay.entry.channelQtys[souq.entity.id] === 30, 'a line of 100 records that 30 of them went through Souq Gas');
check(mixDay.ok && mixDay.entry.channelDeliveryFee === 120 && mixDay.entry.channelCommission === 45, 'the fee and commission follow the 30 only (30 x 4, 30 x 1.5)');
close(ctx.computeNet_([mixDay.entry]).netCashOwed, 4500 + 120 - 45, 'and the cash owed takes them in');
var overQ = {}; overQ[souq.entity.id] = 101;
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-08', sourceType: 'store', sourceId: store.entity.id,
  productId: fixedProduct.entity.id, qty: 100, unitPrice: 45, cashSales: 4500, channelQtys: overQ }).error === 'channel_qty_exceeds', 'the Souq Gas part cannot be more than the line');
var badQ = { nope: 3 };
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-08', sourceType: 'store', sourceId: store.entity.id,
  productId: fixedProduct.entity.id, qty: 10, unitPrice: 45, cashSales: 450, channelQtys: badQ }).error === 'invalid_channel', 'only a channel that exists');

console.log('--- a POS device can name its holder without a user account ---');
var posNamed = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: car.entity.id, label: 'Test/1234 ABC', posId: '10000001', holderName: 'Test Holder', holderIqama: '2000000001' } });
check(posNamed.ok && posNamed.entity.holderName === 'Test Holder' && posNamed.entity.holderIqama === '2000000001', 'a device saves with its holder\'s name and iqama');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: car.entity.id, label: 'No holder' } }).error === 'holder_required', 'but it still needs a holder, by account or by name');

console.log('--- master data comes in from Excel, row by row, through the same checks as the form ---');
var impRes = call({ action: 'adminImportEntities', token: adminTok, kind: 'product', rows: [
  { data: { name: 'Imported Cylinder 11kg', type: 'goods', unitPrice: 30 } },
  { data: { name: '', type: 'goods' } },
  { data: { name: 'Imported Service', type: 'services', unitPrice: 15, priceLocked: true } }
] });
check(impRes.ok && impRes.created === 2 && impRes.total === 3, 'good rows are saved and a bad one is not');
check(impRes.results[1].ok === false && impRes.results[1].error === 'invalid_input', 'the bad row says why');
check(/^PR-\d+$/.test(impRes.results[0].code || ''), 'each saved row gets its system number');
var impUpd = call({ action: 'adminImportEntities', token: adminTok, kind: 'product', rows: [{ id: impRes.results[0].id, data: { unitPrice: 32 } }] });
check(impUpd.ok && impUpd.updated === 1 && ctx.getById_(ctx.SHEETS.PRODUCTS, impRes.results[0].id).unitPrice === 32, 'a row naming an existing record updates it');
check(call({ action: 'adminImportEntities', token: aliTok, kind: 'product', rows: [{ data: { name: 'X' } }] }).error === 'forbidden', 'only an admin imports');
check(call({ action: 'adminImportEntities', token: adminTok, kind: 'nope', rows: [{ data: { name: 'X' } }] }).error === 'invalid_kind', 'only known record types');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
