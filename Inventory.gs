// ---------- Inventory (2026-09-29) ----------
// Per branch and inventory item, over a period:
//   opening + purchases + returns from restaurants = available for use
//   available - sales (from the day entries) - damaged = ending
// Opening, purchases, returns and damage are typed in as movements
// (inventory_moves); sales are the product lines already entered, so stock
// and cash come from the same figures. A movement is never edited or
// deleted: a wrong one is voided with a reason, like an entry.
//
// The opening balance is a physical count on a day. Nothing before that day
// counts (the branch sold for months before anyone counted), the count is
// the start of that day, so the day's own sales come off it. An item not
// counted yet at a branch reads "no opening yet", never short.
//
// Cylinders (2026-09-30). The branches count gas cylinders full and empty,
// and the products they sell move those counts differently: an exchange
// takes a full one out and brings an empty one back, the empty-cylinder sale
// takes an empty one out, a full purchase is a refill (the same number of
// empties goes out for filling). A product marked `cylinder` holds the full
// and empty counts; a product with `stockOf` draws from it with its
// `stockEffect` (exchange | sell_empty | sell_full). Every other goods
// product is its own stock, counted in units as before. This is the sheet's
// own arithmetic; the first real branch day balanced to the cylinder.
var INV_KINDS_ = ['opening', 'purchase', 'return', 'damage', 'transfer_in', 'transfer_out'];
var INV_STATES_ = ['full', 'empty'];
var INV_MAX_QTY_ = 1000000;

// the branches a person keeps stock for
function invBranches_(user) {
  if (user.role === 'admin' || user.role === 'finance') return null; // every branch
  if (user.role === 'cluster_manager') {
    return readSheet(SHEETS.LOCATIONS).filter(function (l) { return clusterManagerOwnsCluster_(user.id, l.clusterId); }).map(function (l) { return l.id; });
  }
  if (user.role === 'store_manager') {
    return readSheet(SHEETS.STORES).filter(function (s) { return s.storeManagerUserId === user.id; }).map(function (s) { return s.locationId; });
  }
  return [];
}
// the branches a person may read: management sees all of them
function invReadBranches_(user) {
  if (isCompanyWide_(user.role)) return null;
  if (user.role === 'cluster_manager' || user.role === 'store_manager') return invBranches_(user);
  return false;
}
// a real calendar date, as YYYY-MM-DD
function invDateOk_(d) {
  d = String(d || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  var x = new Date(d + 'T00:00:00Z');
  return !isNaN(x.getTime()) && x.toISOString().slice(0, 10) === d && d >= '2020-01-01';
}
// a quantity typed as a number or plain digits, positive, not absurd
function invQty_(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v))) return null;
  var q = Math.round(Number(v) * 1000) / 1000;
  return isFinite(q) && q > 0 && q <= INV_MAX_QTY_ ? q : null;
}
function invHasMoves_(productId) {
  return readSheet(SHEETS.INV_MOVES).some(function (m) { return !m.voided && m.productId === productId; });
}

// the branch a person may load stock for, or the error
function invLocFor_(user, locationId) {
  var mine = invBranches_(user);
  var loc = getById_(SHEETS.LOCATIONS, locationId);
  if (!loc) return { error: mine && !mine.length ? 'forbidden' : 'invalid_location' };
  if (mine && mine.indexOf(loc.id) < 0) return { error: 'forbidden' };
  return { loc: loc };
}
// one movement's fields checked: the item holding the stock, full/empty for a
// cylinder, a known kind, a positive quantity, a real past date
function invCheckMove_(m, date) {
  var kind = String(m.kind || ''), qty = invQty_(m.qty);
  if (INV_KINDS_.indexOf(kind) < 0) return { error: 'invalid_kind' };
  if (qty == null) return { error: 'invalid_qty' };
  var product = getById_(SHEETS.PRODUCTS, m.productId);
  if (!product || product.active === false) return { error: 'invalid_product' };
  if (product.type === 'services') return { error: 'not_inventory' };
  if (product.stockOf) return { error: 'use_stock_item' };
  var st = m.state == null ? '' : String(m.state);
  if (product.cylinder ? INV_STATES_.indexOf(st) < 0 : st !== '') return { error: 'invalid_state' };
  if (!invDateOk_(date)) return { error: 'invalid_date' };
  if (date > todayRiyadh_()) return { error: 'future_date' };
  return { move: { productId: product.id, state: st || null, kind: kind, qty: qty, note: String(m.note || '').slice(0, 300) } };
}
function invOpeningKey_(locId, productId, state) { return locId + '|' + productId + '|' + (state || ''); }
function invOpenings_() {
  var o = {};
  readSheet(SHEETS.INV_MOVES).forEach(function (m) { if (!m.voided && m.kind === 'opening') o[invOpeningKey_(m.locationId, m.productId, m.state)] = true; });
  return o;
}

