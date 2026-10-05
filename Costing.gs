// ---------- Costing and profitability (2026-10-01) ----------
// What each car and each store costs a month, what the branch, the area, the
// city and the head office cost on top, and from those and the day entries:
// the profit of any day or period, from the top line to the bottom line.
//
//   sales as entered                       (cash + card; credit is inside)
//   - VAT inside the prices                (setting salesIncludeVat)
//   = net sales                            top line
//   - cost of goods (qty x unit cost)
//   = GROSS MARGIN
//   - commissions and what was paid out of the takings
//   - the car's or the store's own monthly costs, day by day
//   = CONTRIBUTION MARGIN                  what the car or store itself earns
//   - branch, area, city overheads and head-office G&A
//   = NET PROFIT                           bottom line
//
// This is multi-level contribution margin accounting (profit-centre
// reporting): a cost is charged where it is caused. A car's depreciation,
// insurance and driver are the car's; the branch manager is the branch's;
// G&A is the company's. A level only ever carries its own costs in full; the
// costs of the levels above reach it as a share (by sales, by units sold, or
// equally), so the bottom line can be read at any level and still adds up.
//
// A cost is a monthly amount that runs from a month to a month (or open
// ended). Nothing is edited: a new amount ends the old line the month before
// and starts a new one, and a wrong line is voided with a reason. A day
// carries a month's cost divided by the days of that month.
var COST_GROUPS_ = ['vehicle', 'staff', 'premises', 'operations', 'admin'];
var COST_CENTRES_ = ['car', 'store', 'location', 'cluster', 'city', 'company'];
var COST_BASES_ = ['sales', 'qty', 'equal'];
var COST_ROLES_ = ['admin', 'finance', 'accountant'];
var COST_MAX_AMOUNT_ = 100000000;
var COST_GROUP_FIELD_ = { vehicle: 'fixedVehicle', staff: 'fixedStaff', premises: 'fixedPremises', operations: 'fixedOperations', admin: 'fixedAdmin' };
var COST_LEVEL_FIELD_ = { location: 'ovhLocation', cluster: 'ovhCluster', city: 'ovhCity', company: 'ovhCompany' };

// Costs and profit are read by the admin, finance and the accountant; a
// salary is in there. Only admin and finance write (requireManager_).
function costCanRead_(user) { return COST_ROLES_.indexOf(user.role) >= 0; }
function requireCostRead_(user) { if (!costCanRead_(user)) throw new Error('forbidden'); }
// prices as typed at the branches hold VAT unless the setting says otherwise
function salesIncludeVat_() { return config_().salesIncludeVat !== false; }

// ---------- months and days ----------
function costMonthOk_(m) {
  m = String(m == null ? '' : m);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m) && m >= '2020-01' && m <= '2099-12';
}
function costMonthIndex_(m) { return Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1; }
function costMonthOf_(i) { var mo = i % 12 + 1; return Math.floor(i / 12) + '-' + (mo < 10 ? '0' : '') + mo; }
function costDaysIn_(m) { return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate(); }
function costDateAdd_(d, n) { var x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function costDaysBetween_(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) + 1; }
function costR4_(n) { return Math.round(n * 10000) / 10000; }
// an amount typed as a number or plain digits, positive, not absurd
function costAmount_(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v))) return null;
  var a = Math.round(Number(v) * 100) / 100;
  return isFinite(a) && a > 0 && a <= COST_MAX_AMOUNT_ ? a : null;
}

// Many new rows in one sheet call instead of one call each: a sheet of 400
// costs took minutes row by row, with every other writer waiting on the lock.
// The caller holds the script lock.
function costAppendMany_(name, rows) {
  if (!rows.length) return [];
  var sh = sheet_(name), now = new Date().toISOString(), vals = [], out = [];
  rows.forEach(function (obj) {
    var toStore = {};
    safeOwnKeys_(obj).forEach(function (k) { toStore[k] = obj[k]; });
    if (!toStore.id) toStore.id = Utilities.getUuid();
    toStore.updatedAt = now;
    vals.push([toStore.id, JSON.stringify(toStore), now]);
    out.push(toStore);
  });
  var first = sh.getLastRow() + 1;
  // a real sheet has a fixed grid: make room before writing past its end
  if (sh.getMaxRows && first + vals.length - 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), first + vals.length - 1 - sh.getMaxRows());
  sh.getRange(first, 1, vals.length, 3).setValues(vals);
  bumpVersion_(name);
  return out;
}

