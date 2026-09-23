/**
 * ONE-OFF DEMO SEED — TWO area managers, BOTH in Riyadh city, one shared
 * collector. Zero transactions at seed time (the cycle is run live).
 * Every employee has an Iqama ID, every POS has a POS ID + POS Config,
 * area-bulk upload enabled.
 *
 * Run: node tests/demo-two-riyadh-areas.js [port]
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var harness = require('./stub-harness');

var PORT = Number(process.argv[2] || 8998);
var LATENCY_MS = Number(process.argv[3] || 0);
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

console.log('Seeding TWO-area-manager (both Riyadh, shared collector) demo scenario...');
bootstrapAdmin('admin@bestgas.sa', 'Bootstrap#1');
var adminTok = call({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' }).token;

var deputy = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Khalid (Deputy Operations Manager)', email: 'khalid@bestgas.sa', role: 'deputy_operations_manager' } }).user;
var collector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Yousef (Collector)', email: 'yousef@bestgas.sa', role: 'collector' } }).user;

var cylinderProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'LPG Cylinder 12kg', type: 'goods', active: true } }).entity;
var deliveryProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Delivery Fee', type: 'services', active: true } }).entity;

var AREAS = [
  {
    areaName: 'Riyadh North Area', areaMgrName: 'Faisal Al-Otaibi (Area Manager)', areaMgrEmail: 'faisal@bestgas.sa',
    locs: [
      ['Olaya',  'Nawaf (Store Manager)', 'Turki (Driver)', '2011122233', '2011122234', 'POS-OLY-01'],
      ['Malaz',  'Bandar (Store Manager)','Saad (Driver)',  '2011122235', '2011122236', 'POS-MLZ-01'],
      ['Naseem', 'Majed (Store Manager)', 'Omar (Driver)',  '2011122237', '2011122238', 'POS-NSM-01']
    ]
  },
  {
    areaName: 'Riyadh South Area', areaMgrName: 'Saad Al-Ghamdi (Area Manager)', areaMgrEmail: 'saad.ghamdi@bestgas.sa',
    locs: [
      ['Sulaimaniyah', 'Fahad (Store Manager)',  'Yazan (Driver)',   '2011122239', '2011122240', 'POS-SLM-01'],
      ['Yarmouk',      'Sultan (Store Manager)', 'Ibrahim (Driver)', '2011122241', '2011122242', 'POS-YRM-01'],
      ['Rawdah',       'Waleed (Store Manager)', 'Hamzah (Driver)',  '2011122243', '2011122244', 'POS-RWD-01']
    ]
  }
];

var allLocRows = [];
AREAS.forEach(function (area, ai) {
  var areaMgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: area.areaMgrName, email: area.areaMgrEmail, role: 'cluster_manager' } }).user;
  var cluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: area.areaName, clusterManagerUserId: areaMgr.id, collectorUserId: collector.id } }).entity;
  area.locs.forEach(function (row, i) {
    var name = row[0], mgrName = row[1], drvName = row[2], mgrIqama = row[3], drvIqama = row[4], posId = row[5];
    var idx = ai + '_' + i;
    var mgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: mgrName, email: 'mgr' + idx + '@bestgas.sa', role: 'store_manager', iqamaId: mgrIqama } }).user;
    var drv = call({ action: 'adminCreateUser', token: adminTok, data: { name: drvName, email: 'drv' + idx + '@bestgas.sa', role: 'driver', iqamaId: drvIqama } }).user;
    var loc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: name, clusterId: cluster.id } }).entity;
    var store = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: loc.id, name: name + ' Branch', storeManagerUserId: mgr.id } }).entity;
    var car = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: loc.id, label: name + ' Truck', driverUserId: drv.id } }).entity;
    var posEntity = call({
      action: 'adminSaveEntity', token: adminTok, kind: 'pos',
      data: { ownerType: 'car', ownerId: car.id, label: name + ' POS Machine', assignedUserId: drv.id, posId: posId, posConfig: 'merchantId=9914' + (1000 + ai * 10 + i) + ';terminal=T' + idx }
    }).entity;
    allLocRows.push({ area: area.areaName, name: name, mgrEmail: 'mgr' + idx + '@bestgas.sa', drvEmail: 'drv' + idx + '@bestgas.sa' });
  });
  console.log(area.areaName + ' -> ' + area.areaMgrEmail + ' / temp: ' + lastInviteFor(area.areaMgrEmail));
});

call({ action: 'adminSetConfig', token: adminTok, data: { areaManagerBulkUploadEnabled: true } });

console.log('\nSeeded (ZERO transactions). Sign in at http://localhost:' + PORT + '/ with API URL http://localhost:' + PORT + '/api\n');
console.log('admin@bestgas.sa   / Bootstrap#1                     (mustChangePw: no)');
console.log('khalid@bestgas.sa (deputy, both areas) / temp: ' + lastInviteFor('khalid@bestgas.sa'));
console.log('yousef@bestgas.sa (collector, both areas) / temp: ' + lastInviteFor('yousef@bestgas.sa'));
allLocRows.forEach(function (r) {
  console.log(r.area + ' / ' + r.name + ':  ' + r.mgrEmail + ' temp=' + lastInviteFor(r.mgrEmail) + '   ' + r.drvEmail + ' temp=' + lastInviteFor(r.drvEmail));
});
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
      // Optional 2nd CLI arg: artificial per-request delay (ms), to feel the
      // same round-trip cost as the real Apps Script backend.
      setTimeout(function () {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }, LATENCY_MS);
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/__maillog') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ctx._debug.mailLog));
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
