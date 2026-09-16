/**
 * ONE-OFF DEMO SEED — not part of the shipped system, not committed test
 * infrastructure like mock-backend-server.js. Built for a single recording:
 * one area manager running exactly 5 locations, nothing else in the system,
 * so every dashboard/report number the video shows traces back to this
 * scenario alone. Every employee gets an Iqama ID; every POS machine gets a
 * POS ID + POS Config. Every location gets all four transaction sources
 * (Store, Car, POS Machine, Delivery fee) across all three payment channels
 * (Cash, Credit, POS) so the video can show every combination.
 *
 * Run: node tests/demo-single-area-5-locations.js [port]
 * Then open http://localhost:<port>/ — temp passwords print below.
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var harness = require('./stub-harness');

var PORT = Number(process.argv[2] || 8990);
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
function lastInviteFor(email) {
  var log = ctx._debug.mailLog;
  for (var i = log.length - 1; i >= 0; i--) {
    if (log[i].to === email) { var m = /Temporary password: (\S+)/.exec(log[i].body); if (m) return m[1]; }
  }
  return null;
}

console.log('Seeding single-area-manager / 5-location demo scenario...');
bootstrapAdmin('admin@bestgas.sa', 'Bootstrap#1');
var adminTok = call({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' }).token;

var area = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Faisal Al-Otaibi (Area Manager)', email: 'faisal@bestgas.sa', role: 'cluster_manager' } }).user;
var deputy = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Khalid (Deputy Operations Manager)', email: 'khalid@bestgas.sa', role: 'deputy_operations_manager' } }).user;
var collector = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Yousef (Collector)', email: 'yousef@bestgas.sa', role: 'collector' } }).user;

var cluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Central Area', clusterManagerUserId: area.id, collectorUserId: collector.id } }).entity;

var cylinderProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'LPG Cylinder 12kg', type: 'goods', active: true } }).entity;
var deliveryProduct = call({ action: 'adminSaveEntity', token: adminTok, kind: 'product', data: { name: 'Delivery Fee', type: 'services', active: true } }).entity;

// city, location name, store manager name, driver name, iqama(mgr), iqama(driver), posId, deliveryFee (clean VAT: fee/1.15 * 0.15)
var LOCS = [
  ['Riyadh',  'Olaya',        'Nawaf (Store Manager)', 'Turki (Driver)',   '2011122233', '2011122234', 'POS-OLY-01', 115],
  ['Riyadh',  'Malaz',        'Bandar (Store Manager)','Saad (Driver)',    '2011122235', '2011122236', 'POS-MLZ-01', 230],
  ['Jeddah',  'Rawdah',       'Majed (Store Manager)', 'Omar (Driver)',    '2011122237', '2011122238', 'POS-RWD-01', 345],
  ['Dammam',  'Corniche',     'Fahad (Store Manager)', 'Yazan (Driver)',   '2011122239', '2011122240', 'POS-DMC-01', 460],
  ['Khobar',  'Rakah',        'Sultan (Store Manager)','Ibrahim (Driver)', '2011122241', '2011122242', 'POS-KHR-01', 575]
];

var today = new Date().toISOString().slice(0, 10);
var summary = [];

LOCS.forEach(function (row, i) {
  var city = row[0], name = row[1], mgrName = row[2], drvName = row[3], mgrIqama = row[4], drvIqama = row[5], posId = row[6], deliveryFee = row[7];

  var mgr = call({ action: 'adminCreateUser', token: adminTok, data: { name: mgrName, email: 'mgr' + i + '@bestgas.sa', role: 'store_manager', iqamaId: mgrIqama } }).user;
  var drv = call({ action: 'adminCreateUser', token: adminTok, data: { name: drvName, email: 'drv' + i + '@bestgas.sa', role: 'driver', iqamaId: drvIqama } }).user;

  var loc = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: city, name: name, clusterId: cluster.id } }).entity;
  var store = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: loc.id, name: name + ' Branch', storeManagerUserId: mgr.id } }).entity;
  var car = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: loc.id, label: name + ' Truck', driverUserId: drv.id } }).entity;
  var posEntity = call({
    action: 'adminSaveEntity', token: adminTok, kind: 'pos',
    data: { ownerType: 'car', ownerId: car.id, label: name + ' POS Machine', assignedUserId: drv.id, posId: posId, posConfig: 'merchantId=9912' + (1000 + i) + ';terminal=T' + (i + 1) }
  }).entity;

  // Store: cash + credit + POS all in one entry — a store can carry all
  // three channels at once (see CLAUDE.md, "any source can carry all
  // three now"). No delivery fee here: a store branch has nothing to
  // deliver (see lastShowDelivery in renderEntries).
  var storeCash = 1000 + i * 200, storeCredit = 400 + i * 50, storePos = 600 + i * 100;
  call({
    action: 'createDailyEntry', token: adminTok, date: today, sourceType: 'store', sourceId: store.id, productId: cylinderProduct.id,
    cashSales: storeCash, creditSales: storeCredit, posSales: storePos, note: 'Store daily sales — ' + name
  });

  // Car: cash + credit + POS sale first, satisfying deliveryNeedsSale_ for
  // the delivery-fee entry that follows on the same source+date.
  var carCash = 800 + i * 150, carCredit = 300 + i * 40, carPos = 500 + i * 80;
  call({
    action: 'createDailyEntry', token: adminTok, date: today, sourceType: 'car', sourceId: car.id, productId: cylinderProduct.id,
    cashSales: carCash, creditSales: carCredit, posSales: carPos, note: 'Car daily sales — ' + name
  });
  call({
    action: 'createDailyEntry', token: adminTok, date: today, sourceType: 'car', sourceId: car.id, productId: deliveryProduct.id,
    deliveryFeeBankAmount: deliveryFee, note: 'Delivery fee — ' + name
  });

  // POS Machine as its own source (distinct from the car it's mounted on)
  // — a POS terminal can carry cash too, not just card (same convention).
  var posCash = 300 + i * 60, posCredit = 150 + i * 20, posPos = 900 + i * 120;
  call({
    action: 'createDailyEntry', token: adminTok, date: today, sourceType: 'pos', sourceId: posEntity.id, productId: cylinderProduct.id,
    cashSales: posCash, creditSales: posCredit, posSales: posPos, note: 'POS machine daily sales — ' + name
  });

  var vatOnDelivery = Math.round((deliveryFee / 1.15) * 0.15 * 100) / 100;
  var netForLocation = storeCash + carCash + posCash - deliveryFee + vatOnDelivery;
  summary.push({
    location: city + ' — ' + name, storeManager: mgrName, driver: drvName, posId: posId,
    storeCash: storeCash, storeCredit: storeCredit, storePos: storePos,
    carCash: carCash, carCredit: carCredit, carPos: carPos,
    posCash: posCash, posCredit: posCredit, posPos: posPos,
    deliveryFee: deliveryFee, vatOnDelivery: vatOnDelivery, netCashOwed: netForLocation
  });
});

call({ action: 'adminSetConfig', token: adminTok, data: { areaManagerBulkUploadEnabled: true } });

console.log('\nSeeded. Sign in at http://localhost:' + PORT + '/ with API URL http://localhost:' + PORT + '/api\n');
console.log('admin@bestgas.sa   / Bootstrap#1                     (mustChangePw: no)');
console.log('faisal@bestgas.sa (area manager, Central Area) / temp: ' + lastInviteFor('faisal@bestgas.sa'));
console.log('khalid@bestgas.sa (deputy ops manager)          / temp: ' + lastInviteFor('khalid@bestgas.sa'));
console.log('yousef@bestgas.sa (collector)                   / temp: ' + lastInviteFor('yousef@bestgas.sa'));
LOCS.forEach(function (row, i) {
  console.log('mgr' + i + '@bestgas.sa (' + row[2] + ', ' + row[1] + ') / temp: ' + lastInviteFor('mgr' + i + '@bestgas.sa'));
  console.log('drv' + i + '@bestgas.sa (' + row[3] + ', ' + row[1] + ')     / temp: ' + lastInviteFor('drv' + i + '@bestgas.sa'));
});
console.log('\n--- per-location expected numbers (for on-camera reference) ---');
summary.forEach(function (s) {
  console.log(s.location + ':');
  console.log('  store cash=' + s.storeCash + ' credit=' + s.storeCredit + ' pos=' + s.storePos);
  console.log('  car   cash=' + s.carCash + ' credit=' + s.carCredit + ' pos=' + s.carPos + '  delivery fee=' + s.deliveryFee + ' (vat=' + s.vatOnDelivery + ')');
  console.log('  pos machine cash=' + s.posCash + ' credit=' + s.posCredit + ' pos=' + s.posPos);
  console.log('  -> netCashOwed = ' + s.storeCash + '+' + s.carCash + '+' + s.posCash + '-' + s.deliveryFee + '+' + s.vatOnDelivery + ' = ' + s.netCashOwed);
});
var grandTotal = summary.reduce(function (a, s) { return a + s.netCashOwed; }, 0);
console.log('\nGrand total net cash owed across all 5 locations: ' + Math.round(grandTotal * 100) / 100);
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