// ---------- cost types: the catalogue (entity kind cost_type) ----------
// [Arabic name, group, nature, English, Urdu, depreciation]
var COST_TYPE_SEED_ = [
  ['استهلاك المركبة', 'vehicle', 'fixed', 'Vehicle depreciation', 'گاڑی کی فرسودگی', true],
  ['إيجار أو تمويل المركبة', 'vehicle', 'fixed', 'Vehicle lease or financing', 'گاڑی کا کرایہ یا فنانسنگ'],
  ['تأمين المركبة', 'vehicle', 'fixed', 'Vehicle insurance', 'گاڑی کا بیمہ'],
  ['الاستمارة ورخصة السير', 'vehicle', 'fixed', 'Vehicle registration (Istimara)', 'گاڑی کی رجسٹریشن'],
  ['الفحص الدوري', 'vehicle', 'fixed', 'Periodic inspection', 'گاڑی کا معائنہ'],
  ['بطاقة التشغيل', 'vehicle', 'fixed', 'Operating card', 'آپریٹنگ کارڈ'],
  ['وقود', 'vehicle', 'variable', 'Fuel', 'ایندھن'],
  ['صيانة وإصلاح المركبة', 'vehicle', 'variable', 'Vehicle maintenance and repairs', 'گاڑی کی مرمت'],
  ['إطارات', 'vehicle', 'variable', 'Tyres', 'ٹائر'],
  ['زيوت وفلاتر', 'vehicle', 'variable', 'Oil and filters', 'تیل اور فلٹر'],
  ['تتبع المركبات', 'vehicle', 'fixed', 'Vehicle tracking', 'گاڑی کی ٹریکنگ'],
  ['مخالفات مرورية', 'vehicle', 'variable', 'Traffic fines', 'ٹریفک جرمانے'],
  ['غسيل ونظافة المركبة', 'vehicle', 'variable', 'Vehicle washing', 'گاڑی کی دھلائی'],
  ['راتب أساسي', 'staff', 'fixed', 'Basic salary', 'بنیادی تنخواہ'],
  ['بدل سكن', 'staff', 'fixed', 'Housing allowance', 'رہائش الاؤنس'],
  ['بدل نقل', 'staff', 'fixed', 'Transport allowance', 'ٹرانسپورٹ الاؤنس'],
  ['بدلات أخرى', 'staff', 'fixed', 'Other allowances', 'دیگر الاؤنسز'],
  ['عمل إضافي', 'staff', 'variable', 'Overtime', 'اوور ٹائم'],
  ['حوافز وعمولات', 'staff', 'variable', 'Incentives and commissions', 'مراعات اور کمیشن'],
  ['التأمينات الاجتماعية', 'staff', 'fixed', 'Social insurance (GOSI)', 'سوشل انشورنس'],
  ['تأمين طبي', 'staff', 'fixed', 'Medical insurance', 'طبی بیمہ'],
  ['الإقامة ورخصة العمل', 'staff', 'fixed', 'Iqama and work permit', 'اقامہ اور ورک پرمٹ'],
  ['مكافأة نهاية الخدمة', 'staff', 'fixed', 'End of service benefit', 'اختتام ملازمت کا معاوضہ'],
  ['إجازات وتذاكر سفر', 'staff', 'fixed', 'Vacation and air tickets', 'چھٹیاں اور سفری ٹکٹ'],
  ['سكن العمال', 'staff', 'fixed', 'Staff accommodation', 'عملے کی رہائش'],
  ['زي موحد ومعدات سلامة', 'staff', 'variable', 'Uniforms and safety gear', 'یونیفارم اور حفاظتی سامان'],
  ['إيجار المحل', 'premises', 'fixed', 'Shop rent', 'دکان کا کرایہ'],
  ['كهرباء', 'premises', 'variable', 'Electricity', 'بجلی'],
  ['مياه', 'premises', 'variable', 'Water', 'پانی'],
  ['اتصالات وإنترنت', 'premises', 'fixed', 'Telecom and internet', 'ٹیلی کام اور انٹرنیٹ'],
  ['رخصة البلدية', 'premises', 'fixed', 'Municipality licence', 'بلدیہ لائسنس'],
  ['رخصة الدفاع المدني', 'premises', 'fixed', 'Civil defence licence', 'سول ڈیفنس لائسنس'],
  ['صيانة المبنى', 'premises', 'variable', 'Building maintenance', 'عمارت کی مرمت'],
  ['نظافة وحراسة', 'premises', 'fixed', 'Cleaning and security', 'صفائی اور سیکیورٹی'],
  ['تأمين المحل', 'premises', 'fixed', 'Premises insurance', 'دکان کا بیمہ'],
  ['استهلاك تجهيزات المحل', 'premises', 'fixed', 'Depreciation of shop fittings', 'دکان کے سامان کی فرسودگی', true],
  ['رسوم أجهزة نقاط البيع', 'operations', 'fixed', 'POS device fees', 'پی او ایس مشین فیس'],
  ['رسوم بنكية', 'operations', 'variable', 'Bank charges', 'بینک چارجز'],
  ['مطبوعات وقرطاسية', 'operations', 'variable', 'Printing and stationery', 'چھپائی اور اسٹیشنری'],
  ['مصاريف تشغيلية أخرى', 'operations', 'variable', 'Other operating costs', 'دیگر آپریٹنگ اخراجات'],
  ['رواتب الإدارة العامة', 'admin', 'fixed', 'Head office salaries', 'ہیڈ آفس تنخواہیں'],
  ['إيجار المكتب الرئيسي', 'admin', 'fixed', 'Head office rent', 'ہیڈ آفس کا کرایہ'],
  ['أنظمة وبرامج', 'admin', 'fixed', 'Software and systems', 'سافٹ ویئر اور سسٹمز'],
  ['أتعاب مهنية وقانونية', 'admin', 'fixed', 'Professional and legal fees', 'پیشہ ورانہ اور قانونی فیس'],
  ['رسوم حكومية وتراخيص', 'admin', 'fixed', 'Government fees and licences', 'سرکاری فیس اور لائسنس'],
  ['تسويق وإعلان', 'admin', 'variable', 'Marketing and advertising', 'مارکیٹنگ اور اشتہارات'],
  ['مصاريف إدارية أخرى', 'admin', 'variable', 'Other general and administrative costs', 'دیگر انتظامی اخراجات']
];
// The starting catalogue, written once. A name already there is left alone,
// and the English and Urdu come with it so nothing waits on a translation.
function seedCostTypes_() {
  var n = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    var have = Object.create(null), seq = Number(PropertiesService.getScriptProperties().getProperty('SEQ_cost_type') || 0);
    readSheet(SHEETS.COST_TYPES).forEach(function (r) {
      have[normalizeName_(r.name)] = true;
      var m = /^CST-(\d+)$/.exec(String(r.code || ''));
      if (m && Number(m[1]) > seq) seq = Number(m[1]);
    });
    var idx = translationIndex_(), types = [], words = [];
    COST_TYPE_SEED_.forEach(function (s) {
      if (have[normalizeName_(s[0])]) return;
      seq++;
      var code = String(seq); while (code.length < 4) code = '0' + code;
      var row = { id: Utilities.getUuid(), active: true, name: s[0], group: s[1], nature: s[2], code: 'CST-' + code };
      if (s[5]) row.depreciation = true;
      types.push(row);
      if (!hasOwn_(idx, s[0])) words.push({ src: s[0], en: s[3], ur: s[4], auto: false });
      n++;
    });
    if (types.length) { costAppendMany_(SHEETS.COST_TYPES, types); setScriptProp_('SEQ_cost_type', String(seq)); }
    costAppendMany_(SHEETS.TRANSLATIONS, words);
  } finally { try { lock.releaseLock(); } catch (e) {} }
  return n;
}
function seedCostTypesOnce_() { runOnce_('SEEDED_COST_TYPES', seedCostTypes_); }

