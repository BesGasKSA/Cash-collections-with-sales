/**
 * Serves the real index.html AND answers its API calls using the real
 * Code.gs/Admin.gs/Collection.gs logic (via stub-harness.js) on one origin,
 * so the actual browser UI can be driven end-to-end with no live Google
 * deployment. Seeds one ready-to-use scenario and prints the temp passwords
 * needed to sign in as each seeded person. Not part of the shipped system —
 * a local testing aid only. Run: node tests/mock-backend-server.js [port]
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var harness = require('./stub-harness');

var PORT = Number(process.argv[2] || 8904);
var ctx = harness.buildContext();
var SHEETS = ctx.SHEETS;

function call(payload) {
  try { return ctx.route_(payload); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function bootstrapAdmin(email, plainPw) {
  var salt = ctx.randomSalt_();
  var pass = ctx.hashPw_(plainPw, salt);
  var admin = { id: ctx.Utilities.getUuid(), name: 'Admin', email: email, role: 'admin', active: true, language: 'ar', salt: salt, pass: pass, mustChangePw: false };
  ctx.writeRow(SHEETS.USERS, admin);
  return admin;
}

// Invitations carry a single-use link, not a password: accept it once with
// a fixed demo password and print that.
var DEMO_PW = 'Welcome#1';
function lastInviteFor(email) {
  var log = ctx._debug.mailLog;
  for (var i = log.length - 1; i >= 0; i--) {
    if (log[i].to === email) {
      var m = /[?&]invite=([A-Za-z0-9]+)/.exec(log[i].body);
      if (m) { ctx.route_({ action: 'acceptInvite', inviteToken: m[1], password: DEMO_PW }); return DEMO_PW; }
    }
  }
  return null;
}

console.log('Seeding scenario...');
var admin = bootstrapAdmin('admin@bestgas.sa', 'Bootstrap#1');
var adminLogin = call({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' });
var adminTok = adminLogin.token;

var sara = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Sara (Cluster Manager)', email: 'sara@bestgas.sa', role: 'cluster_manager' } }).user;
var musa = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Musa (Collector)', email: 'musa@bestgas.sa', role: 'collector' } }).user;
var ali = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ali (Store Manager)', email: 'ali@bestgas.sa', role: 'store_manager' } }).user;
var hassan = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Hassan (Driver)', email: 'hassan@bestgas.sa', role: 'driver' } }).user;
var nasser = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Nasser (Deputy)', email: 'deputy@bestgas.sa', role: 'deputy_operations_manager' } }).user;

var cluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Central', clusterManagerUserId: sara.id, collectorUserId: musa.id } }).entity;
var location = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Malaz', clusterId: cluster.id } }).entity;
var store = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: location.id, name: 'Malaz Branch', storeManagerUserId: ali.id } }).entity;
var car = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: location.id, label: 'Truck-1', driverUserId: hassan.id } }).entity;
call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: car.id, label: 'POS-1', assignedUserId: hassan.id } });

// ---- Larger multi-area-manager scenario, for exercising the bulk-upload
// feature across several clusters/locations at once, each location carrying
// all three source types (store + car + pos). ----
var muzafer = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Muzafer (Area Manager)', email: 'muzafer@bestgas.sa', role: 'cluster_manager' } }).user;
var muntasir = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Muntasir (Area Manager)', email: 'muntasir@bestgas.sa', role: 'cluster_manager' } }).user;
var ahmed = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ahmed (Deputy)', email: 'ahmed@bestgas.sa', role: 'deputy_operations_manager' } }).user;
var mazen = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Mazen (Collector)', email: 'mazen@bestgas.sa', role: 'collector' } }).user;

var northArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'North Area', clusterManagerUserId: muzafer.id, collectorUserId: mazen.id } }).entity;
var southArea = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'South Area', clusterManagerUserId: muntasir.id, collectorUserId: mazen.id } }).entity;

// city, location name, clusterId — one store + one car + one pos per location
var multiLocations = [
  ['Riyadh', 'Olaya', northArea.id],
  ['Riyadh', 'Naseem', northArea.id],
  ['Riyadh', 'Sulaimaniyah', northArea.id],
  ['Jeddah', 'Rawdah', southArea.id],
  ['Jeddah', 'Salamah', southArea.id],
  ['Jeddah', 'Hamra', southArea.id]
];
multiLocations.forEach(function (row) {
  var city = row[0], name = row[1], clusterId = row[2];
  var loc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: city, name: name, clusterId: clusterId } }).entity;
  // every link needs its person now, so each branch gets a manager and a driver
  var slug = name.toLowerCase();
  var bm = call({ action: 'adminCreateUser', token: adminTok, data: { name: name + ' Branch Manager', email: slug + '.bm@bestgas.sa', role: 'store_manager' } }).user;
  var dr = call({ action: 'adminCreateUser', token: adminTok, data: { name: name + ' Driver', email: slug + '.driver@bestgas.sa', role: 'driver' } }).user;
  call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: loc.id, name: name + ' Branch', storeManagerUserId: bm.id } });
  var mCar = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: loc.id, label: name + ' Truck', driverUserId: dr.id } }).entity;
  call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: mCar.id, label: name + ' POS', assignedUserId: dr.id } });
});

// Products — one goods line and one services line, so the area-bulk
// product-level upload (product/qty/unitPrice/paymentMethod per row) has
// something real to resolve against; without these the CSV template and
// every row would fail product lookup.
var cylinderProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'LPG Cylinder 12kg', type: 'goods', active: true } }).entity;
var deliveryProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Delivery Fee', type: 'services', active: true } }).entity;

// Area-manager bulk upload is off by default (see CLAUDE.md) — enabled here
// so the seeded scenario is immediately usable for testing that path too.
call({ action: 'adminSetConfig', token: adminTok, data: { areaManagerBulkUploadEnabled: true } });

console.log('\nSeeded. Sign in at http://localhost:' + PORT + '/ with API URL http://localhost:' + PORT + '/api\n');
console.log('admin@bestgas.sa         / Bootstrap#1               (mustChangePw: no)');
console.log('sara@bestgas.sa (cluster manager)  / temp: ' + lastInviteFor('sara@bestgas.sa'));
console.log('musa@bestgas.sa (collector)        / temp: ' + lastInviteFor('musa@bestgas.sa'));
console.log('ali@bestgas.sa  (store manager)    / temp: ' + lastInviteFor('ali@bestgas.sa'));
console.log('hassan@bestgas.sa (driver)         / temp: ' + lastInviteFor('hassan@bestgas.sa'));
console.log('deputy@bestgas.sa (deputy ops mgr) / temp: ' + lastInviteFor('deputy@bestgas.sa') + '  (area-manager bulk upload is ON)');
console.log('');
console.log('-- multi-area-manager scenario (North Area / South Area, 3 locations each) --');
console.log('muzafer@bestgas.sa (area mgr, North) / temp: ' + lastInviteFor('muzafer@bestgas.sa'));
console.log('muntasir@bestgas.sa (area mgr, South) / temp: ' + lastInviteFor('muntasir@bestgas.sa'));
console.log('ahmed@bestgas.sa (deputy ops mgr)     / temp: ' + lastInviteFor('ahmed@bestgas.sa'));
console.log('mazen@bestgas.sa (collector, both)    / temp: ' + lastInviteFor('mazen@bestgas.sa'));
console.log('');

var ROOT = path.join(__dirname, '..');
var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

http.createServer(function (req, res) {
  if (req.method === 'POST' && req.url === '/api') {
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      var parsed;
      try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
      var result = parsed ? call(parsed) : { ok: false, error: 'bad_request' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  // /__mail?to=someone@x — the last email "sent" to that address, rendered,
  // so an invitation can be opened and its button clicked like a real inbox.
  if (req.url.indexOf('/__mail') === 0) {
    var to = decodeURIComponent((/[?&]to=([^&]+)/.exec(req.url) || [])[1] || '');
    var mails = ctx._debug.mailLog.filter(function (m) { return !to || m.to === to; });
    var last = mails[mails.length - 1];
    res.writeHead(last ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(last ? (last.html || '<pre>' + String(last.body).replace(/</g, '&lt;') + '</pre>') : 'no mail');
    return;
  }
  var reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  var filePath = path.join(ROOT, reqPath);
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, function () { console.log('serving on :' + PORT); });
