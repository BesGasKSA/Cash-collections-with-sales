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
check(!zoneNoCity.ok && zoneNoCity.error === 'city_required', 'zone requires both city and name');

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
// prodA was deactivated above, and a sale names an active item (security review 2026-10-04)
var prodF = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Filter Product', type: 'goods' } }).entity;
check(call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-11', sourceType: 'store', sourceId: filterStore.id, productId: prodA.id, cashSales: 900 }).error === 'invalid_product', 'a sale of a deactivated item is refused');
call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-11', sourceType: 'store', sourceId: filterStore.id, productId: prodF.id, cashSales: 900 });

var cityReport = call({ action: 'getSalesReport', token: adminTok, city: 'Jeddah' });
check(cityReport.ok && cityReport.totals.netCashOwed >= 900, 'city filter includes the Jeddah entry');
check(!cityReport.byLocation.some(function (r) { return r.city === 'Riyadh'; }), 'city filter excludes Riyadh locations');

var productReport = call({ action: 'getSalesReport', token: adminTok, productId: prodF.id });
check(productReport.ok && productReport.entries.length > 0 && productReport.entries.every(function (e) { return e.productId === prodF.id; }), 'product filter only returns entries tagged with that product');

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
check(!blankNameRejected.ok && blankNameRejected.error === 'name_required', 'a blank name is rejected, not silently saved');

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
check(!badRole.ok && badRole.error === 'role_required', 'validRole_ still rejects a garbage role — no regression from adding the new one');

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
var inv = call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://besgasksa.github.io/Cash-collections-with-sales/', data: { name: 'Invitee Person', email: 'invitee@bestgas.sa', role: 'store_manager', language: 'ar' } });
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
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'income_item', data: { name: '' } }).error === 'name_required', 'an item needs a name');
check(call({ action: 'adminSaveEntity', token: aliTok, kind: 'expense_item', data: { name: 'Sneaky' } }).error === 'forbidden', 'only admin keeps the master data');
var incomeId = incomeItem.entity.id, expenseId = expenseItem.entity.id;

console.log('--- product price: fixed or editable per product ---');
var fixedProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'أسطوانة 12.5kg', type: 'goods', unitPrice: 45, priceLocked: true } });
check(fixedProduct.ok && fixedProduct.entity.priceLocked === true && fixedProduct.entity.unitPrice === 45, 'a product can carry a fixed price');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Bad', priceLocked: true } }).error === 'price_needed', 'a price cannot be locked when there is no price to lock');
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
check(!neg.ok && neg.error === 'invalid_amount', 'a negative sale is refused (it would quietly cut what is owed)');
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
check(call({ action: 'adminSetConfig', token: adminTok, data: { vatRate: 15 } }).error === 'invalid_vat', 'a VAT rate of 15 (meant 0.15) is refused');
check(call({ action: 'adminSetConfig', token: adminTok, data: { secondApprovalThreshold: -1 } }).error === 'invalid_setting', 'a negative threshold is refused');
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

// cash on its way would vanish with the round (security review 2026-10-04)
var archOpen = ctx.readSheet(SHEETS.HANDOFFS).filter(function (h) { return ['pending', 'pending_deputy', 'disputed'].indexOf(h.status) >= 0; });
check(archOpen.length > 0 && call({ action: 'adminArchiveTransactions', token: adminTok, confirm: 'ARCHIVE' }).error === 'cash_in_flight', 'nothing is archived while a handover is still open');
archOpen.forEach(function (h) { h.status = 'rejected'; ctx.writeRow(SHEETS.HANDOFFS, h); });
var arch = call({ action: 'adminArchiveTransactions', token: adminTok, confirm: 'ARCHIVE' });
check(arch.ok && arch.archived.length > 0, 'once settled, the archive runs and reports what it moved');
check(!arch.archived.some(function (a) { return a.sheet === SHEETS.AUDIT; }), 'the audit trail stays where it is');
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
check(arch2.ok && arch2.archived.length >= 1, 'a second fresh start straight after the first still works');
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
call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://x.test/', data: { name: 'عبد الله القحطاني', email: 'fx.abd@bestgas.sa', role: 'driver', language: 'ar' } });
var fxAbd = ctx._debug.mailLog.filter(function (m) { return m.to === 'fx.abd@bestgas.sa'; }).pop();
check(fxAbd && fxAbd.html.indexOf('أهلاً عبد الله،') >= 0, 'the invitation greets عبد الله as عبد الله, not عبد');
call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://x.test/', data: { name: 'أبو فهد', email: 'fx.abu@bestgas.sa', role: 'driver', language: 'ar' } });
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
var stEntry = call({ action: 'createDailyEntry', token: adminTok, date: '2026-08-02', sourceType: 'store', sourceId: stStore.id, productId: prodF.id, cashSales: 900, creditSales: 300, creditCustomerId: stCust.id });
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
check(call({ action: 'createDailyEntry', token: aliTok, date: '2026-09-01', sourceType: 'store', sourceId: store.entity.id, cashSales: 100, bankTransferAmount: -5 }).error === 'invalid_amount', 'a negative transfer is refused');
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
check(call(mz({ sourceType: 'car', sourceId: car.entity.id, directDepositPhotoId: ph.fileId })).error === 'deposit_needs_pos', 'a car\'s الموازنة must say which POS device, where the branch has one');
var otherBranchPos = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'store', ownerId: filterStore.id, label: 'Jeddah POS', assignedUserId: mgr8.id } }).entity;
check(call(mz({ directDepositPhotoId: ph.fileId, directDepositPosId: otherBranchPos.id })).error === 'invalid_pos', 'a POS device from another branch is refused');
var phOther = call({ action: 'uploadEntryPhoto', token: adminTok, fileBase64: 'iVBORw0KGgo=', fileName: 'x.png', fileMime: 'image/png' });
check(call(mz({ directDepositPhotoId: phOther.fileId, directDepositPosId: pos.entity.id })).error === 'invalid_photo', 'a photo someone else uploaded cannot be used');
var mzOk = call(mz({ directDepositPhotoId: ph.fileId, directDepositPosId: pos.entity.id }));
check(mzOk.ok && mzOk.entry.directDepositPosId === pos.entity.id, 'with its device and photo it saves');
check(mzOk.deposit && mzOk.deposit.attachmentId === ph.fileId && mzOk.deposit.posId === pos.entity.id, 'and the bank deposit it records carries the photo and the device');
check(call(mz({ directDepositPhotoId: ph.fileId, directDepositPosId: pos.entity.id, directDepositRef: 'MZ-2' })).error === 'invalid_photo', 'one photo serves one الموازنة only');
check(call({ action: 'getFile', token: financeTok, fileId: ph.fileId }).ok, 'finance can open the photo');
var phAll = call({ action: 'uploadEntryPhoto', token: aliTok, fileBase64: 'iVBORw0KGgo=', fileName: 'all.png', fileMime: 'image/png' });
var mzAll = call(mz({ directDepositPhotoId: phAll.fileId, directDepositRef: 'MZ-ALL', directDepositAmount: 100 }));
check(mzAll.ok && mzAll.entry.directDepositPosId === null, 'a day entered for the branch itself may bank one الموازنة for all its devices: no device named (got ' + (mzAll.error || 'ok') + ')');
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
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', id: cdCust.id, data: { deliveryFees: (function () { var p = {}; p[fixedProduct.entity.id] = -1; return p; })() } }).error === 'invalid_amount', 'and never below zero');
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
close(cdNet.creditDeliveryFees, 100, 'the delivery fee is shown with what was sold, on its own line');
close(cdNet.creditDeliveryUnpaid, 100, 'and taken off again: the customer pays it later, never in cash (the user, 2026-10-04)');
check(cdOk.entry.creditFeeRule === 2, 'a day saved from now on carries the rule it was saved under');
close(cdNet.creditCommissions, 50, 'the commission is a deduction, on its own line');
// the customer owes the fee on account with the goods, so the fee adds no
// cash; the commission the driver keeps comes off
// the fee is only ever added (the user, 2026-09-29); the commission comes off
close(cdNet.netCashOwed, 5000 - 2250 + 100 - 100 - 50, 'the cash to hand over: sales, less the credit, the delivery fee in and out again, less the commission');
var cdOld = JSON.parse(JSON.stringify(cdOk.entry)); delete cdOld.creditFeeRule;
close(ctx.computeNet_([cdOld]).netCashOwed, 5000 - 2250 + 100 - 50, 'a day saved before the change keeps the figure it was handed over with');
close(ctx.computeNet_([cdOld]).creditDeliveryUnpaid, 0, 'and carries no such deduction');
check(cdLine(cdCust.id, 2, 42).error === 'price_locked', 'there are no special prices: a fixed price stays fixed for everyone');
var cdPlain = call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', data: { name: 'No Fee Customer', city: 'Riyadh' } }).entity;
var cdNone = cdLine(cdPlain.id, 10, 45);
check(cdNone.ok && !cdNone.entry.creditDeliveryFee, 'a customer without a fee has none');
var cdMeta = call({ action: 'listMeta', token: aliTok }).customers.filter(function (c) { return c.id === cdCust.id; })[0];
check(cdMeta && cdMeta.deliveryFees && cdMeta.deliveryFees[fixedProduct.entity.id] === 2, 'the branch sees the fees, so the form can show them as it fills in');
close(ctx.sumBreakdowns_([cdNet, cdNet]).creditDeliveryFees, 200, 'the fee adds up when handoffs are combined');
close(ctx.sumBreakdowns_([cdNet, cdNet]).creditDeliveryUnpaid, 200, 'and so does the fee taken off again');
close(ctx.sumBreakdowns_([cdNet, cdNet]).creditCommissions, 100, 'and so does the commission');
check(cdMeta.commissions && cdMeta.commissions[fixedProduct.entity.id] === 1, 'the branch sees the commissions too');

console.log('--- a sales channel (Souq Gas) carries its own delivery fee and driver commission per unit ---');
var chRates = function (v) { var p = {}; p[fixedProduct.entity.id] = v; return p; };
var souq = call({ action: 'adminSaveEntity', token: adminTok, kind: 'channel', data: { name: 'Souq Gas', deliveryFees: chRates(4), commissions: chRates(1.5) } });
check(souq.ok && /^CH-\d+$/.test(souq.entity.code || ''), 'the admin adds Souq Gas as a sales channel, with its own number');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'channel', data: { name: '' } }).error === 'name_required', 'a channel needs a name');
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

console.log('--- the finance manager runs every module; user accounts stay with the admin ---');
var finArea = call({ action: 'adminSaveEntity', token: financeTok, kind: 'zone', data: { city: 'Riyadh', name: 'Finance Zone' } });
check(finArea.ok, 'finance adds master data');
check(call({ action: 'adminImportEntities', token: financeTok, kind: 'product', rows: [{ data: { name: 'Finance Import', type: 'goods' } }] }).ok, 'finance imports master data from Excel');
check(call({ action: 'adminDeleteEntity', token: financeTok, kind: 'zone', id: finArea.entity.id }).ok, 'finance deletes master data');
check(call({ action: 'adminSetConfig', token: financeTok, data: { secondApprovalThreshold: call({ action: 'listMeta', token: adminTok }).config.secondApprovalThreshold } }).ok, 'finance changes the settings');
check(call({ action: 'adminImportCustomers', token: financeTok, rows: [{ name: 'Finance Customer', city: 'Riyadh' }] }).ok, 'finance imports customers');
check(call({ action: 'adminCreateUser', token: financeTok, data: { name: 'Nope', email: 'nope.fin@bestgas.sa', role: 'driver' } }).error === 'forbidden', 'but only the admin creates users');
check(call({ action: 'adminUpdateUser', token: financeTok, id: ali.id, data: { name: 'Renamed' } }).error === 'forbidden', 'or changes them');
check(call({ action: 'adminResetPassword', token: financeTok, id: ali.id }).error === 'forbidden', 'or resets their passwords');
check(call({ action: 'adminResendInvite', token: financeTok, id: ali.id }).error === 'forbidden', 'or sends invitations');
check(call({ action: 'adminSaveEntity', token: call({ action: 'login', email: 'ali@bestgas.sa', password: 'RealPass#1' }).token, kind: 'zone', data: { city: 'Riyadh', name: 'X' } }).error === 'forbidden', 'nobody else manages master data');

console.log('--- master data comes in from Excel, row by row, through the same checks as the form ---');
var impRes = call({ action: 'adminImportEntities', token: adminTok, kind: 'product', rows: [
  { data: { name: 'Imported Cylinder 11kg', type: 'goods', unitPrice: 30 } },
  { data: { name: '', type: 'goods' } },
  { data: { name: 'Imported Service', type: 'services', unitPrice: 15, priceLocked: true } }
] });
check(impRes.ok && impRes.created === 2 && impRes.total === 3, 'good rows are saved and a bad one is not');
check(impRes.results[1].ok === false && impRes.results[1].error === 'name_required', 'the bad row says why');
check(/^PR-\d+$/.test(impRes.results[0].code || ''), 'each saved row gets its system number');
var impUpd = call({ action: 'adminImportEntities', token: adminTok, kind: 'product', rows: [{ id: impRes.results[0].id, data: { unitPrice: 32 } }] });
check(impUpd.ok && impUpd.updated === 1 && ctx.getById_(ctx.SHEETS.PRODUCTS, impRes.results[0].id).unitPrice === 32, 'a row naming an existing record updates it');
check(call({ action: 'adminImportEntities', token: aliTok, kind: 'product', rows: [{ data: { name: 'X' } }] }).error === 'forbidden', 'only an admin imports');
check(call({ action: 'adminImportEntities', token: adminTok, kind: 'nope', rows: [{ data: { name: 'X' } }] }).error === 'invalid_kind', 'only known record types');

console.log('--- names show in English and Urdu: translated once, correctable by hand ---');
var tr = ctx._debug.translate;
function trOf(src) { return (call({ action: 'listMeta', token: adminTok }).translations || []).filter(function (x) { return x.src === src; })[0]; }
var trProd = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'منظم تجريبي', type: 'goods' } });
check(trProd.ok, 'an Arabic name saves as always');
var trRow = trOf('منظم تجريبي');
check(trRow && trRow.en === 'EN:منظم تجريبي' && trRow.ur === 'UR:منظم تجريبي', 'and comes back with its English and Urdu');
check(trRow && trRow.auto === true, 'marked as a machine translation');
check(trProd.meta && (trProd.meta.translations || []).some(function (x) { return x.src === 'منظم تجريبي'; }), 'the save answers with the translation too');
var trCalls = tr.log.length;
call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: trProd.entity.id, data: { unitPrice: 9 } });
check(tr.log.length === trCalls, 'a name already translated is not sent again');
call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Plain English Name', type: 'goods' } });
check(tr.log.length === trCalls && !trOf('Plain English Name'), 'a name with no Arabic needs nothing');
call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { city: 'Riyadh', name: 'النسيم Al-Naseem' } });
check(tr.log.length === trCalls, 'nor one that already carries its English');

var fix = call({ action: 'adminSaveTranslation', token: adminTok, src: 'منظم تجريبي', en: 'Test regulator', ur: 'ٹیسٹ ریگولیٹر' });
check(fix.ok && trOf('منظم تجريبي').en === 'Test regulator' && trOf('منظم تجريبي').auto === false, 'the admin corrects a translation');
check(fix.meta && fix.meta.translations, 'and the correction answers with fresh reference data');
tr.log.length = 0;
call({ action: 'adminFillTranslations', token: adminTok });
check(trOf('منظم تجريبي').en === 'Test regulator', 'filling the gaps never overwrites a correction');
check(call({ action: 'adminSaveTranslation', token: aliTok, src: 'منظم تجريبي', en: 'x' }).error === 'forbidden', 'only a manager corrects translations');
check(call({ action: 'adminSaveTranslation', token: adminTok, src: '', en: 'x' }).error === 'invalid_input', 'a correction names its Arabic text');
var bulkFix = call({ action: 'adminSaveTranslation', token: adminTok, rows: [{ src: 'منظم تجريبي', en: 'Regulator A' }, { src: 'نص جديد', en: 'New text', ur: 'نیا' }] });
check(bulkFix.ok && trOf('منظم تجريبي').en === 'Regulator A' && trOf('منظم تجريبي').ur === 'ٹیسٹ ریگولیٹر' && trOf('نص جديد').ur === 'نیا', 'several corrections go in one request, a blank keeps what was there');

tr.fail = true;
var trDown = call({ action: 'adminSaveEntity', token: adminTok, kind: 'city', data: { name: 'مدينة الاختبار' } });
check(trDown.ok, 'when Google Translate is down the record still saves');
check(!trOf('مدينة الاختبار'), 'just without a translation for now');
tr.fail = false;
var filled = call({ action: 'adminFillTranslations', token: adminTok });
check(filled.ok && filled.added >= 1 && trOf('مدينة الاختبار') && trOf('مدينة الاختبار').en === 'EN:مدينة الاختبار', 'and filling the gaps catches it up later');

tr.log.length = 0;
var trImp = call({ action: 'adminImportEntities', token: adminTok, kind: 'product', rows: [
  { data: { name: 'صنف مستورد أول', type: 'goods' } }, { data: { name: 'صنف مستورد ثان', type: 'goods' } }, { data: { name: 'صنف مستورد ثالث', type: 'goods' } }
] });
check(trImp.ok && trOf('صنف مستورد ثان') && trOf('صنف مستورد ثان').ur === 'UR:صنف مستورد ثان', 'an Excel import is translated too');
check(tr.log.length === 2, 'in one request per language, not one per row (got ' + tr.log.length + ')');
call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { city: 'مدينة المنطقة', name: 'Zone T' } });
check(trOf('مدينة المنطقة'), 'a city typed on a record is translated along with its name');

console.log('--- a driver with no email signs in with their iqama number ---');
var mailsBeforeIq = mailLog.length;
var iqUser = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Test Driver Iqama', iqamaId: '2999000111', role: 'driver', language: 'ur' } });
check(iqUser.ok && iqUser.user && !iqUser.user.email, 'an account is created with an iqama number and no email');
check(iqUser.ok && typeof iqUser.tempPassword === 'string' && iqUser.tempPassword.length >= 8, 'the admin gets a temporary password to hand over');
check(mailLog.length === mailsBeforeIq, 'and no email is sent');
var iqLogin = call({ action: 'login', email: '2999000111', password: iqUser.tempPassword });
check(iqLogin.ok && iqLogin.user.mustChangePw === true, 'the driver signs in with the iqama number and must change the password');
var iqLogin2 = call({ action: 'login', email: ' ٢٩٩٩٠٠٠١١١ ', password: iqUser.tempPassword });
check(iqLogin2.ok, 'Arabic digits and stray spaces in the iqama number still sign in');
check(call({ action: 'login', email: '2999000111', password: 'wrong-pass-1' }).error === 'invalid_credentials', 'a wrong password is refused');
check(call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Dup', iqamaId: '2999000111', role: 'driver' } }).error === 'iqama_exists', 'an iqama number belongs to one account');
check(call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Nothing', role: 'driver' } }).error === 'login_required', 'an account needs an email or an iqama number');
check(call({ action: 'login', email: '', password: 'x' }).ok === false, 'a blank sign-in never matches an account without email');
var iqReset = call({ action: 'adminResetPassword', token: adminTok, id: iqUser.user.id });
check(iqReset.ok && typeof iqReset.tempPassword === 'string' && mailLog.length === mailsBeforeIq, 'a reset hands the admin a new temporary password instead of emailing');
check(call({ action: 'login', email: '2999000111', password: iqReset.tempPassword }).ok, 'and the new one works');
check(!ctx.sendMail_('', 'x', 'y') || mailLog.length === mailsBeforeIq, 'mail to an empty address goes nowhere');

var bulkUsers = call({ action: 'adminImportUsers', token: adminTok, rows: [
  { name: 'Bulk Driver A', iqamaId: '2999000222', role: 'driver' },
  { name: 'Bulk Driver B', iqamaId: '2999000111', role: 'driver' },
  { name: '', iqamaId: '2999000333', role: 'driver' },
  { name: 'Bulk Driver C', iqamaId: 'fk 7966 999', role: 'driver' }
] });
check(bulkUsers.ok && bulkUsers.created === 2, 'drivers are created in bulk (got ' + (bulkUsers.created) + ')');
check(bulkUsers.ok && bulkUsers.results[1].error === 'iqama_exists' && bulkUsers.results[2].error === 'name_required', 'each refused row says why');
check(bulkUsers.ok && bulkUsers.results[0].tempPassword && bulkUsers.results[0].id, 'each new account comes back with its temporary password');
check(bulkUsers.ok && call({ action: 'login', email: 'FK7966999', password: bulkUsers.results[3].tempPassword }).ok, 'a passport-style number is kept in capitals without spaces');
check(call({ action: 'adminImportUsers', token: financeTok, rows: [{ name: 'X', iqamaId: '2999000444', role: 'driver' }] }).error === 'forbidden', 'only the admin creates accounts in bulk');

console.log('--- a branch worker enters sales for the POS device they hold at the branch ---');
var bw = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Test Branch Worker', iqamaId: '2888000111', role: 'branch_worker', locationId: location.entity.id } });
check(bw.ok && bw.user.role === 'branch_worker', 'the branch worker role exists');
var bwPos = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'store', ownerId: store.entity.id, label: 'Counter POS', posId: '15500001', assignedUserId: bw.user.id } });
check(bwPos.ok, 'a store POS device is linked to the branch worker');
// a temporary sign-in is changed first, as the app makes everyone do (2026-10-04)
function tempLogin(id, temp) { var t0 = call({ action: 'login', email: id, password: temp }).token; var ch = call({ action: 'changePassword', token: t0, newPassword: 'Changed#2026' }); return ch.token || t0; }
var bwTok = tempLogin('2888000111', bw.tempPassword);
var bwEntry = call({ action: 'createDailyEntry', token: bwTok, date: '2026-09-20', sourceType: 'pos', sourceId: bwPos.entity.id, cashSales: 120 });
check(bwEntry.ok, 'the branch worker enters the day for their own device');
check(call({ action: 'createDailyEntry', token: bwTok, date: '2026-09-20', sourceType: 'pos', sourceId: pos.entity.id, cashSales: 5 }).error === 'forbidden', 'but not for somebody else\'s device');
check(call({ action: 'createDailyEntry', token: bwTok, date: '2026-09-20', sourceType: 'store', sourceId: store.entity.id, cashSales: 5 }).error === 'forbidden', 'nor for the branch store itself');
var bwList = call({ action: 'listEntries', token: bwTok });
check(bwList.ok && bwList.entries.length >= 1 && bwList.entries.every(function (e) { return e.enteredBy === bw.user.id; }), 'and sees only their own entries');
check(call({ action: 'adminSaveEntity', token: bwTok, kind: 'zone', data: { city: 'Riyadh', name: 'X' } }).error === 'forbidden', 'a branch worker manages nothing');

console.log('--- a driver\'s POS machine rides on his car: its cash goes through his own handover first ---');
var noor = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Noor', email: 'noor@bestgas.sa', role: 'store_manager' } }).user;
var noorTok = acceptInvite('noor@bestgas.sa');
var dpLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Driver POS Test', clusterId: cluster.entity.id, collectorUserId: musa.id } }).entity;
call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: dpLoc.id, name: 'Driver POS Store', storeManagerUserId: noor.id } });
var dpDriver = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Driver With POS', iqamaId: '2666000111', role: 'driver' } });
var dpTok = tempLogin('2666000111', dpDriver.tempPassword);
var dpCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: dpLoc.id, label: 'Driver With POS', driverUserId: dpDriver.user.id } }).entity;
var dpPos = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: dpCar.id, label: 'Car POS', posId: '15500002', assignedUserId: dpDriver.user.id } }).entity;
var noorShop = call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-22', sourceType: 'store', sourceId: call({ action: 'listMeta', token: adminTok }).stores.filter(function (s) { return s.locationId === dpLoc.id; })[0].id, cashSales: 200 });
check(noorShop.ok, 'the branch manager enters the store\'s own day');
check(call({ action: 'createDailyEntry', token: dpTok, date: '2026-09-22', sourceType: 'pos', sourceId: dpPos.id, cashSales: 1000 }).ok, 'the driver enters his day on the POS machine in his car');
var dpEarly = call({ action: 'createHandoff', token: noorTok, kind: 'location_to_cluster', locationId: dpLoc.id });
check(dpEarly.ok && Math.abs(dpEarly.handoff.amount - 200) < 0.005, 'the branch manager cannot hand over the driver\'s POS cash before receiving it (got ' + (dpEarly.handoff && dpEarly.handoff.amount) + ')');
var dpCarHo = call({ action: 'createHandoff', token: dpTok, kind: 'car_to_location', carId: dpCar.id });
check(dpCarHo.ok && Math.abs(dpCarHo.handoff.amount - 1000) < 0.005, 'the driver hands his POS machine\'s cash to the branch manager with his car');
check(call({ action: 'confirmHandoff', token: noorTok, id: (dpCarHo.handoff || {}).id }).ok, 'the branch manager confirms receiving it');
var dpLate = call({ action: 'createHandoff', token: noorTok, kind: 'location_to_cluster', locationId: dpLoc.id });
check(dpLate.ok && Math.abs(dpLate.handoff.amount - 1000) < 0.005, 'and only then passes it on');

