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
  AUDIT: 'audit',
  // Imported bank-statement rows for reconciliation (Reconciliation.gs) —
  // closes the loop between "the collector said they deposited it" and
  // "the bank actually shows it arrived".
  BANK_LINES: 'bank_statement_lines',
  // Operational risks and complaints (Risk.gs) — anyone can submit, only
  // company-wide roles can browse/resolve. See CLAUDE.md.
  RISK_ITEMS: 'risk_items',
  // Area-manager bulk uploads awaiting Deputy Operations Manager approval —
  // an explicit, toggleable exception to the normal chain. See CLAUDE.md.
  AREA_BULK_BATCHES: 'area_bulk_batches',
  // Master data for the two kinds of money that move at a source without
  // being a sale: cash collected for something else (an old credit sale
  // being paid off, a cylinder deposit, scrap) and cash paid out of the
  // takings (fuel, a repair). Both are picked from a list an admin keeps,
  // never typed free-hand, so the report can group them.
  INCOME_ITEMS: 'income_items',
  EXPENSE_ITEMS: 'expense_items'
};

var IDLE_MS = 12 * 3600 * 1000;      // 12h idle session expiry
var HARD_MS = 7 * 24 * 3600 * 1000;  // 7 day hard cap
var LOCK_FAILS = 8;
var LOCK_WINDOW_SEC = 15 * 60;
var PW_ROUNDS = 120;

// ---------- Sheet-as-DB ----------

// ---------- Per-request memo ----------
// Every PropertiesService / CacheService / SpreadsheetApp call is a network
// round trip inside Google (tens of ms each). One request used to repeat
// the same ones many times -- e.g. login read the SECRET property 120 times
// while hashing, and every readSheet re-read its version property. This
// memo makes each of those happen at most once per request. It is reset at
// the start of every route_ call (and Apps Script starts every execution
// with fresh globals anyway).
var EXEC_ = null;
function exec_() {
  if (!EXEC_) EXEC_ = { props: null, ss: null, sheets: {}, rows: {} };
  return EXEC_;
}
function resetExecMemo_() { EXEC_ = null; }

function scriptProps_() {
  var ex = exec_();
  if (!ex.props) ex.props = PropertiesService.getScriptProperties().getProperties() || {};
  return ex.props;
}
function setScriptProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  scriptProps_()[key] = value;
}

// Works whether this script is bound to the Sheet (Extensions > Apps Script,
// getActiveSpreadsheet works directly) or standalone (script.google.com on
// its own — needs the Sheet's id in Script Properties as SHEET_ID). Try
// bound first since it needs no configuration.
function spreadsheet_() {
  var ex = exec_();
  if (ex.ss) return ex.ss;
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return (ex.ss = active);
  var id = scriptProps_().SHEET_ID;
  if (!id) throw new Error('Set a Script Property named SHEET_ID to this project\'s Google Sheet id (Project Settings > Script Properties) — this script is not bound to a Sheet.');
  return (ex.ss = SpreadsheetApp.openById(id));
}

function sheet_(name) {
  var ex = exec_();
  if (ex.sheets[name]) return ex.sheets[name];
  var ss = spreadsheet_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(['id', 'data', 'updatedAt']);
    sh.setFrozenRows(1);
  }
  return (ex.sheets[name] = sh);
}

function verKey_(name) { return 'ver_' + name; }

function version_(name) {
  return scriptProps_()[verKey_(name)] || '0';
}

// A random value, not a counter: a counter read from a stale memo by two
// concurrent writers could land on the same number twice, leaving a cache
// entry that silently hides the second write. A fresh UUID always changes.
function bumpVersion_(name) {
  var v = Utilities.getUuid();
  setScriptProp_(verKey_(name), v);
  delete exec_().rows[name];
  return v;
}