// ---------- a product's unit cost over time ----------
// saveEntity_ calls this when a product's unit cost changes: the sales made
// before today keep the cost they were sold at. The first change also writes
// the cost that stood until then.
function noteProductCost_(saved, before, userId) {
  if (before == null) return;                       // a new product: its cost is simply its cost
  var now = Number(saved.unitCost || 0), was = Number(before || 0);
  if (was === now) return;
  productCostFrom_(saved.id, was, now, todayRiyadh_(), userId);
}
// The cost from a date on. Records dated that day or later are superseded
// (kept, marked voided), so a correction can reach back and a second change
// on one day replaces the first; the first change of all also writes the
// cost that stood until then.
function productCostFrom_(productId, was, now, from, userId) {
  var at = new Date().toISOString(), kept = 0;
  readSheet(SHEETS.PRODUCT_COSTS).forEach(function (r) {
    if (r.productId !== productId || r.voided) return;
    if (String(r.from) >= from) { r.voided = true; r.voidedAt = at; r.voidedBy = userId; writeRow(SHEETS.PRODUCT_COSTS, r); }
    else kept++;
  });
  if (!kept && was > 0 && from > '2000-01-01') writeRow(SHEETS.PRODUCT_COSTS, { productId: productId, unitCost: was, from: '2000-01-01', at: at, by: userId });
  writeRow(SHEETS.PRODUCT_COSTS, { productId: productId, unitCost: now, from: from, at: at, by: userId });
}
// A unit cost that applies from a date (today, or earlier to correct what
// was typed wrong). It becomes the product's cost; the sales before that
// date keep the cost that stood then.
function actionSetProductCost_(req, user) {
  requireManager_(user);
  var from = String(req.from == null ? '' : req.from), cost = Number(req.unitCost);
  if (typeof req.unitCost !== 'number' && !(typeof req.unitCost === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(req.unitCost))) return { ok: false, error: 'invalid_cost' };
  if (!isFinite(cost) || cost < 0 || cost > COST_MAX_AMOUNT_) return { ok: false, error: 'invalid_cost' };
  if (!invDateOk_(from)) return { ok: false, error: 'invalid_date' };
  if (from > todayRiyadh_()) return { ok: false, error: 'future_date' };
  // a cost applies from today on; reaching back re-costs sales already made, so
  // it is a correction and must say why (the user, 2026-10-04)
  var reason = String(req.reason || '').trim().slice(0, 300);
  if (from < todayRiyadh_() && !reason) return { ok: false, error: 'past_needs_reason' };
  cost = Math.round(cost * 10000) / 10000;
  return costLocked_(function () {
    var p = getById_(SHEETS.PRODUCTS, req.productId);
    if (!p) return { ok: false, error: 'not_found' };
    if (p.type === 'services') return { ok: false, error: 'not_inventory' };
    var was = Number(p.unitCost || 0), pBefore = JSON.parse(JSON.stringify(p));
    productCostFrom_(p.id, was, cost, from, user.id);
    p.unitCost = cost;
    p = writeRow(SHEETS.PRODUCTS, p);
    rateChanges_('product', pBefore, p, user.id, { fromDate: from, reason: reason, via: 'set_cost' });
    logAudit_('product_cost_set', user.id, p.id + ' ' + cost + ' ' + from + (reason ? ' (' + reason + ')' : ''));
    return { ok: true, product: p, history: readSheet(SHEETS.PRODUCT_COSTS).filter(function (r) { return r.productId === p.id && !r.voided; }) };
  });
}
function costHistory_() {
  var h = Object.create(null);     // keyed by record ids: never a plain object (CLAUDE.md trap 4)
  readSheet(SHEETS.PRODUCT_COSTS).forEach(function (r) { if (!r.voided) (h[r.productId] = h[r.productId] || []).push(r); });
  Object.keys(h).forEach(function (k) {
    h[k].sort(function (a, b) { return String(a.from).localeCompare(String(b.from)) || String(a.at).localeCompare(String(b.at)); });
  });
  return h;
}
// ---------- an inventory item's costs over time (LPG Task 1b, 2026-10-05) ----------
// A cylinder item has a gas cost (filling one) and a cylinder cost (the empty
// body); a unit item a unit cost. Each is dated in product_costs under
// `stk:<id>#gas|cyl|unit`, so a change never re-costs a day already sold.
var STK_COST_FIELDS_ = { gasCost: 'gas', cylinderCost: 'cyl', unitCost: 'unit' };
function stockCostKey_(id, field) { return 'stk:' + id + '#' + STK_COST_FIELDS_[field]; }
function stockItemsById_() { var m = Object.create(null); readSheet(SHEETS.STOCK_ITEMS).forEach(function (s) { m[s.id] = s; }); return m; }
// one cost of an item on a day: the record in force (known), else the first
// record (a day older than every record), else the item's own figure
function stockItemCostOn_(it, field, date, hist) {
  hist = hist || costHistory_();
  var list = hist[stockCostKey_(it.id, field)];
  if (list && list.length) {
    var v = null;
    for (var i = 0; i < list.length; i++) if (String(list[i].from) <= date) v = Number(list[i].unitCost || 0);
    if (v != null) return { v: v, known: true };
    return { v: Number(list[0].unitCost || 0), known: false };
  }
  return { v: Number(it[field] || 0), known: false };
}
// A cost from a date on: records dated that day or later are superseded (kept,
// voided). The first change also writes the cost that stood until then: since
// the item was created, or for an item made by the setup, since the setup day
// (the days before it keep the sales items' own cost history).
function stockItemCostFrom_(it, field, was, now, from, userId) {
  var key = stockCostKey_(it.id, field), at = new Date().toISOString(), kept = 0;
  readSheet(SHEETS.PRODUCT_COSTS).forEach(function (r) {
    if (r.productId !== key || r.voided) return;
    if (String(r.from) >= from) { r.voided = true; r.voidedAt = at; r.voidedBy = userId; writeRow(SHEETS.PRODUCT_COSTS, r); }
    else kept++;
  });
  var wasFrom = it.fromSetup && it.since ? String(it.since) : '2000-01-01';
  if (!kept && wasFrom < from && (was > 0 || it.fromSetup)) writeRow(SHEETS.PRODUCT_COSTS, { productId: key, stockItemId: it.id, field: field, unitCost: was, from: wasFrom, at: at, by: userId });
  writeRow(SHEETS.PRODUCT_COSTS, { productId: key, stockItemId: it.id, field: field, unitCost: now, from: from, at: at, by: userId });
}
// saveEntity_ calls this when an item's costs change: from today on
function noteStockItemCost_(saved, before, userId) {
  if (!before) return;
  Object.keys(STK_COST_FIELDS_).forEach(function (f) {
    var was = Number(before[f] || 0), now = Number(saved[f] || 0);
    if (was !== now) stockItemCostFrom_(saved, f, was, now, todayRiyadh_(), userId);
  });
}
// A cost of an inventory item from a date (a past date corrects, with a reason)
function actionSetStockItemCost_(req, user) {
  requireManager_(user);
  var field = String(req.field || ''), from = String(req.from == null ? '' : req.from), cost = Number(req.cost);
  if (!hasOwn_(STK_COST_FIELDS_, field)) return { ok: false, error: 'invalid_cost' };
  if (typeof req.cost !== 'number' && !(typeof req.cost === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(req.cost))) return { ok: false, error: 'invalid_cost' };
  if (!isFinite(cost) || cost < 0 || cost > COST_MAX_AMOUNT_) return { ok: false, error: 'invalid_cost' };
  if (!invDateOk_(from)) return { ok: false, error: 'invalid_date' };
  if (from > todayRiyadh_()) return { ok: false, error: 'future_date' };
  var reason = String(req.reason || '').trim().slice(0, 300);
  if (from < todayRiyadh_() && !reason) return { ok: false, error: 'past_needs_reason' };
  cost = Math.round(cost * 10000) / 10000;
  return costLocked_(function () {
    var it = getById_(SHEETS.STOCK_ITEMS, req.stockItemId);
    if (!it) return { ok: false, error: 'not_found' };
    if ((it.kind === 'cylinder') !== (field !== 'unitCost')) return { ok: false, error: 'invalid_cost' };
    var before = JSON.parse(JSON.stringify(it));
    stockItemCostFrom_(it, field, Number(it[field] || 0), cost, from, user.id);
    it[field] = cost;
    it = writeRow(SHEETS.STOCK_ITEMS, it);
    rateChanges_('stock_item', before, it, user.id, { fromDate: from, reason: reason, via: 'set_cost' });
    logAudit_('stock_item_cost_set', user.id, it.id + ' ' + field + ' ' + cost + ' ' + from + (reason ? ' (' + reason + ')' : ''));
    var keys = Object.keys(STK_COST_FIELDS_).map(function (f) { return stockCostKey_(it.id, f); });
    return { ok: true, stockItem: it, history: readSheet(SHEETS.PRODUCT_COSTS).filter(function (r) { return keys.indexOf(r.productId) >= 0 && !r.voided; }) };
  });
}