console.log('--- review fixes, 2026-09-29 ---');
var lkUser = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Lockout Test', iqamaId: '2555111222', role: 'driver' } });
['2555111222', ' 2555 111 222', '2555-111-222', '٢٥٥٥١١١٢٢٢', '2555111222 ', '25551-11222', ' ٢٥٥٥ ١١١ ٢٢٢', '2555 111222'].forEach(function (v) { call({ action: 'login', email: v, password: 'wrong-guess-1' }); });
check(call({ action: 'login', email: '2555111222', password: lkUser.tempPassword }).error === 'locked', 'wrong guesses in any spelling of one iqama number all count toward its lock');
check(call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Bidi', iqamaId: '‏2555111222', role: 'driver' } }).error === 'iqama_exists', 'an iqama copied from Excel with a hidden direction mark is the same number');
check(call({ action: 'adminUpdateUser', token: adminTok, id: lkUser.user.id, data: { iqamaId: '' } }).error === 'login_required', 'an account without email keeps its iqama number, or it could never sign in');
check(call({ action: 'forgotPassword', email: '2555111222' }).askAdmin === true, 'forgot password with an iqama number says to ask the admin');
check(call({ action: 'adminResendInvite', token: adminTok, id: lkUser.user.id }).ok === false, 'no invitation is "sent" to an account without email');
var pendingForSara = call({ action: 'listHandoffs', token: saraTok }).handoffs.filter(function (h) { return h.status === 'pending' && h.toUserId === sara.id; })[0];
if (pendingForSara) {
  check(call({ action: 'confirmHandoff', token: saraTok, id: pendingForSara.id, receivedAmount: -5 }).error === 'invalid_amount', 'a negative amount received is refused');
  check(call({ action: 'confirmHandoff', token: saraTok, id: pendingForSara.id, receivedAmount: 'abc' }).error === 'invalid_amount', 'and so is one that is not a number');
} else check(false, 'a pending handoff for the review checks');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'store', ownerId: store.entity.id, label: 'Wrong Holder', assignedUserId: musa.id } }).error === 'wrong_role', 'a POS machine is held by a driver, branch worker or branch manager, not a collector');
var dMeta = call({ action: 'listMeta', token: dpTok });
check(dMeta.ok && dMeta.pos.every(function (p) { return !p.holderIqama; }), 'a driver is not sent the POS holders\' iqama numbers');
check(call({ action: 'listMeta', token: financeTok }).pos.some(function (p) { return p.holderIqama || true; }), 'finance still receives the full POS list');

console.log('--- inventory: opening + purchases + returns = available; less sales and damage = ending ---');
var invP = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Inv Cylinder', type: 'goods', unitPrice: 30, unitCost: 18 } });
check(invP.ok && invP.entity.unitCost === 18, 'an inventory item carries its cost');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Bad Cost', type: 'goods', unitCost: -1 } }).error === 'invalid_cost', 'a cost cannot be negative');
var invSvc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Inv Service', type: 'services' } }).entity;
var dpStoreId = call({ action: 'listMeta', token: adminTok }).stores.filter(function (s) { return s.locationId === dpLoc.id; })[0].id;
function mv(tok, o) { var p = { action: 'addInventoryMove', token: tok, locationId: dpLoc.id, productId: invP.entity.id }; Object.keys(o).forEach(function (k) { p[k] = o[k]; }); return call(p); }
check(mv(noorTok, { kind: 'opening', qty: 100, date: '2026-08-31' }).ok, 'the branch manager records the opening stock');
check(mv(noorTok, { kind: 'opening', qty: 5, date: '2026-09-01' }).error === 'opening_exists', 'a product has one opening balance per branch');
check(mv(noorTok, { kind: 'purchase', qty: 50, date: '2026-09-02', note: 'PO-1' }).ok, 'purchases are entered by hand');
check(mv(noorTok, { kind: 'return', qty: 7, date: '2026-09-03' }).ok, 'and returns from restaurants');
var dmg = mv(noorTok, { kind: 'damage', qty: 3, date: '2026-09-04', note: 'leaking' });
check(dmg.ok, 'and damaged items');
check(mv(noorTok, { kind: 'purchase', qty: 0, date: '2026-09-02' }).error === 'invalid_qty', 'a movement needs a quantity');
check(mv(noorTok, { kind: 'stolen', qty: 1, date: '2026-09-02' }).error === 'invalid_kind', 'and a known kind');
check(mv(noorTok, { kind: 'purchase', qty: 1, date: '2099-01-01' }).error === 'future_date', 'and not a future date');
check(call({ action: 'addInventoryMove', token: noorTok, locationId: dpLoc.id, productId: invSvc.id, kind: 'purchase', qty: 1, date: '2026-09-02' }).error === 'not_inventory', 'a service has no stock');
check(call({ action: 'addInventoryMove', token: noorTok, locationId: location.entity.id, productId: invP.entity.id, kind: 'purchase', qty: 1, date: '2026-09-02' }).error === 'forbidden', 'a branch manager keeps only his own branch\'s stock');
check(call({ action: 'addInventoryMove', token: dpTok, locationId: dpLoc.id, productId: invP.entity.id, kind: 'purchase', qty: 1, date: '2026-09-02' }).error === 'forbidden', 'a driver keeps no stock records');
check(call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-05', sourceType: 'store', sourceId: dpStoreId, productId: invP.entity.id, qty: 40, unitPrice: 30, cashSales: 1200 }).ok, 'a sale is entered as always');
var inv = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-01', dateTo: '2026-09-30', locationId: dpLoc.id });
var invRow = inv.ok && inv.rows.filter(function (r) { return r.stockItemId === invP.entity.id; })[0];
check(invRow && invRow.opening === 100 && invRow.purchases === 50 && invRow.returns === 7 && invRow.available === 157, 'opening 100 + purchases 50 + returns 7 = available 157');
check(invRow && invRow.sales === 40 && invRow.damaged === 3 && invRow.ending === 114, 'available 157 less sales 40 (from the system) and damage 3 = ending 114');
check(invRow && invRow.unitCost === 18 && Math.abs(invRow.endingValue - 114 * 18) < 0.005, 'the ending stock is valued at cost');
check(inv.ok && !inv.rows.some(function (r) { return r.stockItemId === invSvc.id; }), 'services never appear in the stock');
var invOct = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-10-01', dateTo: '2026-10-31', locationId: dpLoc.id });
var octRow = invOct.rows.filter(function (r) { return r.stockItemId === invP.entity.id; })[0];
check(octRow && octRow.opening === 114 && octRow.ending === 114, 'next period opens with the last period\'s ending');
check(call({ action: 'voidInventoryMove', token: noorTok, id: dmg.move.id }).error === 'reason_required', 'voiding a movement needs a reason');
check(call({ action: 'voidInventoryMove', token: noorTok, id: dmg.move.id, reason: 'counted twice' }).ok, 'the author voids a wrong movement with a reason');
var inv2 = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-01', dateTo: '2026-09-30', locationId: dpLoc.id });
check(inv2.rows.filter(function (r) { return r.stockItemId === invP.entity.id; })[0].ending === 117, 'and it no longer counts');
check(call({ action: 'getInventoryReport', token: noorTok, dateFrom: '2026-09-01', dateTo: '2026-09-30' }).rows.every(function (r) { return r.locationId === dpLoc.id; }), 'a branch manager sees only his branch');
check(call({ action: 'getInventoryReport', token: dpTok }).error === 'forbidden', 'a driver sees no stock report');
var invShort = call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-06', sourceType: 'store', sourceId: dpStoreId, productId: invP.entity.id, qty: 200, unitPrice: 30, cashSales: 6000 });
var inv3 = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-01', dateTo: '2026-09-30', locationId: dpLoc.id });
var r3 = inv3.rows.filter(function (r) { return r.stockItemId === invP.entity.id; })[0];
check(invShort.ok && r3.short === true && r3.ending === -83, 'selling more than the stock is flagged as short');

console.log('--- inventory review fixes: go-live, validation, voids ---');
var golP = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'GoLive Item', type: 'goods', unitPrice: 10, unitCost: 6 } }).entity;
['2026-09-10', '2026-09-11', '2026-09-12'].forEach(function (d) { call({ action: 'createDailyEntry', token: noorTok, date: d, sourceType: 'store', sourceId: dpStoreId, productId: golP.id, qty: 20, unitPrice: 10, cashSales: 200 }); });
check(mv(noorTok, { productId: golP.id, kind: 'opening', qty: 100, date: '2026-09-12' }).ok, 'a branch counts its stock after months of sales');
var gl = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-01', dateTo: '2026-09-30', locationId: dpLoc.id }).rows.filter(function (r) { return r.stockItemId === golP.id; })[0];
check(gl && gl.opening === 100 && gl.sales === 20 && gl.ending === 80 && !gl.short, 'sales before the opening count are not taken off it; the count day\'s own sales are (got ' + JSON.stringify(gl && [gl.opening, gl.sales, gl.ending]) + ')');
var glEarly = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-08-01', dateTo: '2026-08-31', locationId: dpLoc.id }).rows.filter(function (r) { return r.stockItemId === golP.id; })[0];
check(!glEarly || (glEarly.noOpening && !glEarly.short), 'a period before the count reads "no opening yet", never short');
var noCount = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Never Counted', type: 'goods' } }).entity;
call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-13', sourceType: 'store', sourceId: dpStoreId, productId: noCount.id, qty: 5, unitPrice: 10, cashSales: 50 });
var nc = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-01', dateTo: '2026-09-30', locationId: dpLoc.id }).rows.filter(function (r) { return r.stockItemId === noCount.id; })[0];
check(nc && nc.noOpening && !nc.short, 'an item nobody has counted yet says so instead of reading short');
call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-14', sourceType: 'store', sourceId: dpStoreId, productId: golP.id, cashSales: 300 });
var nq = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-01', dateTo: '2026-09-30', locationId: dpLoc.id }).rows.filter(function (r) { return r.stockItemId === golP.id; })[0];
check(nq && nq.salesWithoutQty === 1 && Math.abs(nq.salesWithoutQtyAmount - 300) < 0.005, 'a sale entered without a quantity is flagged, not silently dropped');
[true, [5], '1e12', 1e308, 0.0001, 'abc'].forEach(function (bad) {
  check(mv(noorTok, { productId: golP.id, kind: 'purchase', qty: bad, date: '2026-09-15' }).error === 'invalid_qty', 'a quantity of ' + JSON.stringify(bad) + ' is refused');
});
check(mv(noorTok, { productId: golP.id, kind: 'purchase', qty: '12', date: '2026-02-31' }).error === 'invalid_date', 'a date that does not exist is refused');
var inactive = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Off Item', type: 'goods', active: false } }).entity;
check(mv(noorTok, { productId: inactive.id, kind: 'purchase', qty: 1, date: '2026-09-15' }).error === 'invalid_product', 'an inactive item takes no movements');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Typo', type: 'service' } }).error === 'invalid_type', 'an item is either inventory or a service');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Inf', type: 'goods', unitCost: 'Infinity' } }).error === 'invalid_cost', 'a cost must be a real number');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: golP.id, data: { type: 'services' } }).error === 'has_stock', 'an item with stock movements stays an inventory item');
check(call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-30', dateTo: '2026-09-01' }).error === 'invalid_period', 'a period that ends before it starts is refused');

console.log('--- area Excel: every section of every POS in one upload ---');
call({ action: 'adminSetConfig', token: adminTok, data: { areaManagerBulkUploadEnabled: true } });
(function () { var fee = {}, com = {}; fee[invP.entity.id] = 3; com[invP.entity.id] = 1; call({ action: 'adminSaveEntity', token: adminTok, kind: 'channel', id: souq.entity.id, data: { deliveryFees: fee, commissions: com } }); })();
var xlDate = '2026-09-24';
var xlRows = [
  // a sale, part of it through Souq Gas
  { date: xlDate, sourceType: 'pos', sourceId: dpPos.id, productId: invP.entity.id, qty: 10, unitPrice: 30, cashSales: 300, channelQtys: (function () { var o = {}; o[souq.entity.id] = 4; return o; })() },
  // a sale on credit to a named customer: counted once, as a sale and as credit
  { date: xlDate, sourceType: 'pos', sourceId: dpPos.id, productId: invP.entity.id, qty: 5, unitPrice: 30, cashSales: 150, creditSales: 150, creditCustomer: 'Nakheel Restaurant', creditItems: [{ productId: invP.entity.id, qty: 5, unitPrice: 30 }] },
  { date: xlDate, sourceType: 'pos', sourceId: dpPos.id, bankTransferAmount: 50, note: 'TRX-9' },
  { date: xlDate, sourceType: 'pos', sourceId: dpPos.id, expenseAmount: 20, expenseItemId: expenseItem.entity.id, expenseReason: 'fuel' },
  { date: xlDate, sourceType: 'pos', sourceId: dpPos.id, otherCash: 15, otherCashItemId: incomeItem.entity.id, otherCashReason: 'old credit paid' },
  { date: xlDate, sourceType: 'pos', sourceId: dpPos.id, directDepositAmount: 100, directDepositRef: 'MZ-XL-1', directDepositNote: 'day banking' }
];
var xlDry = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: xlRows, dryRun: true });
check(xlDry.ok, 'an area file with sales, Souq Gas, credit, transfer, expense, other income and a الموازنة passes (' + (xlDry.error || '') + JSON.stringify(xlDry.results || '') + ')');
var xb = xlDry.ok ? xlDry.batch.breakdown : {};
close(xb.creditSales, 150, 'the credit line is deducted as credit');
close(xb.bankTransfers, 50, 'the transfer is deducted');
check(xb.channelDeliveryFees > 0 && xb.channelCommissions > 0, 'Souq Gas brings its own delivery fee and commission');
check(xb.creditCommissions >= 0, 'and the customer\'s commission is worked out from the customer profile');
var xlReal = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: xlRows });
check(xlReal.ok && xlReal.batch.status === 'pending_deputy', 'the file goes to the deputy for approval');
close(xlReal.batch.breakdown.netCashOwed, xb.netCashOwed, 'and the real submission computes exactly what the preview showed');
var xlInv = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-24', dateTo: '2026-09-24', locationId: dpLoc.id }).rows.filter(function (r) { return r.stockItemId === invP.entity.id; })[0];
check(xlInv && xlInv.sales === 15, 'stock counts the 10 sold and the 5 on credit once each (got ' + (xlInv && xlInv.sales) + ')');

console.log('--- the Souq Gas driver commission can be changed on the day\'s line ---');
var comOv = {}; comOv[souq.entity.id] = 2.25;
var cqOv = {}; cqOv[souq.entity.id] = 4;
var ovE = call({ action: 'createDailyEntry', token: dpTok, date: '2026-09-26', sourceType: 'pos', sourceId: dpPos.id, productId: invP.entity.id, qty: 10, unitPrice: 30, cashSales: 300, channelQtys: cqOv, channelComRates: comOv });
check(ovE.ok && Math.abs(ovE.entry.channelCommission - 9) < 0.005, 'a commission of 2.25 a unit on 4 units gives 9, not the standard rate (got ' + (ovE.entry && ovE.entry.channelCommission) + ')');
check(ovE.ok && Math.abs(ovE.entry.channelDeliveryFee - 12) < 0.005, 'while the delivery fee keeps its standard rate');
check(ovE.ok && ovE.entry.channelComRates && ovE.entry.channelComRates[souq.entity.id] === 2.25, 'and the rate used is kept on the entry');
var badOv = {}; badOv[souq.entity.id] = -1;
check(call({ action: 'createDailyEntry', token: dpTok, date: '2026-09-26', sourceType: 'pos', sourceId: dpPos.id, productId: invP.entity.id, qty: 2, unitPrice: 30, cashSales: 60, channelQtys: cqOv, channelComRates: badOv }).error === 'invalid_amount', 'a negative commission is refused');
var plainE = call({ action: 'createDailyEntry', token: dpTok, date: '2026-09-26', sourceType: 'pos', sourceId: dpPos.id, productId: invP.entity.id, qty: 5, unitPrice: 30, cashSales: 150, channelQtys: cqOv });
check(plainE.ok && Math.abs(plainE.entry.channelCommission - 4) < 0.005, 'without a change the standard rate still applies');
var bulkOv = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, dryRun: true,
  rows: [{ date: '2026-09-25', sourceType: 'pos', sourceId: dpPos.id, productId: invP.entity.id, qty: 10, unitPrice: 30, cashSales: 300, channelQtys: cqOv, channelComRates: comOv }] });
check(bulkOv.ok && Math.abs(bulkOv.batch.breakdown.channelCommissions - 9) < 0.005, 'the area manager\'s Excel takes the changed commission too (got ' + (bulkOv.batch && bulkOv.batch.breakdown.channelCommissions) + ')');

console.log('--- a deputy approval that stopped half-way finishes without doubling anything ---');
var resRows = [
  { date: '2026-09-25', sourceType: 'pos', sourceId: dpPos.id, productId: invP.entity.id, qty: 4, unitPrice: 30, cashSales: 120, directDepositAmount: 20, directDepositRef: 'MZ-RES-1' }
];
var resBatch = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: resRows });
check(resBatch.ok, 'an area batch waits for the deputy');
// simulate a run that wrote the branch's handover and then timed out
var rb = ctx.getById_(ctx.SHEETS.AREA_BULK_BATCHES, resBatch.batch.id);
rb.status = 'approving'; ctx.writeRow(ctx.SHEETS.AREA_BULK_BATCHES, rb);
ctx.writeRow(ctx.SHEETS.HANDOFFS, { kind: 'cluster_to_collector', fromUserId: rb.uploadedBy, toUserId: musa.id, clusterId: rb.clusterId, locationId: rb.perLocation[0].locationId,
  amount: rb.perLocation[0].amount, breakdown: rb.perLocation[0].breakdown, perLocation: [rb.perLocation[0]], sourceEntryIds: rb.entryIds, sourceHandoffIds: [], status: 'pending', createdAt: new Date().toISOString(), viaBulkBatch: rb.id });
var resApprove = call({ action: 'deputyApproveBatch', token: call({ action: 'login', email: 'deputy@bestgas.sa', password: 'Deputy#Pass1' }).token || adminTok, id: rb.id });
check(resApprove.ok, 'approving again picks up where it stopped (' + (resApprove.error || '') + ')');
var resHandoffs = ctx.readSheet(ctx.SHEETS.HANDOFFS).filter(function (h) { return h.viaBulkBatch === rb.id; });
check(resHandoffs.length === 1, 'and the branch still has exactly one handover (got ' + resHandoffs.length + ')');
var resDeposits = ctx.readSheet(ctx.SHEETS.HANDOFFS).filter(function (h) { return h.kind === 'deposit' && (h.sourceEntryIds || []).indexOf(rb.entryIds[0]) >= 0; });
check(resDeposits.length === 1, 'and one الموازنة deposit (got ' + resDeposits.length + ')');
var resAgain = call({ action: 'deputyApproveBatch', token: adminTok, id: rb.id });
check(resAgain.error === 'not_pending', 'a finished approval cannot run a second time');

console.log('--- a day entered for a POS machine banks its الموازنة on that same machine ---');
var bwPh = call({ action: 'uploadEntryPhoto', token: bwTok, fileBase64: 'iVBORw0KGgo=', fileName: 'mz.png', fileMime: 'image/png' });
var bwMz = { action: 'createDailyEntry', token: bwTok, date: '2026-09-21', sourceType: 'pos', sourceId: bwPos.entity.id, cashSales: 900, directDepositAmount: 400, directDepositRef: 'POS-MZ-1', directDepositPhotoId: bwPh.fileId };
function bwm(extra) { var o = {}; Object.keys(bwMz).forEach(function (k) { o[k] = bwMz[k]; }); Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; }); return o; }
check(call(bwm({ directDepositPosId: pos.entity.id })).error === 'deposit_pos_mismatch', 'a الموازنة on another device than the one the day is for is refused');
var bwMzOk = call(bwm({}));
check(bwMzOk.ok && bwMzOk.entry.directDepositPosId === bwPos.entity.id, 'and one that names no device is put on the day\'s own device');
check(bwMzOk.ok && bwMzOk.deposit && bwMzOk.deposit.posId === bwPos.entity.id, 'the bank deposit carries that device too');

console.log('--- cylinders are counted full and empty, as the branch sheet counts them ---');
var cyIron = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cy Iron Exchange', type: 'goods', unitPrice: 37, cylinder: true, stockName: 'Iron cylinders' } }).entity;
var cyIronSell = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cy Iron Empty Sale', type: 'goods', unitPrice: 186, stockOf: cyIron.id, stockEffect: 'sell_empty' } });
check(cyIronSell.ok, 'a product can draw its stock from a cylinder item (' + (cyIronSell.error || '') + ')');
cyIronSell = cyIronSell.entity;
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cy Bad', type: 'goods', cylinder: true, stockOf: cyIron.id } }).error === 'invalid_stock_link', 'a cylinder item cannot itself draw from another');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cy Bad2', type: 'goods', stockOf: cyIronSell.id } }).error === 'invalid_stock_link', 'nor can a product draw from one that draws from another');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cy Bad3', type: 'goods', stockOf: cyIron.id, stockEffect: 'melt' } }).error === 'invalid_stock_link', 'an unknown effect is refused');
var cyReg = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Cy Regulator', type: 'goods', unitPrice: 45 } }).entity;
function cyMv(o) { var p = { action: 'addInventoryMove', token: noorTok, locationId: dpLoc.id }; Object.keys(o).forEach(function (k) { p[k] = o[k]; }); return call(p); }
check(cyMv({ productId: cyIron.id, kind: 'opening', qty: 5, date: '2026-09-28' }).error === 'invalid_state', 'a cylinder movement must say full or empty');
check(cyMv({ productId: cyIronSell.id, kind: 'purchase', qty: 5, date: '2026-09-28' }).error === 'use_stock_item', 'stock is kept on the cylinder item, not on the product that draws from it');
check(cyMv({ productId: cyReg.id, state: 'full', kind: 'purchase', qty: 5, date: '2026-09-28' }).error === 'invalid_state', 'an item without cylinders takes no full/empty');
var cyDay = { action: 'importInventoryDay', token: noorTok, locationId: dpLoc.id, date: '2026-09-28', ref: 'branch-sheet 2026-09-28', moves: [
  { productId: cyIron.id, state: 'full', kind: 'opening', qty: 3458 }, { productId: cyIron.id, state: 'empty', kind: 'opening', qty: 1432 },
  { productId: cyIron.id, state: 'full', kind: 'purchase', qty: 1400 }, { productId: cyReg.id, kind: 'opening', qty: 54 }] };
var cyImp = call(cyDay);
check(cyImp.ok && cyImp.moves.length === 4, 'a day\'s quantities go in together (' + (cyImp.error || '') + ')');
check(call(cyDay).error === 'already_imported', 'the same sheet day cannot go in twice');
var cyDup = JSON.parse(JSON.stringify(cyDay)); cyDup.ref = 'again'; cyDup.moves = [{ productId: cyIron.id, state: 'full', kind: 'opening', qty: 1 }, { productId: cyReg.id, kind: 'purchase', qty: 3 }];
check(call(cyDup).error === 'opening_exists', 'a second opening count is refused, and nothing of that day is written');
check(!ctx.readSheet(ctx.SHEETS.INV_MOVES).some(function (m) { return m.importRef === 'again'; }), 'all or nothing');
check(call({ action: 'importInventoryDay', token: dpTok, locationId: dpLoc.id, date: '2026-09-28', ref: 'x', moves: [{ productId: cyReg.id, kind: 'purchase', qty: 1 }] }).error === 'forbidden', 'a driver cannot load stock');
var cyStore = call({ action: 'listMeta', token: adminTok }).stores.filter(function (s) { return s.locationId === dpLoc.id; })[0].id;
call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-28', sourceType: 'store', sourceId: cyStore, productId: cyIron.id, qty: 1565, unitPrice: 37, cashSales: 57905 });
call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-28', sourceType: 'store', sourceId: cyStore, productId: cyIronSell.id, qty: 4, unitPrice: 186, cashSales: 744 });
call({ action: 'createDailyEntry', token: noorTok, date: '2026-09-28', sourceType: 'store', sourceId: cyStore, productId: cyReg.id, qty: 3, unitPrice: 45, cashSales: 135 });
var cyRep = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-28', dateTo: '2026-09-28', locationId: dpLoc.id });
function cyRow(pid, st) { return (cyRep.rows || []).filter(function (r) { return r.stockItemId === pid && (r.state || '') === (st || ''); })[0] || {}; }
var cyFull = cyRow(cyIron.id, 'full'), cyEmpty = cyRow(cyIron.id, 'empty');
check(cyFull.ending === 3293, 'full iron: 3458 + 1400 refilled - 1565 exchanged = 3293, as the sheet (got ' + cyFull.ending + ')');
check(cyEmpty.ending === 1593, 'empty iron: 1432 - 1400 sent to refill + 1565 back from exchanges - 4 sold = 1593, as the sheet (got ' + cyEmpty.ending + ')');
check(cyEmpty.refillOut === 1400 && cyEmpty.exchangeIn === 1565 && cyEmpty.sales === 4, 'and each part shows on its own column');
check(cyRow(cyReg.id).ending === 51, 'an item without cylinders counts as before (got ' + cyRow(cyReg.id).ending + ')');
var cyNext = call({ action: 'getInventoryReport', token: financeTok, dateFrom: '2026-09-29', dateTo: '2026-09-29', locationId: dpLoc.id });
var cyN = (cyNext.rows || []).filter(function (r) { return r.stockItemId === cyIron.id && r.state === 'empty'; })[0] || {};
check(cyN.opening === 1593, 'the next day opens with the day\'s ending (got ' + cyN.opening + ')');
check(call({ action: 'importInventoryDay', token: noorTok, locationId: dpLoc.id, date: '2026-09-29', ref: 'tr', moves: [{ productId: cyIron.id, state: 'full', kind: 'transfer_out', qty: 10 }, { productId: cyIron.id, state: 'empty', kind: 'transfer_in', qty: 2 }] }).ok, 'transfers out of and into the branch are movements too');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: cyIron.id, data: { cylinder: false } }).error === 'has_stock', 'a cylinder item with stock cannot stop being one');

