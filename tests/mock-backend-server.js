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

console.log('Seeding scenario...');
var admin = bootstrapAdmin('admin@bestgas.sa', 'Bootstrap#1');
var adminLogin = call({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' });
var adminTok = adminLogin.token;

var sara = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Sara (Cluster Manager)', email: 'sara@bestgas.sa', role: 'cluster_manager' } }).user;
var musa = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Musa (Collector)', email: 'musa@bestgas.sa', role: 'collector' } }).user;
var ali = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Ali (Store Manager)', email: 'ali@bestgas.sa', role: 'store_manager' } }).user;
var hassan = call({ action: 'adminCreateUser', token: adminTok, data: { name: 'Hassan (Driver)', email: 'hassan@bestgas.sa', role: 'driver' } }).user;

var cluster = call({ action: 'adminSaveEntity', token: adminTok, kind: 'cluster', data: { name: 'Central', clusterManagerUserId: sara.id, collectorUserId: musa.id } }).entity;
var location = call({ action: 'adminSaveEntity', token: adminTok, kind: 'location', data: { city: 'Riyadh', name: 'Malaz', clusterId: cluster.id } }).entity;
var store = call({ action: 'adminSaveEntity', token: adminTok, kind: 'store', data: { locationId: location.id, name: 'Malaz Branch', storeManagerUserId: ali.id } }).entity;
var car = call({ action: 'adminSaveEntity', token: adminTok, kind: 'car', data: { locationId: location.id, label: 'Truck-1', driverUserId: hassan.id } }).entity;
call({ action: 'adminSaveEntity', token: adminTok, kind: 'pos', data: { ownerType: 'car', ownerId: car.id, label: 'POS-1', assignedUserId: hassan.id } });

console.log('\nSeeded. Sign in at http://localhost:' + PORT + '/ with API URL http://localhost:' + PORT + '/api\n');
console.log('admin@bestgas.sa         / Bootstrap#1               (mustChangePw: no)');
console.log('sara@bestgas.sa (cluster manager)  / temp: ' + lastInviteFor('sara@bestgas.sa'));
console.log('musa@bestgas.sa (collector)        / temp: ' + lastInviteFor('musa@bestgas.sa'));
console.log('ali@bestgas.sa  (store manager)    / temp: ' + lastInviteFor('ali@bestgas.sa'));
console.log('hassan@bestgas.sa (driver)         / temp: ' + lastInviteFor('hassan@bestgas.sa'));
console.log('');

var ROOT = path.join(__dirname, '..');
var MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

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
  var reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  var filePath = path.join(ROOT, reqPath);
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, function () { console.log('serving on :' + PORT); });
