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
var INV_KINDS_ = ['opening', 'purchase', 'return', 'damage'];
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

function actionAddInventoryMove_(req, user) {
  var mine = invBranches_(user);
  var loc = getById_(SHEETS.LOCATIONS, req.locationId);
  if (!loc) return { ok: false, error: mine && !mine.length ? 'forbidden' : 'invalid_location' };
  if (mine && mine.indexOf(loc.id) < 0) return { ok: false, error: 'forbidden' };
  var kind = String(req.kind || ''), qty = invQty_(req.qty);
  if (INV_KINDS_.indexOf(kind) < 0 || qty == null) return { ok: false, error: 'invalid_input' };
  var product = getById_(SHEETS.PRODUCTS, req.productId);
  if (!product || product.active === false) return { ok: false, error: 'invalid_input' };
  if (product.type === 'services') return { ok: false, error: 'not_inventory' };
  var date = String(req.date || '');
  if (!invDateOk_(date)) return { ok: false, error: 'invalid_input' };
  if (date > todayRiyadh_()) return { ok: false, error: 'future_date' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    if (kind === 'opening') {
      var has = readSheet(SHEETS.INV_MOVES).some(function (m) {
        return !m.voided && m.kind === 'opening' && m.locationId === loc.id && m.productId === product.id;
      });
      if (has) return { ok: false, error: 'opening_exists' };
    }
    var move = writeRow(SHEETS.INV_MOVES, {
      locationId: loc.id, productId: product.id, kind: kind, qty: qty, date: date,
      note: String(req.note || '').slice(0, 300), enteredBy: user.id, createdAt: new Date().toISOString(), voided: false
    });
    logAudit_('inventory_' + kind, user.id, move.id);
    return { ok: true, move: move };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// The author voids his own wrong movement while the branch is still his;
// admin and finance, and the area manager over that branch, may too.
function actionVoidInventoryMove_(req, user) {
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'invalid_input' };
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
  if (!invDateOk_(from) || !invDateOk_(to) || from > to) return { ok: false, error: 'invalid_input' };
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
    if (!m.voided && m.kind === 'opening' && products[m.productId]) openingOf[m.locationId + '|' + m.productId] = m;
  });
  var rows = {}, order = [];
  function row(locId, productId) {
    var k = locId + '|' + productId;
    if (!rows[k]) {
      var op = openingOf[k] || null;
      rows[k] = { locationId: locId, productId: productId, unitCost: Number(products[productId].unitCost || 0),
        opening: 0, purchases: 0, returns: 0, sales: 0, damaged: 0, salesWithoutQty: 0, salesWithoutQtyAmount: 0, salesBySource: {},
        openingDate: op ? op.date : null, noOpening: !op || op.date > to };
      order.push(k);
    }
    return rows[k];
  }
  // add a signed quantity dated d to the period it belongs to
  function post(r, d, field, q) {
    if (r.noOpening || d < r.openingDate || d > to) return;
    if (d < from) { r.opening += field === 'purchases' || field === 'returns' ? q : -q; return; }
    r[field] += q;
  }
  var moves = [];
  allMoves.forEach(function (m) {
    if (!products[m.productId] || !inScope(m.locationId) || m.date > to) return;
    if (m.date >= from) moves.push(m);
    if (m.voided) return;
    var r = row(m.locationId, m.productId), q = Number(m.qty || 0);
    if (m.kind === 'opening') { if (!r.noOpening) r.opening += q; return; }
    post(r, m.date, m.kind === 'purchase' ? 'purchases' : m.kind === 'return' ? 'returns' : 'damaged', q);
  });
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.productId || !products[e.productId] || !inScope(e.locationId) || !e.date || e.date > to) return;
    var r = row(e.locationId, e.productId), q = Number(e.qty || 0);
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
    ['opening', 'purchases', 'returns', 'sales', 'damaged'].forEach(function (f) { r[f] = Math.round(r[f] * 1000) / 1000; });
    r.salesWithoutQtyAmount = Math.round(r.salesWithoutQtyAmount * 100) / 100;
    r.available = Math.round((r.opening + r.purchases + r.returns) * 1000) / 1000;
    r.ending = Math.round((r.available - r.sales - r.damaged) * 1000) / 1000;
    r.short = !r.noOpening && r.ending < 0;
    ['opening', 'purchases', 'returns', 'available', 'sales', 'damaged', 'ending'].forEach(function (f) {
      r[f + 'Value'] = Math.round(r[f] * r.unitCost * 100) / 100;
    });
    return r;
  });
  moves.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, dateFrom: from, dateTo: to, rows: out, moves: moves.slice(0, 2000), movesTotal: moves.length };
}