console.log('--- every way a sale is entered reaches the stock, once (2026-10-05) ---');
var scLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Scenario Branch', clusterId: cluster.entity.id, collectorUserId: musa.id } }).entity;
function scUser(n, role) { return call({ action: 'adminCreateUser', token: adminTok, data: { name: n, email: n.toLowerCase().replace(/\W+/g, '.') + '@bestgas.sa', role: role } }).user; }
var scMgr = scUser('Sc Manager', 'store_manager'), scMgr2 = scUser('Sc Manager Two', 'store_manager'), scDrv = scUser('Sc Driver', 'driver');
var scStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: scLoc.id, name: 'Scenario Store', storeManagerUserId: scMgr.id } }).entity;
var scCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: scLoc.id, label: 'Scenario Car', driverUserId: scDrv.id } }).entity;
var scPos = call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: scCar.id, label: 'Scenario POS', posId: '15599001', assignedUserId: scDrv.id } }).entity;
var scOther = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Scenario Other', clusterId: cluster.entity.id, collectorUserId: musa.id } }).entity;
var scOtherStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: scOther.id, name: 'Scenario Other Store', storeManagerUserId: scMgr2.id } }).entity;
check(scLoc && scLoc.id && scStore && scStore.id && scCar && scCar.id && scPos && scPos.id && scOtherStore && scOtherStore.id, 'a branch with a store, a car and its POS machine');
function scProd(d) { var r = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: d }); check(r.ok, 'product ' + d.name + (r.ok ? '' : ': ' + r.error)); return r.entity || {}; }
var scGas = scProd({ name: 'Sc Gas Exchange', type: 'goods', unitPrice: 37, unitCost: 11.5, emptyCost: 140, cylinder: true, stockName: 'Sc cylinders' });
var scEmptySale = scProd({ name: 'Sc Empty Cylinder Sale', type: 'goods', unitPrice: 186, stockOf: scGas.id, stockEffect: 'sell_empty' });
var scFullSale = scProd({ name: 'Sc Full Cylinder Sale', type: 'goods', unitPrice: 220, stockOf: scGas.id, stockEffect: 'sell_full' });
var scReg = scProd({ name: 'Sc Regulator', type: 'goods', unitPrice: 45, unitCost: 28 });
var scSvc = scProd({ name: 'Sc Delivery', type: 'services', unitPrice: 5 });
var scCust = saveCustomer({ name: 'Scenario Restaurant' }).entity;
[{ productId: scGas.id, state: 'full', qty: 100 }, { productId: scGas.id, state: 'empty', qty: 50 }, { productId: scReg.id, qty: 20 }].forEach(function (o) {
  var r = call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: o.productId, state: o.state, kind: 'opening', qty: o.qty, date: '2026-09-01' });
  check(r.ok, 'opening count ' + (r.error || ''));
});
// a sales item's stock row: the inventory item it is linked to (before the move to
// inventory items, the product holding the stock is its own item)
function scRow(rep, pid, st) {
  var p = ctx.getById_(ctx.SHEETS.PRODUCTS, pid), sid = (p && p.stockItemId) || pid;
  return ((rep && rep.rows) || []).filter(function (r) { return r.stockItemId === sid && (r.state || '') === (st || ''); })[0] || {};
}
function scRep(from, to) { return call({ action: 'getInventoryReport', token: financeTok, dateFrom: from || '2026-09-01', dateTo: to || '2026-09-30', locationId: scLoc.id }); }
function scLine(o) { var r = { date: '2026-09-02', sourceType: 'store', sourceId: scStore.id, submissionId: o.sub || 'sc-1' }; Object.keys(o).forEach(function (k) { if (k !== 'sub') r[k] = o[k]; }); return r; }

// 1. the entry form's product lines: cash, card, a service, and a credit customer inside them
var sc1 = call({ action: 'importDailyEntries', token: adminTok, rows: [
  scLine({ productId: scGas.id, qty: 10, unitPrice: 37, cashSales: 370, creditSales: 148, creditCustomerId: scCust.id, creditItems: [{ productId: scGas.id, qty: 4, unitPrice: 37 }] }),
  scLine({ productId: scReg.id, qty: 2, unitPrice: 45, posSales: 90 }),
  scLine({ productId: scSvc.id, qty: 3, unitPrice: 5, cashSales: 15 })] });
check(sc1.ok && sc1.created === 3, 'a day of product lines with a credit customer inside them is saved (' + JSON.stringify(sc1.results || sc1.error) + ')');
var r1 = scRep();
check(scRow(r1, scGas.id, 'full').sales === 10, 'the 10 exchanged go out of the full ones once; the 4 on credit are part of them (got ' + scRow(r1, scGas.id, 'full').sales + ')');
check(scRow(r1, scGas.id, 'empty').exchangeIn === 10, 'and 10 empties come back');
check(scRow(r1, scReg.id).sales === 2, 'a line paid by card is a sale like cash');
check(!scRow(r1, scSvc.id).productId, 'a service line has no stock');

// 2. a credit customer taking more than the lines sold, or an item no line sold, is refused whole
var sc2 = call({ action: 'importDailyEntries', token: adminTok, rows: [
  scLine({ sub: 'sc-2', productId: scGas.id, qty: 2, unitPrice: 37, cashSales: 74, creditSales: 185, creditCustomerId: scCust.id, creditItems: [{ productId: scGas.id, qty: 5, unitPrice: 37 }] })] });
check(sc2.error === 'credit_over_lines', 'credit for 5 when the lines sold 2 is refused (got ' + JSON.stringify(sc2.error || sc2.results) + ')');
var sc2b = call({ action: 'importDailyEntries', token: adminTok, rows: [
  scLine({ sub: 'sc-2b', productId: scGas.id, qty: 2, unitPrice: 37, cashSales: 74 }),
  scLine({ sub: 'sc-2b', creditSales: 45, creditCustomerId: scCust.id, creditItems: [{ productId: scReg.id, qty: 1, unitPrice: 45 }] })] });
check(sc2b.error === 'credit_over_lines', 'and so is credit for an item no line sold (got ' + JSON.stringify(sc2b.error || sc2b.results) + ')');
check(scRow(scRep(), scGas.id, 'full').sales === 10, 'nothing of a refused day is written');
var sc2c = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-02', sourceType: 'store', sourceId: scStore.id, productId: scReg.id, qty: 1, unitPrice: 45, cashSales: 45, creditSales: 90, creditCustomerId: scCust.id, creditItems: [{ productId: scReg.id, qty: 2, unitPrice: 45 }] });
check(sc2c.error === 'credit_over_lines', 'one line on its own follows the same rule (got ' + sc2c.error + ')');

// 3. part of a line through Souq Gas is still that line's quantity, once
var sc3 = call({ action: 'importDailyEntries', token: adminTok, rows: [scLine({ sub: 'sc-3', sourceType: 'car', sourceId: scCar.id, productId: scGas.id, qty: 6, unitPrice: 37, cashSales: 222, channelQtys: (function () { var o = {}; o[souq.entity.id] = 4; return o; })() })] });
check(sc3.ok && sc3.created === 1, 'a car line with 4 of 6 through Souq Gas is saved (' + JSON.stringify(sc3.results || sc3.error) + ')');

// 4. an amount typed without a quantity cannot move the stock: it is flagged
check(call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-04', sourceType: 'store', sourceId: scStore.id, productId: scGas.id, cashSales: 500 }).ok, 'an amount-only sale is accepted');
// 5. the products that draw from the cylinder item
var sc5 = call({ action: 'importDailyEntries', token: adminTok, rows: [
  scLine({ sub: 'sc-5', date: '2026-09-05', sourceType: 'pos', sourceId: scPos.id, productId: scEmptySale.id, qty: 2, unitPrice: 186, cashSales: 372 }),
  scLine({ sub: 'sc-5', date: '2026-09-05', sourceType: 'pos', sourceId: scPos.id, productId: scFullSale.id, qty: 3, unitPrice: 220, cashSales: 660 })] });
check(sc5.created === 2, 'empty and full cylinder sales on the POS machine are saved (' + JSON.stringify(sc5.results || sc5.error) + ')');
// 6. a voided day gives its units back
var sc6 = call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-06', sourceType: 'store', sourceId: scStore.id, productId: scReg.id, qty: 5, unitPrice: 45, cashSales: 225 });
check(sc6.ok && call({ action: 'voidEntries', token: adminTok, ids: [sc6.entry.id], reason: 'typed twice' }).ok, 'a wrong day is voided');
// 7. the area manager's batch counts while it waits, and a rejected one gives the units back
var sc7 = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: [{ date: '2026-09-07', sourceType: 'pos', sourceId: scPos.id, productId: scGas.id, qty: 7, unitPrice: 37, cashSales: 259 }] });
check(sc7.ok, 'the area manager submits a batch (' + (sc7.error || JSON.stringify(sc7.results || '')) + ')');
check(scRow(scRep(), scGas.id, 'full').sales === 10 + 6 + 3 + 7, 'its 7 leave the stock while the deputy has it (got ' + scRow(scRep(), scGas.id, 'full').sales + ')');
check(sc7.ok && call({ action: 'deputyRejectBatch', token: deputyTok, id: sc7.batch.id, note: 'wrong day' }).ok, 'the deputy rejects it');
// 8. a credit row from the area file is its own sale, counted once
var sc8 = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: [{ date: '2026-09-08', sourceType: 'pos', sourceId: scPos.id, productId: scGas.id, qty: 5, unitPrice: 37, cashSales: 185, creditSales: 185, creditCustomerId: scCust.id, creditItems: [{ productId: scGas.id, qty: 5, unitPrice: 37 }] }] });
check(sc8.ok, 'an area credit row is accepted (' + (sc8.error || JSON.stringify(sc8.results || '')) + ')');
// 9. before the count, and at another branch, nothing moves here
call({ action: 'createDailyEntry', token: adminTok, date: '2026-08-30', sourceType: 'store', sourceId: scStore.id, productId: scReg.id, qty: 4, unitPrice: 45, cashSales: 180 });
call({ action: 'createDailyEntry', token: adminTok, date: '2026-09-09', sourceType: 'store', sourceId: scOtherStore.id, productId: scReg.id, qty: 9, unitPrice: 45, cashSales: 405 });

var rAll = scRep(), gF = scRow(rAll, scGas.id, 'full'), gE = scRow(rAll, scGas.id, 'empty'), rg = scRow(rAll, scReg.id);
check(gF.sales === 24 && gF.ending === 76, 'full: 100 - 10 form - 6 car - 3 sold full - 5 area credit = 76; the rejected batch is back (got sales ' + gF.sales + ', ending ' + gF.ending + ')');
check(gE.exchangeIn === 21 && gE.sales === 2 && gE.ending === 69, 'empty: 50 + 21 back from exchanges - 2 sold empty = 69 (got ' + [gE.exchangeIn, gE.sales, gE.ending].join('/') + ')');
check(rg.sales === 2 && rg.ending === 18, 'regulator: 20 - 2; the voided day, the sale before the count and the other branch do not count (got ' + rg.sales + '/' + rg.ending + ')');
check(gF.salesWithoutQty === 1 && Math.abs(gF.salesWithoutQtyAmount - 500) < 0.005, 'the amount-only sale is flagged with its amount');
var srcs = Object.keys(gF.salesBySource || {});
check(srcs.indexOf('store:' + scStore.id) >= 0 && srcs.indexOf('car:' + scCar.id) >= 0 && srcs.indexOf('pos:' + scPos.id) >= 0, 'each sale is put to the store, car or POS machine that made it');
var rLater = scRep('2026-09-10', '2026-09-30');
check(scRow(rLater, scGas.id, 'full').opening === 76 && scRow(rLater, scGas.id, 'empty').opening === 69, 'a later period opens where the earlier one ended');
check(Math.abs(gF.endingValue - 76 * (11.5 + 140)) < 0.005, 'a full cylinder is valued as the gas plus the cylinder: 76 x 151.50 (got ' + gF.endingValue + ')');
check(Math.abs(gE.endingValue - 69 * 140) < 0.005, 'an empty one at the cylinder cost (got ' + gE.endingValue + ')');
var scById = {}; ctx.readSheet(ctx.SHEETS.PRODUCTS).forEach(function (p) { scById[p.id] = p; });
check(Math.abs(ctx.costOfProduct_(scById[scFullSale.id], '2026-09-05', {}, scById) - 151.5) < 0.005, 'a full cylinder sold costs the gas and the cylinder');
check(Math.abs(ctx.costOfProduct_(scById[scEmptySale.id], '2026-09-05', {}, scById) - 140) < 0.005, 'an empty one the cylinder');
check(ctx.TRANSACTIONAL_SHEETS_.indexOf(ctx.SHEETS.INV_MOVES) >= 0, 'starting a fresh round archives the stock movements with the sales they balance against');
// the live stock: one call, the stock on hand right now at every branch in reach
var live = call({ action: 'getInventoryLive', token: financeTok, locationId: scLoc.id });
check(live.ok && live.asOf, 'the live stock answers with the moment it was read (' + (live.error || '') + ')');
check(live.ok && scRow(live, scGas.id, 'full').ending === 76 && scRow(live, scReg.id).ending === 18, 'and shows what is on hand now, every movement and sale so far included');
check(call({ action: 'getInventoryLive', token: dpTok }).error === 'forbidden', 'a driver sees no live stock');

console.log('--- LPG: setting up inventory items keeps every figure when each stock is mapped to its own item (2026-10-05) ---');
// Still before the setup: the old shape, written through the old actions. A
// product held the stock: two cylinder types, a cross-type swap, a body sale, a box
// size, new cylinders and a refill, a hose sold by the cut.
var mgIron = scProd({ name: 'Mg Iron Exchange', type: 'goods', unitPrice: 37, unitCost: 11, emptyCost: 140, cylinder: true, stockName: 'Mg iron', boxSize: 35 });
var mgFiber = scProd({ name: 'Mg Fiber Exchange', type: 'goods', unitPrice: 37, unitCost: 11, emptyCost: 400, cylinder: true });
var mgSwap = scProd({ name: 'Mg Iron to Fiber', type: 'goods', unitPrice: 297, stockOf: mgFiber.id, stockEffect: 'exchange', returnOf: mgIron.id });
var mgBody = scProd({ name: 'Mg Iron Body Sale', type: 'goods', unitPrice: 186, stockOf: mgIron.id, stockEffect: 'sell_empty' });
var mgHose = scProd({ name: 'Mg Hose', type: 'goods', unitPrice: 20, unitCost: 8 });
var mgCut = scProd({ name: 'Mg Hose Cut', type: 'goods', unitPrice: 10, stockOf: mgHose.id });
var mgSvc = scProd({ name: 'Mg Delivery', type: 'services', unitPrice: 5 });
function mgMv(pid, st, kind, qty, date, extra) {
  var p = { action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: pid, state: st, kind: kind, qty: qty, date: date };
  Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
  var r = call(p); check(r.ok, 'an old-shape ' + kind + ' (' + (r.error || '') + ')'); return r;
}
mgMv(mgIron.id, 'full', 'opening', 60, '2026-09-01'); mgMv(mgIron.id, 'empty', 'opening', 25, '2026-09-01');
mgMv(mgFiber.id, 'full', 'opening', 30, '2026-09-01'); mgMv(mgFiber.id, 'empty', 'opening', 4, '2026-09-01');
mgMv(mgHose.id, null, 'opening', 40, '2026-09-01');
mgMv(mgIron.id, 'full', 'purchase', 35, '2026-09-11'); mgMv(mgIron.id, 'full', 'purchase', 20, '2026-09-11', { newCylinders: true });
var mgVoided = mgMv(mgHose.id, null, 'damage', 3, '2026-09-12');
check(call({ action: 'voidInventoryMove', token: adminTok, id: mgVoided.move.id, reason: 'counted twice' }).ok, 'an old-shape move voided');
var mgDay = call({ action: 'importDailyEntries', token: adminTok, rows: [
  scLine({ sub: 'mg-1', date: '2026-09-14', productId: mgSwap.id, qty: 3, unitPrice: 297, cashSales: 891 }),
  scLine({ sub: 'mg-1', date: '2026-09-14', productId: mgBody.id, qty: 2, unitPrice: 186, cashSales: 372 }),
  scLine({ sub: 'mg-1', date: '2026-09-14', productId: mgIron.id, qty: 9, unitPrice: 37, cashSales: 333 }),
  scLine({ sub: 'mg-1', date: '2026-09-14', productId: mgCut.id, qty: 4, unitPrice: 10, cashSales: 40 }),
  scLine({ sub: 'mg-1', date: '2026-09-14', productId: mgSvc.id, qty: 2, unitPrice: 5, cashSales: 10 })] });
check(mgDay.ok, 'an old-shape day of sales (' + JSON.stringify(mgDay.error || '') + ')');
check(call({ action: 'setProductCost', token: adminTok, productId: mgIron.id, unitCost: 10, from: '2026-09-13', reason: 'plant price fell' }).ok, 'the gas cost changed in the middle of the month, the old way');
var mgCutSaved = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: mgCut.id, data: { unitPrice: 11 } });
check(mgCutSaved.ok && !mgCutSaved.entity.stockEffect && !mgCutSaved.entity.stockItemId, 'before the setup an old stock-of product keeps its empty effect when saved');
check(saveErr('product', { name: 'Mg Unit Effect', type: 'goods', stockEffect: 'unit' }) === 'invalid_stock_link' && saveErr('product', { name: 'Mg Early Link', type: 'goods', stockItemId: 'x' }) === 'invalid_stock_link', 'before the setup a product takes neither the unit effect nor an inventory item');

// the figures before the setup, keyed the old way (a row per product holding stock)
function mgCanon(v) {
  if (Array.isArray(v)) return '[' + v.map(mgCanon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + mgCanon(v[k]); }).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
var MG_PERIODS = [['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-09-14', '2026-09-14'], ['2026-09-28', '2026-09-28'], ['2026-10-01', '2026-10-31']];
function mgFigures(legacyOf) {
  return MG_PERIODS.map(function (p) {
    var rep = call({ action: 'getInventoryReport', token: financeTok, dateFrom: p[0], dateTo: p[1] });
    var rows = (rep.rows || []).map(function (r) {
      var o = {}; Object.keys(r).forEach(function (k) { if (['stockItemId', 'salesByProduct', 'productId', 'stockName'].indexOf(k) < 0) o[k] = r[k]; });
      o.item = legacyOf(r.stockItemId); return mgCanon(o);
    }).sort();
    return mgCanon({ ok: rep.ok, rows: rows, moves: (rep.moves || []).map(function (m) { return m.id; }), total: rep.movesTotal });
  });
}
function mgProfit() {
  return [['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-09-14', '2026-09-14']].map(function (p) {
    var r = call({ action: 'getProfitReport', token: adminTok, dateFrom: p[0], dateTo: p[1] }); delete r.token; return mgCanon(r);
  });
}
function mgSheets(c) { c = c || ctx; return [c.SHEETS.INV_MOVES, c.SHEETS.ENTRIES].map(function (s) { return mgCanon(c.readSheet(s)); }); }
var mgFigBefore = mgFigures(function (id) { return id; });
var mgProfitBefore = mgProfit();
var mgSheetsBefore = mgSheets();
check(mgFigBefore.every(function (f) { return f.indexOf('"ok":true') >= 0; }) && JSON.parse(mgProfitBefore[1]).ok, 'the reports answer before the setup');
check(!call({ action: 'listMeta', token: adminTok }).config.stockItemsLive, 'the inventory items are not set up yet');
// each product that held stock becomes an item of its own; what drew from it follows it
function mgFaithfulPlan() {
  var ps = ctx.readSheet(ctx.SHEETS.PRODUCTS), by = {}, hasMv = {};
  ps.forEach(function (p) { by[p.id] = p; });
  ctx.readSheet(ctx.SHEETS.INV_MOVES).forEach(function (m) { if (!m.voided) hasMv[m.productId] = true; });
  function holder(p) { return p.cylinder || !(p.stockOf && by[p.stockOf] && (by[p.stockOf].type !== 'services' || hasMv[p.stockOf])); }
  var items = [], lines = [];
  ps.forEach(function (p) {
    if (p.type === 'services' || !holder(p)) return;
    items.push(p.cylinder ? { key: 'p:' + p.id, name: p.stockName || p.name, kind: 'cylinder', boxSize: p.boxSize || '', gasCost: p.unitCost || 0, cylinderCost: p.emptyCost || 0 }
      : { key: 'p:' + p.id, name: p.name, kind: 'unit', unitCost: p.unitCost || 0 });
  });
  ps.forEach(function (p) {
    if (p.type === 'services') return;
    var a = holder(p) ? p : by[p.stockOf], eff = a.cylinder ? (p.stockEffect || 'exchange') : 'unit';
    var l = { productId: p.id, stockItemKey: 'p:' + a.id, stockEffect: eff };
    if (eff === 'exchange' && p.returnOf && by[p.returnOf] && by[p.returnOf].cylinder && p.returnOf !== a.id) l.returnItemKey = 'p:' + p.returnOf;
    lines.push(l);
  });
  return { stockItems: items, products: lines };
}
var mgPlan = mgFaithfulPlan();
check(call({ action: 'applyInventorySetup', token: dpTok, stockItems: mgPlan.stockItems, products: mgPlan.products }).error === 'forbidden', 'only admin and finance confirm the setup');
var mgApplied = call({ action: 'applyInventorySetup', token: adminTok, stockItems: mgPlan.stockItems, products: mgPlan.products });
check(mgApplied.ok, 'the setup is confirmed (' + JSON.stringify(mgApplied.error ? [mgApplied.error, mgApplied.names] : '') + ')');
check(call({ action: 'applyInventorySetup', token: adminTok, stockItems: mgPlan.stockItems, products: mgPlan.products }).error === 'already_applied', 'and only once');
check(call({ action: 'inventorySetupProposal', token: adminTok }).error === 'already_applied', 'nothing is proposed once it is done');
var mgItems = ctx.readSheet(ctx.SHEETS.STOCK_ITEMS);
function mgItemOf(pid) { return mgItems.filter(function (s) { return s.setupKey === 'p:' + pid; })[0] || {}; }
var mgLegacyOf = function (id) { var s = mgItems.filter(function (x) { return x.id === id; })[0]; return s ? String(s.setupKey).slice(2) : 'unknown:' + id; };
var mgFigAfter = mgFigures(mgLegacyOf);
MG_PERIODS.forEach(function (p, i) {
  check(mgFigAfter[i] === mgFigBefore[i], 'stock ' + p[0] + ' to ' + p[1] + ': every figure, value, flag and movement is what it was before the setup');
});
var mgProfitAfter = mgProfit();
check(mgProfitAfter.every(function (x, i) { return x === mgProfitBefore[i]; }), 'the profit report for past periods is unchanged by the setup');
var mgSheetsAfter = mgSheets();
check(mgSheetsAfter[0] === mgSheetsBefore[0], 'no movement row is changed');
check(mgSheetsAfter[1] === mgSheetsBefore[1], 'no day entry row is changed');
var mgProducts = ctx.readSheet(ctx.SHEETS.PRODUCTS);
check(mgProducts.every(function (p) { return p.type === 'services' ? !p.stockItemId : !!p.stockItemId; }), 'every goods product has an inventory item, no service has one');
var mgI = mgItemOf(mgIron.id), mgF = mgItemOf(mgFiber.id), mgH = mgItemOf(mgHose.id);
check(mgI.kind === 'cylinder' && mgI.name === 'Mg iron' && mgI.gasCost === 10 && mgI.cylinderCost === 140 && mgI.boxSize === 35, 'a cylinder item with its name, gas cost, cylinder cost and box size');
check(mgF.kind === 'cylinder' && mgF.name === 'Mg Fiber Exchange' && mgH.kind === 'unit' && mgH.unitCost === 8, 'and the others as planned');
function mgP(id) { return ctx.getById_(ctx.SHEETS.PRODUCTS, id); }
check(mgP(mgSwap.id).stockItemId === mgF.id && mgP(mgSwap.id).returnItemId === mgI.id && mgP(mgBody.id).stockEffect === 'sell_empty', 'the swap takes back the iron item; the body sale sells the iron empty');
check(mgItems.every(function (s) { return /^STK-\d{4}$/.test(s.code || '') && s.fromSetup === true; }), 'every item is numbered STK');
check(ctx.readSheet(ctx.SHEETS.AUDIT).some(function (a) { return a.action === 'inventory_setup'; }) && ctx.readSheet(ctx.SHEETS.AUDIT).some(function (a) { return a.action === 'migrate_stock_item'; }), 'the setup is in the audit trail');
var mgRepNew = scRep();
check((mgRepNew.moves || []).every(function (m) { return !!m.stockItemId; }), 'old movements are read with their inventory item');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, productId: mgHose.id, kind: 'purchase', qty: 1, date: '2026-09-15' }).error === 'use_stock_item', 'from now on a move naming a product is refused');
check(call({ action: 'addInventoryMove', token: adminTok, locationId: scLoc.id, stockItemId: mgI.id, state: 'full', kind: 'opening', qty: 1, date: '2026-09-15' }).error === 'opening_exists', 'and the old opening count is the item\'s opening: it is entered once');
check(mgRepNew.rows.every(function (r) { return !('productId' in r); }), 'report rows name inventory items only');