// CacheService rejects any single value over 100KB, and the old code just
// skipped caching in that case -- so once a sheet like daily_entries grew
// past that size, every request re-read the whole sheet. Large values are
// now split across several keys and fetched back in one getAll call.
var CACHE_TTL_SEC = 1800;
var CACHE_CHUNK_CHARS = 30000; // <= 100KB even if every char is 3 UTF-8 bytes
function cacheGetBig_(cache, key) {
  var head = cache.get(key);
  if (head === null || head === undefined) return null;
  if (head.indexOf('__chunks__:') !== 0) return head;
  var n = Number(head.slice(11));
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '#' + i);
  var parts = cache.getAll(keys);
  var out = '';
  for (var j = 0; j < keys.length; j++) {
    if (parts[keys[j]] === null || parts[keys[j]] === undefined) return null;
    out += parts[keys[j]];
  }
  return out;
}
function cachePutBig_(cache, key, str, ttl) {
  if (str.length <= CACHE_CHUNK_CHARS) { cache.put(key, str, ttl); return; }
  var n = Math.ceil(str.length / CACHE_CHUNK_CHARS);
  var chunks = {};
  for (var i = 0; i < n; i++) chunks[key + '#' + i] = str.substr(i * CACHE_CHUNK_CHARS, CACHE_CHUNK_CHARS);
  cache.putAll(chunks, ttl);
  cache.put(key, '__chunks__:' + n, ttl);
}