// What one unit of a sales item cost on a day. Once the inventory items are
// set up, it comes from the item and the effect, dated: exchange = gas (+ the
// cylinder going out - the one coming back, floored at 0, for another type),
// sell_empty = cylinder, sell_full = gas + cylinder, unit = unit cost. On a day
// the item has no record for yet, the sales item's own cost history (the old
// way, below) still decides, so profit for past days does not move.
function costOfProduct_(p, date, hist, byId, items) {
  if (!p || !p.stockItemId || !stockItemsLive_()) return legacyCostOfProduct_(p, date, hist, byId);
  items = items || stockItemsById_();
  var it = items[p.stockItemId];
  if (!it) return legacyCostOfProduct_(p, date, hist, byId);
  hist = hist || costHistory_();
  var cyl = it.kind === 'cylinder';
  var eff = cyl ? (['exchange', 'sell_empty', 'sell_full'].indexOf(p.stockEffect) >= 0 ? p.stockEffect : 'exchange') : 'unit';
  var back = eff === 'exchange' && p.returnItemId && items[p.returnItemId] && items[p.returnItemId].kind === 'cylinder' && p.returnItemId !== it.id ? items[p.returnItemId] : null;
  var parts = eff === 'unit' ? [[it, 'unitCost', 1]] : eff === 'sell_empty' ? [[it, 'cylinderCost', 1]] : eff === 'sell_full' ? [[it, 'gasCost', 1], [it, 'cylinderCost', 1]]
    : back ? [[it, 'gasCost', 1], [it, 'cylinderCost', 1], [back, 'cylinderCost', -1]] : [[it, 'gasCost', 1]];
  var vals = parts.map(function (x) { return stockItemCostOn_(x[0], x[1], date, hist); });
  var sum = 0; vals.forEach(function (v, i) { sum += v.v * parts[i][2]; });
  // a downgrade swap (dearer cylinder taken back) never books a negative cost
  sum = Math.max(0, Math.round(sum * 10000) / 10000);
  if (vals.some(function (v) { return v.known; })) return sum;
  var legacyInputs = (hist[p.id] && hist[p.id].length) || Number(p.unitCost || 0) > 0 || (p.stockOf && byId && byId[p.stockOf]);
  if (legacyInputs) {
    var l = legacyCostOfProduct_(p, date, hist, byId || Object.create(null));
    if (l > 0 || (it.since && date < String(it.since))) return l;
  }
  return sum;
}
// what one unit cost on a day, the old way: the history when there is one (a
// sale older than the first record takes the first cost known), else the
// product's own cost, else the cost of the product it draws from
function legacyCostOfProduct_(p, date, hist, byId) {
  hist = hist || Object.create(null); byId = byId || Object.create(null);
  var list = hist[p.id], own = Number(p.unitCost || 0);
  if (list && list.length) {
    var c = Number(list[0].unitCost || 0);
    for (var i = 0; i < list.length; i++) if (list[i].from <= date) c = Number(list[i].unitCost || 0);
    if (c > 0) return c;
    own = 0;                       // the history says "no cost of its own" for that day: the stock item's applies
  }
  if (own > 0) return own;
  var a = p.stockOf ? byId[p.stockOf] : null;
  if (a && a.id !== p.id) {
    if (p.stockEffect === 'sell_empty') return Number(a.emptyCost || 0);
    var gas = legacyCostOfProduct_(a, date, hist, Object.create(null));
    // an exchange that takes back another cylinder type: the customer leaves with this
    // type's cylinder and the branch keeps theirs, so the difference of the two is a cost
    var back = p.stockEffect === 'exchange' && p.returnOf ? byId[p.returnOf] : null;
    // floored at 0: a downgrade swap (dearer cylinder taken back) must not book a negative cost
    if (back && back.id !== a.id) return Math.max(0, gas + Number(a.emptyCost || 0) - Number(back.emptyCost || 0));
    // a full cylinder sold outright leaves with its cylinder; an exchange keeps it
    return p.stockEffect === 'sell_full' ? gas + Number(a.emptyCost || 0) : gas;
  }
  return 0;
}

// ---------- cost lines ----------
// the place a cost is charged to, or null
function costCentre_(type, id) {
  if (COST_CENTRES_.indexOf(type) < 0) return null;
  if (type === 'company') return { type: 'company', id: 'company' };
  if (type === 'city') {
    var key = normalizeName_(String(id == null ? '' : id));
    if (!key) return null;
    var loc = readSheet(SHEETS.LOCATIONS).filter(function (l) { return l.city && normalizeName_(l.city) === key; })[0];
    if (loc) return { type: 'city', id: loc.city };
    var city = readSheet(SHEETS.CITIES).filter(function (c) { return c.name && normalizeName_(c.name) === key; })[0];
    return city ? { type: 'city', id: city.name } : null;
  }
  var sheet = { car: SHEETS.CARS, store: SHEETS.STORES, location: SHEETS.LOCATIONS, cluster: SHEETS.CLUSTERS }[type];
  var row = getById_(sheet, id);
  return row ? { type: type, id: row.id } : null;
}
// one line's fields checked and normalised
function costCheckLine_(r) {
  r = r || {};
  var centre = costCentre_(String(r.centreType || ''), r.centreId);
  if (!centre) return { error: 'invalid_centre' };
  var type = getById_(SHEETS.COST_TYPES, r.typeId);
  if (!type || type.active === false) return { error: 'invalid_type' };
  var from = String(r.fromMonth == null ? '' : r.fromMonth);
  if (!costMonthOk_(from)) return { error: 'invalid_month' };
  var oneOff = r.oneOff === true;
  var to = oneOff ? from : (r.toMonth == null || r.toMonth === '' ? null : String(r.toMonth));
  if (to != null && (!costMonthOk_(to) || to < from)) return { error: 'invalid_month' };
  var amount, asset = null;
  if (r.asset != null && r.asset !== '') {
    // depreciation, straight line: (cost - what it will sell for) / months of use
    if (typeof r.asset !== 'object' || Array.isArray(r.asset)) return { error: 'invalid_input' };
    var cost = costAmount_(r.asset.cost), life = Number(r.asset.lifeMonths);
    var residual = r.asset.residual == null || r.asset.residual === '' ? 0 : Number(r.asset.residual);
    if (cost == null || !isFinite(residual) || residual < 0 || residual >= cost || !(life >= 1 && life <= 600) || Math.floor(life) !== life) return { error: 'invalid_asset' };
    amount = Math.round((cost - residual) / life * 100) / 100;
    if (!(amount > 0)) return { error: 'invalid_asset' };
    asset = { cost: cost, residual: Math.round(residual * 100) / 100, lifeMonths: life };
    var last = costMonthIndex_(from) + life - 1;
    if (last > costMonthIndex_('2099-12')) return { error: 'invalid_month' };
    to = costMonthOf_(last); oneOff = false;
  } else {
    amount = costAmount_(r.amount);
    if (amount == null) return { error: 'amount_required' };
  }
  var emp = null;
  if (r.employeeUserId) {
    var u = getById_(SHEETS.USERS, r.employeeUserId);
    if (!u) return { error: 'invalid_input' };
    emp = u.id;
  }
  return { line: {
    centreType: centre.type, centreId: centre.id, typeId: type.id, amount: amount, fromMonth: from, toMonth: to, oneOff: oneOff,
    label: String(r.label == null ? '' : r.label).replace(/\s+/g, ' ').trim().slice(0, 80), employeeUserId: emp, asset: asset,
    note: String(r.note == null ? '' : r.note).slice(0, 300)
  } };
}
// what tells two lines of one type on one place apart: a label or a person
function costLineKey_(l) { return [l.centreType, l.centreId, l.typeId, normalizeName_(l.label || ''), l.employeeUserId || ''].join('|'); }
function costActiveIn_(l, m) { return l.fromMonth <= m && (l.toMonth == null || l.toMonth >= m); }
// the same line twice, or two running lines of one type that overlap
function costClash_(line, lines) {
  var key = costLineKey_(line);
  for (var i = 0; i < lines.length; i++) {
    var x = lines[i];
    if (x.voided || costLineKey_(x) !== key) continue;
    if (x.fromMonth === line.fromMonth && (x.toMonth || null) === (line.toMonth || null) && Number(x.amount) === line.amount) return 'duplicate_line';
    if (x.oneOff || line.oneOff) continue;
    var endsX = x.toMonth || '9999-12', endsL = line.toMonth || '9999-12';
    if (x.fromMonth <= endsL && line.fromMonth <= endsX) return 'overlap_line';
  }
  return null;
}
function costRow_(line, user, extra) {
  var row = { id: Utilities.getUuid(), voided: false, createdBy: user.id, createdAt: new Date().toISOString() };
  safeOwnKeys_(line).forEach(function (k) { row[k] = line[k]; });
  safeOwnKeys_(extra || {}).forEach(function (k) { row[k] = extra[k]; });
  return row;
}
function costWrite_(line, user, extra) { return costAppendMany_(SHEETS.COST_LINES, [costRow_(line, user, extra)])[0]; }
function costLocked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { freshenExec_(); return fn(); } finally { try { lock.releaseLock(); } catch (e) {} }
}