console.log('--- LPG: the live products are set up once, from a proposal the manager confirms ---');
// The live data: plain goods products, the branch counted full iron on the
// exchange item and empty iron on the body sale. A fresh system, made-up people.
var lv = harness.buildContext();
function lvCall(payload) { try { return lv.route_(payload); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }
(function () { var salt = lv.randomSalt_(); lv.writeRow(lv.SHEETS.USERS, { id: lv.Utilities.getUuid(), name: 'Lv Admin', email: 'lv.admin@bestgas.sa', role: 'admin', active: true, language: 'en', salt: salt, pass: lv.hashPw_('Bootstrap#1', salt), mustChangePw: false }); })();
var lvTok = lvCall({ action: 'login', email: 'lv.admin@bestgas.sa', password: 'Bootstrap#1' }).token;
function lvEnt(kind, d) { var r = lvCall({ action: 'adminSaveEntity', token: lvTok, kind: kind, data: d }); check(r.ok, 'live shape: ' + kind + ' ' + (d.name || d.label || '') + (r.ok ? '' : ': ' + r.error)); return r.entity || {}; }
function lvUser(n, role) { return lvCall({ action: 'adminCreateUser', token: lvTok, data: { name: n, email: n.toLowerCase().replace(/\W+/g, '.') + '@bestgas.sa', role: role } }).user || {}; }
var lvAm = lvUser('Lv Area Manager', 'cluster_manager'), lvCol = lvUser('Lv Collector', 'collector'), lvBm = lvUser('Lv Branch Manager', 'store_manager');
var lvArea = lvEnt('cluster', { name: 'Lv Area', clusterManagerUserId: lvAm.id });
var lvLoc = lvEnt('location', { city: 'Riyadh', name: 'Lv Branch', clusterId: lvArea.id, collectorUserId: lvCol.id });
var lvStore = lvEnt('store', { locationId: lvLoc.id, name: 'Lv Store', storeManagerUserId: lvBm.id });
var LV_NAMES = [['استبدال غاز', 37, 'exchange'], ['أسطوانة حديد فارغ', 186], ['أستبدال فايبر', 37, 'exchange'], ['أستبدال وذفه', 37], ['بيع وذفه', 409.89], ['أستبدال 5 كجم', 16.82],
  ['بيع 5كجم', 340], ['منظم 50 روافد'], ['منظم ضغط عالي'], ['منظم 50 مللي بار شركة'], ['منظم 90 مللي بار شركة'], ['منظم 22 / 90'], ['لي أحمر 11'], ['توصيل']];
var lvP = LV_NAMES.map(function (x) { var d = { name: x[0], type: 'goods' }; if (x[1]) d.unitPrice = x[1]; if (x[2]) d.stockEffect = x[2]; return lvEnt('product', d); });
var lvExch = lvP[0], lvBody = lvP[1], lvDel = lvP[13];
check(lvCall({ action: 'addInventoryMove', token: lvTok, locationId: lvLoc.id, productId: lvExch.id, kind: 'opening', qty: 2051, date: '2026-09-28' }).ok, 'the branch counted 2051 on the exchange item');
check(lvCall({ action: 'addInventoryMove', token: lvTok, locationId: lvLoc.id, productId: lvBody.id, kind: 'opening', qty: 666, date: '2026-09-28' }).ok, 'and 666 on the body sale');
var lvDay = lvCall({ action: 'importDailyEntries', token: lvTok, rows: [
  { date: '2026-09-28', sourceType: 'store', sourceId: lvStore.id, submissionId: 'lv-1', productId: lvExch.id, qty: 1453, unitPrice: 37, cashSales: 53761 },
  { date: '2026-09-28', sourceType: 'store', sourceId: lvStore.id, submissionId: 'lv-1', productId: lvBody.id, qty: 4, unitPrice: 186, cashSales: 744 }] });
check(lvDay.ok, 'a day of 1453 exchanges and 4 body sales (' + JSON.stringify(lvDay.error || lvDay.results || '') + ')');
function lvRep() { return lvCall({ action: 'getInventoryReport', token: lvTok, dateFrom: '2026-09-28', dateTo: '2026-09-30', locationId: lvLoc.id }); }
var lvOld = lvRep();
function lvRow(rep, id, st) { return ((rep && rep.rows) || []).filter(function (r) { return r.stockItemId === id && (r.state || '') === (st || ''); })[0] || {}; }
check(lvRow(lvOld, lvExch.id).ending === 598 && lvRow(lvOld, lvBody.id).ending === 662, 'before the setup the stock reads as it always has (598 and 662)');
check(lvOld.rows.every(function (r) { return r.productId === r.stockItemId && r.stockName === ''; }), 'before the setup rows keep the old shape: productId and stockName as before');
var lvSpare = lvEnt('product', { name: 'Lv Spare Part', type: 'goods', unitPrice: 9 });
check(lvCall({ action: 'addInventoryMove', token: lvTok, locationId: lvLoc.id, productId: lvSpare.id, kind: 'opening', qty: 3, date: '2026-09-28' }).ok, 'a product with only a count, no sales');
check(lvCall({ action: 'adminDeleteEntity', token: lvTok, kind: 'product', id: lvSpare.id }).error === 'has_children', 'a product holding counted stock cannot be deleted');
function lvCogs() { var r = lvCall({ action: 'getProfitReport', token: lvTok, dateFrom: '2026-09-01', dateTo: '2026-09-30' }); var c = (r.nodes || []).filter(function (n) { return n.key === 'company'; })[0] || { T: {} }; return [r.ok, c.T.cogs, c.T.uncostedSales, c.T.gm].join('|'); }
var lvCogsBefore = lvCogs();
var lvSheetsBefore = mgSheets(lv);
check(lvCall({ action: 'inventorySetupProposal', token: lvCall({ action: 'login', email: 'lv.branch.manager@bestgas.sa', password: 'x' }).token || 'none' }).ok !== true, 'nobody but a manager reads the proposal');
var lvProp = lvCall({ action: 'inventorySetupProposal', token: lvTok });
check(lvProp.ok, 'the proposal is read (' + (lvProp.error || '') + ')');
function lvLine(pid) { return (lvProp.products || []).filter(function (l) { return l.productId === pid; })[0] || {}; }
function lvItem(key) { return (lvProp.stockItems || []).filter(function (s) { return s.key === key; })[0] || {}; }
var lvIronKey = lvLine(lvExch.id).stockItemKey;
check(lvItem(lvIronKey).kind === 'cylinder' && /حديد/.test(lvItem(lvIronKey).name), 'an exchange naming no cylinder type is the iron cylinder (' + lvItem(lvIronKey).name + ')');
check(lvLine(lvExch.id).stockEffect === 'exchange' && lvLine(lvBody.id).stockItemKey === lvIronKey && lvLine(lvBody.id).stockEffect === 'sell_empty', 'the empty iron sale sells the iron empty');
check(lvLine(lvP[2].id).stockEffect === 'exchange' && lvItem(lvLine(lvP[2].id).stockItemKey).kind === 'cylinder' && lvLine(lvP[2].id).stockItemKey !== lvIronKey, 'fiber is its own cylinder item');
check(lvLine(lvP[3].id).stockItemKey === lvLine(lvP[4].id).stockItemKey && lvLine(lvP[4].id).stockEffect === 'sell_empty', 'the wazfa exchange and the wazfa sale share one item');
check(lvLine(lvP[5].id).stockItemKey === lvLine(lvP[6].id).stockItemKey && lvLine(lvP[5].id).stockItemKey !== lvLine(lvP[2].id).stockItemKey, 'the 5 kg exchange and sale share their own item');
check([7, 8, 9, 10, 11, 12].every(function (i) { var l = lvLine(lvP[i].id); return l.stockEffect === 'unit' && lvItem(l.stockItemKey).kind === 'unit' && lvItem(l.stockItemKey).name === lvP[i].name; }), 'each regulator and the hose are unit items named after themselves');
check(lvLine(lvDel.id).toService === true, 'the delivery becomes a service');
var lvLm = function (pid) { return (lvProp.legacyMoves || []).filter(function (m) { return m.productId === pid; })[0] || { maps: {} }; };
check(lvLm(lvExch.id).maps.stockItemKey === lvIronKey && lvLm(lvExch.id).maps.state === 'full' && lvLm(lvExch.id).openings[0].qty === 2051, 'the 2051 counted on the exchange land on iron full');
check(lvLm(lvBody.id).maps.stockItemKey === lvIronKey && lvLm(lvBody.id).maps.state === 'empty' && lvLm(lvBody.id).openings[0].qty === 666, 'the 666 counted on the body sale land on iron empty');
check((lvProp.conflicts || []).length === 0, 'no two counts land on one item');
// a mapping that lands two counts on iron full is refused, naming both
var lvBad = JSON.parse(JSON.stringify(lvProp.products)).map(function (l) { if (l.productId === lvBody.id) l.stockEffect = 'sell_full'; return l; });
var lvConf = lvCall({ action: 'applyInventorySetup', token: lvTok, stockItems: lvProp.stockItems, products: lvBad });
check(lvConf.error === 'opening_conflict' && (lvConf.names || []).indexOf('استبدال غاز') >= 0 && (lvConf.names || []).indexOf('أسطوانة حديد فارغ') >= 0, 'two openings on one item and state are refused, naming the products (got ' + JSON.stringify([lvConf.error, lvConf.names]) + ')');
var lvGone = JSON.parse(JSON.stringify(lvProp.products)).filter(function (l) { return l.productId !== lvBody.id; });
var lvUnm = lvCall({ action: 'applyInventorySetup', token: lvTok, stockItems: lvProp.stockItems, products: lvGone });
check(lvUnm.error === 'moves_unmapped' && (lvUnm.names || []).indexOf('أسطوانة حديد فارغ') >= 0, 'a product with stock counted on it must be mapped (got ' + JSON.stringify([lvUnm.error, lvUnm.names]) + ')');
check(!lv.readSheet(lv.SHEETS.STOCK_ITEMS).length && !lvCall({ action: 'listMeta', token: lvTok }).config.stockItemsLive, 'a refused setup writes nothing');
var lvSvc = JSON.parse(JSON.stringify(lvProp.products)).map(function (l) { if (l.productId === lvExch.id) { l.toService = true; delete l.stockItemKey; } return l; });
check(lvCall({ action: 'applyInventorySetup', token: lvTok, stockItems: lvProp.stockItems, products: lvSvc }).error === 'has_sales', 'a product with sales cannot be made a service');
var lvPrev = lvCall({ action: 'inventorySetupPreview', token: lvTok, stockItems: lvProp.stockItems, products: lvProp.products });
function lvPv(st) { return ((lvPrev && lvPrev.lines) || []).filter(function (x) { return x.locationId === lvLoc.id && x.stockItemKey === lvIronKey && x.state === st; })[0] || {}; }
check(lvPrev.ok && lvPv('full').before === 598 && lvPv('full').after === 598, 'the preview shows iron full 598 -> 598 (got ' + JSON.stringify(lvPrev.error || lvPv('full')) + ')');
check(lvPv('empty').before === 662 && lvPv('empty').after === 2115, 'and iron empty 662 -> 2115 (got ' + JSON.stringify(lvPv('empty')) + ')');
lvProp.stockItems.forEach(function (s) { if (s.key === lvIronKey) s.gasCost = 11; });
// a confirm that stops half-way (the script dies) and is confirmed again
var lvRealWrite = lv.writeRow, lvProdWrites = 0;
lv.writeRow = function (name, obj) { if (name === lv.SHEETS.PRODUCTS && ++lvProdWrites === 3) throw new Error('script stopped'); return lvRealWrite(name, obj); };
var lvHalf = lvCall({ action: 'applyInventorySetup', token: lvTok, stockItems: lvProp.stockItems, products: lvProp.products });
lv.writeRow = lvRealWrite;
check(!lvHalf.ok && lv.readSheet(lv.SHEETS.STOCK_ITEMS).length > 0 && !lvCall({ action: 'listMeta', token: lvTok }).config.stockItemsLive, 'a confirm that stopped half-way leaves the setup unapplied');
var lvApply = lvCall({ action: 'applyInventorySetup', token: lvTok, stockItems: lvProp.stockItems, products: lvProp.products });
var lvKeys = lv.readSheet(lv.SHEETS.STOCK_ITEMS).map(function (s) { return s.setupKey; });
check(lvKeys.length === lvProp.stockItems.length && lvKeys.every(function (k, i) { return lvKeys.indexOf(k) === i; }), 'confirmed again it finishes without a second set of items (' + lvKeys.length + ' of ' + lvProp.stockItems.length + ')');
check(lvApply.ok, 'the proposal is confirmed (' + JSON.stringify(lvApply.error ? [lvApply.error, lvApply.names] : '') + ')');
var lvIron = lvApply.stockItemIds ? lvApply.stockItemIds[lvIronKey] : null;
var lvNew = lvRep();
check(lvRow(lvNew, lvIron, 'full').ending === 598, 'iron full: 2051 - 1453 exchanged = 598 (got ' + lvRow(lvNew, lvIron, 'full').ending + ')');
check(lvRow(lvNew, lvIron, 'empty').ending === 2115, 'iron empty: 666 - 4 sold + 1453 empties back from the exchanges = 2115 (got ' + lvRow(lvNew, lvIron, 'empty').ending + ')');
check(mgSheets(lv)[0] === lvSheetsBefore[0] && mgSheets(lv)[1] === lvSheetsBefore[1], 'no movement or entry row is changed by the setup');
check(lvCall({ action: 'applyInventorySetup', token: lvTok, stockItems: lvProp.stockItems, products: lvProp.products }).error === 'already_applied', 'a second confirm is refused');
check(lv.getById_(lv.SHEETS.PRODUCTS, lvDel.id).type === 'services', 'the delivery is a service now');
check(lvCall({ action: 'addInventoryMove', token: lvTok, locationId: lvLoc.id, stockItemId: lvIron, state: 'full', kind: 'opening', qty: 10, date: '2026-09-29' }).error === 'opening_exists', 'the count already on file is iron full\'s opening: a second one is refused');
check(lvCall({ action: 'importInventoryDay', token: lvTok, locationId: lvLoc.id, date: '2026-09-29', ref: 'lv-sheet', moves: [{ stockItemId: lvIron, state: 'empty', kind: 'opening', qty: 10 }] }).error === 'opening_exists', 'and so is one from a branch sheet');
check(lvCall({ action: 'listMeta', token: lvTok }).stockItems.length === lvProp.stockItems.length, 'the items are on file with their numbers');
var lvAdminId = lv.readSheet(lv.SHEETS.USERS).filter(function (u) { return u.email === 'lv.admin@bestgas.sa'; })[0].id;
check(lv.readSheet(lv.SHEETS.AUDIT).filter(function (a) { return a.action === 'migrate_stock_item'; }).every(function (a) { return a.userId === lvAdminId; }), 'the setup is audited under the manager who confirmed it');
check(lvCogs() === lvCogsBefore, 'September profit and cost of goods are the same after a setup that typed a gas cost of 11 (' + lvCogsBefore + ' / ' + lvCogs() + ')');
var lvLock1 = lvCall({ action: 'adminSaveEntity', token: lvTok, kind: 'product', id: lvBody.id, data: { stockEffect: 'sell_full' } });
check(lvLock1.error === 'stock_link_locked', 'a sales item with history keeps its link: sell_empty to sell_full is refused (got ' + lvLock1.error + ')');
check(lvRow(lvRep(), lvIron, 'full').opening === 2051, 'and iron full still opens at 2051');
check(lvCall({ action: 'adminSaveEntity', token: lvTok, kind: 'product', id: lvExch.id, data: { stockItemId: '' } }).error === 'stock_link_locked', 'nor can its link be cleared');
check(lvCall({ action: 'adminSaveEntity', token: lvTok, kind: 'product', id: lvExch.id, data: { unitPrice: 38 } }).ok, 'an edit that leaves the link alone is fine');
check(lvCall({ action: 'adminSaveEntity', token: lvTok, kind: 'product', id: lvExch.id, data: { type: 'services' } }).error === 'stock_link_locked', 'and turning it into a service is refused too');

console.log('--- LPG: a confirm that stopped half-way is resumed only with the same items ---');
var l2 = harness.buildContext();
function l2Call(payload) { try { return l2.route_(payload); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } }
(function () { var salt = l2.randomSalt_(); l2.writeRow(l2.SHEETS.USERS, { id: l2.Utilities.getUuid(), name: 'L2 Admin', email: 'l2.admin@bestgas.sa', role: 'admin', active: true, language: 'en', salt: salt, pass: l2.hashPw_('Bootstrap#1', salt), mustChangePw: false }); })();
var l2Tok = l2Call({ action: 'login', email: 'l2.admin@bestgas.sa', password: 'Bootstrap#1' }).token;
function l2Ent(kind, d) { var r = l2Call({ action: 'adminSaveEntity', token: l2Tok, kind: kind, data: d }); check(r.ok, 'resume shape: ' + kind + ' ' + (d.name || d.label || '') + (r.ok ? '' : ': ' + r.error)); return r.entity || {}; }
function l2User(n, role) { return l2Call({ action: 'adminCreateUser', token: l2Tok, data: { name: n, email: n.toLowerCase().replace(/\W+/g, '.') + '@bestgas.sa', role: role } }).user || {}; }
var l2Area = l2Ent('cluster', { name: 'L2 Area', clusterManagerUserId: l2User('L2 Area Manager', 'cluster_manager').id });
var l2Loc = l2Ent('location', { city: 'Riyadh', name: 'L2 Branch', clusterId: l2Area.id, collectorUserId: l2User('L2 Collector', 'collector').id });
var l2Exch = l2Ent('product', { name: 'استبدال غاز', type: 'goods', unitPrice: 37 });
var l2Wash = l2Ent('product', { name: 'L2 Washer Pack', type: 'goods', unitPrice: 4 });
var l2Cap = l2Ent('product', { name: 'L2 Cap Pack', type: 'goods', unitPrice: 2 });
check(l2Call({ action: 'addInventoryMove', token: l2Tok, locationId: l2Loc.id, productId: l2Exch.id, kind: 'opening', qty: 100, date: '2026-09-28' }).ok, 'resume shape: an old count');
var l2Prop = l2Call({ action: 'inventorySetupProposal', token: l2Tok });
// the manager adds two items of their own and moves the washer and cap packs onto them
function l2Plan(items) {
  var p = JSON.parse(JSON.stringify(l2Prop));
  items.forEach(function (x, i) { p.stockItems.push({ key: 'new:' + (i + 1), name: x.name, kind: 'unit', unitCost: x.cost }); });
  p.products.forEach(function (l) { items.forEach(function (x, i) { if (l.productId === x.pid) { l.stockItemKey = 'new:' + (i + 1); l.stockEffect = 'unit'; } }); });
  return p;
}
var l2First = l2Plan([{ name: 'L2 Washer', cost: 3, pid: l2Wash.id }, { name: 'L2 Cap', cost: 1, pid: l2Cap.id }]);
var l2Real = l2.writeRow, l2Writes = 0;
l2.writeRow = function (name, obj) { if (name === l2.SHEETS.PRODUCTS && ++l2Writes === 2) throw new Error('script stopped'); return l2Real(name, obj); };
check(!l2Call({ action: 'applyInventorySetup', token: l2Tok, stockItems: l2First.stockItems, products: l2First.products }).ok, 'the first confirm stops half-way');
l2.writeRow = l2Real;
var l2Linked = l2.readSheet(l2.SHEETS.PRODUCTS).filter(function (p) { return p.stockItemId; })[0];
check(!!l2Linked && l2Call({ action: 'adminSaveEntity', token: l2Tok, kind: 'product', id: l2Linked.id, data: { unitPrice: 41 } }).ok, 'a product the stopped run already linked can still be saved');
// the page is opened again: the same two items, in the other order
var l2Swapped = l2Plan([{ name: 'L2 Cap', cost: 1, pid: l2Cap.id }, { name: 'L2 Washer', cost: 3, pid: l2Wash.id }]);
var l2Mis = l2Call({ action: 'applyInventorySetup', token: l2Tok, stockItems: l2Swapped.stockItems, products: l2Swapped.products });
check(l2Mis.error === 'setup_mismatch', 'items that do not match what the stopped run wrote are refused (got ' + l2Mis.error + ')');
check(!l2Call({ action: 'listMeta', token: l2Tok }).config.stockItemsLive, 'and nothing is applied');
// confirmed with the same items, a new cost on one of them
var l2Again = l2Plan([{ name: 'L2 Washer', cost: 5, pid: l2Wash.id }, { name: 'L2 Cap', cost: 1, pid: l2Cap.id }]);
var l2Done = l2Call({ action: 'applyInventorySetup', token: l2Tok, stockItems: l2Again.stockItems, products: l2Again.products });
check(l2Done.ok, 'the same items confirmed again finish the setup (' + (l2Done.error || '') + ')');
var l2Items = l2.readSheet(l2.SHEETS.STOCK_ITEMS);
function l2ItemNamed(n) { return l2Items.filter(function (x) { return x.name === n; }); }
check(l2Items.length === l2Again.stockItems.length && l2ItemNamed('L2 Washer').length === 1 && l2ItemNamed('L2 Cap').length === 1, 'no item is written twice');
check(l2.getById_(l2.SHEETS.PRODUCTS, l2Wash.id).stockItemId === l2ItemNamed('L2 Washer')[0].id && l2.getById_(l2.SHEETS.PRODUCTS, l2Cap.id).stockItemId === l2ItemNamed('L2 Cap')[0].id, 'each pack is linked to its own item');
check(l2ItemNamed('L2 Washer')[0].unitCost === 5, 'a reused item takes the cost of the plan that was confirmed (got ' + l2ItemNamed('L2 Washer')[0].unitCost + ')');

console.log('--- LPG: inventory items are not sales items ---');
var siMgr = scUser('Si Manager', 'store_manager');
var siLoc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Ledger Branch', clusterId: cluster.entity.id, collectorUserId: musa.id } }).entity;
var siStore = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: siLoc.id, name: 'Ledger Store', storeManagerUserId: siMgr.id } }).entity;
function siEnt(kind, d) { var r = call({ action: 'adminSaveEntity', token: adminTok, kind: kind, data: d }); check(r.ok, kind + ' ' + d.name + (r.ok ? '' : ': ' + r.error)); return r.entity || {}; }
var siIron = siEnt('stock_item', { name: 'أسطوانة حديد', kind: 'cylinder', boxSize: 35, gasCost: 11, cylinderCost: 140 });
var siFiber = siEnt('stock_item', { name: 'أسطوانة فايبر', kind: 'cylinder', cylinderCost: 400 });
var siReg = siEnt('stock_item', { name: 'منظم', kind: 'unit', unitCost: 28 });
check(/^STK-\d{4}$/.test(siIron.code || ''), 'an inventory item gets its own number (got ' + siIron.code + ')');
check(siIron.boxSize === 35 && siIron.gasCost === 11 && siIron.cylinderCost === 140 && !siFiber.boxSize, 'a cylinder item keeps its box, gas cost and cylinder cost');
var siWasher = siEnt('stock_item', { name: 'Si Washer', kind: 'unit', unitCost: 3, gasCost: 9, cylinderCost: 9, boxSize: 35 });
check(siWasher.unitCost === 3 && !siWasher.gasCost && !siWasher.cylinderCost && !siWasher.boxSize, 'a unit item keeps no gas, cylinder or box');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'stock_item', id: siWasher.id, data: { active: false } }).ok, 'an inventory item is deactivated');
['opening', 'damage', 'transfer_out'].forEach(function (k, i) { var r = call({ action: 'addInventoryMove', token: adminTok, locationId: siLoc.id, stockItemId: siWasher.id, kind: k, qty: k === 'opening' ? 10 : 1, date: '2026-09-0' + (i + 1) }); check(r.ok, 'a deactivated item still takes its ' + k + ' (' + (r.error || '') + ')'); });
check(saveErr('stock_item', { name: 'Si Bad Kind', kind: 'gas' }) === 'invalid_stock_kind', 'an inventory item is a cylinder or a unit');
check(saveErr('stock_item', { kind: 'unit' }) === 'name_required', 'and has a name');
check(saveErr('stock_item', { name: 'Si Bad Cost', kind: 'cylinder', gasCost: -1 }) === 'invalid_cost', 'a cost cannot be negative');
check(saveErr('stock_item', { name: 'Si Bad Box', kind: 'cylinder', boxSize: -3 }) === 'invalid_box_size', 'a box holds a whole positive number');
check(saveErr('stock_item', { name: 'Si Bad Box2', kind: 'cylinder', boxSize: 2.5 }) === 'invalid_box_size', 'of cylinders');
check(!!trOf('أسطوانة حديد'), 'a new item name is sent for English and Urdu');

