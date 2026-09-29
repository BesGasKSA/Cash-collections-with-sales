// ---------- Inventory (2026-09-29) ----------
// Per branch and inventory item, over a period:
//   opening + purchases + returns from restaurants = available for use
//   available - sales (from the day entries) - damaged = ending
// Opening, purchases, returns and damage are typed in as movements
// (inventory_moves); sales are the product lines already entered, so stock
// and cash come from the same figures. A movement is never edited or
// deleted: a wrong one is voided with a reason, like an entry.
var INV_KINDS_ = ['opening', 'purchase', 'return', 'damage'];

// the branches a person keeps stock for
function invBranches_(user) {
  if (user.role === 'admin' || user.role === 'finance') return null; // every branch
  if (user.role === 'cluster_manager') {
    return readSheet(SHEETS.LOCATIONS).filter(function (l) { return clusterManagerOwnsCluster_(user.id, l.clusterId); }).map(function (l) { return l.id; });
  }
  if (user.role === 'store_manager') {
    var st = storeOfManager_(user.id);
    return st ? [st.locationId] : [];
  }
  return [];
}
// the branches a person may read: management sees all of them
function invReadBranches_(user) {
  if (isCompanyWide_(user.role)) return null;
  if (user.role === 'cluster_manager' || user.role === 'store_manager') return invBranches_(user);
  return false;
}

function actionAddInventoryMove_(req, user) {
  var mine = invBranches_(user);
  var loc = getById_(SHEETS.LOCATIONS, req.locationId);
  if (!loc) return { ok: false, error: mine && !mine.length ? 'forbidden' : 'invalid_location' };
  if (mine && mine.indexOf(loc.id) < 0) return { ok: false, error: 'forbidden' };
  var kind = String(req.kind || ''), qty = Number(req.qty);
  if (INV_KINDS_.indexOf(kind) < 0 || !isFinite(qty) || qty <= 0) return { ok: false, error: 'invalid_input' };
  var product = getById_(SHEETS.PRODUCTS, req.productId);
  if (!product) return { ok: false, error: 'invalid_input' };
  if (product.type === 'services') return { ok: false, error: 'not_inventory' };
  var date = String(req.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'invalid_input' };
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
      locationId: loc.id, productId: product.id, kind: kind, qty: Math.round(qty * 1000) / 1000, date: date,
      note: String(req.note || '').slice(0, 300), enteredBy: user.id, createdAt: new Date().toISOString(), voided: false
    });
    logAudit_('inventory_' + kind, user.id, move.id);
    return { ok: true, move: move };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function actionVoidInventoryMove_(req, user) {
  var m = getById_(SHEETS.INV_MOVES, req.id);
  if (!m) return { ok: false, error: 'not_found' };
  if (m.voided) return { ok: false, error: 'already_voided' };
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'invalid_input' };
  if (m.enteredBy !== user.id && user.role !== 'admin' && user.role !== 'finance') return { ok: false, error: 'forbidden' };
  m.voided = true; m.voidReason = reason.slice(0, 300); m.voidedBy = user.id; m.voidedAt = new Date().toISOString();
  writeRow(SHEETS.INV_MOVES, m);
  logAudit_('inventory_void', user.id, m.id);
  return { ok: true, move: m };
}

function actionInventoryReport_(req, user) {
  var scope = invReadBranches_(user);
  if (scope === false) return { ok: false, error: 'forbidden' };
  var today = todayRiyadh_();
  var from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.dateFrom || '')) ? req.dateFrom : today.slice(0, 8) + '01';
  var to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.dateTo || '')) ? req.dateTo : today;
  function inScope(locId) {
    if (req.locationId && locId !== req.locationId) return false;
    return !scope || scope.indexOf(locId) >= 0;
  }
  var products = {};
  readSheet(SHEETS.PRODUCTS).forEach(function (p) { if (p.type !== 'services') products[p.id] = p; });
  var rows = {}, order = [];
  function row(locId, productId) {
    var k = locId + '|' + productId;
    if (!rows[k]) {
      var cost = Number(products[productId].unitCost || 0);
      rows[k] = { locationId: locId, productId: productId, unitCost: cost, opening: 0, purchases: 0, returns: 0, sales: 0, damaged: 0 };
      order.push(k);
    }
    return rows[k];
  }
  var moves = [];
  readSheet(SHEETS.INV_MOVES).forEach(function (m) {
    if (!products[m.productId] || !inScope(m.locationId) || m.date > to) return;
    moves.push(m);
    if (m.voided) return;
    var r = row(m.locationId, m.productId), q = Number(m.qty || 0);
    // everything before the period, and any opening balance, is the opening
    if (m.date < from || m.kind === 'opening') { r.opening += m.kind === 'damage' ? -q : q; return; }
    if (m.kind === 'purchase') r.purchases += q;
    else if (m.kind === 'return') r.returns += q;
    else if (m.kind === 'damage') r.damaged += q;
  });
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.productId || !products[e.productId] || !inScope(e.locationId) || !e.date || e.date > to) return;
    var q = Number(e.qty || 0);
    if (!q) return;
    var r = row(e.locationId, e.productId);
    if (e.date < from) r.opening -= q; else r.sales += q;
  });
  var out = order.map(function (k) {
    var r = rows[k];
    ['opening', 'purchases', 'returns', 'sales', 'damaged'].forEach(function (f) { r[f] = Math.round(r[f] * 1000) / 1000; });
    r.available = Math.round((r.opening + r.purchases + r.returns) * 1000) / 1000;
    r.ending = Math.round((r.available - r.sales - r.damaged) * 1000) / 1000;
    r.short = r.ending < 0;
    ['opening', 'purchases', 'returns', 'available', 'sales', 'damaged', 'ending'].forEach(function (f) {
      r[f + 'Value'] = Math.round(r[f] * r.unitCost * 100) / 100;
    });
    return r;
  });
  moves.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, dateFrom: from, dateTo: to, rows: out, moves: moves.filter(function (m) { return m.date >= from; }).slice(0, 1000) };
}
