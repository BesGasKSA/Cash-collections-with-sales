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
// The refill cycle (2026-10-06): a branch sends its empties to the plant
// (refill_out: empty −N, at the plant +N) and receives them back filled
// (refill_in: filled +N, at the plant −N). A receipt never exceeds what that
// branch has at the plant for that item; an extra cylinder is new cylinders or
// a transfer. A full purchase saved before the cycle existed stays a one-step
// refill, read as it always was.
var INV_KINDS_ = ['opening', 'purchase', 'return', 'damage', 'transfer_in', 'transfer_out', 'refill_out', 'refill_in', 'deposit_out', 'deposit_return', 'car_load', 'car_return',
  // 2026-10-07: gas lost (a filled cylinder that lost its gas is an empty one), and a physical count's difference
  'waste', 'count_gain', 'count_loss'];
// why stock was written off: a list, so the reports can group it (2026-10-07)
var INV_REASONS_ = { damage: ['broken_body', 'expired_test', 'other'], waste: ['gas_leak', 'valve_failure', 'short_fill', 'other'] };
var INV_COUNT_ = { count_gain: 1, count_loss: 1 };
// purchases need their supplier and invoice, write-offs their reason (config.invControls, default on)
function invControls_() { return config_().invControls !== false; }
// stock is valued at the weighted average of what it cost (default), or at the standard cost
function invAverage_() { return config_().invValuation !== 'standard'; }
var INV_REFILL_STATE_ = { refill_out: 'empty', refill_in: 'full' };
// Cylinders on deposit with a customer (عهدة): out leaves the branch, return comes
// back; a customer never returns more than he holds of an item. A car's load and
// return move stock between the store and the car: the branch total is unchanged.
var INV_DEPOSIT_ = { deposit_out: 1, deposit_return: 1 };
var INV_CAR_ = { car_load: 1, car_return: 1 };
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
  // the refill cycle moves cylinders only: empties out, filled back
  if (hasOwn_(INV_REFILL_STATE_, kind)) {
    if (!cyl) return { error: 'refill_cylinder_only' };
    if (st && st !== INV_REFILL_STATE_[kind]) return { error: 'invalid_state' };
    st = INV_REFILL_STATE_[kind];
  }
  if (cyl ? INV_STATES_.indexOf(st) < 0 : st !== '') return { error: 'invalid_state' };
  // brand-new cylinders bought: counted in, but no empties went out to be filled
  if (m.newCylinders != null && m.newCylinders !== true && m.newCylinders !== false) return { error: 'invalid_new_cylinders' };
  var fresh = m.newCylinders === true;
  if (fresh && !(kind === 'purchase' && cyl && st === 'full')) return { error: 'invalid_new_cylinders' };
  if (!invDateOk_(date)) return { error: 'invalid_date' };
  if (date > todayRiyadh_()) return { error: 'future_date' };
  var move = { state: st || null, kind: kind, qty: qty, newCylinders: fresh, note: String(m.note || '').slice(0, 300) };
  // what one unit cost, as typed (with or without VAT, like every cost), for stock coming in
  if (m.unitCost != null && m.unitCost !== '') {
    if (['opening', 'purchase', 'refill_in'].indexOf(kind) < 0) return { error: 'invalid_cost' };
    var uc = Number(m.unitCost); if (!isFinite(uc) || uc < 0 || uc > 1000000) return { error: 'invalid_cost' };
    move.unitCost = Math.round(uc * 10000) / 10000;
  }
  if (kind === 'purchase' || kind === 'refill_in') {
    move.supplier = String(m.supplier || '').trim().slice(0, 120); move.invoiceNo = String(m.invoiceNo || '').trim().slice(0, 60);
  }
  if (kind === 'waste' && !(cyl && st === 'full')) return { error: 'waste_full_only' };
  if (hasOwn_(INV_REASONS_, kind)) {
    var rs = String(m.reason || '');
    if (rs && INV_REASONS_[kind].indexOf(rs) < 0) return { error: 'invalid_reason' };
    move.reason = rs || null;
  }
  if (key.stockItemId) move.stockItemId = key.stockItemId; else move.productId = key.productId;
  // a deposit names its customer, a registered and active one
  if (hasOwn_(INV_DEPOSIT_, kind)) {
    var cid = String(m.customerId || '');
    if (!cid) return { error: 'customer_required' };
    var cu = getById_(SHEETS.CUSTOMERS, cid);
    if (!cu) return { error: 'unknown_customer' };
    if (cu.active === false && kind === 'deposit_out') return { error: 'invalid_customer' };
    move.customerId = cu.id;
  }
  return { move: move, itemId: it.id };
}
// What one customer holds of one item from one branch: out less back, any state.
function invHeld_(sc, locId, itemId, customerId) {
  var held = 0;
  sc.moves.forEach(function (m) {
    if (m.voided || m.locationId !== locId || m.customerId !== customerId || !hasOwn_(INV_DEPOSIT_, m.kind)) return;
    var tg = sc.moveTarget(m); if (!tg || tg.item.id !== itemId) return;
    held += (m.kind === 'deposit_out' ? 1 : -1) * Number(m.qty || 0);
  });
  return Math.round(held * 1000) / 1000;
}
// What a branch has at the plant for one item: empties sent up to a day, less
// every filled one received back (any day), and when the oldest still out left.
function invPlant_(sc, locId, itemId, uptoDate) {
  var sent = 0, back = 0, outs = [];
  sc.moves.forEach(function (m) {
    if (m.voided || m.locationId !== locId || !hasOwn_(INV_REFILL_STATE_, m.kind)) return;
    var tg = sc.moveTarget(m); if (!tg || tg.item.id !== itemId) return;
    var q = Number(m.qty || 0);
    if (m.kind === 'refill_out') { if (!uptoDate || m.date <= uptoDate) { sent += q; outs.push({ date: m.date, qty: q }); } }
    else back += q;
  });
  // first in, first out: the receipts close the oldest dispatches first
  outs.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  var left = back, oldest = null;
  for (var i = 0; i < outs.length; i++) { if (left >= outs[i].qty) { left -= outs[i].qty; continue; } oldest = outs[i].date; break; }
  var r = function (x) { return Math.round(x * 1000) / 1000; };
  return { sent: r(sent), received: r(back), atPlant: r(sent - back), oldest: oldest };
}
function invMoveRow_(locId, c, date, user, extra) {
  var row = { locationId: locId, state: c.state, kind: c.kind, qty: c.qty, date: date, newCylinders: c.newCylinders, note: c.note,
    enteredBy: user.id, createdAt: new Date().toISOString(), voided: false };
  if (c.stockItemId) row.stockItemId = c.stockItemId; else row.productId = c.productId;
  if (c.customerId) row.customerId = c.customerId;
  // what it cost, from whom, on which invoice; why it was written off (2026-10-07)
  if (c.unitCost != null) row.unitCost = c.unitCost;
  if (c.supplier) row.supplier = c.supplier;
  if (c.invoiceNo) row.invoiceNo = c.invoiceNo;
  if (c.reason) row.reason = c.reason;
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
    if (hasOwn_(INV_COUNT_, c.move.kind)) return { ok: false, error: 'use_stock_count' };
    if (invControls_()) {
      if (c.move.kind === 'purchase' && (!c.move.supplier || !c.move.invoiceNo)) return { ok: false, error: 'purchase_needs_reference' };
      if (hasOwn_(INV_REASONS_, c.move.kind) && !c.move.reason) return { ok: false, error: 'reason_required' };
    }
    // a car's load and return go through carStockMove, which names the car
    if (hasOwn_(INV_CAR_, c.move.kind)) return { ok: false, error: 'use_car_move' };
    // nobody returns more than he holds
    if (c.move.kind === 'deposit_return') {
      var hd = invHeld_(invStockCtx_(), lf.loc.id, c.itemId, c.move.customerId);
      if (c.move.qty > hd + 0.0005) return { ok: false, error: 'deposit_over_held', held: hd };
    }
    // filled cylinders come back only for empties this branch sent
    if (c.move.kind === 'refill_in') {
      var pl = invPlant_(invStockCtx_(), lf.loc.id, c.itemId, date);
      if (c.move.qty > pl.atPlant + 0.0005) return { ok: false, error: 'refill_over_sent', atPlant: pl.atPlant };
    }
    var move = writeRow(SHEETS.INV_MOVES, invMoveRow_(lf.loc.id, c.move, date, user));
    logAudit_('inventory_' + c.move.kind, user.id, move.id);
    return { ok: true, move: move };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// One transfer, both sides (2026-10-06): out at the sending branch and in at the
// receiving one, sharing a linkId, all lines or none. Who keeps the sending
// branch sends; the receiving branch is any other branch.
function actionTransferInventory_(req, user) {
  var lf = invLocFor_(user, req.fromLocationId);
  if (lf.error) return { ok: false, error: lf.error };
  var to = getById_(SHEETS.LOCATIONS, req.toLocationId);
  if (!to) return { ok: false, error: 'branch_required' };
  if (to.id === lf.loc.id) return { ok: false, error: 'same_branch' };
  var date = String(req.date || ''), list = Array.isArray(req.lines) ? req.lines : [];
  if (!list.length || list.length > 50) return { ok: false, error: 'invalid_input' };
  var sc = invStockCtx_(), checked = [];
  for (var i = 0; i < list.length; i++) {
    var ln = list[i] || {}, c = invCheckMove_({ stockItemId: ln.stockItemId, productId: ln.productId, state: ln.state, qty: ln.qty, kind: 'transfer_out', note: req.note }, date, sc);
    if (c.error) return { ok: false, error: c.error, index: i };
    checked.push(c);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    var linkId = Utilities.getUuid(), moves = [];
    checked.forEach(function (c) {
      var outM = {}, inM = {};
      safeOwnKeys_(c.move).forEach(function (k) { outM[k] = c.move[k]; inM[k] = c.move[k]; });
      inM.kind = 'transfer_in';
      moves.push(writeRow(SHEETS.INV_MOVES, invMoveRow_(lf.loc.id, outM, date, user, { linkId: linkId, toLocationId: to.id })));
      moves.push(writeRow(SHEETS.INV_MOVES, invMoveRow_(to.id, inM, date, user, { linkId: linkId, fromLocationId: lf.loc.id })));
    });
    logAudit_('inventory_transfer', user.id, lf.loc.id + ' > ' + to.id + ' (' + checked.length + ')');
    return { ok: true, moves: moves, linkId: linkId };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// A car's morning load or evening return: stock moves between the store and the
// car of the same branch; the branch total is unchanged. Who keeps the branch
// records it (not the driver himself).
function actionCarStockMove_(req, user) {
  var lf = invLocFor_(user, req.locationId);
  if (lf.error) return { ok: false, error: lf.error };
  var car = getById_(SHEETS.CARS, req.carId);
  if (!car || car.locationId !== lf.loc.id) return { ok: false, error: 'invalid_car' };
  var kind = String(req.kind || '');
  if (!hasOwn_(INV_CAR_, kind)) return { ok: false, error: 'invalid_kind' };
  var date = String(req.date || ''), list = Array.isArray(req.lines) ? req.lines : [];
  if (!list.length || list.length > 50) return { ok: false, error: 'invalid_input' };
  var sc = invStockCtx_(), checked = [];
  for (var i = 0; i < list.length; i++) {
    var ln = list[i] || {}, c = invCheckMove_({ stockItemId: ln.stockItemId, productId: ln.productId, state: ln.state, qty: ln.qty, kind: 'purchase', note: req.note }, date, sc);
    if (c.error) return { ok: false, error: c.error, index: i };
    c.move.kind = kind; c.move.newCylinders = false;
    checked.push(c);
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    var moves = checked.map(function (c) { return writeRow(SHEETS.INV_MOVES, invMoveRow_(lf.loc.id, c.move, date, user, { carId: car.id })); });
    logAudit_('inventory_' + kind, user.id, car.id + ' (' + moves.length + ')');
    return { ok: true, moves: moves };
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
    if (!c.error && hasOwn_(INV_COUNT_, c.move.kind)) c = { error: 'use_stock_count' };
    if (!c.error && invControls_() && hasOwn_(INV_REASONS_, c.move.kind) && !c.move.reason) c = { error: 'reason_required' };
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
    // a dispatch whose cylinders already came back cannot be taken away from under them
    if (m.kind === 'refill_out') {
      var sc0 = invStockCtx_(), tg0 = sc0.moveTarget(m);
      if (tg0) { var p0 = invPlant_(sc0, m.locationId, tg0.item.id, null); if (p0.atPlant - Number(m.qty || 0) < -0.0005) return { ok: false, error: 'refill_received' }; }
    }
    // nor a deposit whose cylinders the customer already returned
    if (m.kind === 'deposit_out') {
      var sc1 = invStockCtx_(), tg1 = sc1.moveTarget(m);
      if (tg1 && invHeld_(sc1, m.locationId, tg1.item.id, m.customerId) - Number(m.qty || 0) < -0.0005) return { ok: false, error: 'deposit_returned' };
    }
    var stamp = { voidReason: reason.slice(0, 300), voidedBy: user.id, voidedAt: new Date().toISOString() };
    m.voided = true; m.voidReason = stamp.voidReason; m.voidedBy = stamp.voidedBy; m.voidedAt = stamp.voidedAt;
    writeRow(SHEETS.INV_MOVES, m);
    // a transfer is one movement in two places: both sides go together
    var partners = [];
    if (m.linkId) readSheet(SHEETS.INV_MOVES).forEach(function (x) {
      if (x.id === m.id || x.voided || x.linkId !== m.linkId) return;
      x.voided = true; x.voidReason = stamp.voidReason; x.voidedBy = stamp.voidedBy; x.voidedAt = stamp.voidedAt;
      writeRow(SHEETS.INV_MOVES, x); partners.push(x.id);
    });
    logAudit_('inventory_void', user.id, m.id + (partners.length ? ' +' + partners.join(',') : ''));
    return { ok: true, move: m, partners: partners };
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
// Stock is valued before VAT (2026-10-06): a cost typed with VAT has it taken out.
function invUnitValue_(it, state, date, hist) {
  if (!it.virtual && invAverage_()) { var av = invAvgEx_(it, state, date, hist); if (av != null) return av; }
  return costExVat_(invUnitValueAsTyped_(it, state, date, hist), date);
}
function invUnitValueAsTyped_(it, state, date, hist) {
  if (it.virtual) return state === 'empty' ? it.cylinderCost : state === 'full' ? it.gasCost + it.cylinderCost : it.unitCost;
  if (it.kind !== 'cylinder') return stockItemCostOn_(it, 'unitCost', date, hist).v;
  var cyl = stockItemCostOn_(it, 'cylinderCost', date, hist).v;
  return state === 'empty' ? cyl : stockItemCostOn_(it, 'gasCost', date, hist).v + cyl;
}

// ---------- weighted average cost (2026-10-07, IAS 2) ----------
// A moving average, company-wide, per item: each receipt (opening count,
// purchase, refill from the plant, count gain) is averaged with what is on hand
// at that moment; issues (sales, damage, waste, count loss) leave at the average
// and lower what is on hand, so the average follows the stock actually held. A
// cylinder keeps two pools, the gas (a filling) and the body: a filled cylinder is
// worth gas + body, an empty one the body. Every cost is taken out of VAT at the
// rate of its own day, so the average is already before VAT. A receipt with no
// cost of its own counts at the standard cost of its day.
function invAvgPools_(hist) {
  var ex = exec_(); if (ex.invAvg) return ex.invAvg;
  var items = Object.create(null); readSheet(SHEETS.STOCK_ITEMS).forEach(function (s) { items[s.id] = s; });
  var products = Object.create(null); readSheet(SHEETS.PRODUCTS).forEach(function (p) { products[p.id] = p; });
  var ev = [];
  function std(it, field, d) { return costExVat_(stockItemCostOn_(it, field, d, hist).v, d); }
  // atAvg: what is found by a count comes in at the average it joins (the standard cost only while there is none)
  function inn(itemId, pool, d, at, q, unitEx, atAvg) { ev.push({ k: itemId + '|' + pool, d: d, at: at || '', q: q, c: unitEx, rcv: true, atAvg: !!atAvg }); }
  function out(itemId, pool, d, at, q) { ev.push({ k: itemId + '|' + pool, d: d, at: at || '', q: q, rcv: false }); }
  readSheet(SHEETS.INV_MOVES).forEach(function (m) {
    if (m.voided || !m.stockItemId) return;
    var it = items[m.stockItemId]; if (!it) return;
    var q = Number(m.qty || 0); if (!(q > 0)) return;
    var d = m.date, at = m.createdAt, own = m.unitCost != null && m.unitCost !== '' ? costExVat_(Number(m.unitCost), d) : null;
    var cylF = it.kind === 'cylinder' && m.state !== 'empty', cylE = it.kind === 'cylinder' && m.state === 'empty';
    var receipt = ['opening', 'purchase', 'refill_in', 'count_gain'].indexOf(m.kind) >= 0;
    var issue = ['damage', 'waste', 'count_loss'].indexOf(m.kind) >= 0;
    if (it.kind !== 'cylinder') {
      if (receipt) inn(it.id, 'unit', d, at, q, own != null ? own : std(it, 'unitCost', d), m.kind === 'count_gain');
      else if (issue) out(it.id, 'unit', d, at, q);
      return;
    }
    var gasStd = std(it, 'gasCost', d), bodyStd = std(it, 'cylinderCost', d);
    var found = m.kind === 'count_gain';
    if (receipt) {
      if (cylE) { inn(it.id, 'body', d, at, q, own != null ? own : bodyStd, found); return; }
      // a filling (refill, a full purchase that sent empties): the price paid is the gas
      if ((m.kind === 'purchase' && m.newCylinders !== true) || m.kind === 'refill_in') { inn(it.id, 'gas', d, at, q, own != null ? own : gasStd); return; }
      // filled cylinders that are new to the company (an opening, new cylinders, a count gain): gas and body, the price paid covering both
      var whole = own != null ? own : gasStd + bodyStd;
      inn(it.id, 'gas', d, at, q, gasStd, found); inn(it.id, 'body', d, at, q, Math.max(0, whole - gasStd), found);
      return;
    }
    if (issue) {
      if (cylE) { out(it.id, 'body', d, at, q); return; }
      out(it.id, 'gas', d, at, q);
      // gas lost leaves the body; a broken or missing filled cylinder takes the body too
      if (m.kind !== 'waste') out(it.id, 'body', d, at, q);
    }
  });
  // sales: an exchange takes gas, a filled cylinder sold takes gas and body, an empty sold the body
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.productId || !(Number(e.qty || 0) > 0)) return;
    var p = products[e.productId]; if (!p || !p.stockItemId || !items[p.stockItemId]) return;
    var it = items[p.stockItemId], q = Number(e.qty), d = e.date, at = e.createdAt;
    if (it.kind !== 'cylinder') { out(it.id, 'unit', d, at, q); return; }
    var eff = INV_EFFECTS_.indexOf(p.stockEffect) >= 0 ? p.stockEffect : 'exchange';
    if (eff === 'sell_empty') { out(it.id, 'body', d, at, q); return; }
    out(it.id, 'gas', d, at, q);
    if (eff === 'sell_full') out(it.id, 'body', d, at, q);
  });
  // in date order; within a day, receipts first
  ev.sort(function (a, b) { return String(a.d).localeCompare(String(b.d)) || (a.rcv === b.rcv ? String(a.at).localeCompare(String(b.at)) : (a.rcv ? -1 : 1)); });
  var st = Object.create(null), line = Object.create(null);
  ev.forEach(function (x) {
    var s = st[x.k] || (st[x.k] = { q: 0, avg: null });
    if (x.rcv) {
      if (x.atAvg && s.avg != null) x.c = s.avg;
      var held = Math.max(0, s.q);
      s.avg = held > 0 && s.avg != null ? (held * s.avg + x.q * x.c) / (held + x.q) : x.c;
      s.q = held + x.q;
      (line[x.k] = line[x.k] || []).push({ d: x.d, avg: s.avg });
    } else s.q -= x.q;
  });
  ex.invAvg = line; return line;
}
function invAvgOf_(line, itemId, pool, date) {
  var list = line[itemId + '|' + pool]; if (!list) return null;
  var v = null; for (var i = 0; i < list.length && String(list[i].d) <= date; i++) v = list[i].avg;
  return v;
}
// before VAT
function invAvgEx_(it, state, date, hist) {
  var line = invAvgPools_(hist);
  if (it.kind !== 'cylinder') return invAvgOf_(line, it.id, 'unit', date);
  var body = invAvgOf_(line, it.id, 'body', date); if (body == null) body = costExVat_(stockItemCostOn_(it, 'cylinderCost', date, hist).v, date);
  if (state === 'empty') return body;
  var gas = invAvgOf_(line, it.id, 'gas', date); if (gas == null) gas = costExVat_(stockItemCostOn_(it, 'gasCost', date, hist).v, date);
  return gas + body;
}

// ---------- a physical count (2026-10-07) ----------
// The branch counts what it holds; the difference from what the app says is
// written as a count gain or loss on the count's day, with the counted figure.
function actionRecordStockCount_(req, user) {
  var lf = invLocFor_(user, req.locationId);
  if (lf.error) return { ok: false, error: lf.error };
  var date = String(req.date || '');
  if (!invDateOk_(date)) return { ok: false, error: 'invalid_date' };
  if (date > todayRiyadh_()) return { ok: false, error: 'future_date' };
  var lines = Array.isArray(req.lines) ? req.lines : [];
  if (!lines.length || lines.length > 100) return { ok: false, error: 'invalid_input' };
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    freshenExec_();
    var sc = invStockCtx_();
    if (!sc.live) return { ok: false, error: 'setup_required' };
    // the shelf is counted before the day's sales (they arrive later in the day's entry):
    // the figure it is compared with is the closing of the day before
    var prev = Utilities.formatDate(new Date(Date.parse(date + 'T12:00:00Z') - 86400000), 'UTC', 'yyyy-MM-dd');
    var rep = actionInventoryReport_({ dateFrom: prev, dateTo: prev, locationId: lf.loc.id }, user, sc);
    if (!rep.ok) return rep;
    var have = Object.create(null); rep.rows.forEach(function (r) { if (!r.noOpening) have[r.stockItemId + '|' + (r.state || '')] = r.ending; });
    var out = [], seen = Object.create(null);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i] || {}, it = hasOwn_(sc.items, String(l.stockItemId)) ? sc.items[l.stockItemId] : null;
      if (!it) return { ok: false, error: 'invalid_stock_item', index: i };
      var st = it.kind === 'cylinder' ? String(l.state || '') : '';
      if (it.kind === 'cylinder' && INV_STATES_.indexOf(st) < 0) return { ok: false, error: 'invalid_state', index: i };
      var key = it.id + '|' + st; if (seen[key]) return { ok: false, error: 'invalid_input', index: i }; seen[key] = true;
      var cv = l.counted, counted = (typeof cv === 'number' && cv === 0) || cv === '0' ? 0 : invQty_(cv);
      if (counted == null) return { ok: false, error: 'invalid_qty', index: i };
      if (!hasOwn_(have, key)) return { ok: false, error: 'opening_required', index: i, name: it.name };
      var diff = Math.round((counted - have[key]) * 1000) / 1000;
      out.push({ it: it, st: st, counted: counted, system: have[key], diff: diff });
    }
    var countId = Utilities.getUuid(), written = [];
    out.forEach(function (o) {
      if (!o.diff) return;
      var c = { stockItemId: o.it.id, state: o.st || null, kind: o.diff > 0 ? 'count_gain' : 'count_loss', qty: Math.abs(o.diff), newCylinders: false, note: String(req.note || '').slice(0, 300) };
      written.push(writeRow(SHEETS.INV_MOVES, invMoveRow_(lf.loc.id, c, date, user, { countId: countId, counted: o.counted, systemQty: o.system })));
    });
    logAudit_('inventory_count', user.id, lf.loc.id + ' ' + date + ' ' + out.length + ' lines, ' + written.length + ' differences');
    return { ok: true, countId: countId, lines: out.map(function (o) { return { stockItemId: o.it.id, state: o.st || null, counted: o.counted, system: o.system, diff: o.diff }; }), moves: written };
  } finally { try { lock.releaseLock(); } catch (e) {} }
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
        opening: 0, purchases: 0, newCylinders: 0, returns: 0, exchangeIn: 0, transfersIn: 0, fromPlant: 0, depositBack: 0, sales: 0, damaged: 0, refillOut: 0, toPlant: 0, transfersOut: 0, depositOut: 0,
        wasted: 0, leakedIn: 0, countGain: 0, countLoss: 0, purchasesCost: 0,
        salesWithoutQty: 0, salesWithoutQtyAmount: 0, salesBySource: {}, salesByProduct: {},
        openingDate: op ? op.date : null, noOpening: !op || op.date > to };
      // before the setup a row keeps its old shape too, for a client that has not reloaded
      if (!sc.live) { rows[k].productId = it.id; rows[k].stockName = sc.products[it.id] ? (sc.products[it.id].stockName || '') : ''; }
      order.push(k);
    }
    return rows[k];
  }
  var IN_ = { purchases: 1, returns: 1, exchangeIn: 1, transfersIn: 1, fromPlant: 1, depositBack: 1, leakedIn: 1, countGain: 1 };
  // add a quantity dated d to the period it belongs to
  function post(r, d, field, q) {
    if (r.noOpening || d < r.openingDate || d > to) return;
    if (d < from) { r.opening += IN_[field] ? q : -q; return; }
    r[field] += q;
  }
  var MOVE_FIELD_ = { purchase: 'purchases', 'return': 'returns', damage: 'damaged', transfer_in: 'transfersIn', transfer_out: 'transfersOut', refill_out: 'toPlant', refill_in: 'fromPlant', deposit_out: 'depositOut', deposit_return: 'depositBack',
    waste: 'wasted', count_gain: 'countGain', count_loss: 'countLoss' };
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
    // a car's load and return stay inside the branch: its total does not move
    if (hasOwn_(INV_CAR_, m.kind)) return;
    var r = row(m.locationId, t.item, t.state), q = Number(m.qty || 0);
    if (m.kind === 'opening') { if (!r.noOpening) r.opening += q; return; }
    post(r, m.date, MOVE_FIELD_[m.kind], q);
    // what the purchases in the period actually cost, before VAT (2026-10-07)
    if ((m.kind === 'purchase' || m.kind === 'refill_in') && m.unitCost != null && !r.noOpening && m.date >= from && m.date >= r.openingDate) r.purchasesCost += q * costExVat_(Number(m.unitCost), m.date);
    // a filled cylinder that lost its gas is an empty one: the body stays
    if (m.kind === 'waste' && t.item.kind === 'cylinder' && t.state === 'full') post(row(m.locationId, t.item, 'empty'), m.date, 'leakedIn', q);
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
    ['opening', 'purchases', 'newCylinders', 'returns', 'exchangeIn', 'transfersIn', 'fromPlant', 'depositBack', 'sales', 'damaged', 'refillOut', 'toPlant', 'transfersOut', 'depositOut', 'wasted', 'leakedIn', 'countGain', 'countLoss'].forEach(function (f) { r[f] = Math.round(r[f] * 1000) / 1000; });
    r.purchasesCost = Math.round(r.purchasesCost * 100) / 100;
    r.salesWithoutQtyAmount = Math.round(r.salesWithoutQtyAmount * 100) / 100;
    r.available = Math.round((r.opening + r.purchases + r.returns + r.exchangeIn + r.transfersIn + r.fromPlant + r.depositBack + r.leakedIn + r.countGain) * 1000) / 1000;
    r.ending = Math.round((r.available - r.sales - r.damaged - r.refillOut - r.toPlant - r.transfersOut - r.depositOut - r.wasted - r.countLoss) * 1000) / 1000;
    r.short = !r.noOpening && r.ending < 0;
    ['opening', 'purchases', 'returns', 'exchangeIn', 'transfersIn', 'fromPlant', 'depositBack', 'available', 'sales', 'damaged', 'refillOut', 'toPlant', 'transfersOut', 'depositOut', 'ending', 'wasted', 'leakedIn', 'countGain', 'countLoss'].forEach(function (f) {
      r[f + 'Value'] = Math.round(r[f] * r.unitCost * 100) / 100;
    });
    return r;
  });
  // At the plant, and gas and cylinders, per branch and cylinder type (2026-10-06):
  // gas = filled; cylinders = filled + empty at the branch + at the plant.
  var cyl = Object.create(null), cylOrder = [];
  out.forEach(function (r) {
    if (!r.cylinder) return;
    var k = r.locationId + '|' + r.stockItemId;
    if (!cyl[k]) { cyl[k] = { locationId: r.locationId, stockItemId: r.stockItemId, itemName: r.itemName, filled: 0, empty: 0, noOpening: false, filledValue: 0, emptyValue: 0 }; cylOrder.push(k); }
    var c = cyl[k];
    if (r.noOpening) c.noOpening = true;
    if (r.state === 'full') { c.filled = r.ending; c.filledValue = r.endingValue; } else { c.empty = r.ending; c.emptyValue = r.endingValue; }
  });
  // a branch with empties out at the plant but no row in the period still shows them
  sc.moves.forEach(function (m) {
    if (m.voided || !hasOwn_(INV_REFILL_STATE_, m.kind) || !inScope(m.locationId) || m.date > to) return;
    var tg = sc.moveTarget(m); if (!tg) return;
    var k = m.locationId + '|' + tg.item.id;
    if (!cyl[k]) { cyl[k] = { locationId: m.locationId, stockItemId: tg.item.id, itemName: tg.item.name || '', filled: 0, empty: 0, noOpening: true, filledValue: 0, emptyValue: 0 }; cylOrder.push(k); }
  });
  var r3 = function (x) { return Math.round(x * 1000) / 1000; };
  // cylinders on deposit with customers (عهدة), all time up to the end of the period
  var held = Object.create(null), heldOrder = [];
  sc.moves.forEach(function (m) {
    if (m.voided || !hasOwn_(INV_DEPOSIT_, m.kind) || !inScope(m.locationId) || m.date > to) return;
    var tg = sc.moveTarget(m); if (!tg) return;
    var k = m.locationId + '|' + m.customerId + '|' + tg.item.id;
    if (!held[k]) { held[k] = { locationId: m.locationId, customerId: m.customerId, stockItemId: tg.item.id, out: 0, back: 0, held: 0, last: '' }; heldOrder.push(k); }
    var h = held[k], q = Number(m.qty || 0);
    if (m.kind === 'deposit_out') h.out += q; else h.back += q;
    if (m.date > h.last) h.last = m.date;
  });
  var customerHoldings = heldOrder.map(function (k) { var h = held[k]; h.out = r3(h.out); h.back = r3(h.back); h.held = r3(h.out - h.back); return h; }).filter(function (h) { return h.out || h.back; });
  var withCust = Object.create(null);
  customerHoldings.forEach(function (h) { var k = h.locationId + '|' + h.stockItemId; withCust[k] = (withCust[k] || 0) + h.held; if (!cyl[k] && sc.item(h.stockItemId) && sc.item(h.stockItemId).kind === 'cylinder') { cyl[k] = { locationId: h.locationId, stockItemId: h.stockItemId, itemName: sc.item(h.stockItemId).name || '', filled: 0, empty: 0, noOpening: true, filledValue: 0, emptyValue: 0 }; cylOrder.push(k); } });
  // stock on each car (2026-10-06): tracked from the car's first load; loaded less
  // returned, less what the car sold, plus the empties its exchanges took back
  var carSince = Object.create(null);
  sc.moves.forEach(function (m) {
    if (m.voided || !hasOwn_(INV_CAR_, m.kind) || !m.carId || !inScope(m.locationId) || m.date > to) return;
    if (!carSince[m.carId] || m.date < carSince[m.carId]) carSince[m.carId] = m.date;
  });
  var carRows = Object.create(null), carOrder = [];
  function carRow(locId, carId, it, st) {
    var k = carId + '|' + it.id + '|' + (st || '');
    if (!carRows[k]) { carRows[k] = { locationId: locId, carId: carId, stockItemId: it.id, state: st || null, loaded: 0, returned: 0, sold: 0, exchangeIn: 0, onCar: 0, since: carSince[carId] }; carOrder.push(k); }
    return carRows[k];
  }
  sc.moves.forEach(function (m) {
    if (m.voided || !hasOwn_(INV_CAR_, m.kind) || !m.carId || !inScope(m.locationId) || m.date > to) return;
    var tg = sc.moveTarget(m); if (!tg) return;
    var cr = carRow(m.locationId, m.carId, tg.item, tg.state);
    if (m.kind === 'car_load') cr.loaded += Number(m.qty || 0); else cr.returned += Number(m.qty || 0);
  });
  if (Object.keys(carSince).length) {
    var posMap = posById_();
    readSheet(SHEETS.ENTRIES).forEach(function (e) {
      if (e.voided || !e.productId || !e.date || e.date > to || !Number(e.qty || 0)) return;
      var carId = entryCarId_(e, posMap);
      if (!carId || !carSince[carId] || e.date < carSince[carId]) return;
      var link = sc.saleLink(e.productId); if (!link) return;
      var q = Number(e.qty || 0);
      var st = link.effect === 'unit' ? null : link.effect === 'sell_empty' ? 'empty' : 'full';
      carRow(e.locationId, carId, link.item, st).sold += q;
      if (link.effect === 'exchange') carRow(e.locationId, carId, link.back, 'empty').exchangeIn += q;
    });
  }
  var cars = carOrder.map(function (k) { var c = carRows[k]; ['loaded', 'returned', 'sold', 'exchangeIn'].forEach(function (f) { c[f] = r3(c[f]); }); c.onCar = r3(c.loaded - c.returned - c.sold + c.exchangeIn); c.short = c.onCar < 0; return c; });
  var onCars = Object.create(null);
  cars.forEach(function (c) { var k = c.locationId + '|' + c.stockItemId + '|' + (c.state || ''); onCars[k] = (onCars[k] || 0) + c.onCar; });
  var plant = [], cylSummary = cylOrder.map(function (k) {
    var c = cyl[k], it = sc.item(c.stockItemId) || sc.items[c.stockItemId] || null, p = invPlant_(sc, c.locationId, c.stockItemId, to);
    var bodyCost = it ? Math.round(Number(invUnitValue_(it, 'empty', to, hist) || 0) * 10000) / 10000 : 0;
    c.atPlant = p.atPlant; c.plantSent = p.sent; c.plantReceived = p.received; c.plantOldest = p.oldest;
    c.withCustomers = r3(withCust[k] || 0);
    // the branch's filled and empty include what is on its cars; the store holds the rest
    c.onCarsFilled = r3(onCars[k + '|full'] || 0); c.onCarsEmpty = r3(onCars[k + '|empty'] || 0);
    c.inStoreFilled = r3(c.filled - c.onCarsFilled); c.inStoreEmpty = r3(c.empty - c.onCarsEmpty);
    c.gas = c.filled; c.bodies = r3(c.filled + c.empty + p.atPlant + c.withCustomers);
    c.withCustomersValue = Math.round(c.withCustomers * bodyCost * 100) / 100;
    c.atPlantValue = Math.round(p.atPlant * bodyCost * 100) / 100;
    c.gasKg = it && Number(it.fillKg) > 0 ? Math.round(c.gas * Number(it.fillKg) * 1000) / 1000 : null;
    if (p.sent || p.received) plant.push({ locationId: c.locationId, stockItemId: c.stockItemId, sent: p.sent, received: p.received, atPlant: p.atPlant, oldest: p.oldest, value: c.atPlantValue });
    return c;
  });
  moves.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, dateFrom: from, dateTo: to, rows: out, cylSummary: cylSummary, plant: plant, customerHoldings: customerHoldings, cars: cars,
    moves: moves.slice(0, 2000), movesTotal: moves.length, stockItemsLive: sc.live };
}