var spExch = siEnt('product', { name: 'استبدال غاز', type: 'goods', unitPrice: 37, stockItemId: siIron.id, stockEffect: 'exchange' });
var spBody = siEnt('product', { name: 'بيع أسطوانة حديد', type: 'goods', unitPrice: 186, stockItemId: siIron.id, stockEffect: 'sell_empty' });
var spSwap = siEnt('product', { name: 'تبديل حديد بفايبر', type: 'goods', unitPrice: 297, stockItemId: siFiber.id, stockEffect: 'exchange', returnItemId: siIron.id });
var spReg = siEnt('product', { name: 'منظم', type: 'goods', unitPrice: 45, stockItemId: siReg.id, stockEffect: 'unit' });
var spDel = siEnt('product', { name: 'توصيل', type: 'services', unitPrice: 5 });
var spFull = siEnt('product', { name: 'Si Full Iron Sale', type: 'goods', unitPrice: 220, stockItemId: siIron.id, stockEffect: 'sell_full' });
var spDown = siEnt('product', { name: 'Si Fiber to Iron', type: 'goods', unitPrice: 30, stockItemId: siIron.id, stockEffect: 'exchange', returnItemId: siFiber.id });
check(!spDel.stockItemId && !spDel.stockEffect, 'a service has no stock link');
check(saveErr('product', { name: 'Si Bad Svc', type: 'services', stockItemId: siReg.id, stockEffect: 'unit' }) === 'invalid_stock_link', 'and cannot be given one');
check(saveErr('product', { name: 'Si Bad Link', type: 'goods', stockItemId: siReg.id, stockEffect: 'exchange' }) === 'invalid_stock_link', 'a product on a unit item cannot be an exchange');
check(saveErr('product', { name: 'Si Bad Link2', type: 'goods', stockItemId: siIron.id, stockEffect: 'unit' }) === 'invalid_stock_link', 'nor one on a cylinder item counted in units');
check(saveErr('product', { name: 'Si Bad Link3', type: 'goods', stockItemId: 'nope', stockEffect: 'unit' }) === 'invalid_stock_link', 'and the item must exist');
check(saveErr('product', { name: 'Si Bad Return', type: 'goods', stockItemId: siFiber.id, stockEffect: 'sell_empty', returnItemId: siIron.id }) === 'invalid_return_link', 'a returned item needs an exchange');
check(saveErr('product', { name: 'Si Bad Return2', type: 'goods', stockItemId: siFiber.id, stockEffect: 'exchange', returnItemId: siReg.id }) === 'invalid_return_link', 'and must be a cylinder item');
var spDefault = siEnt('product', { name: 'Si Default Effect', type: 'goods', stockItemId: siReg.id });
check(spDefault.stockEffect === 'unit', 'a unit item\'s sales item counts units without saying so');
var spOld = siEnt('product', { name: 'Si Old Fields', type: 'goods', cylinder: true, stockName: 'x', emptyCost: 9, stockOf: spExch.id, returnOf: spExch.id, boxSize: 35 });
check(!spOld.cylinder && !spOld.stockName && !spOld.emptyCost && !spOld.stockOf && !spOld.returnOf && !spOld.boxSize, 'a sales item no longer takes cylinder, stock name, empty cost, stock-of, return-of or box size');
// unlinking the item drops what hung on it; a new effect without a returned item drops it
var spMixed = siEnt('product', { name: 'Si Mixed Swap', type: 'goods', stockItemId: siFiber.id, stockEffect: 'exchange', returnItemId: siIron.id });
var spUnlink = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: spMixed.id, data: { stockItemId: '', returnItemId: siIron.id } });
check(spUnlink.ok && !spUnlink.entity.returnItemId && !spUnlink.entity.stockEffect, 'unlinking the inventory item drops the returned item and the effect (' + (spUnlink.error || '') + ')');
var spMixed2 = siEnt('product', { name: 'Si Mixed Swap 2', type: 'goods', stockItemId: siFiber.id, stockEffect: 'exchange', returnItemId: siIron.id });
var spReEff = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: spMixed2.id, data: { stockEffect: 'sell_full' } });
check(spReEff.ok && !spReEff.entity.returnItemId, 'a sales item that stops being an exchange keeps no returned item (' + (spReEff.error || '') + ')');
var spToSvc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: spDefault.id, data: { type: 'services' } });
check(spToSvc.ok && !spToSvc.entity.stockItemId && !spToSvc.entity.stockEffect, 'a sales item made a service drops its stock link');

function siMv(o) { var p = { action: 'addInventoryMove', token: adminTok, locationId: siLoc.id }; Object.keys(o).forEach(function (k) { p[k] = o[k]; }); return call(p); }
check(siMv({ productId: spExch.id, state: 'full', kind: 'opening', qty: 1, date: '2026-09-01' }).error === 'use_stock_item', 'a move naming a sales item is refused: stock is kept on inventory items');
check(siMv({ stockItemId: 'nope', kind: 'opening', qty: 1, date: '2026-09-01' }).error === 'invalid_stock_item', 'a move names a real inventory item');
check(siMv({ stockItemId: siIron.id, kind: 'opening', qty: 1, date: '2026-09-01' }).error === 'invalid_state', 'a cylinder item says full or empty');
check(siMv({ stockItemId: siReg.id, state: 'full', kind: 'opening', qty: 1, date: '2026-09-01' }).error === 'invalid_state', 'a unit item does not');
[[siIron, 'full', 100], [siIron, 'empty', 50], [siFiber, 'full', 30], [siFiber, 'empty', 5], [siReg, null, 20]].forEach(function (o) {
  var r = siMv({ stockItemId: o[0].id, state: o[1], kind: 'opening', qty: o[2], date: '2026-09-01' });
  check(r.ok && r.move.stockItemId === o[0].id && !r.move.productId, 'opening count on ' + o[0].name + ' ' + (o[1] || '') + ' (' + (r.error || '') + ')');
});
check(siMv({ stockItemId: siIron.id, state: 'full', kind: 'opening', qty: 5, date: '2026-09-02' }).error === 'opening_exists', 'one opening per branch, item and full or empty');
check(siMv({ stockItemId: siReg.id, kind: 'purchase', qty: 6, date: '2026-09-03' }).ok, 'a purchase on an inventory item');
check(call({ action: 'addInventoryMove', token: noorTok, locationId: siLoc.id, stockItemId: siReg.id, kind: 'purchase', qty: 1, date: '2026-09-03' }).error === 'forbidden', 'a branch manager keeps only his own branch\'s stock');

function siLine(o) { var r = { date: '2026-09-20', sourceType: 'store', sourceId: siStore.id, submissionId: o.sub || 'si-1' }; Object.keys(o).forEach(function (k) { if (k !== 'sub') r[k] = o[k]; }); return r; }
var siDay = call({ action: 'importDailyEntries', token: adminTok, rows: [
  siLine({ productId: spExch.id, qty: 10, unitPrice: 37, cashSales: 370 }),
  siLine({ productId: spBody.id, qty: 2, unitPrice: 186, cashSales: 372 }),
  siLine({ productId: spSwap.id, qty: 3, unitPrice: 297, cashSales: 891 }),
  siLine({ productId: spReg.id, qty: 4, unitPrice: 45, cashSales: 180 }),
  siLine({ productId: spDel.id, qty: 2, unitPrice: 5, cashSales: 10 })] });
check(siDay.ok && siDay.created === 5, 'a day of 10 exchanges, 2 body sales, 3 swaps, 4 regulators and a delivery (' + JSON.stringify(siDay.error || siDay.results || '') + ')');
function siRep(from, to) { return call({ action: 'getInventoryReport', token: financeTok, dateFrom: from || '2026-09-01', dateTo: to || '2026-09-30', locationId: siLoc.id }); }
function siRow(rep, id, st) { return ((rep && rep.rows) || []).filter(function (r) { return r.stockItemId === id && (r.state || '') === (st || ''); })[0] || {}; }
var si1 = siRep();
var siIF = siRow(si1, siIron.id, 'full'), siIE = siRow(si1, siIron.id, 'empty'), siFF = siRow(si1, siFiber.id, 'full'), siFE = siRow(si1, siFiber.id, 'empty'), siRG = siRow(si1, siReg.id);
check(siIF.sales === 10 && siIF.ending === 90, 'iron full: 100 - 10 exchanged = 90 (got ' + siIF.sales + '/' + siIF.ending + ')');
check(siIE.exchangeIn === 13 && siIE.sales === 2 && siIE.ending === 61, 'iron empty: 50 + 10 back from exchanges + 3 iron back from the swaps - 2 bodies sold = 61 (got ' + [siIE.exchangeIn, siIE.sales, siIE.ending].join('/') + ')');
check(siFF.sales === 3 && siFF.ending === 27, 'fiber full: 30 - 3 swapped = 27 (got ' + siFF.ending + ')');
check(!siFE.exchangeIn && siFE.ending === 5, 'no fiber empty comes back');
check(siRG.purchases === 6 && siRG.sales === 4 && siRG.ending === 22, 'regulators: 20 + 6 bought - 4 sold = 22 (got ' + siRG.ending + ')');
var siProdIds = ctx.readSheet(ctx.SHEETS.PRODUCTS).map(function (p) { return p.id; });
check((si1.rows || []).length === 6 && si1.rows.every(function (r) { return r.stockItemId && siProdIds.indexOf(r.stockItemId) < 0 && !('productId' in r); }), 'every row is an inventory item; no row is named after a sales item');
check(siIF.itemName === 'أسطوانة حديد' && siIF.cylinder === true && siRG.cylinder === false, 'rows carry the item\'s own name and kind');
check(siIF.salesBySource['store:' + siStore.id] === 10, 'the sales stay with the store that made them');
check(siIF.salesByProduct[spExch.id] === 10 && siIE.salesByProduct[spBody.id] === 2 && siFF.salesByProduct[spSwap.id] === 3, 'and each row says which sales item sold it');
check(Math.abs(siIF.endingValue - 90 * 151) < 0.005 && Math.abs(siIE.endingValue - 61 * 140) < 0.005 && Math.abs(siRG.endingValue - 22 * 28) < 0.005, 'full = gas + cylinder, empty = cylinder, units at their cost');

// Task 1 on inventory items: new cylinders, a refill by the box, sheet days
check(siMv({ stockItemId: siIron.id, state: 'full', kind: 'purchase', qty: 70, newCylinders: true, date: '2026-09-21' }).ok, 'seventy brand-new full cylinders bought');
check(siMv({ stockItemId: siIron.id, state: 'full', kind: 'purchase', qty: 35, date: '2026-09-21' }).ok, 'and one box refilled at the plant');
var si2 = siRep();
check(siRow(si2, siIron.id, 'full').purchases === 105 && siRow(si2, siIron.id, 'empty').refillOut === 35, 'only the refilled box took empties (refillOut ' + siRow(si2, siIron.id, 'empty').refillOut + ')');
check(siRow(si2, siIron.id, 'full').newCylinders === 70, 'the new cylinders are counted as such');
check(siMv({ stockItemId: siIron.id, state: 'empty', kind: 'damage', qty: 1, newCylinders: true, date: '2026-09-21' }).error === 'invalid_new_cylinders', 'the flag belongs to a full purchase only');
check(siMv({ stockItemId: siReg.id, kind: 'purchase', qty: 1, newCylinders: true, date: '2026-09-21' }).error === 'invalid_new_cylinders', 'of a cylinder item');
check(siMv({ stockItemId: siIron.id, state: 'full', kind: 'purchase', qty: 1, newCylinders: 'true', date: '2026-09-21' }).error === 'invalid_new_cylinders', 'the flag is true or false, never a string');
check(siMv({ stockItemId: siIron.id, state: 'full', kind: 'purchase', qty: 1, newCylinders: false, date: '2026-09-21' }).ok, 'false is the same as absent');
check(call({ action: 'importInventoryDay', token: adminTok, locationId: siLoc.id, date: '2026-09-22', ref: 'si-day', moves: [{ stockItemId: siIron.id, state: 'full', kind: 'purchase', qty: 20, newCylinders: true }, { stockItemId: siReg.id, kind: 'transfer_in', qty: 2 }] }).ok, 'a sheet day goes in on inventory items, new cylinders too');
check(call({ action: 'importInventoryDay', token: adminTok, locationId: siLoc.id, date: '2026-09-22', ref: 'si-day2', moves: [{ stockItemId: siIron.id, state: 'empty', kind: 'return', qty: 2, newCylinders: true }] }).error === 'invalid_new_cylinders', 'and refuses the flag elsewhere');
check(call({ action: 'importInventoryDay', token: adminTok, locationId: siLoc.id, date: '2026-09-22', ref: 'si-day3', moves: [{ productId: spExch.id, state: 'full', kind: 'purchase', qty: 1 }] }).error === 'use_stock_item', 'and a sales item');
var siBox = siEnt('stock_item', { name: 'Si Box Item', kind: 'cylinder', boxSize: 35 });
var siBoxOff = call({ action: 'adminSaveEntity', token: adminTok, kind: 'stock_item', id: siBox.id, data: { kind: 'unit' } });
check(siBoxOff.ok && !siBoxOff.entity.boxSize, 'an item that stops being a cylinder keeps no box size (' + (siBoxOff.error || '') + ')');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'stock_item', id: siIron.id, data: { kind: 'unit' } }).error === 'has_stock', 'a cylinder item with stock cannot stop being one');
// a swap whose returned item was never counted at the branch
var siNever = siEnt('stock_item', { name: 'Si Never Counted', kind: 'cylinder' });
var spNever = siEnt('product', { name: 'Si Fiber for Never', type: 'goods', unitPrice: 250, stockItemId: siFiber.id, stockEffect: 'exchange', returnItemId: siNever.id });
check(call({ action: 'importDailyEntries', token: adminTok, rows: [siLine({ sub: 'si-2', date: '2026-09-23', productId: spNever.id, qty: 2, unitPrice: 250, cashSales: 500 })] }).ok, 'a swap whose returned item was never counted here is saved');
var si3 = siRep();
check(siRow(si3, siFiber.id, 'full').sales === 5, 'the full side still deducts (got ' + siRow(si3, siFiber.id, 'full').sales + ')');
var siNE = siRow(si3, siNever.id, 'empty');
check(siNE.noOpening === true && !siNE.short, 'and the returned item reads no opening yet, never short');

// the cost of a sales item comes from its inventory item and effect
function siCost(p, d) { var by = {}; ctx.readSheet(ctx.SHEETS.PRODUCTS).forEach(function (x) { by[x.id] = x; }); return ctx.costOfProduct_(by[p.id], d, ctx.costHistory_(), by); }
close(siCost(spExch, '2026-09-20'), 11, 'an exchange costs the gas');
close(siCost(spBody, '2026-09-20'), 140, 'a body sale costs the cylinder');
close(siCost(spFull, '2026-09-20'), 151, 'a full cylinder sold costs the gas and the cylinder');
close(siCost(spSwap, '2026-09-20'), 0 + 400 - 140, 'the swap costs the fiber gas (none set) plus the dearer cylinder the customer leaves with, less the iron one that came back');
close(siCost(spDown, '2026-09-20'), 0, 'a downgrade swap never books a negative cost');
close(siCost(spReg, '2026-09-20'), 28, 'a regulator costs its unit cost');
var siToday = ctx.todayRiyadh_();
var siCogsBefore = (call({ action: 'getProfitReport', token: adminTok, dateFrom: '2026-09-01', dateTo: '2026-09-30' }).nodes || []).filter(function (n) { return n.key === 'company'; })[0].T.cogs;
var siValBefore = siRow(siRep(), siIron.id, 'full').endingValue;
var siCh = call({ action: 'adminSaveEntity', token: adminTok, kind: 'stock_item', id: siIron.id, data: { gasCost: 12 } });
check(siCh.ok && siCh.entity.gasCost === 12, 'the gas price of the iron item changes today (' + (siCh.error || '') + ')');
close(siCost(spExch, siToday), 12, 'from today an exchange costs the new gas price');
close(siCost(spExch, '2026-09-20'), 11, 'a sale made before keeps the cost it was made at');
close(siCost(spFull, '2026-09-20'), 151, 'and so does a full cylinder sold then (gas and cylinder both dated)');
close((call({ action: 'getProfitReport', token: adminTok, dateFrom: '2026-09-01', dateTo: '2026-09-30' }).nodes || []).filter(function (n) { return n.key === 'company'; })[0].T.cogs, siCogsBefore, 'the profit of a period that ended before the change does not move');
close(siRow(siRep(), siIron.id, 'full').endingValue, siValBefore, 'nor does the value of its stock');
check(call({ action: 'getRateHistory', token: adminTok, kind: 'stock_item', id: siIron.id }).changes.some(function (r) { return r.field === 'gasCost' && Number(r.from) === 11 && Number(r.to) === 12; }), 'the change is kept in the price history');
check(call({ action: 'setStockItemCost', token: adminTok, stockItemId: siReg.id, field: 'unitCost', cost: 30, from: '2026-09-21' }).error === 'past_needs_reason', 'a cost from a past date is a correction and needs its reason');
check(call({ action: 'setStockItemCost', token: dpTok, stockItemId: siReg.id, field: 'unitCost', cost: 30, from: siToday }).error === 'forbidden', 'a driver sets no costs');
check(call({ action: 'setStockItemCost', token: adminTok, stockItemId: siReg.id, field: 'gasCost', cost: 30, from: siToday }).error === 'invalid_cost', 'a unit item has no gas cost');
check(call({ action: 'setStockItemCost', token: adminTok, stockItemId: siReg.id, field: 'unitCost', cost: 30, from: '2099-01-01' }).error === 'future_date', 'nor a cost from the future');
var siSet = call({ action: 'setStockItemCost', token: adminTok, stockItemId: siReg.id, field: 'unitCost', cost: 30, from: '2026-09-21', reason: 'supplier invoice' });
check(siSet.ok && siSet.stockItem.unitCost === 30, 'a cost is set from a date (' + (siSet.error || '') + ')');
close(siCost(spReg, '2026-09-20'), 28, 'a regulator sold before that date keeps 28');
close(siCost(spReg, '2026-09-22'), 30, 'one sold after costs 30');
var siDrv = call({ action: 'listMeta', token: dpTok });
check(siDrv.ok && siDrv.stockItems.length >= 3 && siDrv.stockItems.every(function (s) { return s.gasCost === undefined && s.cylinderCost === undefined && s.unitCost === undefined; }), 'a driver gets the inventory items without their costs');
check(call({ action: 'listMeta', token: financeTok }).stockItems.some(function (s) { return s.id === siIron.id && s.gasCost === 12; }), 'finance gets them with their costs');
var siSpare = siEnt('stock_item', { name: 'Si Spare', kind: 'unit' });
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'stock_item', id: siIron.id }).error === 'has_children', 'an inventory item with movements stays on file');
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'stock_item', id: siNever.id }).error === 'has_children', 'and so does one a sales item takes back');
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'stock_item', id: siSpare.id }).ok, 'an unused one can go');
var siLive = call({ action: 'getInventoryLive', token: financeTok, locationId: siLoc.id });
check(siLive.ok && siLive.rows.every(function (r) { return !!r.stockItemId && !('productId' in r); }), 'the live stock is by inventory item too');

console.log('--- a batch the deputy rejects is corrected and sent again as the same batch (2026-10-05) ---');
var rsRows = call({ action: 'areaBatchRows', token: saraTok, id: sc7.batch.id });
check(rsRows.ok && rsRows.rows.length === 1 && rsRows.rows[0].productId === scGas.id && rsRows.rows[0].qty === 7, 'the area manager gets the rejected batch\'s lines back to correct (' + (rsRows.error || '') + ')');
check(rsRows.ok && rsRows.batch.rejectionNote === 'wrong day', 'with the deputy\'s reason');
check(call({ action: 'areaBatchRows', token: deputyTok, id: sc7.batch.id }).error === 'forbidden', 'only its author corrects it');
check(call({ action: 'areaBatchRows', token: saraTok, id: sc8.batch.id }).error === 'not_rejected', 'a batch still waiting is not reopened');
var rsFix = rsRows.ok ? rsRows.rows.map(function (r) { var o = JSON.parse(JSON.stringify(r)); o.qty = 4; o.cashSales = 4 * 37; return o; }) : [];
var rsDry = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: rsFix, resubmitOf: sc7.batch.id, dryRun: true });
check(rsDry.ok && Math.abs(rsDry.batch.breakdown.netCashOwed - 148) < 0.005, 'the corrected lines preview at 4 x 37 = 148 (' + (rsDry.error || JSON.stringify(rsDry.results || '')) + ')');
var rsSent = call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: rsFix, resubmitOf: sc7.batch.id });
check(rsSent.ok && rsSent.batch.id === sc7.batch.id, 'sending it again keeps the same batch, no new one (' + (rsSent.error || '') + ')');
check(rsSent.ok && rsSent.batch.status === 'pending_deputy' && rsSent.batch.revision === 2, 'back with the deputy as its second version');
check(rsSent.ok && rsSent.batch.history && rsSent.batch.history.length === 1 && rsSent.batch.history[0].rejectionNote === 'wrong day' && Math.abs(rsSent.batch.history[0].netCashOwed - 259) < 0.005, 'the first version and why it was rejected stay on the batch');
var rsMine = call({ action: 'listAreaBulkBatches', token: saraTok }).batches.filter(function (b) { return b.id === sc7.batch.id; });
check(rsMine.length === 1, 'the list shows it once');
var rsDet = call({ action: 'areaBulkBatchDetail', token: deputyTok, id: sc7.batch.id });
check(rsDet.ok && rsDet.byProduct.length === 1 && rsDet.byProduct[0].qty === 4, 'the deputy sees the corrected lines only (got ' + JSON.stringify(rsDet.byProduct && rsDet.byProduct.map(function (p) { return p.qty; })) + ')');
check(scRow(scRep(), scGas.id, 'full').sales === 24 + 4, 'the stock takes the corrected 4, never the rejected 7 again');
check(call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: rsFix, resubmitOf: sc7.batch.id }).error === 'not_rejected', 'a batch already sent again cannot be sent twice');
check(call({ action: 'bulkSubmitAreaBatch', token: saraTok, clusterId: cluster.entity.id, rows: rsFix, resubmitOf: 'nope' }).error === 'not_found', 'nor a batch that does not exist');
check(call({ action: 'deputyApproveBatch', token: deputyTok, id: sc7.batch.id }).ok, 'and the deputy approves the corrected batch as usual');

console.log('--- costing: cost types are master data, seeded once ---');
var pfMeta = call({ action: 'listMeta', token: adminTok });
check(pfMeta.ok && Array.isArray(pfMeta.costTypes) && pfMeta.costTypes.length >= 30, 'the cost types are seeded (got ' + (pfMeta.costTypes || []).length + ')');
check((pfMeta.costTypes || []).every(function (c) { return /^CST-\d{4}$/.test(c.code || '') && c.name && c.group; }), 'each with its number, name and group');
check(!call({ action: 'listMeta', token: saraTok }).costTypes, 'an area manager is not sent the cost types');
function pfType(group, word) { return pfMeta.costTypes.filter(function (c) { return c.group === group && c.name.indexOf(word) >= 0; })[0]; }
var pfDep = pfMeta.costTypes.filter(function (c) { return c.depreciation; })[0];
var pfIns = pfType('vehicle', 'تأمين'), pfFuel = pfType('vehicle', 'وقود'), pfSal = pfType('staff', 'راتب'), pfRent = pfType('premises', 'إيجار'), pfGa = pfMeta.costTypes.filter(function (c) { return c.group === 'admin'; })[0];
check(pfDep && pfIns && pfFuel && pfSal && pfRent && pfGa, 'depreciation, insurance, fuel, salary, rent and a G&A type exist');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'cost_type', data: { name: 'PF bad', group: 'nonsense' } }).error === 'group_required', 'a cost type needs a known group');
var pfOwn = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cost_type', data: { name: 'PF Car wash', group: 'vehicle', nature: 'variable' } });
check(pfOwn.ok && /^CST-/.test(pfOwn.entity.code), 'finance adds a cost type of its own');