function actionListCosts_(req, user) {
  requireCostRead_(user);
  var lines = readSheet(SHEETS.COST_LINES);
  if (!req.includeVoided) lines = lines.filter(function (l) { return !l.voided; });
  return { ok: true, types: readSheet(SHEETS.COST_TYPES), lines: lines, productCosts: readSheet(SHEETS.PRODUCT_COSTS).filter(function (r) { return !r.voided; }) };
}

function actionSaveCostLine_(req, user) {
  requireManager_(user);
  var c = costCheckLine_(req);
  if (c.error) return { ok: false, error: c.error };
  return costLocked_(function () {
    var clash = costClash_(c.line, readSheet(SHEETS.COST_LINES));
    if (clash) return { ok: false, error: clash };
    var line = costWrite_(c.line, user);
    logAudit_('cost_line_add', user.id, line.id);
    return { ok: true, line: line };
  });
}

// A new amount from a month on: the old line ends the month before and a new
// one starts, so the months already reported keep their figures. From the
// line's own first month it is a correction: the old line is voided.
function costChange_(old, fromMonth, amount, user, batch) {
  var next = { centreType: old.centreType, centreId: old.centreId, typeId: old.typeId, amount: amount, fromMonth: fromMonth, toMonth: old.toMonth || null,
    oneOff: false, label: old.label || '', employeeUserId: old.employeeUserId || null, asset: null, note: old.note || '' };
  var now = new Date().toISOString();
  if (fromMonth === old.fromMonth) {
    old.voided = true; old.voidReason = 'replaced'; old.voidedBy = user.id; old.voidedAt = now;
  } else {
    old.toMonth = costMonthOf_(costMonthIndex_(fromMonth) - 1); old.endedBy = user.id; old.endedAt = now;
  }
  var ended = writeRow(SHEETS.COST_LINES, old);
  if (batch) { batch.push(costRow_(next, user, { replaces: old.id })); return { ended: ended, line: null }; }
  var line = costWrite_(next, user, { replaces: old.id });
  return { ended: ended, line: line };
}
function actionChangeCostLine_(req, user) {
  requireManager_(user);
  var from = String(req.fromMonth == null ? '' : req.fromMonth), amount = costAmount_(req.amount);
  if (!costMonthOk_(from)) return { ok: false, error: 'invalid_month' };
  if (amount == null) return { ok: false, error: 'amount_required' };
  return costLocked_(function () {
    var old = getById_(SHEETS.COST_LINES, req.id);
    if (!old) return { ok: false, error: 'not_found' };
    if (old.voided) return { ok: false, error: 'already_voided' };
    // depreciation follows its asset and a one-month cost is one month: void and enter again
    if (old.asset || old.oneOff) return { ok: false, error: 'line_fixed' };
    if (from < old.fromMonth || (old.toMonth && from > old.toMonth)) return { ok: false, error: 'invalid_month' };
    if (amount === Number(old.amount)) return { ok: false, error: 'duplicate_line' };
    var res = costChange_(old, from, amount, user);
    logAudit_('cost_line_change', user.id, old.id + ' → ' + res.line.id + ' (' + from + ')');
    return { ok: true, line: res.line, ended: res.ended };
  });
}

function actionEndCostLine_(req, user) {
  requireManager_(user);
  var to = String(req.toMonth == null ? '' : req.toMonth);
  if (!costMonthOk_(to)) return { ok: false, error: 'invalid_month' };
  return costLocked_(function () {
    var line = getById_(SHEETS.COST_LINES, req.id);
    if (!line) return { ok: false, error: 'not_found' };
    if (line.voided) return { ok: false, error: 'already_voided' };
    // a one-month cost is its month: void it and enter it again
    if (line.oneOff) return { ok: false, error: 'line_fixed' };
    if (to < line.fromMonth) return { ok: false, error: 'invalid_month' };
    // an ended line may stop earlier, never run on past its end unless nothing
    // else of its kind runs there; depreciation never outlives its asset
    if (line.toMonth && to > line.toMonth) {
      if (line.asset) return { ok: false, error: 'invalid_month' };
      var longer = {}; safeOwnKeys_(line).forEach(function (k) { longer[k] = line[k]; }); longer.toMonth = to; longer.amount = Number(line.amount);
      var clash = costClash_(longer, readSheet(SHEETS.COST_LINES).filter(function (l) { return l.id !== line.id; }));
      if (clash) return { ok: false, error: 'overlap_line' };
    }
    line.toMonth = to; line.endedBy = user.id; line.endedAt = new Date().toISOString();
    line = writeRow(SHEETS.COST_LINES, line);
    logAudit_('cost_line_end', user.id, line.id + ' ' + to);
    return { ok: true, line: line };
  });
}

function actionVoidCostLine_(req, user) {
  requireManager_(user);
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required' };
  return costLocked_(function () {
    var line = getById_(SHEETS.COST_LINES, req.id);
    if (!line) return { ok: false, error: 'not_found' };
    if (line.voided) return { ok: false, error: 'already_voided' };
    line.voided = true; line.voidReason = reason.slice(0, 300); line.voidedBy = user.id; line.voidedAt = new Date().toISOString();
    line = writeRow(SHEETS.COST_LINES, line);
    logAudit_('cost_line_void', user.id, line.id);
    return { ok: true, line: line };
  });
}