function readSheet(name) {
  var ex = exec_();
  // Memoized as a string and re-parsed per call, so callers still get their
  // own fresh objects exactly as before (several mutate what they read).
  if (ex.rows[name] !== undefined) return JSON.parse(ex.rows[name]);

  var cacheKey = name + '@' + version_(name);
  var cache = CacheService.getScriptCache();
  var cached = null;
  try { cached = cacheGetBig_(cache, cacheKey); } catch (e) { cached = null; }
  if (cached) { ex.rows[name] = cached; return JSON.parse(cached); }

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
  var str = JSON.stringify(rows);
  ex.rows[name] = str;
  try { cachePutBig_(cache, cacheKey, str, CACHE_TTL_SEC); } catch (e) { /* cache full or unavailable; the sheet read still stands */ }
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
    // An id we just generated can't already exist, so skip scanning the whole
    // id column for it -- that scan grew with every audit-log entry ever
    // written, since logAudit_ always creates a new row.
    var isNew = !obj.id;
    if (isNew) obj.id = Utilities.getUuid();
    var now = new Date().toISOString();
    var toStore = {};
    for (var k in obj) { if (obj.hasOwnProperty(k)) toStore[k] = obj[k]; }
    toStore.updatedAt = now;
    var json = JSON.stringify(toStore);
    var rowIndex = isNew ? -1 : findRow_(sh, obj.id);
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

// ---------- Safe object access ----------
// Defense-in-depth against prototype pollution: `for...in` merge loops over
// client-supplied JSON (req.data) must never let a key literally named
// __proto__/constructor/prototype reach a plain `obj[k] = ...` assignment.
// JSON.parse creates such a key as a genuine own property, so a bare
// hasOwnProperty(k) check on the *source* object does not exclude it — and
// `obj[k] = value` with k === '__proto__' invokes the real
// Object.prototype.__proto__ setter, reassigning obj's prototype rather than
// storing a field. Every merge loop over req.data in this app must go
// through safeOwnKeys_ instead of a bare hasOwnProperty check.
var UNSAFE_KEYS_ = { '__proto__': true, 'constructor': true, 'prototype': true };
function safeOwnKeys_(obj) {
  var out = [];
  for (var k in obj) {
    if (obj.hasOwnProperty(k) && !UNSAFE_KEYS_.hasOwnProperty(k)) out.push(k);
  }
  return out;
}
// For any object used as a lookup table keyed by client-supplied input
// (action names, entity kinds): a bare `table[key]` truthy-check lets a key
// like "__proto__"/"constructor"/"toString" resolve to an inherited
// Object.prototype member instead of correctly failing as "not found".
function hasOwn_(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
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

// All system emails go through this one choke point. If MicrosoftMail.gs is
// deployed and its GRAPH_* script properties are set, mail goes out from the
// bestgas.sa Microsoft 365 mailbox; otherwise (or if Microsoft rejects the
// send) it falls back to MailApp, so an alert is never lost.
// `html` is optional; when given, clients that render HTML show it and the
// plain `body` is the fallback.
function sendMail_(to, subject, body, html) {
  if (typeof sendViaGraph_ === 'function') {
    var cfg = graphMailConfig_();
    if (cfg) {
      try {
        sendViaGraph_(cfg, to, subject, body, html);
        return 'graph';
      } catch (e) {
        console.error('Microsoft Graph send failed, falling back to MailApp: ' + e);
      }
    }
  }
  if (html) MailApp.sendEmail(to, subject, body, { htmlBody: html, name: config_().senderName || 'Best Gas Cash Collection' });
  else MailApp.sendEmail(to, subject, body);
  return 'mailapp';
}

// Hours a handoff can sit 'pending' before checkStaleHandoffs_ escalates it.
function staleThresholdHours_() {
  var c = config_();
  return typeof c.staleThresholdHours === 'number' ? c.staleThresholdHours : 24;
}

// Hours a CONFIRMED handoff can sit held (not yet consumed by the next
// step up the chain) before checkHeldTooLong_ escalates it — a separate,
// later-stage risk from staleThresholdHours_ above, so it gets its own
// configurable threshold. Default is longer than the pending threshold:
// a still-unconfirmed handoff is more urgent than cash someone is
// legitimately sitting on for a day while batching the next handoff.
function heldThresholdHours_() {
  var c = config_();
  return typeof c.heldThresholdHours === 'number' ? c.heldThresholdHours : 48;
}

// SAR amount above which a confirmed handoff also needs a second
// admin/finance sign-off (see actionConfirmHandoff_ / escalateLargeAmount_
// in Collection.gs). 0 = disabled — a live system shouldn't suddenly start
// flagging existing large handoffs just because this code shipped.
function secondApprovalThreshold_() {
  var c = config_();
  return typeof c.secondApprovalThreshold === 'number' ? c.secondApprovalThreshold : 0;
}

// Gates the entire area-manager bulk-upload -> Deputy Operations Manager
// approval path (Collection.gs: checkClusterBulkEntryScope_,
// actionBulkSubmitAreaBatch_, actionDeputyApproveBatch_/RejectBatch_). Off
// by default — this is a deliberate exception to the normal driver/store-
// manager chain and must never turn itself on for a cluster that hasn't
// asked for it. See CLAUDE.md.
function areaManagerBulkUploadEnabled_() {
  var c = config_();
  return c.areaManagerBulkUploadEnabled === true;
}

// ---------- Crypto / auth ----------

function secret_() {
  var s = scriptProps_().SECRET;
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    setScriptProp_('SECRET', s);
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
  var key = secret_() + salt; // same key every round -- fetched once, not 120 times
  for (var i = 0; i < PW_ROUNDS; i++) {
    h = hmac_(h, key);
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
    mustChangePw: !!u.mustChangePw, iqamaId: u.iqamaId || null,
    status: userStatus_(u), lastLoginAt: u.lastLoginAt || null,
    invitedAt: u.invitedAt || null, acceptedAt: u.acceptedAt || null,
    activatedAt: u.activatedAt || null, inviteExpiresAt: u.inviteExpiresAt || null
  };
}

// invited -> accepted (set a password through the link) -> active (signed
// in). Accounts from before invitations existed have no inviteStatus: they
// count as active once they've signed in, otherwise still 'invited'.
function userStatus_(u) {
  if (u.active === false) return 'disabled';
  if (u.inviteStatus === 'invited') {
    return (u.inviteExpiresAt && new Date(u.inviteExpiresAt).getTime() < Date.now()) ? 'invite_expired' : 'invited';
  }
  if (u.inviteStatus === 'accepted') return 'accepted';
  if (u.inviteStatus === 'active' || u.lastLoginAt) return 'active';
  return 'invited';
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

// ---------- Whole-response cache ----------
// The sheet cache already saves re-reading a sheet; this saves running the
// request at all. A read action's full JSON is kept under a key that carries
// every sheet's version, so ANY write anywhere invalidates every cached
// response without each action having to declare what it depends on. Short
// TTL as well, because a few of these responses embed "hours since" figures.
var CACHEABLE_READ_ACTIONS_ = {
  getDashboardAll: 1, getSalesReport: 1, listHandoffs: 1, listEntries: 1, listMeta: 1,
  listDashboard: 1, getDashboardComparison: 1, getHeldCashTrend: 1, getShortfallByEntrant: 1,
  listAudit: 1, getReconciliation: 1, listAreaBulkBatches: 1, listRiskItems: 1
};
var RESP_CACHE_TTL_SEC = 120;

function dataVersion_() {
  var parts = [];
  for (var k in SHEETS) {
    if (SHEETS.hasOwnProperty(k)) parts.push(version_(SHEETS[k]));
  }
  return parts.join('.');
}

// CacheService keys cap at 250 characters, and a report request carries a
// whole filter object — so the key is a hash of it, not the thing itself.
function responseCacheKey_(action, req, user) {
  var payload = {};
  safeOwnKeys_(req).forEach(function (k) {
    if (k !== 'token' && k !== 'action') payload[k] = req[k];
  });
  var raw = user.id + '|' + action + '|' + JSON.stringify(payload) + '|' + dataVersion_();
  return 'resp_' + hmac_(raw, secret_() + '|resp').slice(0, 96);
}

// Reference data rides back on a successful admin write. The sheets it
// reads are already in this execution's memo, so it costs almost nothing
// here and saves a whole round trip on the client.
function withMeta_(result, req, user) {
  if (result && result.ok) {
    try { result.meta = actionMeta_(req, user); } catch (e) { /* the write still succeeded */ }
  }
  return result;
}

function route_(req) {
  resetExecMemo_();
  var action = req.action;
  if (!action) throw new Error('missing_action');

  if (action === 'login') return actionLogin_(req);
  if (action === 'forgotPassword') return actionForgotPassword_(req);
  // invitation accept page -- the person has no account password yet
  if (action === 'inviteInfo') return actionInviteInfo_(req);
  if (action === 'acceptInvite') return actionAcceptInvite_(req);

  // every other action requires a session
  var session = requireAuth_(req);
  var user = session.user;
  var newToken = renewToken_(user.id, session.hardExp);

  var handlers = {
    // self-service
    whoami: function () { return { user: publicUser_(user) }; },
    // Reopening the app used to be whoami then listMeta: two round trips
    // before anything could render. One call returns both.
    bootstrap: function () { var meta = actionMeta_(req, user); return { ok: true, user: publicUser_(user), meta: meta }; },
    setLanguage: function () { return actionSetLanguage_(req, user); },
    changePassword: function () { return actionChangePassword_(req, user); },

    // reference data
    listDashboard: function () { return actionDashboard_(req, user); },
    getDashboardAll: function () { return actionDashboardAll_(req, user); },
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
    getShortfallByEntrant: function () { return actionShortfallByEntrant_(req, user); },
    getDashboardComparison: function () { return actionDashboardComparison_(req, user); },
    getHeldCashTrend: function () { return actionHeldCashTrend_(req, user); },
    listAudit: function () { return actionListAudit_(req, user); },
    getFile: function () { return actionGetFile_(req, user); },

    // bank reconciliation — admin/finance only, same authority split as
    // dispute resolution (see Reconciliation.gs)
    importBankStatement: function () { return actionImportBankStatement_(req, user); },
    getReconciliation: function () { return actionReconciliationSummary_(req, user); },
    manualMatchReconciliation: function () { return actionManualMatchReconciliation_(req, user); },
    unmatchReconciliation: function () { return actionUnmatchReconciliation_(req, user); },

    // SLA escalation on stale (long-pending) handoffs, and a second
    // sign-off flag on large confirmed amounts (see Collection.gs)
    runStaleCheck: function () { return actionRunStaleCheck_(req, user); },
    adminInstallStaleTrigger: function () { return actionAdminInstallStaleTrigger_(req, user); },
    acknowledgeSecondApproval: function () { return actionAcknowledgeSecondApproval_(req, user); },

    // operational risk / complaint register (see Risk.gs)
    createRiskItem: function () { return actionCreateRiskItem_(req, user); },
    listRiskItems: function () { return actionListRiskItems_(req, user); },
    updateRiskItemStatus: function () { return actionUpdateRiskItemStatus_(req, user); },

    // area-manager bulk upload -> Deputy Operations Manager approval — a
    // toggleable exception to the normal driver/store-manager chain, see
    // CLAUDE.md and checkClusterBulkEntryScope_ (Collection.gs).
    bulkSubmitAreaBatch: function () { return actionBulkSubmitAreaBatch_(req, user); },
    listAreaBulkBatches: function () { return actionListAreaBulkBatches_(req, user); },
    areaBulkBatchDetail: function () { return actionAreaBulkBatchDetail_(req, user); },
    deputyApproveBatch: function () { return actionDeputyApproveBatch_(req, user); },
    deputyRejectBatch: function () { return actionDeputyRejectBatch_(req, user); },

    // admin — users (special: password/invite logic)
    // withMeta_ appends the refreshed reference data to a successful write,
    // so the client never has to follow it with a listMeta round trip —
    // on Apps Script that second call costs as much as the write itself.
    adminCreateUser: function () { return withMeta_(actionAdminCreateUser_(req, user), req, user); },
    adminUpdateUser: function () { return withMeta_(actionAdminUpdateUser_(req, user), req, user); },
    adminResetPassword: function () { return withMeta_(actionAdminResetPassword_(req, user), req, user); },
    adminResendInvite: function () { return withMeta_(actionAdminResendInvite_(req, user), req, user); },

    // admin — full control over the hierarchy: location -> store/car -> pos,
    // plus clusters. One generic save/delete pair per entity kind so every
    // level (including reassigning a POS device to a different driver) goes
    // through the same reviewed path.
    adminSaveEntity: function () { return withMeta_(actionAdminSaveEntity_(req, user), req, user); },
    adminDeleteEntity: function () { return withMeta_(actionAdminDeleteEntity_(req, user), req, user); },
    adminSetConfig: function () { return withMeta_(actionAdminSetConfig_(req, user), req, user); },
    // starts a fresh round of testing by archiving the movement tabs —
    // renames, never deletes (see Admin.gs)
    adminArchiveTransactions: function () { return actionAdminArchiveTransactions_(req, user); }
  };

  if (!hasOwn_(handlers, action)) throw new Error('unknown_action');

  var cacheable = hasOwn_(CACHEABLE_READ_ACTIONS_, action);
  var respKey = null, cache = null;
  if (cacheable) {
    try {
      cache = CacheService.getScriptCache();
      respKey = responseCacheKey_(action, req, user);
      var hit = cacheGetBig_(cache, respKey);
      if (hit) {
        var cached = JSON.parse(hit);
        cached.token = newToken;   // the session token is never cached
        return cached;
      }
    } catch (e) { respKey = null; }
  }

  var result = handlers[action]();
  if (respKey && result && result.ok) {
    try {
      var toCache = {};
      safeOwnKeys_(result).forEach(function (k) { if (k !== 'token') toCache[k] = result[k]; });
      cachePutBig_(cache, respKey, JSON.stringify(toCache), RESP_CACHE_TTL_SEC);
    } catch (e) { /* oversized or unavailable cache must never fail a request */ }
  }
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
  if (user && user.active !== false && user.inviteStatus === 'invited' && !user.pass) {
    // no password exists until the invitation is accepted
    noteFail_(login.toLowerCase());
    return { ok: false, error: 'invite_pending' };
  }
  if (!user || user.active === false || !verifyPw_(pw, user.salt, user.pass)) {
    noteFail_(login.toLowerCase());
    return { ok: false, error: 'invalid_credentials' };
  }
  clearFail_(login.toLowerCase());
  if (user.inviteStatus !== 'active') {
    user.inviteStatus = 'active';
    if (!user.activatedAt) user.activatedAt = new Date().toISOString();
  }
  // The value on file is *before* this login overwrites it, i.e. the
  // previous session's login time — that's the one worth showing back to
  // the user ("last login: ..."), not the one that's happening right now.
  var previousLoginAt = user.lastLoginAt || null;
  user.lastLoginAt = new Date().toISOString();
  writeRow(SHEETS.USERS, user);
  var token = issueToken_(user.id);
  logAudit_('login', user.id, null);
  // Reference data rides along with the login reply, so the client can
  // render straight away instead of making a second round trip for listMeta.
  return { ok: true, token: token, user: publicUser_(user), previousLoginAt: previousLoginAt, meta: actionMeta_(req, user) };
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
  if (user && user.active !== false && user.inviteStatus === 'invited') {
    // never accepted: send the invitation again rather than a temp password
    var inviteToken = issueInvite_(user, null);
    writeRow(SHEETS.USERS, user);
    sendInvitation_(user, inviteToken, null, inviteAppUrl_(req));
    logAudit_('forgot_password_reinvite', user.id, user.id);
  } else if (user && user.active !== false) {
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