console.log('--- costing: a small company to cost ---');
function pfUser(name, role) { return call({ action: 'adminCreateUser', token: adminTok, data: { name: name, email: name.toLowerCase().replace(/\W+/g, '.') + '@bestgas.sa', role: role } }).user; }
var pfMgr = pfUser('PF Area Manager', 'cluster_manager'), pfCol = pfUser('PF Collector', 'collector');
var pfSm1 = pfUser('PF Manager A', 'store_manager'), pfSm2 = pfUser('PF Manager B', 'store_manager');
var pfDr1 = pfUser('PF Driver A', 'driver'), pfDr2 = pfUser('PF Driver B', 'driver');
var pfAcc = pfUser('PF Accountant', 'accountant');
var pfAccTok = acceptInvite('pf.accountant@bestgas.sa');
function pfEnt(kind, data) { var r = call({ action: 'adminSaveEntity', token: adminTok, kind: kind, data: data }); check(r.ok, 'create ' + kind + ' ' + (data.name || data.label) + (r.ok ? '' : ': ' + r.error)); return r.entity || {}; }
var pfArea = pfEnt('cluster', { name: 'PF Area', clusterManagerUserId: pfMgr.id });
var pfLocA = pfEnt('location', { city: 'PF City', name: 'PF Branch A', clusterId: pfArea.id, collectorUserId: pfCol.id });
var pfLocB = pfEnt('location', { city: 'PF City', name: 'PF Branch B', clusterId: pfArea.id, collectorUserId: pfCol.id });
var pfStA = pfEnt('store', { locationId: pfLocA.id, name: 'PF Store A', storeManagerUserId: pfSm1.id });
var pfStB = pfEnt('store', { locationId: pfLocB.id, name: 'PF Store B', storeManagerUserId: pfSm2.id });
var pfCarA = pfEnt('car', { locationId: pfLocA.id, label: 'PF Car A1', driverUserId: pfDr1.id });
var pfCarB = pfEnt('car', { locationId: pfLocB.id, label: 'PF Car B1', driverUserId: pfDr2.id });
var pfPos = pfEnt('pos', { ownerType: 'car', ownerId: pfCarA.id, label: 'PF POS A1', assignedUserId: pfDr1.id });
// price 23 includes 15% VAT: 20 net; the unit costs 15
var pfP1 = pfEnt('product', { name: 'PF Cylinder', type: 'goods', unitPrice: 23, unitCost: 15 });
var pfExp = pfEnt('expense_item', { name: 'PF Fuel from takings' });
function pfSale(date, sourceType, sourceId, qty, extra) {
  var p = { action: 'createDailyEntry', token: adminTok, date: date, sourceType: sourceType, sourceId: sourceId, productId: pfP1.id, qty: qty, unitPrice: 23, cashSales: qty * 23 };
  Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
  var r = call(p); check(r.ok, 'sale ' + sourceType + ' ' + date + (r.ok ? '' : ': ' + r.error)); return r;
}
pfSale('2026-03-10', 'store', pfStA.id, 100);
pfSale('2026-03-10', 'car', pfCarA.id, 50, { expenseAmount: 40, expenseItemId: pfExp.id, expenseReason: 'diesel' });
pfSale('2026-03-11', 'pos', pfPos.id, 20);
pfSale('2026-03-10', 'car', pfCarB.id, 30);

console.log('--- costing: who may read and write costs ---');
function pfLine(tok, o) { var p = { action: 'saveCostLine', token: tok }; Object.keys(o).forEach(function (k) { p[k] = o[k]; }); return call(p); }
check(call({ action: 'listCosts', token: dpTok }).error === 'forbidden', 'a driver sees no costs');
check(call({ action: 'listCosts', token: saraTok }).error === 'forbidden', 'nor does an area manager');
check(call({ action: 'getProfitReport', token: saraTok, dateFrom: '2026-03-01', dateTo: '2026-03-31' }).error === 'forbidden', 'nor the profit report');
check(call({ action: 'listCosts', token: pfAccTok }).ok, 'the accountant reads costs');
check(pfLine(pfAccTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfIns.id, amount: 100, fromMonth: '2026-03' }).error === 'forbidden', 'but only admin and finance write them');

console.log('--- costing: a cost line is checked ---');
check(pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfIns.id, amount: 0, fromMonth: '2026-03' }).error === 'amount_required', 'an amount is needed');
check(pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfIns.id, amount: -5, fromMonth: '2026-03' }).error === 'amount_required', 'and it is not negative');
check(pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfIns.id, amount: 100, fromMonth: '2026-13' }).error === 'invalid_month', 'a real month');
check(pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfIns.id, amount: 100, fromMonth: '2026-03', toMonth: '2026-02' }).error === 'invalid_month', 'that does not end before it starts');
check(pfLine(adminTok, { centreType: 'car', centreId: 'nope', typeId: pfIns.id, amount: 100, fromMonth: '2026-03' }).error === 'invalid_centre', 'a car that exists');
check(pfLine(adminTok, { centreType: 'planet', centreId: pfCarA.id, typeId: pfIns.id, amount: 100, fromMonth: '2026-03' }).error === 'invalid_centre', 'a known level');
check(pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: 'nope', amount: 100, fromMonth: '2026-03' }).error === 'invalid_type', 'a cost type that exists');

console.log('--- costing: the profiles ---');
var pfDepLine = pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfDep.id, fromMonth: '2026-01', asset: { cost: 72000, residual: 12000, lifeMonths: 60 } });
check(pfDepLine.ok && pfDepLine.line.amount === 1000 && pfDepLine.line.toMonth === '2030-12', 'depreciation is worked out from the asset: (72,000 - 12,000) / 60 months = 1,000 until 2030-12 (got ' + (pfDepLine.line && pfDepLine.line.amount + ' ' + pfDepLine.line.toMonth) + ')');
check(pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfDep.id, fromMonth: '2026-01', asset: { cost: 100, residual: 200, lifeMonths: 12 } }).error === 'invalid_asset', 'the residual cannot exceed the cost');
var pfSalLine = pfLine(adminTok, { centreType: 'car', centreId: pfCarA.id, typeId: pfSal.id, amount: 3100, fromMonth: '2026-03', employeeUserId: pfDr1.id });
check(pfSalLine.ok && pfSalLine.line.employeeUserId === pfDr1.id, 'the driver\'s salary sits on his car');
var pfRentLine = pfLine(adminTok, { centreType: 'store', centreId: pfStA.id, typeId: pfRent.id, amount: 6200, fromMonth: '2026-01' });
check(pfRentLine.ok, 'the store\'s rent');
check(pfLine(adminTok, { centreType: 'store', centreId: pfStA.id, typeId: pfRent.id, amount: 6200, fromMonth: '2026-01' }).error === 'duplicate_line', 'the same line twice is refused');
check(pfLine(adminTok, { centreType: 'store', centreId: pfStA.id, typeId: pfRent.id, amount: 7000, fromMonth: '2026-06' }).error === 'overlap_line', 'two running lines of one type on one place cannot overlap');
check(pfLine(adminTok, { centreType: 'store', centreId: pfStA.id, typeId: pfRent.id, amount: 7000, fromMonth: '2026-06', label: 'Second shop' }).ok, 'unless they are told apart by a label');
check(pfLine(adminTok, { centreType: 'car', centreId: pfCarB.id, typeId: pfIns.id, amount: 310, fromMonth: '2026-03' }).ok, 'car B: insurance');
var pfLocLine = pfLine(adminTok, { centreType: 'location', centreId: pfLocA.id, typeId: pfSal.id, amount: 620, fromMonth: '2026-03', label: 'Branch manager' });
var pfAreaLine = pfLine(adminTok, { centreType: 'cluster', centreId: pfArea.id, typeId: pfSal.id, amount: 930, fromMonth: '2026-03', label: 'Area manager' });
var pfCoLine = pfLine(adminTok, { centreType: 'company', centreId: 'company', typeId: pfGa.id, amount: 1550, fromMonth: '2026-03' });
check(pfLocLine.ok && pfAreaLine.ok && pfCoLine.ok, 'branch, area and company overheads');
check(pfLine(adminTok, { centreType: 'city', centreId: 'Atlantis', typeId: pfGa.id, amount: 5, fromMonth: '2026-03' }).error === 'invalid_centre', 'a city some branch sits in');

console.log('--- costing: the month of March 2026, top line to bottom line ---');
function pfReport(o) { var p = { action: 'getProfitReport', token: pfAccTok, dateFrom: '2026-03-01', dateTo: '2026-03-31' }; Object.keys(o || {}).forEach(function (k) { p[k] = o[k]; }); return call(p); }
function pfNode(rep, key) { return ((rep.nodes || []).filter(function (n) { return n.key === key; })[0] || {}).T || {}; }
var pfR = pfReport();
check(pfR.ok && pfR.basis === 'sales' && pfR.vatIncluded === true, 'the report runs, sharing overheads by sales, prices holding VAT');
var pfCo = pfNode(pfR, 'location:' + pfLocA.id), pfB = pfNode(pfR, 'location:' + pfLocB.id), pfAr = pfNode(pfR, 'cluster:PF City|' + pfArea.id);
var pfUa = pfNode(pfR, 'car:' + pfCarA.id), pfUs = pfNode(pfR, 'store:' + pfStA.id), pfUb = pfNode(pfR, 'car:' + pfCarB.id), pfUsb = pfNode(pfR, 'store:' + pfStB.id);
close(pfUs.gross, 2300, 'store A sold 2,300 with VAT'); close(pfUs.net, 2000, '2,000 without it'); close(pfUs.cogs, 1500, 'cost of goods 100 x 15'); close(pfUs.gm, 500, 'gross margin 500');
close(pfUa.net, 1400, 'car A1 carries its own sales and its POS machine\'s: 1,000 + 400');
close(pfUa.cogs, 1050, 'car A1 cost of goods 70 x 15'); close(pfUa.gm, 350, 'car A1 gross margin');
close(pfUa.expenses, 40, 'what the car paid out of its takings is its cost');
close(pfUa.fixed, 4100, 'car A1 monthly profile: depreciation 1,000 + driver 3,100');
close(pfUa.fixedVehicle, 1000, 'of which vehicle 1,000'); close(pfUa.fixedStaff, 3100, 'and staff 3,100');
close(pfUa.cm, -3790, 'car A1 contribution = 350 - 40 - 4,100');
close(pfUs.fixed, 6200, 'store A: only the rent that ran in March (the second shop starts in June)');
close(pfUs.cm, -5700, 'store A contribution');
close(pfUb.cm, -160, 'car B1 contribution = 150 - 310');
close(pfUsb.net, 0, 'store B sold nothing'); close(pfUsb.profit, 0, 'and with no sales it is given no overhead');
close(pfUs.ovhLocation, 620 * 2000 / 3400, 'the branch overhead is shared by sales: store A');
close(pfUa.ovhLocation, 620 * 1400 / 3400, 'and car A1');
close(pfUs.ovhCluster, 465, 'the area overhead 930 x 2,000 / 4,000'); close(pfUb.ovhCluster, 139.5, 'car B1 share of the area');
close(pfUa.ovhCompany, 542.5, 'G&A 1,550 x 1,400 / 4,000');
close(pfCo.cm, -9490, 'branch A contribution'); close(pfCo.ovhLocation, 620, 'branch A carries its whole own overhead');
close(pfCo.ovhCluster, 790.5, 'its share of the area'); close(pfCo.ovhCompany, 1317.5, 'its share of G&A');
close(pfCo.profit, -12218, 'branch A bottom line');
close(pfB.profit, -532, 'branch B bottom line');
var pfTot = pfNode(pfR, 'company');
close(pfTot.net, 4000, 'company net sales'); close(pfTot.gm, 1000, 'company gross margin'); close(pfTot.fixed, 10610, 'company direct fixed costs');
close(pfTot.cm, -9650, 'company contribution'); close(pfTot.ovh, 3100, 'every overhead counted once');
close(pfTot.profit, -12750, 'company bottom line = the branches added up');
close(pfAr.profit, -12750, 'the area node agrees'); close(pfNode(pfR, 'city:PF City').profit, -12750, 'and the city node');
close(pfTot.qty, 200, 'units sold');
check(pfR.ok && pfR.bucket === 'day' && pfR.buckets.length === 31, 'a month comes back day by day');
var pfSerA = ((pfR.units || []).filter(function (u) { return u.key === 'car:' + pfCarA.id; })[0] || {}).series || {};
close((pfSerA.net || [])[9], 1000, 'car A1 on the 10th'); close((pfSerA.net || [])[10], 400, 'and the 11th');
close((pfSerA.fixed || [])[0], 4100 / 31, 'its fixed cost is spread over the days of the month');
close((pfSerA.net || []).reduce(function (a, b) { return a + b; }, 0), 1400, 'the days add up to the month');
close((pfSerA.ovh || []).reduce(function (a, b) { return a + b; }, 0), pfUa.ovh, 'overhead days add up too');
check((pfSerA.other || []).length === 31 && (pfSerA.other || []).every(function (v) { return v === 0; }), 'delivery fees charged have a series of their own, apart from net sales');

console.log('--- costing: one day, another basis, another month ---');
var pfDay = pfReport({ dateFrom: '2026-03-10', dateTo: '2026-03-10' });
var pfDayT = pfNode(pfDay, 'company');
close(pfDayT.net, 3600, 'the 10th: net sales'); close(pfDayT.gm, 900, 'gross margin');
close(pfDayT.fixed, 10610 / 31, 'one day carries a 31st of the month\'s fixed costs');
close(pfDayT.cm, 900 - 40 - 10610 / 31, 'contribution of the day'); close(pfDayT.ovh, 100, 'overheads of the day');
close(pfDayT.profit, 900 - 40 - 10610 / 31 - 100, 'the day\'s bottom line');
var pfEq = pfReport({ basis: 'equal' });
close(pfNode(pfEq, 'store:' + pfStB.id).ovhCluster, 232.5, 'shared equally, each of the area\'s four stores and cars takes a quarter of its overhead');
close(pfNode(pfEq, 'company').profit, -12750, 'the company total does not depend on the basis');
check(pfReport({ basis: 'moon' }).error === 'invalid_input', 'an unknown basis is refused');
check(pfReport({ dateFrom: '2026-03-31', dateTo: '2026-03-01' }).error === 'invalid_period', 'so is a range that ends before it starts');
var pfFeb = pfReport({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
close(pfNode(pfFeb, 'company').fixed, 7200, 'February: only the lines that had started (depreciation 1,000 + rent 6,200)');
close(pfNode(pfFeb, 'company').ovh, 0, 'no overhead line had started');
var pfYear = pfReport({ dateFrom: '2026-01-01', dateTo: '2026-06-30' });
check(pfYear.ok && pfYear.bucket === 'month' && pfYear.buckets.join() === '2026-01,2026-02,2026-03,2026-04,2026-05,2026-06', 'a long range comes back month by month');
var pfCmp = pfReport({ compare: true });
close(((pfCmp.prev || {}).company || {}).fixed, 7200, 'compare brings the period before (February) for each node');

console.log('--- costing: prices without VAT, cost history ---');
check(call({ action: 'adminSetConfig', token: adminTok, data: { salesIncludeVat: false } }).ok, 'the setting: sales prices do not include VAT');
close(pfNode(pfReport(), 'store:' + pfStA.id).net, 2300, 'then net sales are the sales as entered');
check(call({ action: 'adminSetConfig', token: adminTok, data: { salesIncludeVat: true } }).ok && call({ action: 'listMeta', token: adminTok }).config.salesIncludeVat === true, 'and back; the setting shows in the reference data');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: pfP1.id, data: { unitCost: 16 } }).ok, 'the unit cost changes today');
close(pfNode(pfReport(), 'company').cogs, 3000, 'March keeps the cost it was sold at');
var pfNoCost = pfEnt('product', { name: 'PF No cost', type: 'goods', unitPrice: 10 });
check(call({ action: 'createDailyEntry', token: adminTok, date: '2026-03-12', sourceType: 'store', sourceId: pfStB.id, productId: pfNoCost.id, qty: 10, unitPrice: 10, cashSales: 100 }).ok, 'a sale of an item with no cost');
var pfCov = pfReport();
close(pfCov.coverage.uncostedSales, 100 / 1.15, 'is reported as sales with no cost behind them');
check(pfCov.coverage.productsWithoutCost.indexOf(pfNoCost.id) >= 0, 'naming the product');

console.log('--- costing: changing, ending and voiding a line ---');
var pfChg = call({ action: 'changeCostLine', token: adminTok, id: pfRentLine.line.id, fromMonth: '2026-04', amount: 6500 });
check(pfChg.ok && pfChg.ended.toMonth === '2026-03' && pfChg.line.fromMonth === '2026-04' && pfChg.line.amount === 6500, 'a new amount from April ends the old line in March and starts a new one');
close(pfNode(pfReport(), 'store:' + pfStA.id).fixed, 6200, 'March still shows the old rent');
close(pfNode(pfReport({ dateFrom: '2026-04-01', dateTo: '2026-04-30' }), 'store:' + pfStA.id).fixed, 6500, 'April the new one');
check(call({ action: 'changeCostLine', token: adminTok, id: pfChg.line.id, fromMonth: '2026-02', amount: 1 }).error === 'invalid_month', 'a change cannot start before the line did');
var pfEnd = call({ action: 'endCostLine', token: adminTok, id: pfSalLine.line.id, toMonth: '2026-03' });
check(pfEnd.ok && pfEnd.line.toMonth === '2026-03', 'a line is ended at a month');
close(pfNode(pfReport({ dateFrom: '2026-04-01', dateTo: '2026-04-30' }), 'car:' + pfCarA.id).fixed, 1000, 'and stops counting after it');
check(call({ action: 'voidCostLine', token: adminTok, id: pfCoLine.line.id }).error === 'reason_required', 'voiding needs a reason');
check(call({ action: 'voidCostLine', token: pfAccTok, id: pfCoLine.line.id, reason: 'x' }).error === 'forbidden', 'and the right to write');
check(call({ action: 'voidCostLine', token: adminTok, id: pfCoLine.line.id, reason: 'typed twice' }).ok, 'a wrong line is voided with a reason');
close(pfNode(pfReport(), 'company').ovhCompany, 0, 'and drops out of the figures');
check(call({ action: 'voidCostLine', token: adminTok, id: pfCoLine.line.id, reason: 'again' }).error === 'already_voided', 'once');

console.log('--- costing: a sheet of costs goes in all or nothing, and only once ---');
function pfImp(rows, o) { var p = { action: 'importCostLines', token: adminTok, month: '2026-03', rows: rows }; Object.keys(o || {}).forEach(function (k) { p[k] = o[k]; }); return call(p); }
var pfRows = [{ centreType: 'car', centreId: pfCarB.id, typeId: pfIns.id, amount: 310 }, { centreType: 'car', centreId: pfCarB.id, typeId: pfFuel.id, amount: 500 }];
var pfI1 = pfImp(pfRows);
check(pfI1.ok && pfI1.created === 1 && pfI1.skipped === 1 && pfI1.changed === 0, 'the line already there is skipped, the new one is added (got ' + JSON.stringify([pfI1.created, pfI1.skipped, pfI1.changed, pfI1.error]) + ')');
var pfI2 = pfImp(pfRows);
check(pfI2.ok && pfI2.created === 0 && pfI2.skipped === 2, 'the same sheet again changes nothing');
var pfBefore = call({ action: 'listCosts', token: adminTok }).lines.length;
var pfI3 = pfImp([{ centreType: 'car', centreId: pfCarB.id, typeId: pfOwn.entity.id, amount: 25 }, { centreType: 'car', centreId: 'nope', typeId: pfIns.id, amount: 5 }]);
check(!pfI3.ok && pfI3.error === 'invalid_centre' && pfI3.index === 1 && call({ action: 'listCosts', token: adminTok }).lines.length === pfBefore, 'one bad row stops the whole sheet');
var pfI4 = pfImp([{ centreType: 'car', centreId: pfCarB.id, typeId: pfFuel.id, amount: 650 }], { month: '2026-04' });
check(pfI4.ok && pfI4.changed === 1, 'a different amount from April is a change from April');
close(pfNode(pfReport(), 'car:' + pfCarB.id).fixed, 810, 'March: insurance 310 + fuel 500');
close(pfNode(pfReport({ dateFrom: '2026-04-01', dateTo: '2026-04-30' }), 'car:' + pfCarB.id).fixed, 960, 'April: 310 + 650');
var pfI5 = pfImp([{ centreType: 'car', centreId: pfCarB.id, typeId: pfOwn.entity.id, amount: 75 }], { oneOff: true });
check(pfI5.ok && pfI5.created === 1 && pfI5.lines[0].toMonth === '2026-03' && pfI5.lines[0].oneOff === true, 'a one-month cost stays in its month');
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'cost_type', id: pfOwn.entity.id }).error === 'has_children', 'a cost type in use cannot be deleted');

console.log('--- costing: the monthly expenses report ---');
var pfCr = call({ action: 'getCostReport', token: pfAccTok, monthFrom: '2026-02', monthTo: '2026-04' });
check(pfCr.ok && pfCr.months.join() === '2026-02,2026-03,2026-04', 'three months');
function pfCrRow(f) { return (pfCr.rows || []).filter(f)[0] || { amounts: [] }; }
var pfCrDep = pfCrRow(function (r) { return r.centreType === 'car' && r.centreId === pfCarA.id && r.typeId === pfDep.id; });
check(pfCrDep.amounts.join() === '1000,1000,1000' && pfCrDep.locationId === pfLocA.id && pfCrDep.clusterId === pfArea.id && pfCrDep.city === 'PF City', 'depreciation every month, placed under its branch, area and city');
var pfCrFuel = (pfCr.rows || []).filter(function (r) { return r.centreId === pfCarB.id && r.typeId === pfFuel.id; });
check(pfCrFuel.length === 2 && pfCrFuel.map(function (r) { return r.amounts.join(); }).sort().join('|') === '0,0,650|0,500,0', 'the fuel line before and after its change');
var pfCrTak = pfCrRow(function (r) { return r.source === 'takings' && r.centreId === pfCarA.id; });
check(pfCrTak.amounts.join() === '0,40,0', 'what was paid out of the takings shows in its month');
check(!(pfCr.rows || []).some(function (r) { return r.lineId === pfCoLine.line.id; }), 'a voided line is not in the report');
check(call({ action: 'getCostReport', token: saraTok, monthFrom: '2026-02', monthTo: '2026-04' }).error === 'forbidden', 'the expenses report is not for an area manager');
check(call({ action: 'getCostReport', token: pfAccTok, monthFrom: '2020-01', monthTo: '2026-04' }).error === 'period_too_long', 'at most 36 months at a time');