function actionAddInventoryMove_(req, user) {
  var lf = invLocFor_(user, req.locationId);
  if (lf.error) return { ok: false, error: lf.error };
  var date = String(req.date || '');
  var c = invCheckMove_(req, date);
  if (c.error) return { ok: false, error: c.error };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    if (c.move.kind === 'opening' && invOpenings_()[invOpeningKey_(lf.loc.id, c.move.productId, c.move.state)]) return { ok: false, error: 'opening_exists' };
    var move = writeRow(SHEETS.INV_MOVES, {
      locationId: lf.loc.id, productId: c.move.productId, state: c.move.state, kind: c.move.kind, qty: c.move.qty, date: date,
      note: c.move.note, enteredBy: user.id, createdAt: new Date().toISOString(), voided: false
    });
    logAudit_('inventory_' + c.move.kind, user.id, move.id);
    return { ok: true, move: move };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// A branch sheet's quantities for one day, all or nothing: the openings (only
// for what has no count yet), purchases and transfers. `ref` names the sheet
// day, so the same day cannot be loaded twice.
function actionImportInventoryDay_(req, user) {
  var lf = invLocFor_(user, req.locationId);
  if (lf.error) return { ok: false, error: lf.error };
  var date = String(req.date || ''), ref = String(req.ref || '').trim().slice(0, 120);
  var list = Array.isArray(req.moves) ? req.moves : null;
  if (!ref || !list || !list.length || list.length > 200) return { ok: false, error: 'invalid_input' };
  var checked = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var c = invCheckMove_(list[i] || {}, date);
    if (c.error) return { ok: false, error: c.error, index: i };
    if (c.move.kind === 'opening') {
      var k = invOpeningKey_(lf.loc.id, c.move.productId, c.move.state);
      if (seen[k]) return { ok: false, error: 'invalid_input', index: i };
      seen[k] = true;
    }
    checked.push(c.move);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    if (readSheet(SHEETS.INV_MOVES).some(function (m) { return !m.voided && m.locationId === lf.loc.id && m.importRef === ref; })) return { ok: false, error: 'already_imported' };
    var open = invOpenings_();
    for (var j = 0; j < checked.length; j++) {
      if (checked[j].kind === 'opening' && open[invOpeningKey_(lf.loc.id, checked[j].productId, checked[j].state)]) return { ok: false, error: 'opening_exists', index: j };
    }
    var now = new Date().toISOString();
    var written = checked.map(function (m) {
      return writeRow(SHEETS.INV_MOVES, { locationId: lf.loc.id, productId: m.productId, state: m.state, kind: m.kind, qty: m.qty, date: date,
        note: m.note, importRef: ref, enteredBy: user.id, createdAt: now, voided: false });
    });
    logAudit_('inventory_import', user.id, lf.loc.id + ' ' + date + ' (' + written.length + ')');
    return { ok: true, moves: written };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// The author voids his own wrong movement while the branch is still his;
// admin and finance, and the area manager over that branch, may too.
function actionVoidInventoryMove_(req, user) {
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    var m = getById_(SHEETS.INV_MOVES, req.id);
    if (!m) return { ok: false, error: 'not_found' };
    if (m.voided) return { ok: false, error: 'already_voided' };
    var mine = invBranches_(user);
    var inScope = !mine || mine.indexOf(m.locationId) >= 0;
    var allowed = user.role === 'admin' || user.role === 'finance' ||
      (inScope && (m.enteredBy === user.id || user.role === 'cluster_manager'));
    if (!allowed) return { ok: false, error: 'forbidden' };
    m.voided = true; m.voidReason = reason.slice(0, 300); m.voidedBy = user.id; m.voidedAt = new Date().toISOString();
    writeRow(SHEETS.INV_MOVES, m);
    logAudit_('inventory_void', user.id, m.id);
    return { ok: true, move: m };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function actionInventoryReport_(req, user) {
  var scope = invReadBranches_(user);
  if (scope === false) return { ok: false, error: 'forbidden' };
  var today = todayRiyadh_();
  var from = req.dateFrom ? String(req.dateFrom) : today.slice(0, 8) + '01';
  var to = req.dateTo ? String(req.dateTo) : today;
  if (!invDateOk_(from) || !invDateOk_(to) || from > to) return { ok: false, error: 'invalid_period' };
  function inScope(locId) {
    if (req.locationId && locId !== req.locationId) return false;
    return !scope || scope.indexOf(locId) >= 0;
  }
  var products = {};
  // an item switched to a service after its stock history keeps its rows
  var allMoves = readSheet(SHEETS.INV_MOVES);
  var hasMoves = {};
  allMoves.forEach(function (m) { if (!m.voided) hasMoves[m.productId] = true; });
  readSheet(SHEETS.PRODUCTS).forEach(function (p) { if (p.type !== 'services' || hasMoves[p.id]) products[p.id] = p; });

  // each branch-and-item starts on its opening count's day
  var openingOf = {};
  allMoves.forEach(function (m) {
    if (!m.voided && m.kind === 'opening' && products[m.productId]) openingOf[invOpeningKey_(m.locationId, m.productId, m.state)] = m;
  });
  var rows = {}, order = [];
  // one row per branch, stock item and (for a cylinder) full or empty
  function row(locId, productId, state) {
    var k = invOpeningKey_(locId, productId, state);
    if (!rows[k]) {
      var op = openingOf[k] || null, p = products[productId];
      rows[k] = { locationId: locId, productId: productId, state: state || null, cylinder: !!p.cylinder, stockName: p.stockName || '',
        unitCost: state === 'empty' ? Number(p.emptyCost || 0) : Number(p.unitCost || 0),
        opening: 0, purchases: 0, returns: 0, exchangeIn: 0, transfersIn: 0, sales: 0, damaged: 0, refillOut: 0, transfersOut: 0,
        salesWithoutQty: 0, salesWithoutQtyAmount: 0, salesBySource: {},
        openingDate: op ? op.date : null, noOpening: !op || op.date > to };
      order.push(k);
    }
    return rows[k];
  }
  var IN_ = { purchases: 1, returns: 1, exchangeIn: 1, transfersIn: 1 };
  // add a quantity dated d to the period it belongs to
  function post(r, d, field, q) {
    if (r.noOpening || d < r.openingDate || d > to) return;
    if (d < from) { r.opening += IN_[field] ? q : -q; return; }
    r[field] += q;
  }
  var MOVE_FIELD_ = { purchase: 'purchases', 'return': 'returns', damage: 'damaged', transfer_in: 'transfersIn', transfer_out: 'transfersOut' };
  var moves = [];
  allMoves.forEach(function (m) {
    if (!products[m.productId] || !inScope(m.locationId) || m.date > to) return;
    if (m.date >= from) moves.push(m);
    if (m.voided) return;
    var p = products[m.productId], st = p.cylinder ? (m.state || 'full') : null;
    var r = row(m.locationId, m.productId, st), q = Number(m.qty || 0);
    if (m.kind === 'opening') { if (!r.noOpening) r.opening += q; return; }
    post(r, m.date, MOVE_FIELD_[m.kind], q);
    // a full purchase is a refill: as many empties went out to be filled
    if (p.cylinder && st === 'full' && m.kind === 'purchase') post(row(m.locationId, m.productId, 'empty'), m.date, 'refillOut', q);
  });
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.productId || !products[e.productId] || !inScope(e.locationId) || !e.date || e.date > to) return;
    // the stock the product draws from, and how
    var sp = products[e.productId], anchor = sp.stockOf && products[sp.stockOf] ? products[sp.stockOf] : sp;
    var effect = anchor.cylinder ? (sp.stockEffect || 'exchange') : 'unit';
    var r = row(e.locationId, anchor.id, effect === 'unit' ? null : effect === 'sell_empty' ? 'empty' : 'full'), q = Number(e.qty || 0);
    if (q && effect === 'exchange') post(row(e.locationId, anchor.id, 'empty'), e.date, 'exchangeIn', q);
    if (!q) {
      // a sale typed as an amount only: counted as a warning, not as units
      var amt = Number(e.cashSales || 0) + Number(e.posSales || 0);
      if (amt > 0 && e.date >= from && (r.noOpening || e.date >= r.openingDate)) { r.salesWithoutQty++; r.salesWithoutQtyAmount += amt; }
      return;
    }
    post(r, e.date, 'sales', q);
    // which store, car or POS machine sold it, within the period
    if (!r.noOpening && e.date >= r.openingDate && e.date >= from) {
      var sk = e.sourceType + ':' + e.sourceId;
      r.salesBySource[sk] = Math.round(((r.salesBySource[sk] || 0) + q) * 1000) / 1000;
    }
  });
  var out = order.map(function (k) {
    var r = rows[k];
    ['opening', 'purchases', 'returns', 'exchangeIn', 'transfersIn', 'sales', 'damaged', 'refillOut', 'transfersOut'].forEach(function (f) { r[f] = Math.round(r[f] * 1000) / 1000; });
    r.salesWithoutQtyAmount = Math.round(r.salesWithoutQtyAmount * 100) / 100;
    r.available = Math.round((r.opening + r.purchases + r.returns + r.exchangeIn + r.transfersIn) * 1000) / 1000;
    r.ending = Math.round((r.available - r.sales - r.damaged - r.refillOut - r.transfersOut) * 1000) / 1000;
    r.short = !r.noOpening && r.ending < 0;
    ['opening', 'purchases', 'returns', 'exchangeIn', 'transfersIn', 'available', 'sales', 'damaged', 'refillOut', 'transfersOut', 'ending'].forEach(function (f) {
      r[f + 'Value'] = Math.round(r[f] * r.unitCost * 100) / 100;
    });
    return r;
  });
  moves.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, dateFrom: from, dateTo: to, rows: out, moves: moves.slice(0, 2000), movesTotal: moves.length };
}
