/**
 * Best Gas Cash Collection & Approval System — core backend.
 * Sheet-as-database helpers, auth, and the doGet/doPost router.
 * See CLAUDE.md for the architecture this file follows.
 */

// Hierarchy: Location (parent) -> Store + Cars (children) -> POS machines
// (children of Store or Car), each POS linked to the employee/driver who
// carries it. See CLAUDE.md "Entity hierarchy" for the full picture.
var SHEETS = {
  USERS: 'users',
  LOCATIONS: 'locations',
  STORES: 'stores',
  CARS: 'cars',
  POS: 'pos_machines',
  CLUSTERS: 'clusters',
  // Pure geography (Country[KSA, implicit]/City/Zone), independent of
  // Cluster — Cluster is an employee's management assignment (cluster
  // manager + collector) and can cut across zones; Zone is just a label
  // for filtering/reporting, no assignment of its own. See CLAUDE.md.
  ZONES: 'zones',
  PRODUCTS: 'products',
  ENTRIES: 'daily_entries',
  HANDOFFS: 'handoffs',
  CONFIG: 'config',
  AUDIT: 'audit'
};

var IDLE_MS = 12 * 3600 * 1000;      // 12h idle session expiry
var HARD_MS = 7 * 24 * 3600 * 1000;  // 7 day hard cap
var LOCK_FAILS = 8;
var LOCK_WINDOW_SEC = 15 * 60;
var PW_ROUNDS = 120;

// ---------- Sheet-as-DB ----------

// Works whether this script is bound to the Sheet (Extensions > Apps Script,
// getActiveSpreadsheet works directly) or standalone (script.google.com on
// its own — needs the Sheet's id in Script Properties as SHEET_ID). Try
// bound first since it needs no configuration.
function spreadsheet_() {
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Set a Script Property named SHEET_ID to this project\'s Google Sheet id (Project Settings > Script Properties) — this script is not bound to a Sheet.');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['id', 'data', 'updatedAt']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function verKey_(name) { return 'ver_' + name; }

function version_(name) {
  return PropertiesService.getScriptProperties().getProperty(verKey_(name)) || '0';
}

function bumpVersion_(name) {
  var p = PropertiesService.getScriptProperties();
  var v = Number(p.getProperty(verKey_(name)) || '0') + 1;
  p.setProperty(verKey_(name), String(v));
  return v;
}

function readSheet(name) {
  var cacheKey = name + '@' + version_(name);
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var sh = sheet_(name);
  var lastRow = sh.getLastRow();
  var rows = [];
  if (lastRow > 1) {
    var vals = sh.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < vals.length; i++) {
      var id = vals[i][0], data = vals[i][1], updatedAt = vals[i][2];
      if (!id) continue;
      var obj;
      try { obj = JSON.parse(data); } catch (e) { obj = {}; }
      obj.id = id;
      obj.updatedAt = updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
      rows.push(obj);
    }
  }
  try { cache.put(cacheKey, JSON.stringify(rows), 120); } catch (e) { /* row set too large for cache; skip */ }
  return rows;
}

function findRow_(sh, id) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  var idCol = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < idCol.length; i++) {
    if (idCol[i][0] === id) return i + 2;
  }
  return -1;
}

function writeRow(name, obj) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(name);
    if (!obj.id) obj.id = Utilities.getUuid();
    var now = new Date().toISOString();
    var toStore = {};
    for (var k in obj) { if (obj.hasOwnProperty(k)) toStore[k] = obj[k]; }
    toStore.updatedAt = now;
    var json = JSON.stringify(toStore);
    var rowIndex = findRow_(sh, obj.id);
    if (rowIndex > 0) {
      sh.getRange(rowIndex, 1, 1, 3).setValues([[obj.id, json, now]]);
    } else {
      sh.appendRow([obj.id, json, now]);
    }
    bumpVersion_(name);
    return toStore;
  } finally {
    lock.releaseLock();
  }
}

function deleteRow_(name, id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_(name);
    var rowIndex = findRow_(sh, id);
    if (rowIndex > 0) sh.deleteRow(rowIndex);
    bumpVersion_(name);
  } finally {
    lock.releaseLock();
  }
}

function getById_(name, id) {
  var rows = readSheet(name);
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
  return null;
}

function logAudit_(action, userId, detail) {
  writeRow(SHEETS.AUDIT, {
    action: action,
    userId: userId || null,
    detail: detail || null,
    at: new Date().toISOString()
  });
}

// ---------- Config ----------