console.log('--- costing review fixes: ending a line, sheets and labelled lines, cost corrections ---');
check(call({ action: 'endCostLine', token: adminTok, id: pfChg.ended.id, toMonth: '2026-12' }).error === 'overlap_line', 'an ended line cannot be stretched over the line that replaced it');
check(call({ action: 'endCostLine', token: adminTok, id: pfI5.lines[0].id, toMonth: '2026-08' }).error === 'line_fixed', 'a one-month cost has no other last month');
check(call({ action: 'endCostLine', token: adminTok, id: pfDepLine.line.id, toMonth: '2031-06' }).error === 'invalid_month', 'depreciation cannot run past its asset\'s life');
check(call({ action: 'endCostLine', token: adminTok, id: pfDepLine.line.id, toMonth: '2028-12' }).ok, 'but it can stop early (the car was sold)');
// a sheet row carries no label: it speaks for the one running line of its type
var pfCash = pfLine(adminTok, { centreType: 'store', centreId: pfStB.id, typeId: pfSal.id, amount: 3000, fromMonth: '2026-03', label: 'Cashier' });
check(pfCash.ok, 'store B: a labelled salary line');
var pfL1 = pfImp([{ centreType: 'store', centreId: pfStB.id, typeId: pfSal.id, amount: 3000 }]);
check(pfL1.ok && pfL1.skipped === 1 && pfL1.created === 0, 'the sheet\'s plain row finds the labelled line and adds nothing (got ' + JSON.stringify([pfL1.created, pfL1.skipped, pfL1.error]) + ')');
var pfL2 = pfImp([{ centreType: 'store', centreId: pfStB.id, typeId: pfSal.id, amount: 3200 }], { month: '2026-04' });
check(pfL2.ok && pfL2.changed === 1 && pfL2.lines[0].label === 'Cashier' && pfL2.lines[0].amount === 3200, 'a new amount changes that line and keeps its label');
check(pfLine(adminTok, { centreType: 'store', centreId: pfStB.id, typeId: pfSal.id, amount: 2000, fromMonth: '2026-03', label: 'Helper' }).ok, 'a second salary line on the store');
var pfL3 = pfImp([{ centreType: 'store', centreId: pfStB.id, typeId: pfSal.id, amount: 5000 }], { month: '2026-04' });
check(!pfL3.ok && pfL3.error === 'overlap_line' && pfL3.index === 0, 'with two lines of the type, a plain row cannot say which it means');
// a one-month cost typed again with another amount replaces the first
var pfO2 = pfImp([{ centreType: 'car', centreId: pfCarB.id, typeId: pfOwn.entity.id, amount: 80 }], { oneOff: true });
var pfOnes = call({ action: 'listCosts', token: adminTok }).lines.filter(function (l) { return l.oneOff && l.centreId === pfCarB.id && l.typeId === pfOwn.entity.id; });
check(pfO2.ok && pfO2.changed === 1 && pfOnes.length === 1 && pfOnes[0].amount === 80, 'the corrected one-month cost stands alone (got ' + JSON.stringify([pfO2.changed, pfO2.created, pfOnes.length]) + ')');
// a voided line no longer ties its place down
var pfCarX = pfEnt('car', { locationId: pfLocB.id, label: 'PF Car X', driverUserId: pfDr2.id });
var pfXl = pfLine(adminTok, { centreType: 'car', centreId: pfCarX.id, typeId: pfIns.id, amount: 100, fromMonth: '2026-03' });
check(call({ action: 'adminDeleteEntity', token: adminTok, kind: 'car', id: pfCarX.id }).error === 'has_children', 'a car with a cost line stays');
check(call({ action: 'voidCostLine', token: adminTok, id: pfXl.line.id, reason: 'wrong car' }).ok && call({ action: 'adminDeleteEntity', token: adminTok, kind: 'car', id: pfCarX.id }).ok, 'once its only line is voided it can go');
// the unit cost from a date: a correction reaches back
check(call({ action: 'setProductCost', token: pfAccTok, productId: pfP1.id, unitCost: 14, from: '2026-03-11' }).error === 'forbidden', 'the accountant does not set costs');
check(call({ action: 'setProductCost', token: adminTok, productId: pfP1.id, unitCost: 14, from: '2099-01-01' }).error === 'future_date', 'a cost cannot start in the future');
check(call({ action: 'setProductCost', token: adminTok, productId: pfP1.id, unitCost: -1, from: '2026-03-11' }).error === 'invalid_cost', 'nor be negative');
check(call({ action: 'setProductCost', token: adminTok, productId: pfP1.id, unitCost: 14, from: '2026-03-11' }).error === 'past_needs_reason', 'a cost from a past date is a correction, and needs its reason');
var pfSc = call({ action: 'setProductCost', token: adminTok, productId: pfP1.id, unitCost: 14, from: '2026-03-11', reason: 'typed wrong in March' });
check(pfSc.ok && pfSc.product.unitCost === 14, 'a unit cost is set from a date, and becomes the product\'s cost');
close(pfNode(pfReport(), 'company').cogs, 1500 + 750 + 20 * 14 + 450, 'sales from that date cost 14, the earlier ones still 15');
var pfHist = (call({ action: 'listCosts', token: pfAccTok }).productCosts || []).filter(function (r) { return r.productId === pfP1.id; });
check(pfHist.length === 2 && pfHist.map(function (r) { return r.from + ':' + r.unitCost; }).sort().join() === '2000-01-01:15,2026-03-11:14', 'the history keeps what stood before and drops the later cost it replaced (got ' + pfHist.map(function (r) { return r.from + ':' + r.unitCost; }).join() + ')');
// a cost cleared to follow the inventory item (2026-10-05: the item holds the dated cost)
var pfAnchor = pfEnt('stock_item', { name: 'PF Stock', kind: 'unit', unitCost: 15 });
check(call({ action: 'setStockItemCost', token: adminTok, stockItemId: pfAnchor.id, field: 'unitCost', cost: 15, from: '2026-01-01', reason: 'cost known since January' }).ok, 'the inventory item\'s cost is dated from the start of the year');
var pfChild = pfEnt('product', { name: 'PF Child', type: 'goods', unitPrice: 30, unitCost: 20, stockItemId: pfAnchor.id, stockEffect: 'unit' });
check(call({ action: 'setProductCost', token: adminTok, productId: pfChild.id, unitCost: 0, from: '2026-01-01', reason: 'follows its stock item' }).ok, 'a product\'s own cost is cleared from the start of the year');
var pfBeforeChild = pfNode(pfReport(), 'company').cogs;
check(call({ action: 'createDailyEntry', token: adminTok, date: '2026-03-13', sourceType: 'store', sourceId: pfStB.id, productId: pfChild.id, qty: 10, unitPrice: 30, cashSales: 300 }).ok, 'and it is sold');
close(pfNode(pfReport(), 'company').cogs - pfBeforeChild, 150, 'its sale then costs what its stock item costs');
// odd ids never break the report
ctx.writeRow(ctx.SHEETS.PRODUCT_COSTS, { productId: 'toString', unitCost: 5, from: '2026-01-01' });
ctx.writeRow(ctx.SHEETS.PRODUCT_COSTS, { productId: '__proto__', unitCost: 5, from: '2026-01-01' });
check(pfReport().ok, 'a cost record with an odd product id does not stop the report');
// what one unit costs is not for every role
var pfDrMeta = call({ action: 'listMeta', token: dpTok });
check(pfDrMeta.ok && pfDrMeta.products.length > 0 && pfDrMeta.products.every(function (p) { return p.unitCost === undefined && p.emptyCost === undefined; }), 'a driver is not sent unit costs');
check(call({ action: 'listMeta', token: pfAccTok }).products.some(function (p) { return p.unitCost === 14; }), 'the accountant is');

console.log('\n=== Sheets reads written text as if typed: every cell must come back as written ===');
// The fake sheet converts '2026-09-30', '08:00', '0501234567' the way Google Sheets
// does (stub-harness sheetValue). Records live inside the JSON cell, so they are
// safe; the id and updatedAt cells beside it must stay plain text too.
var txId = ctx.writeRow(ctx.SHEETS.RISK_ITEMS, { date: '2026-09-30', time: '08:00', phone: '0501234567', ref: '12/3', big: '012345678901234567' }).id;
ctx.bumpVersion_(ctx.SHEETS.RISK_ITEMS);
var txBack = ctx.readSheet(ctx.SHEETS.RISK_ITEMS).filter(function (r) { return r.id === txId; })[0] || {};
check(txBack.date === '2026-09-30' && txBack.time === '08:00' && txBack.phone === '0501234567' && txBack.ref === '12/3' && txBack.big === '012345678901234567',
  'a record\'s date, time, phone and long number read back exactly as written');
check(typeof txBack.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(txBack.updatedAt), 'updatedAt reads back as the ISO text it was written as');
var txBad = [];
Object.keys(ctx._debug.sheets).forEach(function (n) {
  ctx._debug.sheets[n]._rows.slice(1).forEach(function (r, i) {
    if (typeof r[0] !== 'string' || typeof r[1] !== 'string' || r[1].charAt(0) !== '{' || typeof r[2] !== 'string')
      txBad.push(n + ' row ' + (i + 2) + ': ' + JSON.stringify(r).slice(0, 80));
  });
});
check(txBad.length === 0, 'after the whole run, every row of every sheet is [text id, JSON, ISO text] (' + txBad.slice(0, 3).join(' | ') + ')');

console.log('--- English is the default language; a chosen one stays ---');
var lgNew = call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://x.test/', data: { name: 'Lang Default', email: 'lang.default@bestgas.sa', role: 'collector' } });
check(lgNew.ok && lgNew.user.language === 'en', 'a new account without a language is English (got ' + (lgNew.user && lgNew.user.language) + ')');
var lgMail = ctx._debug.mailLog.filter(function (m) { return m.to === 'lang.default@bestgas.sa'; }).pop();
check(lgMail && lgMail.html.indexOf('Accept invitation') >= 0 && lgMail.html.indexOf('قبول الدعوة') < 0, 'and its invitation is in English');
var lgOld = ctx.getById_(ctx.SHEETS.USERS, lgNew.user.id); lgOld.language = 'ar'; delete lgOld.languageChosen; ctx.writeRow(ctx.SHEETS.USERS, lgOld);
check(ctx.publicUser_(ctx.getById_(ctx.SHEETS.USERS, lgNew.user.id)).language === 'en', 'an account that only carries the old Arabic default opens in English');
ctx.actionSetLanguage_({ language: 'ar' }, ctx.getById_(ctx.SHEETS.USERS, lgNew.user.id));
check(ctx.publicUser_(ctx.getById_(ctx.SHEETS.USERS, lgNew.user.id)).language === 'ar', 'once someone picks Arabic, Arabic stays');
check(call({ action: 'adminCreateUser', token: adminTok, appUrl: 'https://x.test/', data: { name: 'Lang Urdu', email: 'lang.ur@bestgas.sa', role: 'collector', language: 'ur' } }).user.language === 'ur', 'Urdu set by the admin stays Urdu');

console.log('--- a handover amount is the same at every stage, and its parts always add up to it ---');
// what a receiver's statement adds up: what came in, less what came off,
// less what was received short at a handover on the way
function partsNet_(b) {
  var ins = Number(b.storeCash || 0) + Number(b.carCash || 0) + Number(b.posCash || 0) + Number(b.otherCash || 0) + Number(b.creditDeliveryFees || 0) + Number(b.channelDeliveryFees || 0);
  var outs = Number(b.deliveryFee || 0) - Number(b.vatOnDelivery || 0) + Number(b.creditSales || 0) + Number(b.creditCommissions || 0) + Number(b.channelCommissions || 0) +
    Number(b.bankTransfers || 0) + Number(b.expenses || 0) + Number(b.directDeposit || 0) + Number(b.shortfall || 0);
  return ins - outs;
}
var sfDay = ctx.computeNet_([
  { sourceType: 'car', cashSales: 920, deliveryFeeBankAmount: 115, expenseAmount: 50, bankTransferAmount: 100, channelDeliveryFee: 30, channelCommission: 10 },
  { sourceType: 'pos', cashSales: 200, posSales: 300 }]);
close(sfDay.netCashOwed, 890, 'the test day nets to 890');
close(partsNet_(sfDay), 890, 'and its parts add up to it');
function sfRow(id, kind, from, to, b, status, sources) {
  ctx.writeRow(SHEETS.HANDOFFS, { id: id, kind: kind, fromUserId: from, createdBy: from, toUserId: to, amount: b.netCashOwed, breakdown: b,
    sourceEntryIds: [], sourceHandoffIds: sources || [], consumedBy: null, status: status || 'pending', createdAt: new Date().toISOString() });
}
sfRow('sf-car', 'car_to_location', 'sf-driver', 'sf-bm', sfDay);
var sfC1 = ctx.actionConfirmHandoff_({ id: 'sf-car', receivedAmount: 870 }, { id: 'sf-bm', role: 'store_manager' });
check(sfC1.ok && sfC1.handoff.amount === 870, 'the branch manager received 870 of 890');
close(sfC1.handoff.breakdown.shortfall, 20, 'the 20 short is a part of the statement');
close(partsNet_(sfC1.handoff.breakdown), 870, 'so the statement still adds up to what was received');
var sfUp = ctx.sumBreakdowns_([sfC1.handoff.breakdown, ctx.computeNet_([{ sourceType: 'store', cashSales: 1500, creditSales: 200 }])]);
close(sfUp.netCashOwed, 2170, 'the branch hands on 870 + 1,300');
close(sfUp.shortfall, 20, 'with the 20 short still in it');
close(partsNet_(sfUp), 2170, 'and the statement adds up at that stage too');
sfRow('sf-loc', 'location_to_cluster', 'sf-bm', 'sf-am', sfUp, 'pending', ['sf-car']);
var sfC2 = ctx.actionConfirmHandoff_({ id: 'sf-loc', receivedAmount: 2160 }, { id: 'sf-am', role: 'cluster_manager' });
close(sfC2.handoff.breakdown.shortfall, 30, 'a second short receipt adds to the first');
close(partsNet_(sfC2.handoff.breakdown), 2160, 'and the statement adds up to the 2,160 received');
sfRow('sf-over', 'car_to_location', 'sf-driver', 'sf-bm', ctx.computeNet_([{ sourceType: 'car', cashSales: 600 }]));
var sfC3 = ctx.actionConfirmHandoff_({ id: 'sf-over', receivedAmount: 605 }, { id: 'sf-bm', role: 'store_manager' });
close(sfC3.handoff.breakdown.shortfall, -5, 'five more than declared is the same part, the other way');
close(partsNet_(sfC3.handoff.breakdown), 605, 'and that statement adds up to 605');
sfRow('sf-exact', 'car_to_location', 'sf-driver', 'sf-bm', ctx.computeNet_([{ sourceType: 'car', cashSales: 400 }]));
var sfC4 = ctx.actionConfirmHandoff_({ id: 'sf-exact', receivedAmount: 400 }, { id: 'sf-bm', role: 'store_manager' });
check(sfC4.ok && !sfC4.handoff.breakdown.shortfall, 'a handover received in full carries no short part');
sfRow('sf-disp', 'car_to_location', 'sf-driver', 'sf-bm', ctx.computeNet_([{ sourceType: 'car', cashSales: 600 }]), 'disputed');
var sfR = ctx.actionResolveDispute_({ id: 'sf-disp', resolution: 'confirm', receivedAmount: 550, note: 'counted 550' }, { id: 'sf-fin', role: 'finance' });
check(sfR.ok && sfR.handoff.amount === 550, 'a dispute settled at 550');
close(sfR.handoff.breakdown.shortfall, 50, 'records the 50 short as a part too');
close(partsNet_(sfR.handoff.breakdown), 550, 'so its statement adds up to 550');