// A sheet of costs for one month, all or nothing. A row whose running line is
// already there with the same amount is skipped, with another amount it is a
// change from that month, so the same sheet can go in again without harm.
function actionImportCostLines_(req, user) {
  requireManager_(user);
  var month = String(req.month == null ? '' : req.month), oneOff = req.oneOff === true;
  if (!costMonthOk_(month)) return { ok: false, error: 'invalid_month' };
  var rows = Array.isArray(req.rows) ? req.rows : null;
  if (!rows || !rows.length || rows.length > 500) return { ok: false, error: 'invalid_input' };
  var checked = [], seen = Object.create(null);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var c = costCheckLine_({ centreType: r.centreType, centreId: r.centreId, typeId: r.typeId, amount: r.amount, fromMonth: month, oneOff: oneOff,
      label: r.label, employeeUserId: r.employeeUserId, note: r.note });
    if (c.error) return { ok: false, error: c.error, index: i };
    var k = costLineKey_(c.line);
    if (seen[k]) return { ok: false, error: 'duplicate_line', index: i };
    seen[k] = true;
    checked.push(c.line);
  }
  return costLocked_(function () {
    // every line's key worked out once: by its full key, and by place and type alone
    var byKey = Object.create(null), byType = Object.create(null), claimed = Object.create(null);
    readSheet(SHEETS.COST_LINES).forEach(function (l) {
      if (l.voided) return;
      var k = costLineKey_(l), tk = [l.centreType, l.centreId, l.typeId].join('|');
      (byKey[k] = byKey[k] || []).push(l); (byType[tk] = byType[tk] || []).push(l);
    });
    var plan = [];
    for (var j = 0; j < checked.length; j++) {
      var line = checked[j], key = costLineKey_(line);
      var same = byKey[key] || [];
      if (oneOff) {
        // the same one-month cost again is skipped; with another amount it replaces the first
        var ones = same.filter(function (l) { return l.oneOff && l.fromMonth === month; });
        if (ones.length > 1) return { ok: false, error: 'duplicate_line', index: j };
        if (!ones.length) plan.push({ add: line });
        else if (Number(ones[0].amount) === line.amount) plan.push({ skip: true });
        else plan.push({ replace: ones[0], add: line });
        continue;
      }
      var running = same.filter(function (l) { return !l.oneOff && costActiveIn_(l, month); })[0];
      if (!running && !line.label && !line.employeeUserId) {
        // A sheet row carries no label: it speaks for the one running line of
        // its type on that place, whatever label or person that line carries.
        // Two or more and the row cannot say which it means.
        var cand = (byType[[line.centreType, line.centreId, line.typeId].join('|')] || []).filter(function (l) { return !l.oneOff && costActiveIn_(l, month); });
        if (cand.length > 1) return { ok: false, error: 'overlap_line', index: j };
        running = cand[0];
      }
      if (running) {
        if (claimed[running.id]) return { ok: false, error: 'duplicate_line', index: j };
        claimed[running.id] = true;
        if (Number(running.amount) === line.amount) { plan.push({ skip: true }); continue; }
        if (running.asset) return { ok: false, error: 'invalid_input', index: j };
        plan.push({ change: running, amount: line.amount });
        continue;
      }
      // a line of the same kind starting later: this one runs up to it
      var later = same.filter(function (l) { return !l.oneOff && l.fromMonth > month; }).map(function (l) { return l.fromMonth; }).sort()[0];
      if (later) line.toMonth = costMonthOf_(costMonthIndex_(later) - 1);
      plan.push({ add: line });
    }
    // the old lines are closed one by one; every new row goes in one sheet call
    var created = 0, changed = 0, skipped = 0, batch = [], now = new Date().toISOString();
    plan.forEach(function (p) {
      if (p.skip) { skipped++; return; }
      if (p.replace) {
        p.replace.voided = true; p.replace.voidReason = 'replaced'; p.replace.voidedBy = user.id; p.replace.voidedAt = now;
        writeRow(SHEETS.COST_LINES, p.replace);
        batch.push(costRow_(p.add, user, { imported: true, replaces: p.replace.id })); changed++; return;
      }
      if (p.add) { batch.push(costRow_(p.add, user, { imported: true })); created++; return; }
      costChange_(p.change, month, p.amount, user, batch); changed++;
    });
    var written = costAppendMany_(SHEETS.COST_LINES, batch);
    logAudit_('cost_lines_import', user.id, month + ' +' + created + ' ~' + changed + ' =' + skipped);
    return { ok: true, created: created, changed: changed, skipped: skipped, lines: written };
  });
}

// ---------- where things sit ----------
// The store or car a day entry belongs to: a POS machine's day is its
// owner's. Anything that cannot be placed stays on its branch ('none').
function costUnitOf_(e, posById, known) {
  var k = null;
  if (e.sourceType === 'store' || e.sourceType === 'car') k = e.sourceType + ':' + e.sourceId;
  else if (e.sourceType === 'pos') {
    var p = posById[e.sourceId];
    if (p && (p.ownerType === 'store' || p.ownerType === 'car') && p.ownerId) k = p.ownerType + ':' + p.ownerId;
  }
  return k && known[k] ? k : 'none:' + (e.locationId || '');
}
function costMaps_() {
  var m = { locById: Object.create(null), posById: posById_(), unitLoc: Object.create(null), unitRow: Object.create(null) };
  readSheet(SHEETS.LOCATIONS).forEach(function (l) { m.locById[l.id] = l; });
  readSheet(SHEETS.STORES).forEach(function (s) { m.unitLoc['store:' + s.id] = s.locationId; m.unitRow['store:' + s.id] = s; });
  readSheet(SHEETS.CARS).forEach(function (c) { m.unitLoc['car:' + c.id] = c.locationId; m.unitRow['car:' + c.id] = c; });
  return m;
}

// ---------- the monthly expenses report ----------
// Every cost line month by month, with the branch, area and city it sits
// under, plus what the day entries show was paid out of the takings and the
// commissions paid, so "all monthly expenses" really is all of them.
function actionCostReport_(req, user) {
  requireCostRead_(user);
  var mf = String(req.monthFrom == null ? '' : req.monthFrom), mt = String(req.monthTo == null ? '' : req.monthTo);
  if (!costMonthOk_(mf) || !costMonthOk_(mt) || mf > mt) return { ok: false, error: 'invalid_period' };
  var a = costMonthIndex_(mf), b = costMonthIndex_(mt);
  if (b - a + 1 > 36) return { ok: false, error: 'period_too_long' };
  var months = [];
  for (var i = a; i <= b; i++) months.push(costMonthOf_(i));
  var maps = costMaps_(), typeById = Object.create(null);
  readSheet(SHEETS.COST_TYPES).forEach(function (t) { typeById[t.id] = t; });
  function place(row) {
    var locId = row.centreType === 'location' ? row.centreId : (row.centreType === 'car' || row.centreType === 'store') ? maps.unitLoc[row.centreType + ':' + row.centreId] : null;
    var loc = locId ? maps.locById[locId] : null;
    row.locationId = loc ? loc.id : null;
    row.clusterId = loc ? (loc.clusterId || null) : row.centreType === 'cluster' ? row.centreId : null;
    row.city = loc ? (loc.city || null) : row.centreType === 'city' ? row.centreId : null;
    return row;
  }
  var rows = [];
  readSheet(SHEETS.COST_LINES).forEach(function (l) {
    if (l.voided) return;
    var amounts = months.map(function (m) { return costActiveIn_(l, m) ? Number(l.amount) : 0; });
    var total = amounts.reduce(function (x, y) { return x + y; }, 0);
    if (!total) return;
    var t = typeById[l.typeId] || {};
    rows.push(place({ source: 'line', lineId: l.id, centreType: l.centreType, centreId: l.centreId, typeId: l.typeId, group: t.group || 'operations', nature: t.nature || 'fixed',
      label: l.label || '', employeeUserId: l.employeeUserId || null, oneOff: !!l.oneOff, depreciation: !!l.asset, amounts: amounts, total: Math.round(total * 100) / 100 }));
  });
  // from the day entries: paid out of the takings (by expense item) and commissions
  var from = mf + '-01', to = mt + '-' + costDaysIn_(mt), mIdx = Object.create(null), extra = Object.create(null);
  months.forEach(function (m, k) { mIdx[m] = k; });
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.date || e.date < from || e.date > to) return;
    var exp = Number(e.expenseAmount || 0), com = Number(e.channelCommission || 0) + Number(e.creditCommission || 0);
    if (!(exp > 0) && !(com > 0)) return;
    var uk = costUnitOf_(e, maps.posById, maps.unitRow), sep = uk.indexOf(':');
    var ct = uk.slice(0, sep) === 'none' ? 'location' : uk.slice(0, sep), cid = uk.slice(sep + 1);
    function add(source, itemId, amt) {
      var k = source + '|' + uk + '|' + (itemId || '');
      if (!extra[k]) extra[k] = place({ source: source, lineId: null, centreType: ct, centreId: cid, typeId: null, expenseItemId: itemId || null, group: 'operations', nature: 'variable',
        label: '', employeeUserId: null, oneOff: false, depreciation: false, amounts: months.map(function () { return 0; }), total: 0 });
      extra[k].amounts[mIdx[e.date.slice(0, 7)]] += amt; extra[k].total += amt;
    }
    if (exp > 0) add('takings', e.expenseItemId, exp);
    if (com > 0) add('commission', null, com);
  });
  Object.keys(extra).forEach(function (k) {
    extra[k].amounts = extra[k].amounts.map(function (v) { return Math.round(v * 100) / 100; });
    extra[k].total = Math.round(extra[k].total * 100) / 100;
    rows.push(extra[k]);
  });
  return { ok: true, months: months, rows: rows };
}

