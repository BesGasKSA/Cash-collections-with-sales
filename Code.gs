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
  // credit customers (auto-numbered CUS-0001…) and the city list pickers draw from
  CUSTOMERS: 'customers',
  CITIES: 'cities',
  // sales channels such as the Souq Gas app, with their own delivery fee and
  // driver commission per unit
  CHANNELS: 'channels',
  // photos of الموازنات, uploaded before the entry that uses them; one photo
  // serves one line, and only its uploader can use it
  ENTRY_PHOTOS: 'entry_photos',
  // English and Urdu for the Arabic names in master data, keyed by the Arabic
  // text itself: {src, en, ur, auto}. auto = Google Translate; a manager's
  // correction sets it false and is never overwritten.
  TRANSLATIONS: 'translations',
  // stock movements typed in by hand: opening, purchase, return, damage (Inventory.gs)
  INV_MOVES: 'inventory_moves',
  // what a branch holds and counts (LPG Task 1b): cylinder items full and empty,
  // unit items in units; the products (sales items) name the item they move
  STOCK_ITEMS: 'stock_items',
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
  // a date range of transactions taken out of every screen and report, and the
  // rows themselves, so a run can be put back as it was (2026-10-08, Admin.gs)
  ARCHIVE_RUNS: 'archive_runs',
  ARCHIVED_ROWS: 'archived_rows',
  // Master data for the two kinds of money that move at a source without
  // being a sale: cash collected for something else (an old credit sale
  // being paid off, a cylinder deposit, scrap) and cash paid out of the
  // takings (fuel, a repair). Both are picked from a list an admin keeps,
  // never typed free-hand, so the report can group them.
  INCOME_ITEMS: 'income_items',
  EXPENSE_ITEMS: 'expense_items',
  // Costing (Costing.gs): the catalogue of cost types, the monthly cost lines
  // of each car, store, branch, area, city and the company, and each product's
  // unit cost over time
  COST_TYPES: 'cost_types',
  COST_LINES: 'cost_lines',
  PRODUCT_COSTS: 'product_costs',
  // every change to a price, a cost, a delivery fee or a commission, old and new (2026-10-04)
  RATE_CHANGES: 'rate_changes',
  // customers (Customers.gs): payments by bank transfer, and the sales invoices and credit notes issued from the app
  CUSTOMER_PAYMENTS: 'customer_payments',
  SALES_INVOICES: 'sales_invoices'
};

var IDLE_MS = 2 * 3600 * 1000;   // was 12h; the screens sign out after 10 idle minutes (security review 2026-10-04)
var IDLE_MS_WAS_12H = true;      // 12h idle session expiry
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

// ---------- Area switching (2026-10-06) ----------
// An area manager may run more than one area, and works in one at a time, the
// way an ERP user switches company: the client sends the area it is in
// (activeAreaId) with every request, and for that request everything the
// manager sees and does is that area alone: branches, entries, handovers, held
// cash, reports, stock, bulk uploads, what is waiting. The narrowing lives in
// clusterManagerOwnsCluster_ (Collection.gs), which every area check goes
// through, and inActiveArea_ for handovers. An area that is not his is ignored;
// no area sent (an older client) means all of his areas, as before.
function managedAreas_(userId) {
  return readSheet(SHEETS.CLUSTERS).filter(function (c) { return c.clusterManagerUserId === userId; });
}
function setActiveArea_(user, areaId) {
  if (!user || user.role !== 'cluster_manager' || !areaId || typeof areaId !== 'string') return;
  if (!managedAreas_(user.id).some(function (c) { return c.id === areaId; })) return;
  exec_().activeArea = { userId: user.id, areaId: areaId };
}
function activeAreaOf_(userId) {
  var a = EXEC_ && EXEC_.activeArea;
  return a && a.userId === userId ? a.areaId : null;
}
// a handover belongs to the area the manager is working in (always true for anyone else)
function inActiveArea_(user, h) {
  var area = user && user.role === 'cluster_manager' ? activeAreaOf_(user.id) : null;
  return !area || clusterIdForHandoff_(h) === area;
}
// After waiting for the script lock, forget what this request read before:
// another execution may have written in the meantime, and a check made on
// those older reads (a duplicate name, the next number) would be wrong.
function freshenExec_() { var ex = exec_(); ex.props = null; ex.rows = {}; }

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
  // A caller that already holds the lock (a check-then-write that must stay
  // atomic) keeps it: writeRow only releases a lock it took itself.
  var lock = LockService.getScriptLock();
  var held = lock.hasLock ? lock.hasLock() : false;
  if (!held) lock.waitLock(30000);
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
    // a copy read before this record was numbered never erases its number
    if (rowIndex > 0 && ((!toStore.code && isCodedSheet_(name)) || (!toStore.txNo && isTxSheet_(name)))) {
      try {
        var prev = JSON.parse(sh.getRange(rowIndex, 2, 1, 1).getValues()[0][0] || '{}');
        if (prev.code && !toStore.code) toStore.code = prev.code;
        if (prev.txNo && !toStore.txNo) { toStore.txNo = prev.txNo; if (prev.txLine) toStore.txLine = prev.txLine; }
        json = JSON.stringify(toStore);
      } catch (e) {}
    }
    if (rowIndex > 0) {
      sh.getRange(rowIndex, 1, 1, 3).setValues([[obj.id, json, now]]);
    } else {
      // a row new to the sheet (its id may have been made by the caller) gets its number
      if (!toStore.txNo) { txStamp_(name, toStore); if (toStore.txNo) { obj.txNo = toStore.txNo; if (toStore.txLine) obj.txLine = toStore.txLine; json = JSON.stringify(toStore); } }
      sh.appendRow([obj.id, json, now]);
    }
    bumpVersion_(name);
    return toStore;
  } finally {
    if (!held) lock.releaseLock();
  }
}