function config_() {
  var rows = readSheet(SHEETS.CONFIG);
  var row = rows[0];
  if (!row) {
    row = writeRow(SHEETS.CONFIG, {
      vatRate: 0.15,
      senderName: 'Best Gas Cash Collection',
      idleMs: IDLE_MS,
      hardMs: HARD_MS
    });
  }
  return row;
}

function vatRate_() {
  var c = config_();
  return typeof c.vatRate === 'number' ? c.vatRate : 0.15;
}

// ---------- Crypto / auth ----------

function secret_() {
  var p = PropertiesService.getScriptProperties();
  var s = p.getProperty('SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('SECRET', s);
  }
  return s;
}

function hmac_(payload, key) {
  var raw = Utilities.computeHmacSha256Signature(payload, key);
  return Utilities.base64EncodeWebSafe(raw);
}

function sign_(payload) {
  return hmac_(payload, secret_());
}

function randomSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function hashPw_(pw, salt) {
  var h = pw + '|' + salt;
  for (var i = 0; i < PW_ROUNDS; i++) {
    h = hmac_(h, secret_() + salt);
  }
  return 'v1:' + h;
}

function verifyPw_(pw, salt, stored) {
  if (!stored) return false;
  return hashPw_(pw, salt) === stored;
}

function randomPassword_() {
  return Utilities.getUuid().split('-')[0] + Math.floor(Math.random() * 900 + 100);
}

// ---------- Session tokens ----------

function issueToken_(uid) {
  var now = Date.now();
  var payload = uid + '|' + (now + IDLE_MS) + '|' + (now + HARD_MS);
  var sig = sign_(payload);
  return Utilities.base64EncodeWebSafe(payload) + '.' + sig;
}

function authToken_(token) {
  if (!token) return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  var payload;
  try {
    payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  } catch (e) { return null; }
  if (sign_(payload) !== parts[1]) return null;
  var bits = payload.split('|');
  var uid = bits[0], exp = Number(bits[1]), hardExp = Number(bits[2]);
  var now = Date.now();
  if (!uid || now > exp || now > hardExp) return null;
  return { uid: uid, hardExp: hardExp };
}

function renewToken_(uid, hardExp) {
  var now = Date.now();
  var payload = uid + '|' + (now + IDLE_MS) + '|' + hardExp;
  var sig = sign_(payload);
  return Utilities.base64EncodeWebSafe(payload) + '.' + sig;
}

// ---------- Login lockout ----------

function checkLock_(login) {
  return !!CacheService.getScriptCache().get('lock_' + login);
}

function noteFail_(login) {
  var cache = CacheService.getScriptCache();
  var key = 'fail_' + login;
  var n = Number(cache.get(key) || '0') + 1;
  cache.put(key, String(n), LOCK_WINDOW_SEC);
  if (n >= LOCK_FAILS) {
    cache.put('lock_' + login, '1', LOCK_WINDOW_SEC);
  }
}

function clearFail_(login) {
  var cache = CacheService.getScriptCache();
  cache.remove('fail_' + login);
  cache.remove('lock_' + login);
}

// ---------- User lookup ----------

function userByEmail_(email) {
  var rows = readSheet(SHEETS.USERS);
  var norm = String(email || '').trim().toLowerCase();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email || '').trim().toLowerCase() === norm) return rows[i];
  }
  return null;
}

function publicUser_(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    active: u.active !== false, language: u.language || 'ar',
    locationId: u.locationId || null, clusterId: u.clusterId || null,
    mustChangePw: !!u.mustChangePw
  };
}

// ---------- Web app entry points ----------