// ---------- profit ----------
function costZeroT_() {
  return { gross: 0, vat: 0, net: 0, deliveryIncome: 0, cogs: 0, gm: 0, commission: 0, expenses: 0,
    fixed: 0, fixedVehicle: 0, fixedStaff: 0, fixedPremises: 0, fixedOperations: 0, fixedAdmin: 0, cm: 0,
    ovhLocation: 0, ovhCluster: 0, ovhCity: 0, ovhCompany: 0, ovh: 0, profit: 0, qty: 0, uncostedSales: 0 };
}
var COST_SUM_FIELDS_ = ['gross', 'vat', 'net', 'deliveryIncome', 'cogs', 'commission', 'expenses', 'fixed', 'fixedVehicle', 'fixedStaff', 'fixedPremises',
  'fixedOperations', 'fixedAdmin', 'ovhLocation', 'ovhCluster', 'ovhCity', 'ovhCompany', 'qty', 'uncostedSales'];
function costFinishT_(T) {
  T.gm = T.net + T.deliveryIncome - T.cogs;
  T.cm = T.gm - T.commission - T.expenses - T.fixed;
  T.ovh = T.ovhLocation + T.ovhCluster + T.ovhCity + T.ovhCompany;
  T.profit = T.cm - T.ovh;
  Object.keys(T).forEach(function (k) { T[k] = costR4_(T[k]); });
  return T;
}