// ---------- Transaction numbers (2026-10-06) ----------
// Every transaction, whatever its type, carries a number of its own that is
// never edited or reused: PREFIX-YEAR-NNNNNN, one counter per prefix per year
// (script property TXSEQ_<prefix>_<year>). The rows of one saved day share its
// number (DAY-2026-000123) and carry their line within it (txLine). A copy read
// before a row was numbered never erases its number. Rows saved before numbers
// existed are numbered once by txNumbersBackfill_ (from doGet, never inside a
// person's request), in the order they were written.
var TX_PREFIX_ = {
  daily_entries: 'DAY', area_bulk_batches: 'ABU', inventory_moves: 'STM', bank_statement_lines: 'BST',
  risk_items: 'RSK', cost_lines: 'CSL', product_costs: 'PCH', rate_changes: 'RCH', entry_photos: 'PHO',
  customer_payments: 'CPY', sales_invoices: 'INV'
};
var TX_HANDOFF_PREFIX_ = { car_to_location: 'HCB', location_to_cluster: 'HBA', cluster_to_collector: 'HAC', deposit: 'DEP' };
var TX_FLAG_ = 'TX_NUMBERED_V1';
function txPrefixOf_(name, obj) {
  if (name === SHEETS.HANDOFFS) return TX_HANDOFF_PREFIX_[obj.kind] || 'HND';
  if (name === SHEETS.SALES_INVOICES && obj.kind === 'credit_note') return 'CRN';
  return hasOwn_(TX_PREFIX_, name) ? TX_PREFIX_[name] : null;
}
function txYearOf_(obj) {
  var d = String(obj.createdAt || obj.date || obj.updatedAt || '');
  return /^\d{4}/.test(d) ? d.slice(0, 4) : new Date().toISOString().slice(0, 4);
}
// the next number for a prefix and year; the caller holds the script lock
function txNext_(prefix, year) {
  var key = 'TXSEQ_' + prefix + '_' + year;
  var n = Number(PropertiesService.getScriptProperties().getProperty(key) || 0) + 1;
  setScriptProp_(key, String(n));
  var s = String(n); while (s.length < 6) s = '0' + s;
  return prefix + '-' + year + '-' + s;
}
// stamps a new row (writeRow and costAppendMany_ call it under the lock)
function txStamp_(name, obj) {
  if (obj.txNo || !scriptProps_()[TX_FLAG_]) return;
  var prefix = txPrefixOf_(name, obj); if (!prefix) return;
  if (name === SHEETS.ENTRIES && obj.submissionId) {
    var ex = exec_(); ex.txSub = ex.txSub || {};
    var mem = ex.txSub[obj.submissionId];
    if (!mem) {
      // a day's earlier rows saved in another request: its number and its last line
      var sib = readSheet(SHEETS.ENTRIES).filter(function (e) { return e.submissionId === obj.submissionId && e.txNo; });
      mem = sib.length ? { no: sib[0].txNo, line: sib.reduce(function (a, e) { return Math.max(a, Number(e.txLine || 1)); }, 0) } : null;
    }
    if (!mem) mem = { no: txNext_(prefix, txYearOf_(obj)), line: 0 };
    mem.line++;
    ex.txSub[obj.submissionId] = mem;
    obj.txNo = mem.no; obj.txLine = mem.line;
    return;
  }
  obj.txNo = txNext_(prefix, txYearOf_(obj));
}
function isTxSheet_(name) { return name === SHEETS.HANDOFFS || hasOwn_(TX_PREFIX_, name); }
// Numbers every transaction saved before numbers existed: one read and one write
// of each sheet's data column, in the order the rows were written, under the lock.
function txNumbersBackfill_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    if (scriptProps_()[TX_FLAG_]) return 0;
    var done = 0, ctr = {};
    // counters in memory, saved once at the end: a property write per number took
    // 219 s on the live data (2026-10-06) and held the lock all that time
    var txNext_ = function (prefix, year) {
      var key = 'TXSEQ_' + prefix + '_' + year;
      if (!hasOwn_(ctr, key)) ctr[key] = Number(PropertiesService.getScriptProperties().getProperty(key) || 0);
      var s = String(++ctr[key]); while (s.length < 6) s = '0' + s;
      return prefix + '-' + year + '-' + s;
    };
    [SHEETS.ENTRIES, SHEETS.HANDOFFS].concat(Object.keys(TX_PREFIX_).filter(function (n) { return n !== SHEETS.ENTRIES; })).forEach(function (name) {
      var sh = sheet_(name), last = sh.getLastRow();
      if (last < 2) return;
      var rng = sh.getRange(2, 2, last - 1, 1), vals = rng.getValues(), subs = {}, changed = false;
      for (var i = 0; i < vals.length; i++) {
        var o; try { o = JSON.parse(vals[i][0] || '{}'); } catch (e) { continue; }
        if (!o || o.txNo) { if (o && o.txNo && o.submissionId) subs[o.submissionId] = subs[o.submissionId] || { no: o.txNo, line: Number(o.txLine || 1) }; continue; }
        var prefix = txPrefixOf_(name, o); if (!prefix) continue;
        if (name === SHEETS.ENTRIES && o.submissionId) {
          var m = subs[o.submissionId] || (subs[o.submissionId] = { no: txNext_(prefix, txYearOf_(o)), line: 0 });
          m.line++; o.txNo = m.no; o.txLine = m.line;
        } else o.txNo = txNext_(prefix, txYearOf_(o));
        vals[i][0] = JSON.stringify(o); changed = true; done++;
      }
      if (changed) { rng.setValues(vals); bumpVersion_(name); }
    });
    var setP = {}; Object.keys(ctr).forEach(function (k) { setP[k] = String(ctr[k]); });
    if (Object.keys(setP).length) { PropertiesService.getScriptProperties().setProperties(setP); Object.keys(setP).forEach(function (k) { scriptProps_()[k] = setP[k]; }); }
    setScriptProp_(TX_FLAG_, new Date().toISOString());
    logAudit_('tx_numbers_backfill', 'system', String(done));
    return done;
  } finally { try { lock.releaseLock(); } catch (e) {} }
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
      senderName: 'Best Gas Collections',
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
// The VAT rate a day is worked out at (2026-10-04): no change of rate rewrites a
// day already saved. A day saved from now on carries its own rate (vatRate);
// an older one takes the rate in force on its date, from the history a VAT
// change writes (config.vatHistory, oldest first: {rate, until} is the rate that
// stood up to and including that day).
function vatHistory_() { var h = config_().vatHistory; return Array.isArray(h) ? h : []; }
function vatRateOn_(date, hist) {
  hist = hist || vatHistory_();
  var d = String(date || '');
  if (d) for (var i = 0; i < hist.length; i++) if (d <= String(hist[i].until)) return Number(hist[i].rate);
  return vatRate_();
}
function entryVatRate_(e, hist) { return typeof e.vatRate === 'number' && isFinite(e.vatRate) ? e.vatRate : vatRateOn_(e.date, hist); }

