/**
 * ONE-OFF DEMO SEED — org structure ONLY, zero transactions. Same people/
 * locations/POS machines as demo-single-area-5-locations.js (one area
 * manager, 5 locations, every employee has an Iqama ID, every POS has a
 * POS ID + POS Config), but no daily_entries at all — so the live demo can
 * show the full area-bulk CSV *upload* cycle from a truly empty slate:
 * download template -> upload -> preview/VAT -> submit -> Deputy approves
 * -> Collector receives the handoff.
 *
 * Run: node tests/demo-org-only.js [port]
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var harness = require('./stub-harness');

var PORT = Number(process.argv[2] || 8992);
var ctx = harness.buildContext();
var SHEETS = ctx.SHEETS;

function call(payload) {
  var res = ctx.route_(payload);
  if (!res.ok) { console.error('FAILED:', JSON.stringify(payload).slice(0, 160), '->', JSON.stringify(res)); process.exit(1); }
  return res;
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

console.log('Seeding org-only (zero transactions) demo scenario...');
bootstrapAdmin('admin@bestgas.sa', 'Bootstrap#1');
var adminTok = call({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' }).token;

var area = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Faisal Al-Otaibi (Area Manager)', email: 'faisal@bestgas.sa', role: 'cluster_manager' } }).user;
var deputy = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Khalid (Deputy Operations Manager)', email: 'khalid@bestgas.sa', role: 'deputy_operations_manager' } }).user;
var collector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Yousef (Collector)', email: 'yousef@bestgas.sa', role: 'collector' } }).user;

var cluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Central Area', clusterManagerUserId: area.id, collectorUserId: collector.id } }).entity;

var cylinderProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'LPG Cylinder 12kg', type: 'goods', active: true } }).entity;
var deliveryProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Delivery Fee', type: 'services', active: true } }).entity;

var LOCS = [
  // All 5 locations under ONE city (Riyadh) this time — same cluster, same
  // area manager, just five different districts instead of five different
  // cities, per the user's request.
  ['Riyadh',  'Olaya',        'Nawaf (Store Manager)', 'Turki (Driver)',   '2011122233', '2011122234', 'POS-OLY-01'],
  ['Riyadh',  'Malaz',        'Bandar (Store Manager)','Saad (Driver)',    '2011122235', '2011122236', 'POS-MLZ-01'],
  ['Riyadh',  'Naseem',       'Majed (Store Manager)', 'Omar (Driver)',    '2011122237', '2011122238', 'POS-NSM-01'],
  ['Riyadh',  'Sulaimaniyah', 'Fahad (Store Manager)', 'Yazan (Driver)',   '2011122239', '2011122240', 'POS-SLM-01'],
  ['Riyadh',  'Yarmouk',      'Sultan (Store Manager)','Ibrahim (Driver)', '2011122241', '2011122242', 'POS-YRM-01']
];

var locRows = [];
LOCS.forEach(function (row, i) {
  var city = row[0], name = row[1], mgrName = row[2], drvName = row[3], mgrIqama = row[4], drvIqama = row[5], posId = row[6];
  var mgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: mgrName, email: 'mgr' + i + '@bestgas.sa', role: 'store_manager', iqamaId: mgrIqama } }).user;
  var drv = call({ action: 'adminCreateUser', token: adminTok, data: { name: drvName, email: 'drv' + i + '@bestgas.sa', role: 'driver', iqamaId: drvIqama } }).user;
  var loc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: city, name: name, clusterId: cluster.id } }).entity;
  var store = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: loc.id, name: name + ' Branch', storeManagerUserId: mgr.id } }).entity;
  var car = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: loc.id, label: name + ' Truck', driverUserId: drv.id } }).entity;
  var posEntity = call({
    action: 'adminSaveEntity', token: adminTok, kind: 'pos',
    data: { ownerType: 'car', ownerId: car.id, label: name + ' POS Machine', assignedUserId: drv.id, posId: posId, posConfig: 'merchantId=9912' + (1000 + i) + ';terminal=T' + (i + 1) }
  }).entity;
  locRows.push({ city: city, name: name, storeName: name + ' Branch', carLabel: name + ' Truck', mgr: mgrName, drv: drvName });
});

call({ action: 'adminSetConfig', token: adminTok, data: { areaManagerBulkUploadEnabled: true } });

console.log('\nSeeded (ZERO transactions). Sign in at http://localhost:' + PORT + '/ with API URL http://localhost:' + PORT + '/api\n');
console.log('admin@bestgas.sa   / Bootstrap#1                     (mustChangePw: no)');
console.log('faisal@bestgas.sa (area manager, Central Area) / temp: ' + lastInviteFor('faisal@bestgas.sa'));
console.log('khalid@bestgas.sa (deputy ops manager)          / temp: ' + lastInviteFor('khalid@bestgas.sa'));
console.log('yousef@bestgas.sa (collector)                   / temp: ' + lastInviteFor('yousef@bestgas.sa'));
LOCS.forEach(function (row, i) {
  console.log('mgr' + i + '@bestgas.sa (' + row[2] + ', ' + row[1] + ') / temp: ' + lastInviteFor('mgr' + i + '@bestgas.sa'));
  console.log('drv' + i + '@bestgas.sa (' + row[3] + ', ' + row[1] + ')     / temp: ' + lastInviteFor('drv' + i + '@bestgas.sa'));
});
console.log('\nLocations (for the CSV): ' + JSON.stringify(locRows, null, 1));
console.log('');

var ROOT = path.join(__dirname, '..');
var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer(function (req, res) {
  if (req.method === 'POST' && req.url === '/api') {
    var body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      var parsed; try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
      var result = parsed ? (function () { try { return ctx.route_(parsed); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })() : { ok: false, error: 'bad_request' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
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
