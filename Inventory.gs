// ---------- Inventory (2026-09-29) ----------
// Per branch and inventory item, over a period:
//   opening + purchases + returns from restaurants = available for use
//   available - sales (from the day entries) - damaged = ending
// Opening, purchases, returns and damage are typed in as movements
// (inventory_moves); sales are the product lines already entered, so stock
// and cash come from the same figures. A movement is never edited or
// deleted: a wrong one is voided with a reason, like an entry.
//
// The opening balance is a physical count on a day, entered once; after it
// the stock is a running balance. Nothing before that day counts (the branch
// sold for months before anyone counted), the count is the start of that day,
// so the day's own sales come off it. An item not counted yet at a branch
// reads "no opening yet", never short.
//
// Inventory items are not sales items (LPG Task 1b, 2026-10-05). The branch
// holds and counts inventory items (`stock_items`): a cylinder item counted
// full and empty, or a unit item. A sales item (product) is what the customer
// pays for; it names its inventory item (`stockItemId`) and what one sale does
// to it (`stockEffect`): exchange (full out, empty back: `exchangeIn`; the
// empty may be another type, `returnItemId`), sell_empty, sell_full, or unit.
// A full purchase is a refill (as many empties go out), unless the cylinders
// are brand new (`newCylinders`).
//
// Until an admin or finance confirms the setup (`applyInventorySetup`, flag
// STOCK_ITEMS_SETUP), everything works as before: a product holds the stock
// (a `cylinder` product full and empty, a `stockOf` product draws from one).
// After it, a movement saved before names a product: it belongs to that
// product's inventory item, in the state its effect implies (exchange or
// sell_full: full; sell_empty: empty). Nothing already saved is rewritten.
var INV_KINDS_ = ['opening', 'purchase', 'return', 'damage', 'transfer_in', 'transfer_out'];
var INV_STATES_ = ['full', 'empty'];
var INV_EFFECTS_ = ['exchange', 'sell_empty', 'sell_full'];
var INV_MAX_QTY_ = 1000000;
var INV_SETUP_FLAG_ = 'STOCK_ITEMS_SETUP';

// whether the inventory items are set up (the confirm step has run)
function stockItemsLive_() { return !!scriptProps_()[INV_SETUP_FLAG_]; }

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
// the state a sale or an old product movement lands on, for a cylinder item
function invEffectState_(effect) { return effect === 'sell_empty' ? 'empty' : 'full'; }