// All system emails go through this one choke point. If MicrosoftMail.gs is
// deployed and its GRAPH_* script properties are set, mail goes out from the
// bestgas.sa Microsoft 365 mailbox; otherwise (or if Microsoft rejects the
// send) it falls back to MailApp, so an alert is never lost.
// `html` is optional; when given, clients that render HTML show it and the
// plain `body` is the fallback.
function sendMail_(to, subject, body, html) {
  // accounts without email (drivers who sign in by iqama) simply get nothing
  to = String(to || '').split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x.indexOf('@') > 0; }).join(',');
  if (!to) return 'none';
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
  if (html) MailApp.sendEmail(to, subject, body, { htmlBody: html, name: config_().senderName || 'Best Gas Collections' });
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
// Whether the entry screen offers POS (card) sales at all. Off until the
// company starts taking card payments at the branches; the admin turns it on.
function posSalesEnabled_() {
  return config_().posSalesEnabled === true;
}

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
  return safeEq_(hashPw_(pw, salt), stored);
}
// compares in the same time however early two strings differ
function safeEq_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length, n = Math.max(a.length, b.length);
  for (var i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function randomPassword_() {
  // about 120 bits from two UUIDs; Math.random was guessable (security review 2026-10-04)
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 16);
}

// ---------- Session tokens ----------
// uid|idle expiry|hard expiry|epoch. The epoch is the account's tokenEpoch when
// the token was made: a password change, a reset or an email change raises it,
// and every older token stops working (security review 2026-10-04). A token from
// before this has no epoch, read as 0, so nobody is signed out by the deploy.
function epochOf_(u) { return Number(u && u.tokenEpoch || 0); }
function bumpEpoch_(u) { u.tokenEpoch = epochOf_(u) + 1; }