// ---------- The stock card (2026-10-06) ----------
// One branch and one inventory item: every movement in the order it happened
// (the opening count, sales and exchanges from the day entries, purchases,
// empties sent to the plant and filled received, transfers, returns, damage),
// each with its number, who and when, what it did to filled, empty and at the
// plant, and the balances after it: filled, empty, at the plant, gas, cylinders.
// The same rules as actionInventoryReport_, so the card's last line is the
// report's ending. Nothing before the opening count counts.
function actionStockLedger_(req, user) {
  var scope = invReadBranches_(user);
  if (scope === false) return { ok: false, error: 'forbidden' };
  var locId = String(req.locationId || ''), itemId = String(req.stockItemId || req.productId || '');
  if (!locId || !getById_(SHEETS.LOCATIONS, locId)) return { ok: false, error: 'branch_required' };
  if (scope && scope.indexOf(locId) < 0) return { ok: false, error: 'forbidden' };
  var today = todayRiyadh_();
  var from = req.dateFrom ? String(req.dateFrom) : '2020-01-01', to = req.dateTo ? String(req.dateTo) : today;
  if (!invDateOk_(from) || !invDateOk_(to) || from > to) return { ok: false, error: 'invalid_period' };
  var sc = invStockCtx_(), it = sc.item(itemId);
  if (!it) return { ok: false, error: 'invalid_stock_item' };
  var cyl = it.kind === 'cylinder';
  // the opening count: per state for a cylinder, one for a unit item
  var openings = Object.create(null);
  sc.moves.forEach(function (m) {
    if (m.voided || m.kind !== 'opening' || m.locationId !== locId) return;
    var tg = sc.moveTarget(m); if (tg && tg.item.id === it.id) openings[tg.state || ''] = m;
  });
  var openDate = Object.keys(openings).map(function (k) { return openings[k].date; }).sort()[0] || null;
  var ev = [];
  function push(o) { ev.push(o); }
  sc.moves.forEach(function (m) {
    if (m.voided || m.locationId !== locId || m.date > to) return;
    var tg = sc.moveTarget(m); if (!tg || tg.item.id !== it.id) return;
    var q = Number(m.qty || 0), s = tg.state, d = { full: 0, empty: 0, plant: 0, cust: 0, unit: 0 };
    if (m.kind === 'opening') { if (cyl) d[s] = q; else d.unit = q; }
    else if (m.kind === 'refill_out') { d.empty = -q; d.plant = q; }
    else if (m.kind === 'refill_in') { d.full = q; d.plant = -q; }
    // a deposit leaves the branch for the customer and comes back from him
    else if (m.kind === 'deposit_out') { if (cyl) { d[s] = -q; d.cust = q; } else d.unit = -q; }
    else if (m.kind === 'deposit_return') { if (cyl) { d[s] = q; d.cust = -q; } else d.unit = q; }
    // a car's load and return stay inside the branch: listed, no effect on its balance
    else if (hasOwn_(INV_CAR_, m.kind)) { /* zero effect */ }
    else {
      var sign = ({ purchase: 1, 'return': 1, transfer_in: 1, count_gain: 1, damage: -1, transfer_out: -1, waste: -1, count_loss: -1 })[m.kind] || 0;
      if (cyl && s === 'full' && m.kind === 'waste') d.empty += q;
      if (cyl) d[s] += sign * q; else d.unit += sign * q;
      // a full purchase saved before the cycle existed is a one-step refill: as many empties went
      if (cyl && s === 'full' && m.kind === 'purchase' && m.newCylinders !== true) d.empty -= q;
    }
    push({ date: m.date, at: m.createdAt || '', kind: m.kind, newCylinders: m.newCylinders === true, txNo: m.txNo || '', by: m.enteredBy, note: m.note || '', moveId: m.id, d: d, opening: m.kind === 'opening',
      customerId: m.customerId || null, carId: m.carId || null, toLocationId: m.toLocationId || null, fromLocationId: m.fromLocationId || null, qty: q });
  });
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided || !e.productId || e.locationId !== locId || !e.date || e.date > to) return;
    var link = sc.saleLink(e.productId); if (!link) return;
    var q = Number(e.qty || 0); if (!q) return;
    var d = { full: 0, empty: 0, plant: 0, cust: 0, unit: 0 }, mine = false;
    if (link.item.id === it.id) {
      mine = true;
      if (link.effect === 'unit') d.unit -= q;
      else if (link.effect === 'sell_empty') d.empty -= q;
      else d.full -= q;
    }
    if (link.effect === 'exchange' && link.back.id === it.id) { mine = true; d.empty += q; }
    if (!mine) return;
    push({ date: e.date, at: e.createdAt || '', kind: 'sale', effect: link.effect, productId: e.productId, txNo: e.txNo ? e.txNo + (Number(e.txLine) > 1 ? '/' + e.txLine : '') : '',
      by: e.enteredBy, sourceType: e.sourceType, sourceId: e.sourceId, entryId: e.id, d: d });
  });
  // the count opens the day; within a day, in the order the rows were saved
  ev.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || (b.opening ? 1 : 0) - (a.opening ? 1 : 0) || String(a.at).localeCompare(String(b.at)); });
  var KS = ['full', 'empty', 'plant', 'cust', 'unit'];
  var bal = { full: 0, empty: 0, plant: 0, cust: 0, unit: 0 }, lines = [], openBal = null, r3 = function (x) { return Math.round(x * 1000) / 1000; };
  function snap() { var b = {}; KS.forEach(function (k) { b[k] = r3(bal[k]); }); if (cyl) { b.gas = b.full; b.bodies = r3(bal.full + bal.empty + bal.plant + bal.cust); } return b; }
  ev.forEach(function (x) {
    // before the opening count only what is away moves (at the plant, with customers)
    var counted = openDate && x.date >= openDate;
    if (!counted && !(x.d.plant || x.d.cust)) return;
    if (!counted) x.d = { full: 0, empty: 0, plant: x.d.plant, cust: x.d.cust, unit: 0 };
    if (x.date < from) { KS.forEach(function (k) { bal[k] += x.d[k]; }); return; }
    if (!openBal) openBal = snap();
    KS.forEach(function (k) { bal[k] += x.d[k]; x.d[k] = r3(x.d[k]); });
    x.bal = snap();
    delete x.opening;
    lines.push(x);
  });
  if (!openBal) openBal = snap();
  var endBal = lines.length ? lines[lines.length - 1].bal : openBal;
  return { ok: true, locationId: locId, stockItemId: it.id, itemName: it.name || '', cylinder: cyl, fillKg: Number(it.fillKg || 0) || null,
    dateFrom: from, dateTo: to, openingDate: openDate, noOpening: !openDate, opening: openBal, ending: endBal, lines: lines.slice(-3000), linesTotal: lines.length };
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