// How every movement and sale finds the stock it moves: the inventory item and
// (for a cylinder) full or empty. Before the setup a product holding stock is
// its own item, exactly as the stock was read until then.
// `ov` {products, items} reads the stock as a setup plan would (the setup's preview).
function invStockCtx_(ov) {
  var live = ov ? true : stockItemsLive_();
  var products = Object.create(null), items = Object.create(null), legacyIn = Object.create(null), virt = Object.create(null);
  if (ov) { products = ov.products; items = ov.items; }
  else readSheet(SHEETS.PRODUCTS).forEach(function (p) { products[p.id] = p; });
  var moves = readSheet(SHEETS.INV_MOVES);
  if (live && !ov) readSheet(SHEETS.STOCK_ITEMS).forEach(function (s) { items[s.id] = s; });
  else {
    // an item switched to a service after its stock history keeps its rows
    var hasMoves = Object.create(null);
    moves.forEach(function (m) { if (!m.voided) hasMoves[m.productId] = true; });
    Object.keys(products).forEach(function (id) { if (products[id].type !== 'services' || hasMoves[id]) legacyIn[id] = products[id]; });
  }
  function virtual(p) {
    if (!virt[p.id]) virt[p.id] = { id: p.id, name: p.cylinder && p.stockName ? p.stockName : p.name, kind: p.cylinder ? 'cylinder' : 'unit',
      gasCost: Number(p.unitCost || 0), cylinderCost: Number(p.emptyCost || 0), unitCost: Number(p.unitCost || 0), boxSize: p.boxSize, active: p.active, virtual: true };
    return virt[p.id];
  }
  function item(id) { return live ? (items[id] || null) : (legacyIn[id] ? virtual(legacyIn[id]) : null); }
  // a movement's item and state
  function moveTarget(m) {
    var it, st;
    if (live) {
      if (m.stockItemId) { it = items[m.stockItemId]; st = m.state; }
      else {
        var p = products[m.productId];
        it = p && p.stockItemId ? items[p.stockItemId] : null;
        st = m.state || (p ? invEffectState_(p.stockEffect) : null);
      }
    } else {
      var lp = legacyIn[m.productId];
      it = lp ? virtual(lp) : null; st = m.state;
    }
    if (!it) return null;
    return { item: it, state: it.kind === 'cylinder' ? (st || 'full') : null };
  }
  // what one sale of a product does: the item, the effect, and the item whose empty comes back
  function saleLink(productId) {
    if (live) {
      var p = products[productId];
      if (!p || p.type === 'services' || !p.stockItemId || !items[p.stockItemId]) return null;
      var it = items[p.stockItemId], cyl = it.kind === 'cylinder';
      var effect = cyl ? (INV_EFFECTS_.indexOf(p.stockEffect) >= 0 ? p.stockEffect : 'exchange') : 'unit';
      var back = p.returnItemId && items[p.returnItemId] && items[p.returnItemId].kind === 'cylinder' ? items[p.returnItemId] : it;
      return { item: it, effect: effect, back: back };
    }
    var sp = legacyIn[productId];
    if (!sp) return null;
    var anchor = sp.stockOf && legacyIn[sp.stockOf] ? legacyIn[sp.stockOf] : sp;
    var eff = anchor.cylinder ? (sp.stockEffect || 'exchange') : 'unit';
    // the empty that comes back may be another type than the full one that left (iron in, fiber out)
    var bk = sp.returnOf && legacyIn[sp.returnOf] && legacyIn[sp.returnOf].cylinder ? legacyIn[sp.returnOf] : anchor;
    return { item: virtual(anchor), effect: eff, back: virtual(bk) };
  }
  return { live: live, products: products, items: items, moves: moves, item: item, moveTarget: moveTarget, saleLink: saleLink };
}
function invOpeningKey_(locId, itemId, state) { return locId + '|' + itemId + '|' + (state || ''); }
// every opening count on file, old ones on a sales item included: the opening is entered once
function invOpenings_(sc) {
  sc = sc || invStockCtx_();
  var o = Object.create(null);
  sc.moves.forEach(function (m) {
    if (m.voided || m.kind !== 'opening') return;
    var t = sc.moveTarget(m);
    if (t) o[invOpeningKey_(m.locationId, t.item.id, t.state)] = true;
  });
  return o;
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
function invCheckMove_(m, date, sc) {
  var kind = String(m.kind || ''), qty = invQty_(m.qty);
  if (INV_KINDS_.indexOf(kind) < 0) return { error: 'invalid_kind' };
  if (qty == null) return { error: 'invalid_qty' };
  var it, key;
  if (sc.live) {
    // stock is kept on inventory items, never on a sales item
    if (!m.stockItemId) return { error: m.productId ? 'use_stock_item' : 'invalid_stock_item' };
    it = hasOwn_(sc.items, String(m.stockItemId)) ? sc.items[m.stockItemId] : null;
    // a deactivated item still takes counts, damage and transfers (corrections); it is only not sold
    if (!it) return { error: 'invalid_stock_item' };
    key = { stockItemId: it.id };
  } else {
    var product = getById_(SHEETS.PRODUCTS, m.productId);
    if (!product || product.active === false) return { error: 'invalid_product' };
    if (product.type === 'services') return { error: 'not_inventory' };
    if (product.stockOf) return { error: 'use_stock_item' };
    it = { id: product.id, kind: product.cylinder ? 'cylinder' : 'unit' };
    key = { productId: product.id };
  }
  var cyl = it.kind === 'cylinder';
  var st = m.state == null ? '' : String(m.state);
  if (cyl ? INV_STATES_.indexOf(st) < 0 : st !== '') return { error: 'invalid_state' };
  // brand-new cylinders bought: counted in, but no empties went out to be filled
  if (m.newCylinders != null && m.newCylinders !== true && m.newCylinders !== false) return { error: 'invalid_new_cylinders' };
  var fresh = m.newCylinders === true;
  if (fresh && !(kind === 'purchase' && cyl && st === 'full')) return { error: 'invalid_new_cylinders' };
  if (!invDateOk_(date)) return { error: 'invalid_date' };
  if (date > todayRiyadh_()) return { error: 'future_date' };
  var move = { state: st || null, kind: kind, qty: qty, newCylinders: fresh, note: String(m.note || '').slice(0, 300) };
  if (key.stockItemId) move.stockItemId = key.stockItemId; else move.productId = key.productId;
  return { move: move, itemId: it.id };
}
function invMoveRow_(locId, c, date, user, extra) {
  var row = { locationId: locId, state: c.state, kind: c.kind, qty: c.qty, date: date, newCylinders: c.newCylinders, note: c.note,
    enteredBy: user.id, createdAt: new Date().toISOString(), voided: false };
  if (c.stockItemId) row.stockItemId = c.stockItemId; else row.productId = c.productId;
  safeOwnKeys_(extra || {}).forEach(function (k) { row[k] = extra[k]; });
  return row;
}

function actionAddInventoryMove_(req, user) {
  var lf = invLocFor_(user, req.locationId);
  if (lf.error) return { ok: false, error: lf.error };
  var date = String(req.date || '');
  var c = invCheckMove_(req, date, invStockCtx_());
  if (c.error) return { ok: false, error: c.error };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    if (c.move.kind === 'opening' && invOpenings_()[invOpeningKey_(lf.loc.id, c.itemId, c.move.state)]) return { ok: false, error: 'opening_exists' };
    var move = writeRow(SHEETS.INV_MOVES, invMoveRow_(lf.loc.id, c.move, date, user));
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
  var sc = invStockCtx_();
  var checked = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var c = invCheckMove_(list[i] || {}, date, sc);
    if (c.error) return { ok: false, error: c.error, index: i };
    if (c.move.kind === 'opening') {
      var k = invOpeningKey_(lf.loc.id, c.itemId, c.move.state);
      if (seen[k]) return { ok: false, error: 'invalid_input', index: i };
      seen[k] = true;
    }
    checked.push(c);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    if (readSheet(SHEETS.INV_MOVES).some(function (m) { return !m.voided && m.locationId === lf.loc.id && m.importRef === ref; })) return { ok: false, error: 'already_imported' };
    var open = invOpenings_();
    for (var j = 0; j < checked.length; j++) {
      if (checked[j].move.kind === 'opening' && open[invOpeningKey_(lf.loc.id, checked[j].itemId, checked[j].move.state)]) return { ok: false, error: 'opening_exists', index: j };
    }
    var written = checked.map(function (x) { return writeRow(SHEETS.INV_MOVES, invMoveRow_(lf.loc.id, x.move, date, user, { importRef: ref })); });
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

// The stock on hand right now: every movement and sale up to this moment, at
// every branch in reach (or one). Never served from the response cache.
function actionInventoryLive_(req, user) {
  var today = todayRiyadh_();
  var res = actionInventoryReport_({ dateFrom: today, dateTo: today, locationId: req.locationId || null }, user);
  if (!res.ok) return res;
  res.asOf = new Date().toISOString();
  res.live = true;
  delete res.moves;                  // the live card shows stock, not the day's movements
  return res;
}

// What one unit of an item in a state is worth on a day: a full cylinder is the
// gas and the cylinder it is in, an empty one the cylinder (both dated).
function invUnitValue_(it, state, date, hist) {
  if (it.virtual) return state === 'empty' ? it.cylinderCost : state === 'full' ? it.gasCost + it.cylinderCost : it.unitCost;
  if (it.kind !== 'cylinder') return stockItemCostOn_(it, 'unitCost', date, hist).v;
  var cyl = stockItemCostOn_(it, 'cylinderCost', date, hist).v;
  return state === 'empty' ? cyl : stockItemCostOn_(it, 'gasCost', date, hist).v + cyl;
}

function actionInventoryReport_(req, user, scOverride) {
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
  var sc = scOverride || invStockCtx_(), hist = sc.live ? costHistory_() : null;
  var allMoves = sc.moves;

  // each branch-and-item starts on its opening count's day
  var openingOf = Object.create(null);
  allMoves.forEach(function (m) {
    if (m.voided || m.kind !== 'opening') return;
    var t = sc.moveTarget(m);
    if (t) openingOf[invOpeningKey_(m.locationId, t.item.id, t.state)] = m;
  });
  var rows = Object.create(null), order = [];
  // one row per branch, inventory item and (for a cylinder) full or empty
  function row(locId, it, state) {
    var k = invOpeningKey_(locId, it.id, state);
    if (!rows[k]) {
      var op = openingOf[k] || null;
      rows[k] = { locationId: locId, stockItemId: it.id, state: state || null, cylinder: it.kind === 'cylinder', itemName: it.name || '',
        unitCost: Math.round(Number(invUnitValue_(it, state, to, hist) || 0) * 10000) / 10000,
        opening: 0, purchases: 0, newCylinders: 0, returns: 0, exchangeIn: 0, transfersIn: 0, sales: 0, damaged: 0, refillOut: 0, transfersOut: 0,
        salesWithoutQty: 0, salesWithoutQtyAmount: 0, salesBySource: {}, salesByProduct: {},
        openingDate: op ? op.date : null, noOpening: !op || op.date > to };
      // before the setup a row keeps its old shape too, for a client that has not reloaded
      if (!sc.live) { rows[k].productId = it.id; rows[k].stockName = sc.products[it.id] ? (sc.products[it.id].stockName || '') : ''; }
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
    var t = sc.moveTarget(m);
    if (!t || !inScope(m.locationId) || m.date > to) return;
    if (m.date >= from) {
      // the movement as listed names its inventory item (a copy: the sheet row is not touched)
      var mc = {}; safeOwnKeys_(m).forEach(function (k) { mc[k] = m[k]; });
      mc.stockItemId = t.item.id; if (t.state && !mc.state) mc.state = t.state;
      moves.push(mc);
    }
    if (m.voided) return;
    var r = row(m.locationId, t.item, t.state), q = Number(m.qty || 0);
    if (m.kind === 'opening') { if (!r.noOpening) r.opening += q; return; }
    post(r, m.date, MOVE_FIELD_[m.kind], q);
    // a full purchase is a refill: as many empties went out to be filled; brand-new cylinders
    // (newCylinders) sent none, and are counted on their own within the period
    if (t.item.kind === 'cylinder' && t.state === 'full' && m.kind === 'purchase') {
      if (m.newCylinders === true) { if (!r.noOpening && m.date >= r.openingDate && m.date >= from) r.newCylinders += q; }
      else post(row(m.locationId, t.item, 'empty'), m.date, 'refillOut', q);
    }
  });
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.productId || !inScope(e.locationId) || !e.date || e.date > to) return;
    // the stock the product draws from, and how
    var link = sc.saleLink(e.productId);
    if (!link) return;
    var effect = link.effect;
    var r = row(e.locationId, link.item, effect === 'unit' ? null : effect === 'sell_empty' ? 'empty' : 'full'), q = Number(e.qty || 0);
    if (q && effect === 'exchange') post(row(e.locationId, link.back, 'empty'), e.date, 'exchangeIn', q);
    if (!q) {
      // a sale typed as an amount only: counted as a warning, not as units
      var amt = Number(e.cashSales || 0) + Number(e.posSales || 0);
      if (amt > 0 && e.date >= from && (r.noOpening || e.date >= r.openingDate)) { r.salesWithoutQty++; r.salesWithoutQtyAmount += amt; }
      return;
    }
    post(r, e.date, 'sales', q);
    // which store, car or POS machine sold it, and which sales item, within the period
    if (!r.noOpening && e.date >= r.openingDate && e.date >= from) {
      var sk = e.sourceType + ':' + e.sourceId;
      r.salesBySource[sk] = Math.round(((r.salesBySource[sk] || 0) + q) * 1000) / 1000;
      if (sc.live) r.salesByProduct[e.productId] = Math.round(((r.salesByProduct[e.productId] || 0) + q) * 1000) / 1000;
    }
  });
  var out = order.map(function (k) {
    var r = rows[k];
    ['opening', 'purchases', 'newCylinders', 'returns', 'exchangeIn', 'transfersIn', 'sales', 'damaged', 'refillOut', 'transfersOut'].forEach(function (f) { r[f] = Math.round(r[f] * 1000) / 1000; });
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
  return { ok: true, dateFrom: from, dateTo: to, rows: out, moves: moves.slice(0, 2000), movesTotal: moves.length, stockItemsLive: sc.live };
}

// ---------- Setting up the inventory items (once, confirmed by a manager) ----------
// The live products were typed as plain goods, and the branches counted their
// cylinders on the sales items that stand for them (full iron on the exchange,
// empty iron on the body sale). The proposal reads the product names with the
// branch sheet's own words; the manager corrects it and confirms it once.
var INV_GROUPS_ = [
  { key: 'fiber5', words: ['5 كيلو', '5 kilo', '5 كجم', '5كجم', '5 kg', '5kg'], name: 'أسطوانة فايبر 5 كجم' },
  { key: 'iron', words: ['حديد', 'iron'], name: 'أسطوانة حديد' },
  { key: 'wazfa', words: ['وذفة', 'وذفه', 'wazfa'], name: 'أسطوانة وذفه' },
  { key: 'fiber', words: ['فايبر', 'fiber'], name: 'أسطوانة فايبر' }
];
function invNameHas_(name, words) { var n = normalizeName_(name); return words.some(function (w) { return n.indexOf(normalizeName_(w)) >= 0; }); }
function invNameWord_(name, words) { var parts = normalizeName_(name).split(/[\s\/\-]+/); return words.some(function (w) { return parts.indexOf(normalizeName_(w)) >= 0; }); }
function invGroupOf_(name) { for (var i = 0; i < INV_GROUPS_.length; i++) if (invNameHas_(name, INV_GROUPS_[i].words)) return INV_GROUPS_[i]; return null; }

function inventorySetupProposal_() {
  var products = readSheet(SHEETS.PRODUCTS), byId = Object.create(null);
  products.forEach(function (p) { byId[p.id] = p; });
  var items = [], itemByKey = Object.create(null), plan = [];
  function addItem(key, o) { if (!itemByKey[key]) { o.key = key; itemByKey[key] = o; items.push(o); } return itemByKey[key]; }
  function cylItem(g) { return addItem('cyl:' + g.key, { name: g.name, kind: 'cylinder', boxSize: 35, gasCost: 0, cylinderCost: 0 }); }
  function guess(p) {
    var name = String(p.name || '');
    if (invNameHas_(name, ['توصيل', 'delivery']) || (!(Number(p.unitPrice) > 0) && invNameHas_(name, ['خدمه', 'service', 'رسوم', 'fee']))) return { toService: true };
    var g = invGroupOf_(name);
    var swap = invNameHas_(name, ['استبدال', 'تبديل', 'exchange', 'swap']);
    var sell = invNameHas_(name, ['بيع', 'فارغ', 'empty']) || invNameWord_(name, ['sale', 'sell']);
    if (p.cylinder) return { item: g ? cylItem(g) : addItem('own:' + p.id, { name: p.stockName || p.name, kind: 'cylinder', boxSize: Number(p.boxSize) > 0 ? Number(p.boxSize) : 35, gasCost: 0, cylinderCost: 0 }), effect: 'exchange' };
    if (invNameHas_(name, ['منظم', 'regulator']) || invNameWord_(name, ['لي', 'pipe', 'hose'])) return { item: addItem('own:' + p.id, { name: p.name, kind: 'unit', unitCost: Number(p.unitCost || 0) }), effect: 'unit' };
    if (swap) return { item: cylItem(g || INV_GROUPS_[1]), effect: 'exchange' };      // no type named: iron, the usual cylinder
    if (sell && g) return { item: cylItem(g), effect: 'sell_empty' };
    return { item: addItem('own:' + p.id, { name: p.name, kind: 'unit', unitCost: Number(p.unitCost || 0) }), effect: 'unit' };
  }
  var withSales = Object.create(null);
  readSheet(SHEETS.ENTRIES).forEach(function (e) { if (!e.voided && e.productId && Number(e.qty || 0) > 0) withSales[e.productId] = true; });
  var guessed = Object.create(null);
  products.forEach(function (p) { if (p.type !== 'services' && !p.stockOf) guessed[p.id] = guess(p); });
  // a product drawing from another (the old link) follows it
  products.forEach(function (p) {
    if (p.type === 'services' || !p.stockOf) return;
    var a = guessed[p.stockOf];
    if (a && a.item) guessed[p.id] = { item: a.item, effect: a.item.kind === 'cylinder' ? (INV_EFFECTS_.indexOf(p.stockEffect) >= 0 ? p.stockEffect : 'exchange') : 'unit' };
    else guessed[p.id] = guess(p);
  });
  products.forEach(function (p) {
    if (p.type === 'services') return;
    var g = guessed[p.id];
    if (g.toService && withSales[p.id]) { plan.push({ productId: p.id, name: p.name, toService: false, hasSales: true }); return; }
    if (g.toService) { plan.push({ productId: p.id, name: p.name, toService: true }); return; }
    var line = { productId: p.id, name: p.name, stockItemKey: g.item.key, stockEffect: g.effect, toService: false };
    if (g.effect === 'exchange' && p.returnOf && guessed[p.returnOf] && guessed[p.returnOf].item && guessed[p.returnOf].item.kind === 'cylinder' && guessed[p.returnOf].item.key !== g.item.key) line.returnItemKey = guessed[p.returnOf].item.key;
    // what the product's own costs say about its item
    var it = g.item, cost = Number(p.unitCost || 0);
    if (it.kind === 'cylinder') {
      if (g.effect === 'exchange' && cost > 0 && !it.gasCost) it.gasCost = cost;
      if (g.effect === 'exchange' && Number(p.emptyCost) > 0 && !it.cylinderCost) it.cylinderCost = Number(p.emptyCost);
      if (g.effect === 'sell_empty' && cost > 0 && !it.cylinderCost) it.cylinderCost = cost;
    }
    plan.push(line);
  });
  var res = { stockItems: items, products: plan, withSales: Object.keys(withSales) };
  var chk = inventorySetupCheck_(res);
  res.legacyMoves = chk.legacyMoves; res.conflicts = chk.conflicts;
  return res;
}

// A plan checked against the stock on file: where each old count lands, two
// old openings landing on one item and state at one branch (never summed), and
// a product with movements left unmapped.
function inventorySetupCheck_(plan) {
  var items = Object.create(null), lines = Object.create(null), names = Object.create(null);
  (plan.stockItems || []).forEach(function (s) { if (s && s.key != null) items[String(s.key)] = s; });
  readSheet(SHEETS.STOCK_ITEMS).forEach(function (s) { items['id:' + s.id] = s; });
  (plan.products || []).forEach(function (l) { if (l && l.productId) lines[l.productId] = l; });
  readSheet(SHEETS.PRODUCTS).forEach(function (p) { names[p.id] = p.name; });
  function keyOf(l) { return l.stockItemKey != null && l.stockItemKey !== '' ? String(l.stockItemKey) : l.stockItemId ? 'id:' + l.stockItemId : ''; }
  var per = Object.create(null), openings = Object.create(null), unmapped = [];
  readSheet(SHEETS.INV_MOVES).forEach(function (m) {
    if (m.voided || !m.productId || m.stockItemId) return;
    var l = lines[m.productId], k = l && !l.toService ? keyOf(l) : '', it = k ? items[k] : null;
    if (!it) { if (unmapped.indexOf(m.productId) < 0) unmapped.push(m.productId); return; }
    var st = it.kind === 'cylinder' ? (m.state || invEffectState_(l.stockEffect)) : null;
    var x = per[m.productId] = per[m.productId] || { productId: m.productId, name: names[m.productId] || '', count: 0, maps: { stockItemKey: k, state: st }, openings: [] };
    x.count++;
    if (m.kind === 'opening') {
      x.openings.push({ locationId: m.locationId, qty: Number(m.qty || 0), state: st, rawState: m.state || null });
      var ok = m.locationId + '|' + k + '|' + (st || '');
      (openings[ok] = openings[ok] || { locationId: m.locationId, stockItemKey: k, state: st, productIds: [] });
      if (openings[ok].productIds.indexOf(m.productId) < 0) openings[ok].productIds.push(m.productId);
    }
  });
  var conflicts = Object.keys(openings).map(function (k) { return openings[k]; }).filter(function (o) { return o.productIds.length > 1; })
    .map(function (o) { o.names = o.productIds.map(function (id) { return names[id] || id; }); return o; });
  return { legacyMoves: Object.keys(per).map(function (k) { return per[k]; }), conflicts: conflicts, unmapped: unmapped };
}

function actionInventorySetupProposal_(req, user) {
  requireManager_(user);
  if (stockItemsLive_()) return { ok: false, error: 'already_applied' };
  var p = inventorySetupProposal_();
  return { ok: true, stockItems: p.stockItems, products: p.products, legacyMoves: p.legacyMoves, conflicts: p.conflicts, withSales: p.withSales };
}

// What the setup would change, branch by branch: each stock line's ending now,
// read the old way and read with the plan. The empties rise by the exchanges
// recorded since the count, because their empties now come back.
function actionInventorySetupPreview_(req, user) {
  requireManager_(user);
  if (stockItemsLive_()) return { ok: false, error: 'already_applied' };
  var plan = { stockItems: req.stockItems, products: req.products };
  var v = inventorySetupValidate_(plan);
  if (v.error) return { ok: false, error: v.error, name: v.name || null };
  var items = Object.create(null), lineOf = Object.create(null), products = Object.create(null);
  readSheet(SHEETS.STOCK_ITEMS).forEach(function (s) { items[s.id] = s; });
  Object.keys(v.items).forEach(function (key) { var d = v.items[key], o = {}; safeOwnKeys_(d).forEach(function (k) { o[k] = d[k]; }); o.id = key; items[key] = o; });
  readSheet(SHEETS.PRODUCTS).forEach(function (p) { var o = {}; safeOwnKeys_(p).forEach(function (k) { o[k] = p[k]; }); products[p.id] = o; });
  v.lines.forEach(function (l) {
    var o = products[l.product.id];
    if (l.toService) { o.type = 'services'; o.stockItemId = ''; o.stockEffect = ''; o.returnItemId = ''; return; }
    if (!l.itemKey && !l.itemId) { o.stockItemId = ''; return; }
    o.stockItemId = l.itemKey || l.itemId; o.stockEffect = l.effect; o.returnItemId = l.backKey || l.backId || '';
    lineOf[o.id] = o;
  });
  var today = todayRiyadh_();
  var before = actionInventoryReport_({ dateFrom: today, dateTo: today }, user);
  var after = actionInventoryReport_({ dateFrom: today, dateTo: today }, user, invStockCtx_({ products: products, items: items }));
  if (!before.ok || !after.ok) return { ok: false, error: before.error || after.error };
  var lines = Object.create(null), order = [];
  function line(loc, key, st) {
    var k = loc + '|' + key + '|' + (st || '');
    if (!lines[k]) { lines[k] = { locationId: loc, stockItemKey: key, state: st || null, name: items[key] ? items[key].name : '', before: null, after: null }; order.push(k); }
    return lines[k];
  }
  after.rows.forEach(function (r) { var x = line(r.locationId, r.stockItemId, r.state); if (!r.noOpening) x.after = r.ending; });
  before.rows.forEach(function (r) {
    // an old row was a product: it lands where that product's counts land
    var p = lineOf[r.stockItemId], it = p ? items[p.stockItemId] : null;
    if (!it || r.noOpening) return;
    var st = it.kind === 'cylinder' ? (r.state && products[r.stockItemId] && products[r.stockItemId].cylinder ? r.state : invEffectState_(p.stockEffect)) : null;
    var x = line(r.locationId, it.id, st);
    x.before = Math.round(((x.before || 0) + r.ending) * 1000) / 1000;
  });
  return { ok: true, lines: order.map(function (k) { return lines[k]; }) };
}

// The plan checked line by line. Returns {error, key|productId} or {items, lines}.
function inventorySetupValidate_(plan) {
  if (!plan || !Array.isArray(plan.stockItems) || !Array.isArray(plan.products) || plan.stockItems.length > 500 || plan.products.length > 2000) return { error: 'invalid_input' };
  var items = Object.create(null), existing = Object.create(null);
  readSheet(SHEETS.STOCK_ITEMS).forEach(function (s) { existing[s.id] = s; });
  for (var i = 0; i < plan.stockItems.length; i++) {
    var s = plan.stockItems[i] || {}, key = String(s.key == null ? '' : s.key);
    if (!key || hasOwn_(items, key)) return { error: 'invalid_input', index: i };
    var d = stockItemClean_({ name: s.name, kind: s.kind, boxSize: s.boxSize, gasCost: s.gasCost, cylinderCost: s.cylinderCost, unitCost: s.unitCost, active: true });
    var err = validateEntity_('stock_item', d);
    if (err) return { error: err, key: key, name: s.name || '' };
    items[key] = d;
  }
  var lines = [], seen = Object.create(null);
  for (var j = 0; j < plan.products.length; j++) {
    var l = plan.products[j] || {}, p = l.productId ? getById_(SHEETS.PRODUCTS, l.productId) : null;
    if (!p || hasOwn_(seen, p.id)) return { error: 'invalid_product', index: j };
    seen[p.id] = true;
    if (l.toService === true) {
      // a sales item that sold is not turned into a service: its past sales would leave the stock
      if (readSheet(SHEETS.ENTRIES).some(function (e) { return !e.voided && e.productId === p.id && Number(e.qty || 0) > 0; })) return { error: 'has_sales', productId: p.id, name: p.name };
      lines.push({ product: p, toService: true }); continue;
    }
    var it = null, itKey = l.stockItemKey != null && l.stockItemKey !== '' ? String(l.stockItemKey) : '';
    if (itKey) it = hasOwn_(items, itKey) ? items[itKey] : null;
    else if (l.stockItemId) it = hasOwn_(existing, String(l.stockItemId)) ? existing[l.stockItemId] : null;
    if (!it && (itKey || l.stockItemId)) return { error: 'invalid_stock_link', productId: p.id, name: p.name };
    if (!it) { lines.push({ product: p }); continue; }
    var eff = String(l.stockEffect || (it.kind === 'cylinder' ? 'exchange' : 'unit'));
    if (it.kind === 'cylinder' ? INV_EFFECTS_.indexOf(eff) < 0 : eff !== 'unit') return { error: 'invalid_stock_link', productId: p.id, name: p.name };
    var back = null, bKey = l.returnItemKey != null && l.returnItemKey !== '' ? String(l.returnItemKey) : '';
    if (bKey || l.returnItemId) {
      back = bKey ? (hasOwn_(items, bKey) ? items[bKey] : null) : (hasOwn_(existing, String(l.returnItemId)) ? existing[l.returnItemId] : null);
      if (!back || back.kind !== 'cylinder' || eff !== 'exchange') return { error: 'invalid_return_link', productId: p.id, name: p.name };
    }
    lines.push({ product: p, itemKey: itKey, itemId: itKey ? null : it.id, effect: eff, backKey: bKey, backId: bKey ? null : (back ? back.id : null) });
  }
  return { items: items, lines: lines };
}

// Writes the plan: the inventory items (numbered STK, names sent for
// translation), each sales item's link, and the service-like items made
// services. Moves and entries are never touched. Returns the rows written.
// The caller holds the script lock.
function migrateStockItems_(plan, userId) {
  userId = userId || 'system';
  var v = inventorySetupValidate_(plan);
  if (v.error) return v;
  var chk = inventorySetupCheck_(plan);
  if (chk.conflicts.length) return { error: 'opening_conflict', conflicts: chk.conflicts, names: chk.conflicts[0].names };
  if (chk.unmapped.length) return { error: 'moves_unmapped', productIds: chk.unmapped, names: chk.unmapped.map(function (id) { var p = getById_(SHEETS.PRODUCTS, id); return p ? p.name : id; }) };
  var today = todayRiyadh_(), at = new Date().toISOString(), ids = Object.create(null), written = 0, names = [];
  // a confirm that stopped half-way left some items: they are reused, never written twice
  var done = Object.create(null);
  readSheet(SHEETS.STOCK_ITEMS).forEach(function (s) { if (s.fromSetup && s.setupKey != null) done[String(s.setupKey)] = s; });
  // ... but only the same item: a page opened again numbers its own new items afresh, so a key
  // alone could land on another item. Same name and kind, or the confirm is refused whole.
  var keys = Object.keys(v.items);
  for (var ki = 0; ki < keys.length; ki++) {
    var dn = done[keys[ki]], pn = v.items[keys[ki]];
    if (dn && (normalizeName_(dn.name) !== normalizeName_(pn.name) || dn.kind !== pn.kind)) return { error: 'setup_mismatch', key: keys[ki], name: pn.name };
  }
  Object.keys(v.items).forEach(function (key) {
    if (done[key]) {
      var re = done[key], pl = v.items[key], ch = false;
      // the confirmed plan's costs and box size stand: the setup is not live yet, so nobody
      // could have dated a cost on this item and there is no cost history to keep
      ['boxSize', 'gasCost', 'cylinderCost', 'unitCost'].forEach(function (f) { if (String(re[f] == null ? '' : re[f]) !== String(pl[f] == null ? '' : pl[f])) { re[f] = pl[f]; ch = true; } });
      if (ch) { re.since = today; writeRow(SHEETS.STOCK_ITEMS, re); written++; }
      ids[key] = re.id; names = names.concat(translatableOf_(re)); return;
    }
    var d = v.items[key];
    d.id = Utilities.getUuid(); d.code = nextCode_('stock_item'); d.since = today; d.fromSetup = true; d.setupKey = key; d.createdAt = at;
    var s = writeRow(SHEETS.STOCK_ITEMS, d);
    ids[key] = s.id; written++; names = names.concat(translatableOf_(s));
    logAudit_('migrate_stock_item', userId, s.id + ' ' + s.code + ' ' + s.name);
  });
  v.lines.forEach(function (l) {
    var p = l.product;
    var was = { type: p.type, stockItemId: p.stockItemId, stockEffect: p.stockEffect, returnItemId: p.returnItemId };
    if (l.toService) { p.type = 'services'; p.stockItemId = ''; p.stockEffect = ''; p.returnItemId = ''; }
    else if (l.itemKey || l.itemId) {
      p.stockItemId = l.itemKey ? ids[l.itemKey] : l.itemId; p.stockEffect = l.effect;
      p.returnItemId = l.backKey ? ids[l.backKey] : (l.backId || '');
    } else return;
    if (was.type === p.type && String(was.stockItemId || '') === String(p.stockItemId || '') && String(was.stockEffect || '') === String(p.stockEffect || '') && String(was.returnItemId || '') === String(p.returnItemId || '')) return;   // already linked by the stopped run
    writeRow(SHEETS.PRODUCTS, p); written++;
    logAudit_('migrate_stock_item', userId, p.id + (l.toService ? ' -> service' : ' -> ' + p.stockItemId + ' ' + p.stockEffect));
  });
  return { ok: true, written: written, names: names, stockItemIds: ids };
}

function actionApplyInventorySetup_(req, user) {
  requireManager_(user);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var res;
  try {
    freshenExec_();
    if (stockItemsLive_()) return { ok: false, error: 'already_applied' };
    res = migrateStockItems_({ stockItems: req.stockItems, products: req.products }, user.id);
    if (!res.ok) return { ok: false, error: res.error, key: res.key || null, productId: res.productId || null, name: res.name || null, names: res.names || null, conflicts: res.conflicts || null, index: res.index != null ? res.index : null };
    setScriptProp_(INV_SETUP_FLAG_, new Date().toISOString());
    logAudit_('inventory_setup', user.id, Object.keys(res.stockItemIds).length + ' items, ' + res.written + ' rows');
  } finally { try { lock.releaseLock(); } catch (e) {} }
  fillTranslations_(res.names);
  return { ok: true, written: res.written, stockItemIds: res.stockItemIds };
}