function doGet(e) {
  return json_({ ok: true, service: 'bestgas-cash-collection' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_request' });
  }
  try {
    return json_(route_(req));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function requireAuth_(req) {
  var claim = authToken_(req.token);
  if (!claim) throw new Error('auth_required');
  var user = getById_(SHEETS.USERS, claim.uid);
  if (!user || user.active === false) throw new Error('auth_required');
  return { user: user, hardExp: claim.hardExp };
}

function route_(req) {
  var action = req.action;
  if (!action) throw new Error('missing_action');

  if (action === 'login') return actionLogin_(req);
  if (action === 'forgotPassword') return actionForgotPassword_(req);

  // every other action requires a session
  var session = requireAuth_(req);
  var user = session.user;
  var newToken = renewToken_(user.id, session.hardExp);

  var handlers = {
    // self-service
    whoami: function () { return { user: publicUser_(user) }; },
    setLanguage: function () { return actionSetLanguage_(req, user); },
    changePassword: function () { return actionChangePassword_(req, user); },

    // reference data
    listDashboard: function () { return actionDashboard_(req, user); },
    listMeta: function () { return actionMeta_(req, user); },

    // entries
    createDailyEntry: function () { return actionCreateEntry_(req, user); },
    importDailyEntries: function () { return actionImportEntries_(req, user); },
    listEntries: function () { return actionListEntries_(req, user); },

    // handoffs
    createHandoff: function () { return actionCreateHandoff_(req, user); },
    confirmHandoff: function () { return actionConfirmHandoff_(req, user); },
    disputeHandoff: function () { return actionDisputeHandoff_(req, user); },
    resolveDispute: function () { return actionResolveDispute_(req, user); },
    recordDeposit: function () { return actionRecordDeposit_(req, user); },
    listHandoffs: function () { return actionListHandoffs_(req, user); },

    // reporting
    getSalesReport: function () { return actionSalesReport_(req, user); },
    listAudit: function () { return actionListAudit_(req, user); },
    getFile: function () { return actionGetFile_(req, user); },

    // admin — users (special: password/invite logic)
    adminCreateUser: function () { return actionAdminCreateUser_(req, user); },
    adminUpdateUser: function () { return actionAdminUpdateUser_(req, user); },
    adminResetPassword: function () { return actionAdminResetPassword_(req, user); },

    // admin — full control over the hierarchy: location -> store/car -> pos,
    // plus clusters. One generic save/delete pair per entity kind so every
    // level (including reassigning a POS device to a different driver) goes
    // through the same reviewed path.
    adminSaveEntity: function () { return actionAdminSaveEntity_(req, user); },
    adminDeleteEntity: function () { return actionAdminDeleteEntity_(req, user); },
    adminSetConfig: function () { return actionAdminSetConfig_(req, user); }
  };

  if (!handlers[action]) throw new Error('unknown_action');
  var result = handlers[action]();
  result.token = newToken;
  return result;
}

function actionLogin_(req) {
  var login = String(req.email || '').trim();
  if (!login) throw new Error('missing_email');
  if (checkLock_(login.toLowerCase())) {
    return { ok: false, error: 'locked' };
  }
  var pw = String(req.password || '').trim();
  var user = userByEmail_(login);
  if (!user || user.active === false || !verifyPw_(pw, user.salt, user.pass)) {
    noteFail_(login.toLowerCase());
    return { ok: false, error: 'invalid_credentials' };
  }
  clearFail_(login.toLowerCase());
  var token = issueToken_(user.id);
  logAudit_('login', user.id, null);
  return { ok: true, token: token, user: publicUser_(user) };
}

// Self-service password reset — no session required, since a locked-out user
// has no session. Always returns { ok:true } whether or not the email has an
// account, so this can't be used to enumerate registered addresses.
//
// Throttling is a short per-email cooldown (30s), separate from the login
// brute-force lockout (checkLock_/noteFail_, 8 strikes/15min) — reusing that
// mechanism here backfired: a nervous user clicking "send" a few times while
// waiting for the email locked themselves out for 15 minutes, silently, with
// the UI still showing "check your email" every time. `throttled: true`
// lets the client say "you already asked, wait a bit" instead of repeating
// the success message — it still never reveals whether the account exists.
function actionForgotPassword_(req) {
  var login = String(req.email || '').trim();
  if (!login) return { ok: true };
  var cache = CacheService.getScriptCache();
  var throttleKey = 'fpwait_' + login.toLowerCase();
  if (cache.get(throttleKey)) return { ok: true, throttled: true };
  cache.put(throttleKey, '1', 30);
  var user = userByEmail_(login);
  if (user && user.active !== false) {
    var temp = randomPassword_();
    var salt = randomSalt_();
    user.salt = salt;
    user.pass = hashPw_(temp, salt);
    user.mustChangePw = true;
    writeRow(SHEETS.USERS, user);
    sendInvite_(user, temp);
    logAudit_('forgot_password_reset', user.id, user.id);
  }
  return { ok: true };
}

function actionSetLanguage_(req, user) {
  user.language = req.language === 'en' || req.language === 'ur' ? req.language : 'ar';
  writeRow(SHEETS.USERS, user);
  return { ok: true };
}

function actionChangePassword_(req, user) {
  if (!req.newPassword || String(req.newPassword).length < 8) {
    return { ok: false, error: 'weak_password' };
  }
  if (!user.mustChangePw && !verifyPw_(req.currentPassword, user.salt, user.pass)) {
    return { ok: false, error: 'wrong_current_password' };
  }
  var salt = randomSalt_();
  user.salt = salt;
  user.pass = hashPw_(req.newPassword, salt);
  user.mustChangePw = false;
  writeRow(SHEETS.USERS, user);
  logAudit_('change_password', user.id, null);
  return { ok: true };
}