function profitCompute_(from, to, basis, vatIncl) {
  var vatHist = vatHistory_();
  var maps = costMaps_(), productsById = Object.create(null), typeById = Object.create(null), hist = costHistory_(), stkItems = stockItemsById_();
  readSheet(SHEETS.PRODUCTS).forEach(function (p) { productsById[p.id] = p; });
  readSheet(SHEETS.COST_TYPES).forEach(function (t) { typeById[t.id] = t; });

  // the columns of every series: days, or months for a long range
  var days = costDaysBetween_(from, to), byMonth = days > 62, buckets = [], bIdx = Object.create(null);
  if (byMonth) { for (var mi = costMonthIndex_(from.slice(0, 7)); mi <= costMonthIndex_(to.slice(0, 7)); mi++) buckets.push(costMonthOf_(mi)); }
  else { for (var di = 0; di < days; di++) buckets.push(costDateAdd_(from, di)); }
  buckets.forEach(function (b, i) { bIdx[b] = i; });
  // each month the range touches: its length, and where its days land
  var spans = [];
  for (var si = costMonthIndex_(from.slice(0, 7)); si <= costMonthIndex_(to.slice(0, 7)); si++) {
    var m = costMonthOf_(si), dim = costDaysIn_(m);
    var first = m + '-01' < from ? from : m + '-01', last = m + '-' + (dim < 10 ? '0' : '') + dim > to ? to : m + '-' + (dim < 10 ? '0' : '') + dim;
    var n = costDaysBetween_(first, last), cols = [];
    if (byMonth) cols.push([bIdx[m], n / dim]);
    else for (var dj = 0; dj < n; dj++) cols.push([bIdx[costDateAdd_(first, dj)], 1 / dim]);
    spans.push({ month: m, share: n / dim, cols: cols });
  }
  function zeros() { return buckets.map(function () { return 0; }); }

  var units = Object.create(null), order = [];
  function unit(key) {
    if (!units[key]) {
      var sep = key.indexOf(':'), type = key.slice(0, sep), rest = key.slice(sep + 1);
      var row = maps.unitRow[key] || null;
      units[key] = { key: key, type: type, id: rest, row: row, locationId: type === 'none' ? rest : type === 'ovh' ? null : maps.unitLoc[key] || null,
        T: costZeroT_(), touched: false, series: { gross: zeros(), net: zeros(), other: zeros(), cogs: zeros(), variable: zeros(), fixed: zeros(), ovh: zeros() } };
      order.push(key);
    }
    return units[key];
  }
  Object.keys(maps.unitRow).forEach(unit);

  // the day entries
  var noCost = Object.create(null);
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.date || e.date < from || e.date > to) return;
    var u = unit(costUnitOf_(e, maps.posById, maps.unitRow)), T = u.T, b = bIdx[byMonth ? e.date.slice(0, 7) : e.date];
    // VAT inside the prices at the rate the day was saved with
    var div = vatIncl ? 1 + entryVatRate_(e, vatHist) : 1;
    var gross = Number(e.cashSales || 0) + Number(e.posSales || 0), net = gross / div;
    var deliv = (Number(e.channelDeliveryFee || 0) + Number(e.creditDeliveryFee || 0)) / div;
    var com = Number(e.channelCommission || 0) + Number(e.creditCommission || 0), exp = Number(e.expenseAmount || 0);
    var qty = Number(e.qty || 0), p = e.productId ? productsById[e.productId] : null, cogs = 0;
    if (p && p.type === 'services') { /* a service has no cost of goods */ }
    else if (p && qty > 0) {
      var c = costOfProduct_(p, e.date, hist, productsById, stkItems);
      if (c > 0) cogs = qty * c;
      else if (net > 0) { T.uncostedSales += net; noCost[p.id] = true; }
    } else if (net > 0) T.uncostedSales += net;   // a sale typed as an amount only cannot be costed
    if (gross || deliv || com || exp || qty) u.touched = true;
    T.gross += gross; T.net += net; T.vat += gross - net; T.deliveryIncome += deliv; T.cogs += cogs; T.commission += com; T.expenses += exp;
    if (p && p.type !== 'services') T.qty += qty;
    u.series.gross[b] += gross; u.series.net[b] += net; u.series.other[b] += deliv; u.series.cogs[b] += cogs; u.series.variable[b] += com + exp;
  });

  // the cost lines: a car's or store's own, and the pools above them
  var pools = [];
  readSheet(SHEETS.COST_LINES).forEach(function (l) {
    if (l.voided) return;
    var ser = null, total = 0;
    spans.forEach(function (s) {
      if (!costActiveIn_(l, s.month)) return;
      if (!ser) ser = zeros();
      s.cols.forEach(function (c2) { ser[c2[0]] += Number(l.amount) * c2[1]; });
      total += Number(l.amount) * s.share;
    });
    if (!ser) return;
    if (l.centreType === 'car' || l.centreType === 'store') {
      var u = unit(l.centreType + ':' + l.centreId), g = COST_GROUP_FIELD_[(typeById[l.typeId] || {}).group] || 'fixedOperations';
      u.touched = true; u.T.fixed += total; u.T[g] += total;
      ser.forEach(function (v, i) { u.series.fixed[i] += v; });
    } else pools.push({ level: l.centreType, id: l.centreId, series: ser, total: total });
  });

  // each pool is shared among the stores and cars under it
  function under(pool) {
    var cityKey = pool.level === 'city' ? normalizeName_(pool.id) : null;
    return order.map(function (k) { return units[k]; }).filter(function (u) {
      if (u.type === 'ovh') return false;
      if (u.type !== 'none' && !(u.row && u.row.active !== false) && !u.touched) return false;
      if (u.type === 'none' && !u.touched) return false;
      var loc = maps.locById[u.locationId] || null;
      if (pool.level === 'company') return true;
      if (!loc) return false;
      if (pool.level === 'location') return loc.id === pool.id;
      if (pool.level === 'cluster') return loc.clusterId === pool.id;
      return normalizeName_(loc.city || '') === cityKey;
    });
  }
  pools.forEach(function (pool) {
    var members = under(pool), field = COST_LEVEL_FIELD_[pool.level];
    var w = members.map(function (u) { return basis === 'equal' ? 1 : Math.max(0, basis === 'qty' ? u.T.qty : u.T.net + u.T.deliveryIncome); });
    var sum = w.reduce(function (a, b) { return a + b; }, 0);
    if (!sum) { w = members.map(function () { return 1; }); sum = members.length; }
    if (!members.length) {
      // nothing under it to carry the cost: it stays on the place itself
      members = [unit('ovh:' + pool.level + ':' + pool.id)]; w = [1]; sum = 1;
      members[0].touched = true;
    }
    members.forEach(function (u, i) {
      if (!w[i]) return;
      var share = w[i] / sum;
      u.T[field] += pool.total * share;
      pool.series.forEach(function (v, k) { u.series.ovh[k] += v * share; });
    });
  });

  // the tree: company > city > area within the city > branch > store or car
  var nodes = Object.create(null), nodeOrder = [];
  function node(key, level, parent, info) {
    if (!nodes[key]) { nodes[key] = { key: key, level: level, parent: parent, T: costZeroT_() }; safeOwnKeys_(info || {}).forEach(function (k) { nodes[key][k] = info[k]; }); nodeOrder.push(key); }
    return nodes[key];
  }
  node('company', 'company', null);
  var outUnits = [];
  order.forEach(function (k) {
    var u = units[k];
    if (u.type === 'none' || u.type === 'ovh') { if (!u.touched) return; }
    else if (!(u.row && u.row.active !== false) && !u.touched) return;
    var chain = ['company'], parent = 'company';
    var loc = maps.locById[u.locationId] || null;
    if (u.type === 'ovh') {
      var lvl = u.id.slice(0, u.id.indexOf(':')), cid = u.id.slice(u.id.indexOf(':') + 1);
      if (lvl === 'location' && maps.locById[cid]) loc = maps.locById[cid];
      else if (lvl === 'city') { node('city:' + cid, 'city', 'company', { city: cid }); chain.push('city:' + cid); parent = 'city:' + cid; }
    }
    if (loc) {
      var city = loc.city || '', ck = 'city:' + city, ak = 'cluster:' + city + '|' + (loc.clusterId || '_'), lk = 'location:' + loc.id;
      node(ck, 'city', 'company', { city: city });
      node(ak, 'cluster', ck, { city: city, clusterId: loc.clusterId || null });
      node(lk, 'location', ak, { city: city, clusterId: loc.clusterId || null, locationId: loc.id });
      chain.push(ck, ak, lk); parent = lk;
    }
    node(k, 'unit', parent, { unitType: u.type, unitId: u.id, locationId: loc ? loc.id : null, clusterId: loc ? (loc.clusterId || null) : null, city: loc ? (loc.city || '') : null });
    chain.push(k);
    chain.forEach(function (nk) { COST_SUM_FIELDS_.forEach(function (f) { nodes[nk].T[f] += u.T[f]; }); });
    var s = u.series, any = false, ser = {};
    ['gross', 'net', 'other', 'cogs', 'variable', 'fixed', 'ovh'].forEach(function (f) { ser[f] = s[f].map(function (v) { if (v) any = true; return costR4_(v); }); });
    if (any) outUnits.push({ key: k, series: ser });
  });
  var list = nodeOrder.map(function (k) { costFinishT_(nodes[k].T); return nodes[k]; });
  var company = nodes.company.T;
  return {
    bucket: byMonth ? 'month' : 'day', buckets: buckets, nodes: list, units: outUnits,
    coverage: { sales: company.net, uncostedSales: company.uncostedSales, productsWithoutCost: Object.keys(noCost),
      unitsWithoutCosts: order.filter(function (k) { var u = units[k]; return (u.type === 'store' || u.type === 'car') && u.row && u.row.active !== false && !u.T.fixed; }) }
  };
}

// the period before: the calendar months before for whole months, else the
// same number of days before
function costPrevRange_(from, to) {
  var mf = from.slice(0, 7), mt = to.slice(0, 7);
  if (from === mf + '-01' && to === costDateAdd_(costMonthOf_(costMonthIndex_(mt) + 1) + '-01', -1)) {
    var n = costMonthIndex_(mt) - costMonthIndex_(mf) + 1;
    var pf = costMonthOf_(costMonthIndex_(mf) - n), pt = costMonthOf_(costMonthIndex_(mf) - 1);
    return [pf + '-01', pt + '-' + costDaysIn_(pt)];
  }
  var days = costDaysBetween_(from, to);
  return [costDateAdd_(from, -days), costDateAdd_(from, -1)];
}

function actionProfitReport_(req, user) {
  requireCostRead_(user);
  var today = todayRiyadh_();
  var from = req.dateFrom ? String(req.dateFrom) : today.slice(0, 8) + '01', to = req.dateTo ? String(req.dateTo) : today;
  var basis = req.basis == null || req.basis === '' ? 'sales' : String(req.basis);
  if (COST_BASES_.indexOf(basis) < 0) return { ok: false, error: 'invalid_input' };
  if (!invDateOk_(from) || !invDateOk_(to) || from > to) return { ok: false, error: 'invalid_period' };
  if (costDaysBetween_(from, to) > 1100) return { ok: false, error: 'period_too_long' };
  var vatIncl = salesIncludeVat_();
  var res = profitCompute_(from, to, basis, vatIncl);
  res.ok = true; res.dateFrom = from; res.dateTo = to; res.basis = basis; res.vatIncluded = vatIncl; res.vatRate = vatRate_();
  if (req.compare) {
    var pr = costPrevRange_(from, to);
    if (pr[0] >= '2020-01-01') {
      var prev = profitCompute_(pr[0], pr[1], basis, vatIncl), map = Object.create(null);
      prev.nodes.forEach(function (n) { map[n.key] = { net: n.T.net, cogs: n.T.cogs, gm: n.T.gm, fixed: n.T.fixed, cm: n.T.cm, ovh: n.T.ovh, profit: n.T.profit, qty: n.T.qty }; });
      res.prev = map; res.prevFrom = pr[0]; res.prevTo = pr[1];
    }
  }
  return res;
}