function issueToken_(uid, epoch) {
  var now = Date.now();
  var payload = uid + '|' + (now + IDLE_MS) + '|' + (now + HARD_MS) + '|' + Number(epoch || 0) + '|' + Utilities.getUuid().slice(0, 8);
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
  if (!safeEq_(sign_(payload), parts[1])) return null;
  var bits = payload.split('|');
  var uid = bits[0], exp = Number(bits[1]), hardExp = Number(bits[2]), epoch = Number(bits[3] || 0);
  var now = Date.now();
  if (!uid || now > exp || now > hardExp) return null;
  return { uid: uid, hardExp: hardExp, epoch: epoch };
}

function renewToken_(uid, hardExp, epoch) {
  var now = Date.now();
  var payload = uid + '|' + (now + IDLE_MS) + '|' + hardExp + '|' + Number(epoch || 0) + '|' + Utilities.getUuid().slice(0, 8);   // every token unique
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
  // an account without email must never match a blank address
  if (!norm) return null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email || '').trim().toLowerCase() === norm) return rows[i];
  }
  return null;
}

// Drivers without email sign in with their iqama (or passport) number
// (2026-09-29): Arabic digits become ASCII, spaces and dashes go, letters are
// capitals, so "ab 1234 567" and "١٢٣٤٥٦٧٨٩٠" match what the admin typed (made-up examples).
function normIqama_(v) {
  return String(v == null ? '' : v).replace(/[\u0660-\u0669]/g, function (c) { return String(c.charCodeAt(0) - 0x0660); })
    .replace(/[\u06F0-\u06F9]/g, function (c) { return String(c.charCodeAt(0) - 0x06F0); })
    .toUpperCase().replace(/[^0-9A-Z]/g, '');
}
// the key a sign-in's failed attempts count against: one per account, however
// the iqama number was typed
function loginKey_(login) {
  login = String(login || '').trim();
  return login.indexOf('@') >= 0 ? login.toLowerCase() : 'iq:' + normIqama_(login);
}
function userByIqama_(iq) {
  var norm = normIqama_(iq);
  if (!norm) return null;
  var rows = readSheet(SHEETS.USERS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].iqamaId && normIqama_(rows[i].iqamaId) === norm) return rows[i];
  }
  return null;
}
// what the sign-in box holds: an email, or else an iqama number
function userByLogin_(login) {
  login = String(login || '').trim();
  if (!login) return null;
  return login.indexOf('@') >= 0 ? userByEmail_(login) : userByIqama_(login);
}