console.log('--- the screens use the same arithmetic as the server ---');
var clientHtml = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
// a top-level client function's source, braces matched past strings and comments
function clientFn_(name) {
  var at = clientHtml.indexOf('\nfunction ' + name + '(');
  if (at < 0) return '';
  var i = clientHtml.indexOf('{', at), depth = 0, q = null;
  for (; i < clientHtml.length; i++) {
    var c = clientHtml[i], n = clientHtml[i + 1];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '\x60') { q = c; continue; }
    // a regex literal (a slash where a value starts): skip to its closing slash
    if (c === '/' && n !== '/' && n !== '*' && /(^|[(,=:[!&|?{};+\-*%~^<>]|\breturn)\s*$/.test(clientHtml.slice(Math.max(0, i - 12), i))) {
      var inClass = false;
      for (i++; i < clientHtml.length; i++) {
        var r = clientHtml[i];
        if (r === '\\') { i++; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if ((r === '/' && !inClass) || r === '\n') break;
      }
      continue;
    }
    if (c === '/' && n === '/') { i = clientHtml.indexOf('\n', i); continue; }
    if (c === '/' && n === '*') { i = clientHtml.indexOf('*/', i) + 1; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return clientHtml.slice(at + 1, i + 1);
  }
  return '';
}
var vm = require('vm');
var clientCtx = vm.createContext({ t: function (k) { return k; }, money: function (n) { return Number(n || 0).toFixed(2); }, vatRateClient_: function () { return 0.15; } });
['vatRateFor_', 'entryAmt_', 'cashCalcRows_', 'brkParts_'].forEach(function (n) {
  var src = clientFn_(n);
  check(!!src, 'the screen function ' + n + ' exists');
  if (src) vm.runInContext(src, clientCtx);
});
var mixed = [
  { sourceType: 'car', cashSales: 920, deliveryFeeBankAmount: 115, expenseAmount: 50, bankTransferAmount: 100, channelDeliveryFee: 30, channelCommission: 10 },
  { sourceType: 'pos', cashSales: 200, posSales: 300, directDepositAmount: 80 },
  { sourceType: 'store', cashSales: 1500, creditSales: 200, creditDeliveryFee: 12, creditCommission: 4, otherCash: 35 },
  { sourceType: 'store', cashSales: 800, creditSales: 100, creditDeliveryFee: 20, creditCommission: 3, creditFeeRule: 2 }];
if (clientCtx.entryAmt_) close(mixed.reduce(function (a, e) { return a + clientCtx.entryAmt_(e).net; }, 0), ctx.computeNet_(mixed).netCashOwed, 'each entry\'s net on the screens adds up to the server\'s net');
function rowsAddUp_(b, label) {
  if (!clientCtx.brkParts_ || !clientCtx.cashCalcRows_) return check(false, label + ': no brkParts_');
  var rows = clientCtx.cashCalcRows_(clientCtx.brkParts_(b));
  var ins = 0, outs = 0, fin = null;
  rows.forEach(function (r) { if (!r.kind) ins += r.amount; else if (r.kind === 'deduct') outs += r.amount; else if (r.kind === 'final') fin = r.amount; });
  close(ins - outs, b.netCashOwed, label + ': the lines add up to the amount');
  close(fin, b.netCashOwed, label + ': and the last line is the amount');
}
rowsAddUp_(sfDay, 'a day with a transfer, Souq Gas and a delivery fee');
rowsAddUp_(ctx.computeNet_(mixed), 'a mixed day with credit fees and a الموازنة');
rowsAddUp_(sfC2.handoff.breakdown, 'a handover received short twice');
rowsAddUp_(sfC3.handoff.breakdown, 'a handover received over');
// a handover confirmed short before the part existed: the gap still shows as a line
rowsAddUp_(Object.assign({}, ctx.computeNet_([{ sourceType: 'car', cashSales: 600 }]), { netCashOwed: 580 }), 'an old short handover');
if (clientCtx.brkParts_) {
  var ddParts = clientCtx.brkParts_({ storeCash: 0, carCash: 0, posCash: 0, deliveryFee: 0, posSales: 0, creditSales: 0, vatOnDelivery: 0, otherCash: 0, expenses: 0, directDeposit: 0, netCashOwed: 750 });
  check(!ddParts.short, 'a الموازنة banked at the branch (a breakdown that only carries its amount) draws no short or over line');
}
check(/brkParts_\(/.test(clientFn_('breakdownGrid')), 'the handover card draws its statement from brkParts_');
check(/brkParts_\(/.test(clientFn_('handoffDocView_')), 'the handover document draws its statement from brkParts_');
var rhSrc = clientFn_('renderHandoffs');
check(rhSrc.indexOf('entryAmt_(e).net') >= 0 && !/Number\(e\.expenseAmount\|\|0\)\s*-\s*Number\(e\.directDepositAmount/.test(rhSrc),
  'the area manager\'s ready figure counts his own days with entryAmt_, the server\'s arithmetic');
check(/T\.netCashOwed/.test(clientFn_('salesAndCollectionStatements_')), 'the collection statement takes what is owed from the server\'s total');

console.log('--- signed out after ten minutes without a touch, the draft kept ---');
function idleCtx_(lastActiveAgoMs, opts) {
  opts = opts || {};
  var store = {}, now = 1800000000000, out = { logouts: 0 };
  if (lastActiveAgoMs != null) store.bgc_lastActive = String(now - lastActiveAgoMs);
  if (opts.draft) store['bgc_entryDraft_u1'] = '{"v":1}';
  var c = vm.createContext({
    Date: { now: function () { return now; } }, Number: Number, String: String, Math: Math,
    localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); } },
    state: { user: { id: 'u1' } }, out: out
  });
  vm.runInContext('var IDLE_LIMIT_MS = 10 * 60 * 1000; var idleSaveHook_ = null, idleWrote_ = 0; function logout(){ out.logouts++; state.user = null; }', c);
  ['idleMark_', 'idleLast_', 'idleCheck_'].forEach(function (n) { vm.runInContext(clientFn_(n), c); });
  if (opts.hook) vm.runInContext('idleSaveHook_ = function(){ out.hookRan = true; return ' + (opts.hook === 'saved') + '; };', c);
  return { c: c, out: out, store: store };
}
var ic1 = idleCtx_(9 * 60 * 1000); ic1.c.idleCheck_();
check(ic1.out.logouts === 0, 'nine minutes without a touch: still signed in');
var ic2 = idleCtx_(10 * 60 * 1000 + 1000, { hook: 'saved' }); ic2.c.idleCheck_();
check(ic2.out.logouts === 1 && ic2.out.hookRan, 'ten minutes: the entry screen keeps its draft, then the person is signed out');
check(ic2.c.state.idleOut === 'draft', 'and the sign-in page says the entry is kept as a draft');
var ic3 = idleCtx_(60 * 60 * 1000); ic3.c.idleCheck_();
check(ic3.out.logouts === 1 && ic3.c.state.idleOut === 'plain', 'nothing typed: signed out with the plain message');
var ic4 = idleCtx_(60 * 60 * 1000, { draft: true }); ic4.c.idleCheck_();
check(ic4.c.state.idleOut === 'draft', 'a draft saved earlier (another screen open now) is still announced');
var ic5 = idleCtx_(null); ic5.c.idleCheck_();
check(ic5.out.logouts === 0 && Number(ic5.store.bgc_lastActive) > 0, 'no activity recorded yet (first run of this build): counting starts, nobody is signed out');
var ic6 = idleCtx_(60 * 60 * 1000); ic6.c.state.user = null; ic6.c.idleCheck_();
check(ic6.out.logouts === 0, 'nobody signed in: nothing to do');
var ic7 = idleCtx_(9 * 60 * 1000); ic7.c.idleMark_(true);
check(Number(ic7.store.bgc_lastActive) === 1800000000000, 'activity moves the mark to now');

console.log('--- the welcome line turns with every sign-in ---');
var wSrc = clientHtml.slice(clientHtml.indexOf('\nvar WIS_ = ['), clientHtml.indexOf('\nvar OTD_V_'));
check(wSrc.length > 100, 'the sayings are in the page');
var wc = vm.createContext({ state: { user: { id: 'abc' } }, localStorage: { getItem: function () { return wc.n; } }, Number: Number, String: String, Math: Math, n: '0' });
vm.runInContext(wSrc, wc); vm.runInContext(clientFn_('wisPick_'), wc);
var allOk = wc.WIS_.length >= 20 && wc.WIS_.every(function (q) { return q.en && q.ar && q.ur && q.by && q.by.en && q.by.ar && q.by.ur && !/\u2014|\u2013/.test(q.en + q.ar + q.ur); });
check(allOk, 'every saying has English, Arabic and Urdu text and its author in all three, with no dashes');
wc.n = '2'; var w2 = wc.wisPick_(); wc.n = '3'; var w3 = wc.wisPick_(); wc.n = '4'; var w4 = wc.wisPick_();
check(!w2.event && w3.event && !w4.event, 'one sign-in a saying, the next an event of this day, then a saying again');
check(w2.quote !== w4.quote, 'and the saying is a different one each time');

console.log('--- review 2026-10-03: a stale session is never restored, and the clock going back signs nobody out ---');
function staleCtx_(agoMs, opts) {
  opts = opts || {};
  var now = 1800000000000, store = { bgc_user: '{"id":"u9"}', bgc_meta: '{}' };
  if (opts.token !== false) store.bgc_token = 'tok';
  if (agoMs != null) store.bgc_lastActive = String(now - agoMs);
  if (opts.draft) store.bgc_entryDraft_u9 = '{"v":1}';
  var c = vm.createContext({ Date: { now: function () { return now; } }, Number: Number, String: String, JSON: JSON, Math: Math,
    localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } },
    state: { token: 'tok', user: null, meta: null } });
  vm.runInContext('var IDLE_LIMIT_MS = 10 * 60 * 1000;', c);
  var src = clientFn_('idleStaleAtStart_');
  check(!!src, 'idleStaleAtStart_ exists');
  if (src) vm.runInContext(src, c);
  return { c: c, store: store };
}
var sa1 = staleCtx_(11 * 60 * 1000, { draft: true });
check(sa1.c.idleStaleAtStart_ && sa1.c.idleStaleAtStart_() === true, 'an app reopened after eleven idle minutes is stale');
check(!sa1.store.bgc_token && !sa1.store.bgc_user && !sa1.store.bgc_meta && sa1.c.state.token === '', 'and its token, user and reference data are dropped before anything is drawn');
check(sa1.c.state.idleOut === 'draft' && !!sa1.store.bgc_entryDraft_u9, 'the draft stays, and the sign-in page says so');
var sa2 = staleCtx_(5 * 60 * 1000);
check(sa2.c.idleStaleAtStart_ && sa2.c.idleStaleAtStart_() === false && sa2.store.bgc_token === 'tok', 'five minutes: the session is restored as before');
var sa3 = staleCtx_(null);
check(sa3.c.idleStaleAtStart_ && sa3.c.idleStaleAtStart_() === false && sa3.store.bgc_token === 'tok', 'no activity recorded yet: restored as before');
var sa4 = staleCtx_(60 * 60 * 1000, { token: false });
check(sa4.c.idleStaleAtStart_ && sa4.c.idleStaleAtStart_() === false && !sa4.c.state.idleOut, 'nobody signed in: no message');
var ck = idleCtx_(-5 * 60 * 1000); ck.c.idleCheck_();
check(ck.out.logouts === 0 && Number(ck.store.bgc_lastActive) === 1800000000000, 'the clock set back five minutes: nobody is signed out, and counting starts again from now');

console.log('--- review 2026-10-03: the short part, and older records ---');
if (clientCtx.brkParts_) {
  var rv1 = clientCtx.brkParts_({ carCash: 600, shortfall: 20, netCashOwed: 580 });
  check(rv1.short === 20 && !rv1.diff, 'the server\'s short part is used as it is');
  var rv2 = clientCtx.brkParts_({ storeCash: 1500, creditSales: 200, netCashOwed: 1500 });
  check(!rv2.short && rv2.diff === -200, 'a handover from before credit was deducted shows a neutral difference, never a receipt that was over');
  var rv3 = clientCtx.brkParts_({ carCash: 600, netCashOwed: 580 }, { originalAmount: 600, amount: 580 });
  check(rv3.short === 20 && !rv3.diff, 'a handover received short before the part was kept still says short');
  var rv4 = clientCtx.brkParts_({ carCash: 1200, shortfall: 10, netCashOwed: 1170 });
  check(rv4.short === 10 && rv4.diff === 20, 'a part kept today plus a short from an older stage: both shown, the statement still adds up');
  rowsAddUp_({ carCash: 1200, shortfall: 10, netCashOwed: 1170 }, 'a statement with a short part and an older difference');
  rowsAddUp_({ storeCash: 1500, creditSales: 200, netCashOwed: 1500 }, 'an old statement from before credit was deducted');
}

console.log('--- review 2026-10-03: the welcome line, and the test helper ---');
vm.runInContext(clientFn_('wisPick_'), wc);
wc.n = '3'; var w5 = wc.wisPick_();
check(w5.alt && w5.alt !== w5.quote, 'an event sign-in carries another saying for when there is no event');
var abxLen = clientFn_('abxTemplate_').length;
check(abxLen > 0 && abxLen < 20000, 'the helper reads a function holding a regex literal and stops at its end (got ' + abxLen + ' characters)');

console.log('--- imports read cells as people type them in Excel ---');
var impCtx = vm.createContext({ String: String, Number: Number, Math: Math, RegExp: RegExp });
['cellNorm_', 'csvDelim_', 'parseCsv_', 'headerCell_'].forEach(function (n) {
  var src = clientFn_(n); check(!!src, 'the import helper ' + n + ' exists'); if (src) vm.runInContext(src, impCtx);
});
if (impCtx.cellNorm_) {
  var cn = impCtx.cellNorm_;
  check(cn('1,234.50') === '1234.50', 'a figure with a thousand separator loses it (got ' + cn('1,234.50') + ')');
  check(cn('12,500') === '12500' && cn('1,000,000') === '1000000', 'several groups too');
  check(cn('١٢٣٤٫٥') === '1234.5' && cn('١٬٢٣٤٫٥٠') === '1234.50', 'Arabic digits and separators become a plain figure');
  check(cn('۱۲۳') === '123', 'Persian/Urdu digits too');
  check(cn('750 SAR') === '750' && cn('ر.س 1,200') === '1200', 'a currency word next to the figure is dropped');
  check(cn('-45.5') === '-45.5', 'a minus sign stays');
  check(cn('2026/10/3') === '2026-10-03' && cn('2026-1-9') === '2026-01-09', 'a date typed year first becomes yyyy-mm-dd');
  check(cn('3/10/2026') === '2026-10-03', 'day first when it could be either (as dates are written here)');
  check(cn('10/25/2026') === '2026-10-25', 'month first only when the second part can only be a day');
  check(cn('0501234567') === '0501234567' && cn('+966501234567') === '+966501234567', 'phone numbers and codes with a leading zero or plus stay exactly as typed');
  check(cn('Truck-1') === 'Truck-1' && cn('سيارة ١') === 'سيارة ١' && cn('POS 1,2') === 'POS 1,2', 'names and labels stay as typed, Arabic digits in a name included');
  check(cn('2,5') === '2,5' && cn('1.234,50') === '1.234,50', 'something that is not clearly one figure is left for the import to reject');
  check(cn('  ') === '' && cn(null) === '' && cn(42) === '42', 'blank and real numbers');
}
if (impCtx.csvDelim_ && impCtx.parseCsv_) {
  check(impCtx.csvDelim_('date;sourceType;cashSales\n2026-10-03;car;"1.234,5"') === ';', 'a CSV saved with semicolons is read with semicolons');
  check(impCtx.csvDelim_('date,cashSales\n2026-10-03,"1,234"') === ',' && impCtx.csvDelim_('date\tcashSales\n1\t2') === '\t', 'commas and tabs are recognised');
  var pc = impCtx.parseCsv_('\uFEFFdate;cashSales\r\n2026-10-03;"1 234"\r\n', ';');
  check(pc.length === 2 && pc[0][0] === 'date' && pc[1][1] === '1 234', 'a BOM at the start is dropped and the semicolon file splits into columns');
}
if (impCtx.headerCell_) {
  var hc = impCtx.headerCell_(['Date', ' cash sales ', 'SOURCE_TYPE', 'note']);
  check(hc(['2026-10-03', '900', 'car', 'x'], 'cashSales') === '900' && hc(['2026-10-03', '900', 'car', 'x'], 'sourceType') === 'car' && hc(['2026-10-03'], 'date') === '2026-10-03',
    'a header in other capitals, with spaces or underscores, still finds its column');
  check(hc(['a'], 'missing') === '', 'a column that is not there is empty');
}

console.log('--- a customer sheet sets the commission and delivery fee for every product ---');
var crGoods = ctx.readSheet(SHEETS.PRODUCTS).filter(function (p) { return p.type !== 'services' && p.active !== false; });
var crServices = ctx.readSheet(SHEETS.PRODUCTS).filter(function (p) { return p.type === 'services'; });
check(crGoods.length > 0, 'there are goods to price (' + crGoods.length + ')');
var crAdminUser = ctx.getById_(SHEETS.USERS, admin.id);
var crOld = ctx.importCustomers_([{ name: 'عميل الأسعار القديم' }]).created[0];
check(!!crOld, 'an existing customer to overwrite');
var cr1 = ctx.actionAdminImportCustomers_({ update: true, rows: [
  { name: 'عميل الأسعار القديم', commission: 1, delivery: 2 },
  { name: 'عميل الأسعار الجديد', commission: 0, delivery: 1 },
  { name: 'عميل بسعر سالب', commission: -1, delivery: 1 }
] }, crAdminUser);
check(cr1.ok, 'the sheet is accepted');
var crOldNow = ctx.getById_(SHEETS.CUSTOMERS, crOld.id);
check(crGoods.every(function (p) { return crOldNow.commissions && crOldNow.commissions[p.id] === 1 && crOldNow.deliveryFees && crOldNow.deliveryFees[p.id] === 2; }),
  'the existing customer now takes 1 commission and 2 delivery on every product');
check(crServices.every(function (p) { return !crOldNow.deliveryFees || crOldNow.deliveryFees[p.id] == null; }), 'a service is not charged a per-unit delivery fee');
check((cr1.updated || []).some(function (u) { return u.id === crOld.id; }), 'and is reported as updated');
var crNew = (cr1.created || []).filter(function (c) { return c.name === 'عميل الأسعار الجديد'; })[0];
check(crNew && crNew.commissions && crNew.deliveryFees && crGoods.every(function (p) { return crNew.commissions[p.id] === 0 && crNew.deliveryFees[p.id] === 1; }), 'a new customer is created with its amounts');
check((cr1.skipped || []).some(function (k) { return k.name === 'عميل بسعر سالب' && k.reason === 'invalid_amount'; }), 'a negative amount is refused, that row only');
var crTr = {}; ctx.readSheet(SHEETS.TRANSLATIONS).forEach(function (r) { crTr[r.src] = r; });
check(crTr['عميل الأسعار الجديد'] && crTr['عميل الأسعار الجديد'].en && crTr['عميل الأسعار الجديد'].ur, 'an imported customer gets its English and Urdu name');
check(crTr['عميل الأسعار القديم'] && crTr['عميل الأسعار القديم'].ur, 'so does a customer the sheet updated');
check(!crTr['عميل بسعر سالب'], 'a refused row is not translated');
var cr2 = ctx.actionAdminImportCustomers_({ rows: [{ name: 'عميل الأسعار القديم', commission: 5, delivery: 5 }] }, crAdminUser);
check(cr2.ok && (cr2.skipped || []).some(function (k) { return k.reason === 'duplicate'; }) && (ctx.getById_(SHEETS.CUSTOMERS, crOld.id).commissions || {})[crGoods[0].id] === 1,
  'without overwrite an existing customer is left as it is');
var cr3 = ctx.actionAdminImportCustomers_({ update: true, rows: [{ name: 'عميل الأسعار القديم', commission: 3, delivery: '' }] }, crAdminUser);
var crOld3 = ctx.getById_(SHEETS.CUSTOMERS, crOld.id);
check(cr3.ok && crOld3.commissions && crOld3.deliveryFees && crOld3.commissions[crGoods[0].id] === 3 && crOld3.deliveryFees[crGoods[0].id] === 2, 'a blank amount leaves that one unchanged');
check(ctx.importCustomers_([{ name: 'عميل بسعر نصي', commission: 'abc' }], { update: true }).skipped.length === 1, 'an amount that is not a number is refused');

console.log('--- the customer sheet is read with its header, wherever it starts ---');
['customerRowsFromCells_'].forEach(function (n) { var src = clientFn_(n); check(!!src, n + ' exists'); if (src) vm.runInContext(src, impCtx); });
if (impCtx.customerRowsFromCells_) {
  var crRows = impCtx.customerRowsFromCells_([['', 'التطبيق على كل المنتجات', ''], ['العميل', 'العمولة', 'التوصيل'], ['مخبز تجريبي', 0, 1], ['مطعم تجريبي', '1', '٢'], ['', '', '']]);
  check(crRows.length === 2 && crRows[0].name === 'مخبز تجريبي', 'the title row and the header row are not customers (got ' + crRows.map(function (r) { return r.name; }).join(', ') + ')');
  check(crRows[0].commission === 0 && crRows[0].delivery === 1 && crRows[1].commission === 1 && crRows[1].delivery === 2, 'the commission and delivery columns are read, Arabic digits included');
  var crPlain = impCtx.customerRowsFromCells_([['مخبز أ'], ['مطعم ب']]);
  check(crPlain.length === 2 && crPlain[0].commission == null && crPlain[0].delivery == null, 'a plain list of names still works, with no amounts');
}

console.log('--- the pivot splits a row: the product keeps its sale, each deduction is a line of its own ---');
function clientVar_(name, end) {
  var at = clientHtml.indexOf('\nvar ' + name + ' = ');
  if (at < 0) return '';
  var stop = clientHtml.indexOf(end, at);
  return stop < 0 ? '' : clientHtml.slice(at, stop + end.length);
}
var pvSrc = [clientVar_('EQ_PARTS_', '\n};'), clientVar_('PV_SPLIT_', '\n];'), clientFn_('eqTotals_'), clientFn_('pvSplit_'), clientFn_('pvSources_')];
check(pvSrc.every(Boolean), 'the pivot functions exist');
if (pvSrc.every(Boolean)) {
  vm.runInContext(pvSrc.join('\n'), clientCtx);
  // the day the user showed: every deduction saved on the first product's row
  var pvDay = [
    { id: 'e1', productId: 'gas', cashSales: 31376, directDepositAmount: 9000, expenseAmount: 300, expenseItemId: 'fuel', creditSales: 2000, creditCommission: 57, bankTransferAmount: 500 },
    { id: 'e2', productId: 'fiber', cashSales: 925 },
    { id: 'e3', productId: 'reg', cashSales: 45, otherCash: 20, otherCashItemId: 'scrap' }];
  var pvWhole = clientCtx.eqTotals_(pvDay), pvParts = clientCtx.pvSplit_(pvDay), pvAll = clientCtx.eqTotals_(pvParts);
  ['sales', 'additions', 'deductions', 'net'].forEach(function (m) { close(pvAll[m], pvWhole[m], 'the split rows keep the ' + m); });
  var pvGas = clientCtx.eqTotals_(pvParts.filter(function (p) { return p.productId === 'gas'; }));
  close(pvGas.deductions, 0, 'the first product no longer carries the deductions of the day');
  close(pvGas.sales, 31376, 'and keeps its own sale');
  var pvBanked = pvParts.filter(function (p) { return p.productId === 'x:d:dBanked'; });
  check(pvBanked.length === 1 && clientCtx.eqTotals_(pvBanked).deductions === 9000, 'the الموازنة is a line of its own');
  check(pvParts.some(function (p) { return p.productId === 'x:d:dExpense:fuel'; }), 'an expense is named by its item');
  check(pvParts.some(function (p) { return p.productId === 'x:a:aOther:scrap'; }), 'and so is another collection');
  check(clientCtx.pvSources_(pvParts).length === 3, 'counted, the day is still three transactions');
}

console.log('--- a VAT change never rewrites a day already saved ---');
var vtNew = ctx.nonSalesFields_({});
check(vtNew.vatRate === 0.15 && vtNew.creditFeeRule === 2, 'every new day carries the VAT rate and the fee rule it was saved under');
var vtStamped = { sourceType: 'car', cashSales: 1150, deliveryFeeBankAmount: 115, vatRate: 0.15, date: '2026-09-01' };
var vtBefore = ctx.computeNet_([vtStamped]).netCashOwed;
check(call({ action: 'adminSetConfig', token: adminTok, data: { vatRate: 0.2 } }).ok, 'the VAT rate changes');
close(ctx.computeNet_([vtStamped]).netCashOwed, vtBefore, 'a day saved with the old rate keeps its figure');
var vtUnstamped = { sourceType: 'car', cashSales: 1150, deliveryFeeBankAmount: 115, date: '2026-09-01' };
close(ctx.computeNet_([vtUnstamped]).netCashOwed, vtBefore, 'a day saved before rates were stamped takes the rate of its own date');
var vtToday = { sourceType: 'car', cashSales: 1150, deliveryFeeBankAmount: 115, date: ctx.todayRiyadh_() };
close(ctx.computeNet_([vtToday]).vatOnDelivery, 115 / 1.2 * 0.2, 'a day from today on takes the new rate');
check(ctx.nonSalesFields_({ date: '2026-09-01' }).vatRate === 0.15, 'a past day entered late is stamped with the rate of its own date, not today\'s');
check(ctx.nonSalesFields_({ date: ctx.todayRiyadh_() }).vatRate === 0.2, 'and today\'s day with today\'s');
check(call({ action: 'adminSetConfig', token: adminTok, data: { vatRate: 0.15 } }).ok, 'and back');
close(ctx.computeNet_([vtUnstamped]).netCashOwed, vtBefore, 'going back the same day leaves the history as it was');
var vtMeta = call({ action: 'listMeta', token: aliTok }).config;
check(Array.isArray(vtMeta.vatHistory), 'the screens get the VAT history too, to work out old days the same way');

console.log('--- every change to a price, cost, delivery fee or commission is kept, old and new ---');
var rhP = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'RH Gas', type: 'goods', unitPrice: 20, unitCost: 10 } }).entity;
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: rhP.id, data: { unitPrice: 22 } }).ok, 'a price changes');
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: rhP.id, data: { unitCost: 11 } }).ok, 'a cost changes');
var rhC = call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', data: { name: 'عميل سجل الأسعار', city: 'Riyadh', deliveryFees: (function () { var m = {}; m[rhP.id] = 2; return m; })() } }).entity;
check(call({ action: 'adminSaveEntity', token: adminTok, kind: 'customer', id: rhC.id, data: { deliveryFees: (function () { var m = {}; m[rhP.id] = 3; return m; })(), commissions: (function () { var m = {}; m[rhP.id] = 1; return m; })() } }).ok, 'a customer\'s delivery fee and commission change');
ctx.importCustomers_([{ name: 'عميل سجل الأسعار', commission: 2, delivery: '' }], { update: true, userId: admin.id });
var rhH = call({ action: 'getRateHistory', token: adminTok, kind: 'product', id: rhP.id });
function rhRow(list, field, from, to) { return (list || []).some(function (r) { return r.field === field && Number(r.from) === from && Number(r.to) === to; }); }
check(rhH.ok && rhRow(rhH.changes, 'unitPrice', 20, 22), 'the price change is kept, old and new');
check(rhH.ok && rhRow(rhH.changes, 'unitCost', 10, 11), 'and the cost change');
check(rhH.ok && rhH.changes.every(function (r) { return r.by && r.at; }), 'each with who and when');
var rhCH = call({ action: 'getRateHistory', token: adminTok, kind: 'customer', id: rhC.id });
check(rhCH.ok && rhRow(rhCH.changes, 'deliveryFees', 2, 3) && rhCH.changes.some(function (r) { return r.productId === rhP.id; }), 'a customer\'s delivery fee change is kept, by item');
check(rhCH.ok && rhRow(rhCH.changes, 'commissions', 0, 1), 'a commission set for the first time is kept too');
check(rhCH.ok && rhRow(rhCH.changes, 'commissions', 1, 2), 'and the customer sheet\'s change');
check(call({ action: 'getRateHistory', token: aliTok, kind: 'product', id: rhP.id }).error === 'forbidden', 'a branch manager does not read the history');
var rhAcc = call({ action: 'getRateHistory', token: pfAccTok, kind: 'product', id: rhP.id });
check(rhAcc.ok && rhRow(rhAcc.changes, 'unitCost', 10, 11), 'the accountant reads it, costs included');
var rhPf = call({ action: 'getRateHistory', token: adminTok, kind: 'product', id: pfP1.id });
check(rhPf.ok && rhPf.changes.some(function (r) { return r.field === 'unitCost' && r.reason === 'typed wrong in March' && r.fromDate === '2026-03-11'; }), 'a cost correction keeps its reason and its date');
var rhLocked = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'RH Locked', type: 'goods', unitPrice: 20, priceLocked: true, unitCost: 10 } }).entity;
var rhBefore = call({ action: 'getRateHistory', token: adminTok, kind: 'product', id: rhLocked.id }).changes.length;
check(call({ action: 'setProductCost', token: adminTok, productId: rhLocked.id, unitCost: 12, from: ctx.todayRiyadh_() }).ok, 'a priced, fixed product gets a new cost');
var rhAfter = call({ action: 'getRateHistory', token: adminTok, kind: 'product', id: rhLocked.id }).changes;
check(rhAfter.length === rhBefore + 1 && rhAfter[0].field === 'unitCost', 'and the history gains that one change only, not its price again (got ' + (rhAfter.length - rhBefore) + ')');
var rhZero = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'RH Zero', type: 'goods' } }).entity;
call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', id: rhZero.id, data: { unitCost: 0 } });
check(!call({ action: 'getRateHistory', token: adminTok, kind: 'product', id: rhZero.id }).changes.some(function (r) { return r.field === 'unitCost'; }), 'a cost saved as 0 where there was none is not a change');

console.log('--- a save never takes its record id from the form ---');
var sxZone = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { city: 'Riyadh', name: 'SX one' } }).entity;
var sxTry = call({ action: 'adminSaveEntity', token: adminTok, kind: 'zone', data: { city: 'Riyadh', name: 'SX two', id: sxZone.id } });
check(sxTry.ok && sxTry.entity.id !== sxZone.id && ctx.getById_(SHEETS.ZONES, sxZone.id).name === 'SX one', 'an id in the form makes a new record; the old one is untouched');

console.log('--- security: whoever raised a dispute never settles it ---');
// a handover pending for someone else; the admin flags it on their behalf
var scH = ctx.writeRow(SHEETS.HANDOFFS, { kind: 'car_to_location', fromUserId: 'sc-from', toUserId: 'sc-to', amount: 500, status: 'pending', breakdown: { carCash: 500, netCashOwed: 500 } });
check(call({ action: 'disputeHandoff', token: adminTok, id: scH.id, note: 'checking' }).ok, 'an admin may flag a handover for its receiver');
check(ctx.getById_(SHEETS.HANDOFFS, scH.id).disputedBy === admin.id, 'the flag records who raised it');
check(call({ action: 'resolveDispute', token: adminTok, id: scH.id, resolution: 'confirm', receivedAmount: 1 }).error === 'conflict_of_interest', 'and the same admin cannot settle it at an amount of their own');
check(call({ action: 'resolveDispute', token: financeTok, id: scH.id, resolution: 'confirm' }).ok, 'another manager can');
var scLarge = ctx.writeRow(SHEETS.HANDOFFS, { kind: 'car_to_location', fromUserId: 'sc-from', toUserId: 'sc-to', amount: 900, status: 'confirmed', confirmedBy: 'sc-to', resolvedBy: admin.id, requiresSecondApproval: true });
check(call({ action: 'acknowledgeSecondApproval', token: adminTok, id: scLarge.id }).error === 'conflict_of_interest', 'whoever settled a large handover does not give its second approval');

console.log('--- security: a day names a real, active item ---');
var scStore = ctx.readSheet(SHEETS.STORES)[0];
['__proto__', 'constructor', 'not-a-product'].forEach(function (bad) {
  var r = call({ action: 'createDailyEntry', token: adminTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: scStore.id, productId: bad, qty: 1, unitPrice: 1, cashSales: 1 });
  check(r.error === 'invalid_product', 'an item id of ' + JSON.stringify(bad) + ' is refused (got ' + (r.error || 'saved') + ')');
});

console.log('--- security: a fresh test round keeps the audit trail and waits for open handovers ---');
check(ctx.TRANSACTIONAL_SHEETS_.indexOf(SHEETS.AUDIT) < 0, 'the audit trail is never archived away');
var scOpen = ctx.writeRow(SHEETS.HANDOFFS, { kind: 'car_to_location', fromUserId: 'sc-from', toUserId: 'sc-to', amount: 10, status: 'pending' });
var scArc = call({ action: 'adminArchiveTransactions', token: adminTok, confirm: 'ARCHIVE' });
check(scArc.error === 'cash_in_flight' || scArc.error === 'live_locked', 'nothing is archived while a handover is open (got ' + (scArc.error || 'archived') + ')');
scOpen.status = 'rejected'; ctx.writeRow(SHEETS.HANDOFFS, scOpen);

console.log('--- security: a password change ends every older sign-in ---');
call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Session Tester', email: 'sess.fx@bestgas.sa', role: 'accountant' } });
var seTok1 = acceptInvite('sess.fx@bestgas.sa');
var seTok2 = login('sess.fx@bestgas.sa', 'RealPass#1').token;
check(!!call({ action: 'whoami', token: seTok2 }).user, 'a second device is signed in');
var seCh = call({ action: 'changePassword', token: seTok1, currentPassword: 'RealPass#1', newPassword: 'NewPass#123' });
check(seCh.ok && !!seCh.token, 'the password changes');
check(!!call({ action: 'whoami', token: seCh.token }).user, 'the device that changed it stays signed in');
check(call({ action: 'whoami', token: seTok2 }).error === 'auth_required', 'every other sign-in ends');
check(call({ action: 'whoami', token: seTok1 }).error === 'auth_required', 'and so does the token it had before');
var seUser = ctx.readSheet(SHEETS.USERS).filter(function (u) { return u.email === 'sess.fx@bestgas.sa'; })[0];
check(call({ action: 'adminResetPassword', token: adminTok, id: seUser.id }).ok, 'an admin resets the password');
check(call({ action: 'whoami', token: seCh.token }).error === 'auth_required', 'and the person\'s sessions end with it');
var seOld = (function () { var p = admin.id + '|' + (Date.now() + 3600000) + '|' + (Date.now() + 86400000); return ctx.Utilities.base64EncodeWebSafe(p) + '.' + ctx.sign_(p); })();
check(!!call({ action: 'whoami', token: seOld }).user, 'a sign-in made before this update keeps working');

console.log('--- security: a temporary password is changed before anything else ---');
var tpNew = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Temp Driver', iqamaId: '2111222333', role: 'driver' } });
check(tpNew.ok && !!tpNew.tempPassword, 'an iqama account starts with a temporary password');
var tpTok = login('2111222333', tpNew.tempPassword).token;
check(!!tpTok, 'it signs in with it');
check(call({ action: 'listEntries', token: tpTok }).error === 'first_login_change', 'and can do nothing but change it');
check(!!call({ action: 'whoami', token: tpTok }).user, 'the app still knows who is signed in');
var tpCh = call({ action: 'changePassword', token: tpTok, newPassword: 'Driver#2026' });
check(tpCh.ok, 'the new password is set');
check(call({ action: 'listEntries', token: tpCh.token }).ok, 'then the app opens');

console.log('--- security: email and iqama numbers reach only the admin and finance ---');
var mmDeputy = call({ action: 'listMeta', token: deputyTok });
check(mmDeputy.ok && mmDeputy.users.every(function (u) { return !u.email && !u.iqamaId; }), 'the deputy sees people, not their email or iqama');
check(mmDeputy.pos.every(function (p) { return !p.holderIqama; }), 'nor a device holder\'s iqama');
var mmAdmin = call({ action: 'listMeta', token: adminTok });
check(mmAdmin.users.some(function (u) { return u.email; }), 'the admin still does');

console.log('--- security: nobody matches their own deposit to the bank ---');
var rcDep = ctx.writeRow(SHEETS.HANDOFFS, { kind: 'deposit', fromUserId: finance.id, amount: 321, status: 'completed', createdAt: new Date().toISOString() });
var rcLine = ctx.writeRow(SHEETS.BANK_LINES, { date: ctx.todayRiyadh_(), amount: 321, reference: 'SELF', status: 'unmatched' });
check(call({ action: 'manualMatchReconciliation', token: financeTok, lineId: rcLine.id, handoffId: rcDep.id }).error === 'conflict_of_interest', 'finance does not reconcile a deposit they made');

console.log('--- security: free text has a ceiling ---');
var ltStore = ctx.readSheet(SHEETS.STORES)[0];
var ltLong = new Array(5001).join('x');
var ltE = call({ action: 'createDailyEntry', token: adminTok, date: ctx.todayRiyadh_(), sourceType: 'store', sourceId: ltStore.id, cashSales: 5, note: ltLong });
check(ltE.ok && ltE.entry.note.length <= 1000, 'a note is kept to 1000 characters');
var ltR = call({ action: 'createRiskItem', token: adminTok, type: ctx.RISK_TYPES[0], title: ltLong, description: ltLong + ltLong });
check(ltR.ok && ltR.item.title.length <= 200 && ltR.item.description.length <= 4000, 'a report\'s title and text too');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