// The language a person sees (2026-09-30: English is the default). Accounts
// saved before carry "ar" only because Arabic used to be the default, so an
// account's language counts when someone chose it (languageChosen: picked in
// the app, or set by an admin) or when it is English or Urdu.
function userLang_(u) {
  var l = u && u.language;
  if (l === 'en' || l === 'ur') return l;
  return u && u.languageChosen && l === 'ar' ? 'ar' : 'en';
}
function publicUser_(u) {
  return {
    id: u.id, code: u.code || null, name: u.name, email: u.email, role: u.role,
    active: u.active !== false, language: userLang_(u),
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
  // The warm-up ping also runs the one-time data jobs, so they finish on the
  // deploy's own check rather than on a person's first tap.
  try { resetExecMemo_(); runOneTimeMigrations_(); }
  catch (err) { try { logAudit_('migration_failed', 'system', String(err && err.message || err)); } catch (e2) {} }
  // transactions saved before numbers existed get theirs once (one bulk pass per sheet)
  try { resetExecMemo_(); if (!scriptProps_()[TX_FLAG_]) txNumbersBackfill_(); }
  catch (err) { try { logAudit_('tx_numbers_failed', 'system', String(err && err.message || err)); } catch (e2) {} }
  // names still without their other languages, a slice per ping
  var tr = null;
  try { resetExecMemo_(); tr = translationsCatchUpStep_(); }
  catch (err) { try { logAudit_('translations_catchup_failed', 'system', String(err && err.message || err)); } catch (e2) {} }
  return json_({ ok: true, service: 'bestgas-cash-collection', translations: tr });
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
    var msg = String(err && err.message || err);
    // an error code reaches the client; a raw exception is kept in the audit trail
    if (!/^[a-z_]+$/.test(msg)) { try { logAudit_('server_error', 'system', msg.slice(0, 500)); } catch (e2) {} msg = 'server_error'; }
    return json_({ ok: false, error: msg });
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
  if (claim.epoch !== epochOf_(user)) throw new Error('auth_required');
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
  listAudit: 1, getReconciliation: 1, listAreaBulkBatches: 1, listRiskItems: 1,
  listCosts: 1, getCostReport: 1, getProfitReport: 1
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
// Reads what is still unconsumed and marks it consumed as one step, under the
// script lock and against a fresh read, so a double tap or two phones cannot
// hand the same cash over twice. writeRow keeps a lock its caller holds.
function withCashLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { freshenExec_(); return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

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
  runOneTimeMigrations_();
  // the area an area manager is working in, for this request only (area switching, 2026-10-06)
  setActiveArea_(user, req.activeAreaId);
  var newToken = renewToken_(user.id, session.hardExp, epochOf_(user));
  // a temporary sign-in is changed before anything else (security review 2026-10-04)
  if (user.mustChangePw && ['whoami', 'bootstrap', 'changePassword', 'setLanguage'].indexOf(action) < 0) return { ok: false, error: 'first_login_change', token: newToken };

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
    myPendingActions: function () { return actionMyPendingActions_(req, user); },
    getJourney: function () { return actionGetJourney_(req, user); },
    getDashboardAll: function () { return actionDashboardAll_(req, user); },
    listMeta: function () { return actionMeta_(req, user); },

    // entries
    voidEntries: function () { return actionVoidEntries_(req, user); },
    deputyValidateHandoff: function () { return actionDeputyValidateHandoff_(req, user); },
    deputyReturnHandoff: function () { return actionDeputyReturnHandoff_(req, user); },
    createDailyEntry: function () { return actionCreateEntry_(req, user); },
    importDailyEntries: function () { return actionImportEntries_(req, user); },
    listEntries: function () { return actionListEntries_(req, user); },

    // handoffs
    createHandoff: function () { return withCashLock_(function () { return actionCreateHandoff_(req, user); }); },
    confirmHandoff: function () { return actionConfirmHandoff_(req, user); },
    disputeHandoff: function () { return actionDisputeHandoff_(req, user); },
    resolveDispute: function () { return actionResolveDispute_(req, user); },
    recordDeposit: function () { return withCashLock_(function () { return actionRecordDeposit_(req, user); }); },
    uploadEntryPhoto: function () { return actionUploadEntryPhoto_(req, user); },
    listHandoffs: function () { return actionListHandoffs_(req, user); },
    addInventoryMove: function () { return actionAddInventoryMove_(req, user); },
    recordStockCount: function () { return actionRecordStockCount_(req, user); },
    voidInventoryMove: function () { return actionVoidInventoryMove_(req, user); },
    getInventoryReport: function () { return actionInventoryReport_(req, user); },
    getInventoryLive: function () { return actionInventoryLive_(req, user); },
    getStockLedger: function () { return actionStockLedger_(req, user); },
    recordCustomerPayment: function () { return actionRecordCustomerPayment_(req, user); },
    voidCustomerPayment: function () { return actionVoidCustomerPayment_(req, user); },
    listCustomerPayments: function () { return actionListCustomerPayments_(req, user); },
    getCustomerStatement: function () { return actionCustomerStatement_(req, user); },
    getCustomerBalances: function () { return actionCustomerBalances_(req, user); },
    getInvoiceCandidates: function () { return actionInvoiceCandidates_(req, user); },
    createInvoice: function () { return actionCreateInvoice_(req, user); },
    creditInvoice: function () { return actionCreditInvoice_(req, user); },
    listInvoices: function () { return actionListInvoices_(req, user); },
    transferInventory: function () { return actionTransferInventory_(req, user); },
    carStockMove: function () { return actionCarStockMove_(req, user); },
    importInventoryDay: function () { return actionImportInventoryDay_(req, user); },
    inventorySetupProposal: function () { return actionInventorySetupProposal_(req, user); },
    inventorySetupPreview: function () { return actionInventorySetupPreview_(req, user); },
    applyInventorySetup: function () { return withMeta_(actionApplyInventorySetup_(req, user), req, user); },

    // costing and profitability (see Costing.gs)
    listCosts: function () { return actionListCosts_(req, user); },
    saveCostLine: function () { return actionSaveCostLine_(req, user); },
    changeCostLine: function () { return actionChangeCostLine_(req, user); },
    endCostLine: function () { return actionEndCostLine_(req, user); },
    voidCostLine: function () { return actionVoidCostLine_(req, user); },
    importCostLines: function () { return actionImportCostLines_(req, user); },
    setProductCost: function () { return withMeta_(actionSetProductCost_(req, user), req, user); },
    setStockItemCost: function () { return withMeta_(actionSetStockItemCost_(req, user), req, user); },
    getRateHistory: function () { return actionGetRateHistory_(req, user); },
    getCostReport: function () { return actionCostReport_(req, user); },
    getProfitReport: function () { return actionProfitReport_(req, user); },

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
    areaBatchRows: function () { return actionAreaBatchRows_(req, user); },
    deputyApproveBatch: function () { return withCashLock_(function () { return actionDeputyApproveBatch_(req, user); }); },
    deputyRejectBatch: function () { return withCashLock_(function () { return actionDeputyRejectBatch_(req, user); }); },

    // admin — users (special: password/invite logic)
    // withMeta_ appends the refreshed reference data to a successful write,
    // so the client never has to follow it with a listMeta round trip —
    // on Apps Script that second call costs as much as the write itself.
    adminCreateUser: function () { return withMeta_(actionAdminCreateUser_(req, user), req, user); },
    adminUpdateUser: function () { return withMeta_(actionAdminUpdateUser_(req, user), req, user); },
    adminResetPassword: function () { return withMeta_(actionAdminResetPassword_(req, user), req, user); },
    adminResendInvite: function () { return withMeta_(actionAdminResendInvite_(req, user), req, user); },
    adminImportUsers: function () { return withMeta_(actionAdminImportUsers_(req, user), req, user); },

    // admin — full control over the hierarchy: location -> store/car -> pos,
    // plus clusters. One generic save/delete pair per entity kind so every
    // level (including reassigning a POS device to a different driver) goes
    // through the same reviewed path.
    adminSaveEntity: function () { return withMeta_(actionAdminSaveEntity_(req, user), req, user); },
    adminDeleteEntity: function () { return withMeta_(actionAdminDeleteEntity_(req, user), req, user); },
    adminImportCustomers: function () { return withMeta_(actionAdminImportCustomers_(req, user), req, user); },
    adminImportEntities: function () { return withMeta_(actionAdminImportEntities_(req, user), req, user); },
    adminSetConfig: function () { return withMeta_(actionAdminSetConfig_(req, user), req, user); },
    adminSaveTranslation: function () { return withMeta_(actionAdminSaveTranslation_(req, user), req, user); },
    adminFillTranslations: function () { return withMeta_(actionAdminFillTranslations_(req, user), req, user); },
    // starts a fresh round of testing by archiving the movement tabs —
    // renames, never deletes (see Admin.gs)
    adminArchiveTransactions: function () { return actionAdminArchiveTransactions_(req, user); },
    // a date range, with its whole chain; previewed first, and reversible (2026-10-08)
    archiveRangePreview: function () { return actionArchiveRange_(req, user, true); },
    archiveRange: function () { return actionArchiveRange_(req, user, false); },
    archiveRestore: function () { return actionArchiveRestore_(req, user); },
    listArchiveRuns: function () { return actionListArchiveRuns_(req, user); }
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
  // after the action: a changed sign-in raises the epoch, and this device keeps its session
  result.token = renewToken_(user.id, session.hardExp, epochOf_(user));
  return result;
}

function actionLogin_(req) {
  var login = String(req.email || '').trim();
  if (!login) throw new Error('missing_email');
  var lockKey = loginKey_(login);
  if (checkLock_(lockKey)) {
    return { ok: false, error: 'locked' };
  }
  var pw = String(req.password || '').trim();
  var user = userByLogin_(login);
  if (user && user.active !== false && user.inviteStatus === 'invited' && !user.pass) {
    // no password exists until the invitation is accepted
    noteFail_(lockKey);
    return { ok: false, error: 'invite_pending' };
  }
  // A temporary password from "forgot password" works alongside the real
  // one for an hour; whichever is used first ends it.
  var viaReset = !!(user && user.active !== false && user.resetPass && Number(user.resetExpires || 0) > Date.now() &&
    !verifyPw_(pw, user.salt, user.pass) && verifyPw_(pw, user.resetSalt, user.resetPass));
  if (!user) hashPw_(pw, randomSalt_());   // the same work either way, so the timing tells nothing
  if (!user || user.active === false || (!viaReset && !verifyPw_(pw, user.salt, user.pass))) {
    noteFail_(lockKey);
    return { ok: false, error: 'invalid_credentials' };
  }
  clearFail_(lockKey);
  if (viaReset) {
    user.salt = user.resetSalt;
    user.pass = user.resetPass;
    user.mustChangePw = true;
    bumpEpoch_(user);   // whoever else was signed in is not any more
  }
  delete user.resetPass; delete user.resetSalt; delete user.resetExpires;
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
  var token = issueToken_(user.id, epochOf_(user));
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
  // an iqama sign-in has no mailbox: the admin gives a new password
  if (login.indexOf('@') < 0) return { ok: true, askAdmin: true };
  var cache = CacheService.getScriptCache();
  var throttleKey = 'fpwait_' + login.toLowerCase();
  if (cache.get(throttleKey)) return { ok: true, throttled: true };
  cache.put(throttleKey, '1', 30);
  // Anyone can call this, so it has a ceiling of its own: cycling through
  // staff addresses must not use up the day's email quota.
  var user = userByEmail_(login);
  if (!user || user.active === false) return { ok: true };
  // the ceiling counts real accounts only, so a flood of made-up addresses
  // cannot block everyone's recovery (security review 2026-10-04)
  var hourKey = 'fp_hour_' + Math.floor(Date.now() / 3600000);
  var sentThisHour = Number(cache.get(hourKey) || 0);
  if (sentThisHour >= 40) return { ok: true, throttled: true };
  cache.put(hourKey, String(sentThisHour + 1), 3600);
  if (user && user.active !== false && user.inviteStatus === 'invited') {
    // never accepted: send the invitation again rather than a temp password.
    // The link always points at the live app: this path needs no sign-in, so
    // a caller-supplied address could send the fresh token anywhere.
    var inviteToken = issueInvite_(user, null);
    writeRow(SHEETS.USERS, user);
    sendInvitation_(user, inviteToken, null, DEFAULT_APP_URL);
    logAudit_('forgot_password_reinvite', user.id, user.id);
  } else if (user && user.active !== false) {
    // The current password keeps working: a stranger asking for a reset
    // must not lock the person out. The temporary one lasts an hour.
    var temp = randomPassword_();
    var salt = randomSalt_();
    user.resetSalt = salt;
    user.resetPass = hashPw_(temp, salt);
    user.resetExpires = Date.now() + 3600000;
    writeRow(SHEETS.USERS, user);
    sendInvite_(user, temp);
    logAudit_('forgot_password_reset', user.id, user.id);
  }
  return { ok: true };
}

function actionSetLanguage_(req, user) {
  user.language = req.language === 'ar' || req.language === 'ur' ? req.language : 'en';
  user.languageChosen = true;
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
  bumpEpoch_(user);   // every other sign-in ends; this device gets a fresh token
  writeRow(SHEETS.USERS, user);
  logAudit_('change_password', user.id, null);
  return { ok: true };
}
