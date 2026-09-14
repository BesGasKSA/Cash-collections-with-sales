/**
 * Collection.gs — the actual cash-collection domain: daily figures per
 * source (store / car / pos), the handoff+confirm approval chain
 * (location -> cluster -> collector -> bank deposit), disputes, sales
 * reporting, and dashboards. See CLAUDE.md for the formula and chain.
 */

// ---------- Lookups scoped to the hierarchy ----------

function storeOfManager_(userId) {
  var rows = readSheet(SHEETS.STORES);
  for (var i = 0; i < rows.length; i++) if (rows[i].storeManagerUserId === userId) return rows[i];
  return null;
}

function storeOfLocation_(locationId) {
  var rows = readSheet(SHEETS.STORES);
  for (var i = 0; i < rows.length; i++) if (rows[i].locationId === locationId) return rows[i];
  return null;
}

// location_to_cluster/cluster_to_collector handoffs carry clusterId
// directly; a car_to_location handoff only carries locationId, so its
// cluster (for escalation-recipient purposes) has to be resolved one hop
// up through the location instead.
function clusterIdForHandoff_(handoff) {
  if (handoff.clusterId) return handoff.clusterId;
  if (handoff.locationId) {
    var loc = getById_(SHEETS.LOCATIONS, handoff.locationId);
    if (loc) return loc.clusterId;
  }
  return null;
}

function clusterManagerOwnsCluster_(userId, clusterId) {
  var c = getById_(SHEETS.CLUSTERS, clusterId);
  return !!c && c.clusterManagerUserId === userId;
}

function collectorClusterIds_(userId) {
  return readSheet(SHEETS.CLUSTERS)
    .filter(function (c) { return c.collectorUserId === userId; })
    .map(function (c) { return c.id; });
}

function resolveSourceLocation_(sourceType, sourceId) {
  if (sourceType === 'store') {
    var s = getById_(SHEETS.STORES, sourceId);
    return s ? s.locationId : null;
  }
  if (sourceType === 'car') {
    var c = getById_(SHEETS.CARS, sourceId);
    return c ? c.locationId : null;
  }
  if (sourceType === 'pos') {
    var p = getById_(SHEETS.POS, sourceId);
    if (!p) return null;
    if (p.ownerType === 'store') {
      var st = getById_(SHEETS.STORES, p.ownerId);
      return st ? st.locationId : null;
    }
    if (p.ownerType === 'car') {
      var cr = getById_(SHEETS.CARS, p.ownerId);
      return cr ? cr.locationId : null;
    }
  }
  return null;
}

function checkEntryScope_(user, sourceType, sourceId) {
  var locationId = resolveSourceLocation_(sourceType, sourceId);
  if (!locationId) return { ok: false, error: 'not_found' };

  if (user.role === 'admin') return { ok: true, locationId: locationId };

  if (user.role === 'store_manager') {
    var store = storeOfManager_(user.id);
    if (!store || store.locationId !== locationId) return { ok: false, error: 'forbidden' };
    return { ok: true, locationId: locationId };
  }

  if (user.role === 'driver') {
    if (sourceType === 'car') {
      var car = getById_(SHEETS.CARS, sourceId);
      if (!car || car.driverUserId !== user.id) return { ok: false, error: 'forbidden' };
      return { ok: true, locationId: locationId };
    }
    if (sourceType === 'pos') {
      var pos = getById_(SHEETS.POS, sourceId);
      if (!pos || pos.assignedUserId !== user.id) return { ok: false, error: 'forbidden' };
      return { ok: true, locationId: locationId };
    }
    return { ok: false, error: 'forbidden' };
  }

  return { ok: false, error: 'forbidden' };
}

// ---------- Daily entries ----------

// A delivery fee is charged for delivering something that was sold — it
// can never stand alone. Shared by both the single-entry and bulk-import
// paths below: `siblingHasSale` lets a caller vouch that another row in
// the very same submission already carries the cash/POS sale (the normal
// case for "product mode", where the sale and its delivery fee are split
// across two separate product lines/entries in one batch); failing that,
// there must already be an entry on file for this exact source+date that
// sold something, or the delivery fee is rejected outright.
function deliveryNeedsSale_(sourceType, sourceId, date, cashSales, posSales, siblingHasSale, creditSales) {
  if (Number(cashSales || 0) > 0 || Number(posSales || 0) > 0 || Number(creditSales || 0) > 0) return true;
  if (siblingHasSale) return true;
  return readSheet(SHEETS.ENTRIES).some(function (e) {
    return e.sourceType === sourceType && e.sourceId === sourceId && e.date === date &&
      (Number(e.cashSales || 0) > 0 || Number(e.posSales || 0) > 0 || Number(e.creditSales || 0) > 0);
  });
}

function actionCreateEntry_(req, user) {
  if (!req.date || !req.sourceType || !req.sourceId) return { ok: false, error: 'invalid_input' };
  var scope = checkEntryScope_(user, req.sourceType, req.sourceId);
  if (!scope.ok) return { ok: false, error: scope.error };

  if (Number(req.deliveryFeeBankAmount || 0) > 0 &&
    !deliveryNeedsSale_(req.sourceType, req.sourceId, req.date, req.cashSales, req.posSales, false, req.creditSales)) {
    return { ok: false, error: 'delivery_without_sale' };
  }

  var entry = {
    id: Utilities.getUuid(),
    date: req.date,
    sourceType: req.sourceType,
    sourceId: req.sourceId,
    locationId: scope.locationId,
    enteredBy: user.id,
    productId: req.productId || null,
    cashSales: Number(req.cashSales || 0),
    deliveryFeeBankAmount: Number(req.deliveryFeeBankAmount || 0),
    posSales: Number(req.posSales || 0),
    // Sold on credit: counts toward total sales (byProduct, the daily trend,
    // the report totals) exactly like posSales does, but — same as posSales —
    // never enters computeNet_'s cash formula. No money has actually moved
    // yet, so there is nothing to hand up the collection chain for it.
    creditSales: Number(req.creditSales || 0),
    // Qty/unit price are optional, purely informational passthrough for the
    // client's "product-level" entry mode (qty x unitPrice = the amount
    // already folded into cashSales/posSales/deliveryFeeBankAmount above,
    // per whichever payment method the line was tagged with) — never
    // touched by computeNet_ or anything downstream, so there is nothing
    // here for a mismatch between these two and the real amount fields to
    // break; they exist only so a receipt/report can show the per-product
    // subtotal that produced the figure.
    qty: req.qty != null && req.qty !== '' ? Number(req.qty) : null,
    unitPrice: req.unitPrice != null && req.unitPrice !== '' ? Number(req.unitPrice) : null,
    // LPG cylinder exchange — independent of the cash formula, pure
    // physical-inventory counts (see CLAUDE.md "Cylinder tracking").
    cylindersOut: Number(req.cylindersOut || 0),
    cylindersIn: Number(req.cylindersIn || 0),
    note: req.note || '',
    consumedBy: null
  };
  writeRow(SHEETS.ENTRIES, entry);
  logAudit_('create_entry', user.id, entry.id);
  return { ok: true, entry: entry };
}

// Bulk version of actionCreateEntry_ for CSV/Excel import — same per-row
// scope check and field shape, just looped, so a bad row can't silently
// corrupt a good one. Capped well under Apps Script's execution limit.
function actionImportEntries_(req, user) {
  var rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length) return { ok: false, error: 'invalid_input' };
  if (rows.length > 500) return { ok: false, error: 'too_many_rows' };

  // "Product mode" on the client splits one real-world sale into several
  // rows in the same submission (e.g. a cash-tagged goods line plus a
  // separate delivery-tagged line) — so a delivery-only row here has to be
  // checked against its siblings in this same batch, not just itself.
  function batchHasSale(sourceType, sourceId, date) {
    return rows.some(function (row) {
      return row.sourceType === sourceType && row.sourceId === sourceId && row.date === date &&
        (Number(row.cashSales || 0) > 0 || Number(row.posSales || 0) > 0 || Number(row.creditSales || 0) > 0);
    });
  }

  var results = [];
  var created = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    if (!r.date || !r.sourceType || !r.sourceId) {
      results.push({ row: i, ok: false, error: 'invalid_input' });
      continue;
    }
    var scope = checkEntryScope_(user, r.sourceType, r.sourceId);
    if (!scope.ok) {
      results.push({ row: i, ok: false, error: scope.error });
      continue;
    }
    if (Number(r.deliveryFeeBankAmount || 0) > 0 &&
      !deliveryNeedsSale_(r.sourceType, r.sourceId, r.date, r.cashSales, r.posSales, batchHasSale(r.sourceType, r.sourceId, r.date), r.creditSales)) {
      results.push({ row: i, ok: false, error: 'delivery_without_sale' });
      continue;
    }
    var entry = {
      id: Utilities.getUuid(),
      date: r.date,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      locationId: scope.locationId,
      enteredBy: user.id,
      productId: r.productId || null,
      cashSales: Number(r.cashSales || 0),
      deliveryFeeBankAmount: Number(r.deliveryFeeBankAmount || 0),
      posSales: Number(r.posSales || 0),
      creditSales: Number(r.creditSales || 0),
      qty: r.qty != null && r.qty !== '' ? Number(r.qty) : null,
      unitPrice: r.unitPrice != null && r.unitPrice !== '' ? Number(r.unitPrice) : null,
      cylindersOut: Number(r.cylindersOut || 0),
      cylindersIn: Number(r.cylindersIn || 0),
      note: r.note || '',
      consumedBy: null
    };
    writeRow(SHEETS.ENTRIES, entry);
    created++;
    results.push({ row: i, ok: true, id: entry.id });
  }
  logAudit_('import_entries', user.id, created + '/' + rows.length);
  return { ok: true, created: created, total: rows.length, results: results };
}

function actionListEntries_(req, user) {
  var rows = readSheet(SHEETS.ENTRIES);

  if (isCompanyWide_(user.role)) {
    // full visibility
  } else if (user.role === 'cluster_manager') {
    var locIds = readSheet(SHEETS.LOCATIONS)
      .filter(function (l) { return clusterManagerOwnsCluster_(user.id, l.clusterId); })
      .map(function (l) { return l.id; });
    rows = rows.filter(function (e) { return locIds.indexOf(e.locationId) >= 0; });
  } else if (user.role === 'store_manager') {
    var store = storeOfManager_(user.id);
    rows = rows.filter(function (e) { return store && e.locationId === store.locationId; });
  } else if (user.role === 'driver') {
    rows = rows.filter(function (e) { return e.enteredBy === user.id; });
  } else {
    rows = [];
  }

  if (req.locationId) rows = rows.filter(function (e) { return e.locationId === req.locationId; });
  if (req.date) rows = rows.filter(function (e) { return e.date === req.date; });

  rows.sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
  return { ok: true, entries: rows };
}

function unconsumedEntriesForLocation_(locationId) {
  return readSheet(SHEETS.ENTRIES).filter(function (e) { return e.locationId === locationId && !e.consumedBy && !e.voided; });
}

// Gross "total sales" for one entry — cash + POS + credit, regardless of
// cash-collection risk. Used for report filtering/aggregation only; never
// for computeNet_'s cash-owed formula, which credit sales stay out of.
function entrySalesTotal_(e) {
  return Number(e.cashSales || 0) + Number(e.posSales || 0) + Number(e.creditSales || 0);
}

// mirrors the xlsx formula, extended to POS: a POS machine can also take cash
// (not just card) and can also carry its own delivery fee paid to the bank —
// both are real cash risk / real deductions exactly like a car's, so they
// feed the same net-cash formula. posSales stays card/bank-only, no cash risk.
// A store or car can carry its own mounted POS terminal too, so a store/car
// entry can also report card/bank posSales alongside its cash — same
// no-cash-risk treatment as a dedicated 'pos' source, just logged on the
// store's/car's own entry instead of a separate pos_machines row. A store
// never has a delivery fee though (nothing to deliver), so that field stays
// car/pos-only.
// netCashOwed = branchCash + carCash + posCash - (carDeliveryFee + posDeliveryFee) + vatOnDelivery
function computeNet_(entries) {
  var storeCash = 0, carCash = 0, posCash = 0, deliveryFee = 0, posSales = 0, creditSales = 0;
  entries.forEach(function (e) {
    // creditSales is tallied the same way across all three source types as
    // posSales — a sale on credit carries no cash risk either, since no
    // money has moved yet, so it never touches netCashOwed below.
    creditSales += Number(e.creditSales || 0);
    if (e.sourceType === 'store') {
      storeCash += Number(e.cashSales || 0);
      posSales += Number(e.posSales || 0);
    } else if (e.sourceType === 'car') {
      carCash += Number(e.cashSales || 0);
      deliveryFee += Number(e.deliveryFeeBankAmount || 0);
      posSales += Number(e.posSales || 0);
    } else if (e.sourceType === 'pos') {
      posCash += Number(e.cashSales || 0);
      deliveryFee += Number(e.deliveryFeeBankAmount || 0);
      posSales += Number(e.posSales || 0);
    }
  });
  var vat = vatRate_();
  var vatOnDelivery = deliveryFee > 0 ? (deliveryFee / (1 + vat)) * vat : 0;
  var netCashOwed = storeCash + carCash + posCash - deliveryFee + vatOnDelivery;
  return {
    storeCash: storeCash, carCash: carCash, posCash: posCash, deliveryFee: deliveryFee,
    posSales: posSales, creditSales: creditSales, vatOnDelivery: vatOnDelivery, netCashOwed: netCashOwed
  };
}

// A cluster-to-collector handoff batches several already-confirmed
// location handoffs, and a deposit batches several cluster handoffs — each
// carries its own breakdown already, so the batch's breakdown is just their
// sum, never recomputed from entries (that would double-apply the VAT
// clawback). Without this, receivers only ever saw one flat total with no
// way to see what it was made of.
function sumBreakdowns_(breakdowns) {
  var out = { storeCash: 0, carCash: 0, posCash: 0, deliveryFee: 0, posSales: 0, creditSales: 0, vatOnDelivery: 0, netCashOwed: 0 };
  breakdowns.forEach(function (b) {
    if (!b) return;
    out.storeCash += Number(b.storeCash || 0);
    out.carCash += Number(b.carCash || 0);
    out.posCash += Number(b.posCash || 0);
    out.deliveryFee += Number(b.deliveryFee || 0);
    out.posSales += Number(b.posSales || 0);
    out.creditSales += Number(b.creditSales || 0);
    out.vatOnDelivery += Number(b.vatOnDelivery || 0);
    out.netCashOwed += Number(b.netCashOwed || 0);
  });
  return out;
}

// ---------- Handoffs (the approval gate) ----------

function actionCreateHandoff_(req, user) {
  if (req.kind === 'car_to_location') return createCarHandoff_(req, user);
  if (req.kind === 'location_to_cluster') return createLocationHandoff_(req, user);
  if (req.kind === 'cluster_to_collector') return createClusterHandoff_(req, user);
  return { ok: false, error: 'invalid_kind' };
}

// The cycle the xlsx "Cycle" sheet actually describes starts one hop earlier
// than location_to_cluster: a driver physically hands the store manager
// what he owes the company first, and that handoff needs its own
// confirm/dispute gate exactly like every other hop in the chain — before
// this, a car's cash was just aggregated straight into the location's
// totals with no receiving-party confirmation at all, which was the
// "missed cycle".
// The driver nets it out himself before handing anything over — the
// delivery fee was paid to the bank directly and is the driver's own
// incentive to keep (per the xlsx note), except the VAT portion of it,
// which the company still claws back. So what actually changes hands here
// is cashSales - deliveryFeeBankAmount + vatOnDelivery (computeNet_'s
// netCashOwed for this car alone), not the raw cash figure — confirmed
// directly by the user against their own process (2026-09-13): a driver
// handing over the full, un-netted cash was wrong.
function createCarHandoff_(req, user) {
  var car = getById_(SHEETS.CARS, req.carId);
  if (!car) return { ok: false, error: 'not_found' };
  if (user.role !== 'admin' && (user.role !== 'driver' || car.driverUserId !== user.id)) {
    return { ok: false, error: 'forbidden' };
  }

  var location = getById_(SHEETS.LOCATIONS, car.locationId);
  if (!location) return { ok: false, error: 'not_found' };
  var store = storeOfLocation_(location.id);
  if (!store || !store.storeManagerUserId) return { ok: false, error: 'no_store_manager' };
  if (store.storeManagerUserId === user.id) return { ok: false, error: 'conflict_of_interest' };

  var entries = readSheet(SHEETS.ENTRIES).filter(function (e) {
    return e.sourceType === 'car' && e.sourceId === car.id && !e.consumedBy;
  });
  if (!entries.length) return { ok: false, error: 'no_entries' };
  var totals = computeNet_(entries);
  if (totals.netCashOwed <= 0) return { ok: false, error: 'nothing_owed' };

  var handoff = {
    id: Utilities.getUuid(),
    kind: 'car_to_location',
    fromUserId: user.id,
    toUserId: store.storeManagerUserId,
    locationId: location.id,
    carId: car.id,
    amount: totals.netCashOwed,
    breakdown: totals,
    sourceEntryIds: entries.map(function (e) { return e.id; }),
    sourceHandoffIds: [],
    consumedBy: null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  writeRow(SHEETS.HANDOFFS, handoff);
  entries.forEach(function (e) { e.consumedBy = handoff.id; writeRow(SHEETS.ENTRIES, e); });
  logAudit_('create_handoff_car', user.id, handoff.id);
  notifyPending_(handoff);
  return { ok: true, handoff: handoff };
}

function createLocationHandoff_(req, user) {
  var location = getById_(SHEETS.LOCATIONS, req.locationId);
  if (!location) return { ok: false, error: 'not_found' };

  if (user.role !== 'admin') {
    var storeCheck = storeOfManager_(user.id);
    if (user.role !== 'store_manager' || !storeCheck || storeCheck.locationId !== location.id) {
      return { ok: false, error: 'forbidden' };
    }
  }

  var cluster = getById_(SHEETS.CLUSTERS, location.clusterId);
  if (!cluster || !cluster.clusterManagerUserId) return { ok: false, error: 'no_cluster_manager' };
  if (cluster.clusterManagerUserId === user.id) return { ok: false, error: 'conflict_of_interest' };

  // A car entry normally has to clear its own driver -> store-manager
  // handoff first (createCarHandoff_ above) before it can be swept up into
  // this batch — the one exception is a car entry the store manager
  // entered themself (the "same person wears both hats" case the xlsx
  // notes call out: a store manager who is also the store sales rep and
  // just types the car's numbers in directly), which was never anyone
  // else's cash to hand over in the first place.
  var store = storeOfLocation_(location.id);
  var allUnconsumed = unconsumedEntriesForLocation_(location.id);
  var directEntries = allUnconsumed.filter(function (e) {
    return e.sourceType !== 'car' || (store && e.enteredBy === store.storeManagerUserId);
  });

  var heldCarHandoffs = readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'car_to_location' && h.locationId === location.id && h.status === 'confirmed' && !h.consumedBy;
  });

  if (!directEntries.length && !heldCarHandoffs.length) return { ok: false, error: 'no_entries' };
  var totals = sumBreakdowns_([computeNet_(directEntries)].concat(heldCarHandoffs.map(function (h) { return h.breakdown; })));
  if (totals.netCashOwed <= 0) return { ok: false, error: 'nothing_owed' };

  var handoff = {
    id: Utilities.getUuid(),
    kind: 'location_to_cluster',
    fromUserId: user.id,
    toUserId: cluster.clusterManagerUserId,
    locationId: location.id,
    clusterId: cluster.id,
    amount: totals.netCashOwed,
    breakdown: totals,
    sourceEntryIds: directEntries.map(function (e) { return e.id; }),
    sourceHandoffIds: heldCarHandoffs.map(function (h) { return h.id; }),
    consumedBy: null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  writeRow(SHEETS.HANDOFFS, handoff);
  directEntries.forEach(function (e) { e.consumedBy = handoff.id; writeRow(SHEETS.ENTRIES, e); });
  heldCarHandoffs.forEach(function (h) { h.consumedBy = handoff.id; writeRow(SHEETS.HANDOFFS, h); });
  logAudit_('create_handoff_location', user.id, handoff.id);
  notifyPending_(handoff);
  return { ok: true, handoff: handoff };
}

function createClusterHandoff_(req, user) {
  var cluster = getById_(SHEETS.CLUSTERS, req.clusterId);
  if (!cluster) return { ok: false, error: 'not_found' };
  if (user.role !== 'admin' && cluster.clusterManagerUserId !== user.id) return { ok: false, error: 'forbidden' };
  if (!cluster.collectorUserId) return { ok: false, error: 'no_collector' };
  if (cluster.collectorUserId === user.id) return { ok: false, error: 'conflict_of_interest' };

  var held = readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'location_to_cluster' && h.clusterId === cluster.id && h.status === 'confirmed' && !h.consumedBy;
  });
  if (!held.length) return { ok: false, error: 'no_held_cash' };
  var amount = held.reduce(function (s, h) { return s + Number(h.amount || 0); }, 0);
  var breakdown = sumBreakdowns_(held.map(function (h) { return h.breakdown; }));
  var perLocation = held.map(function (h) {
    return { locationId: h.locationId, amount: h.amount, breakdown: h.breakdown };
  });

  var handoff = {
    id: Utilities.getUuid(),
    kind: 'cluster_to_collector',
    fromUserId: user.id,
    toUserId: cluster.collectorUserId,
    clusterId: cluster.id,
    amount: amount,
    breakdown: breakdown,
    perLocation: perLocation,
    sourceEntryIds: [],
    sourceHandoffIds: held.map(function (h) { return h.id; }),
    consumedBy: null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  writeRow(SHEETS.HANDOFFS, handoff);
  held.forEach(function (h) { h.consumedBy = handoff.id; writeRow(SHEETS.HANDOFFS, h); });
  logAudit_('create_handoff_cluster', user.id, handoff.id);
  notifyPending_(handoff);
  return { ok: true, handoff: handoff };
}

// ---------- Area-manager bulk upload -> Deputy Operations Manager approval ----------
// A deliberate, toggleable exception to the normal chain above, for when a
// cluster's drivers/store managers genuinely can't use the app themselves:
// the Area (cluster) Manager uploads the whole cluster's day at once, and
// one Deputy Operations Manager sign-off replaces what would otherwise be a
// location_to_cluster handoff AND a cluster_to_collector handoff. Off by
// default (areaManagerBulkUploadEnabled_(), Code.gs). See CLAUDE.md.

// A parallel function to checkEntryScope_, deliberately NOT a branch added
// to it — a cluster_manager branch in checkEntryScope_ itself would silently
// let cluster managers use the ordinary single-entry/single-location-import
// actions too, a real widening of authority that would stay live even with
// this feature's toggle off (checkEntryScope_ has no knowledge of the
// config flag).
function checkClusterBulkEntryScope_(user, clusterId, sourceType, sourceId) {
  if (!areaManagerBulkUploadEnabled_()) return { ok: false, error: 'feature_disabled' };
  if (user.role !== 'cluster_manager' && user.role !== 'admin') return { ok: false, error: 'forbidden' };
  if (user.role === 'cluster_manager' && !clusterManagerOwnsCluster_(user.id, clusterId)) {
    return { ok: false, error: 'forbidden' };
  }
  var locationId = resolveSourceLocation_(sourceType, sourceId);
  if (!locationId) return { ok: false, error: 'not_found' };
  var loc = getById_(SHEETS.LOCATIONS, locationId);
  if (!loc || loc.clusterId !== clusterId) return { ok: false, error: 'forbidden' };
  return { ok: true, locationId: locationId };
}

// Same row shape and per-row checks as actionImportEntries_, but scoped to
// one cluster and, unlike that action, all-or-nothing: the Deputy reviewing
// this batch has no per-row visibility into what might have been silently
// skipped, so a batch with any bad row is rejected whole, nothing written,
// and the area manager fixes the file and resubmits clean.
function actionBulkSubmitAreaBatch_(req, user) {
  if (!areaManagerBulkUploadEnabled_()) return { ok: false, error: 'feature_disabled' };
  var cluster = getById_(SHEETS.CLUSTERS, req.clusterId);
  if (!cluster) return { ok: false, error: 'not_found' };
  if (user.role !== 'admin' && (user.role !== 'cluster_manager' || cluster.clusterManagerUserId !== user.id)) {
    return { ok: false, error: 'forbidden' };
  }

  var rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length) return { ok: false, error: 'invalid_input' };
  if (rows.length > 500) return { ok: false, error: 'too_many_rows' };

  function batchHasSale(sourceType, sourceId, date) {
    return rows.some(function (row) {
      return row.sourceType === sourceType && row.sourceId === sourceId && row.date === date &&
        (Number(row.cashSales || 0) > 0 || Number(row.posSales || 0) > 0 || Number(row.creditSales || 0) > 0);
    });
  }

  var prepared = [];
  var errors = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    if (!r.date || !r.sourceType || !r.sourceId) {
      errors.push({ row: i, error: 'invalid_input' });
      continue;
    }
    var scope = checkClusterBulkEntryScope_(user, cluster.id, r.sourceType, r.sourceId);
    if (!scope.ok) {
      errors.push({ row: i, error: scope.error });
      continue;
    }
    if (Number(r.deliveryFeeBankAmount || 0) > 0 &&
      !deliveryNeedsSale_(r.sourceType, r.sourceId, r.date, r.cashSales, r.posSales, batchHasSale(r.sourceType, r.sourceId, r.date), r.creditSales)) {
      errors.push({ row: i, error: 'delivery_without_sale' });
      continue;
    }
    prepared.push({ row: r, locationId: scope.locationId });
  }
  if (errors.length) return { ok: false, error: 'invalid_rows', results: errors };

  var batchId = Utilities.getUuid();
  var entries = prepared.map(function (p) {
    var r = p.row;
    var entry = {
      id: Utilities.getUuid(),
      date: r.date,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      locationId: p.locationId,
      enteredBy: user.id,
      productId: r.productId || null,
      cashSales: Number(r.cashSales || 0),
      deliveryFeeBankAmount: Number(r.deliveryFeeBankAmount || 0),
      posSales: Number(r.posSales || 0),
      creditSales: Number(r.creditSales || 0),
      qty: r.qty != null && r.qty !== '' ? Number(r.qty) : null,
      unitPrice: r.unitPrice != null && r.unitPrice !== '' ? Number(r.unitPrice) : null,
      cylindersOut: Number(r.cylindersOut || 0),
      cylindersIn: Number(r.cylindersIn || 0),
      note: r.note || '',
      batchId: batchId,
      consumedBy: batchId,
      voided: false
    };
    writeRow(SHEETS.ENTRIES, entry);
    return entry;
  });

  var byLocation = {};
  entries.forEach(function (e) {
    if (!byLocation[e.locationId]) byLocation[e.locationId] = [];
    byLocation[e.locationId].push(e);
  });
  var perLocation = Object.keys(byLocation).map(function (locationId) {
    var t = computeNet_(byLocation[locationId]);
    return { locationId: locationId, amount: t.netCashOwed, breakdown: t };
  });
  var breakdown = sumBreakdowns_(perLocation.map(function (p) { return p.breakdown; }));

  var batch = {
    id: batchId,
    clusterId: cluster.id,
    uploadedBy: user.id,
    createdAt: new Date().toISOString(),
    status: 'pending_deputy',
    entryIds: entries.map(function (e) { return e.id; }),
    breakdown: breakdown,
    perLocation: perLocation,
    rejectionNote: null,
    deputyActedBy: null,
    deputyActedAt: null,
    resultHandoffId: null
  };
  writeRow(SHEETS.AREA_BULK_BATCHES, batch);
  logAudit_('bulk_submit_area_batch', user.id, batch.id);
  notifyDeputyPendingBatch_(batch);
  return { ok: true, batch: batch };
}

function actionListAreaBulkBatches_(req, user) {
  var rows = readSheet(SHEETS.AREA_BULK_BATCHES);
  if (user.role === 'cluster_manager') {
    rows = rows.filter(function (b) { return b.uploadedBy === user.id; });
  } else if (user.role !== 'deputy_operations_manager' && !isCompanyWide_(user.role)) {
    rows = [];
  }
  if (req.status) rows = rows.filter(function (b) { return b.status === req.status; });
  rows.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return { ok: true, batches: rows };
}

// Hand-builds a cluster_to_collector-shaped handoff directly rather than
// routing the Deputy's decision through actionConfirmHandoff_/dispute — see
// CLAUDE.md for the full reasoning. Short version: confirmHandoff_ exists to
// capture a *received-cash* variance (shortfall/originalAmount), and the
// Deputy isn't receiving cash here, they're approving whether the uploaded
// *data* is accurate before any cash claim exists; forcing this through that
// machinery would permanently no-op the shortfall path for every bulk batch.
function actionDeputyApproveBatch_(req, user) {
  if (user.role !== 'deputy_operations_manager' && user.role !== 'admin') return { ok: false, error: 'forbidden' };
  var batch = getById_(SHEETS.AREA_BULK_BATCHES, req.id);
  if (!batch) return { ok: false, error: 'not_found' };
  if (batch.status !== 'pending_deputy') return { ok: false, error: 'not_pending' };
  // Structurally near-impossible today (a user holds exactly one role), but
  // checked explicitly anyway — a self-check is never implied by the role
  // requirement alone (see CLAUDE.md Trap #3).
  if (batch.uploadedBy === user.id) return { ok: false, error: 'conflict_of_interest' };

  var cluster = getById_(SHEETS.CLUSTERS, batch.clusterId);
  if (!cluster) return { ok: false, error: 'not_found' };
  if (!cluster.collectorUserId) return { ok: false, error: 'no_collector' };
  if (cluster.collectorUserId === user.id) return { ok: false, error: 'conflict_of_interest' };

  var handoff = {
    id: Utilities.getUuid(),
    kind: 'cluster_to_collector',
    fromUserId: batch.uploadedBy,
    toUserId: cluster.collectorUserId,
    clusterId: cluster.id,
    amount: batch.breakdown.netCashOwed,
    breakdown: batch.breakdown,
    perLocation: batch.perLocation,
    sourceEntryIds: batch.entryIds,
    sourceHandoffIds: [],
    consumedBy: null,
    status: 'pending',
    createdAt: new Date().toISOString(),
    viaBulkBatch: batch.id
  };
  writeRow(SHEETS.HANDOFFS, handoff);
  batch.entryIds.forEach(function (id) {
    var e = getById_(SHEETS.ENTRIES, id);
    if (e) { e.consumedBy = handoff.id; writeRow(SHEETS.ENTRIES, e); }
  });

  batch.status = 'deputy_approved';
  batch.deputyActedBy = user.id;
  batch.deputyActedAt = new Date().toISOString();
  batch.resultHandoffId = handoff.id;
  writeRow(SHEETS.AREA_BULK_BATCHES, batch);

  logAudit_('deputy_approve_batch', user.id, batch.id + ' -> ' + handoff.id);
  notifyPending_(handoff);
  return { ok: true, batch: batch, handoff: handoff };
}

// Rejected entries are marked voided (not just released back to unconsumed)
// so a corrected re-upload can never double-count them — see CLAUDE.md for
// the double-counting gap this closes: a straight release would leave the
// old rejected rows floating in the unconsumed pool while the corrected
// resubmit creates a brand new set of entries for the same real-world cash.
function actionDeputyRejectBatch_(req, user) {
  if (user.role !== 'deputy_operations_manager' && user.role !== 'admin') return { ok: false, error: 'forbidden' };
  var batch = getById_(SHEETS.AREA_BULK_BATCHES, req.id);
  if (!batch) return { ok: false, error: 'not_found' };
  if (batch.status !== 'pending_deputy') return { ok: false, error: 'not_pending' };
  if (batch.uploadedBy === user.id) return { ok: false, error: 'conflict_of_interest' };

  batch.entryIds.forEach(function (id) {
    var e = getById_(SHEETS.ENTRIES, id);
    if (e) { e.voided = true; e.consumedBy = null; writeRow(SHEETS.ENTRIES, e); }
  });

  batch.status = 'deputy_rejected';
  batch.rejectionNote = req.note || '';
  batch.deputyActedBy = user.id;
  batch.deputyActedAt = new Date().toISOString();
  writeRow(SHEETS.AREA_BULK_BATCHES, batch);

  logAudit_('deputy_reject_batch', user.id, batch.id);
  notifyAreaBatchRejected_(batch);
  return { ok: true, batch: batch };
}

function notifyDeputyPendingBatch_(batch) {
  var recipients = readSheet(SHEETS.USERS).filter(function (u) {
    return (u.role === 'deputy_operations_manager' || u.role === 'admin' || u.role === 'finance') && u.email;
  });
  recipients.forEach(function (u) {
    try {
      MailApp.sendEmail(u.email,
        'دفعة بيانات جديدة بانتظار الاعتماد / New bulk batch pending approval',
        'رفع مدير المنطقة دفعة بيانات جديدة بمبلغ ' + batch.breakdown.netCashOwed.toFixed(2) + ' بانتظار اعتمادك.\n' +
        'An area manager uploaded a new bulk batch of ' + batch.breakdown.netCashOwed.toFixed(2) + ' awaiting your approval.');
    } catch (e) { /* email is best-effort */ }
  });
}

function notifyAreaBatchRejected_(batch) {
  var uploader = getById_(SHEETS.USERS, batch.uploadedBy);
  if (!uploader || !uploader.email) return;
  try {
    MailApp.sendEmail(uploader.email,
      'تم رفض دفعة البيانات المرفوعة / Your bulk batch was rejected',
      'تم رفض الدفعة بواسطة نائب مدير العمليات. السبب: ' + (batch.rejectionNote || '—') + '\n' +
      'Your bulk batch was rejected by the Deputy Operations Manager. Reason: ' + (batch.rejectionNote || '—'));
  } catch (e) { /* email is best-effort */ }
}

// No one — not even an admin — may confirm or dispute a handoff they
// themselves submitted. That is the exact conflict of interest this chain
// exists to prevent: the same person declaring an amount AND approving its
// receipt. An admin may still act on behalf of an unavailable receiver
// (toUserId check is relaxed for admin below), but never on their own
// submission.
// Confirming asks the receiver how much cash actually changed hands, not
// just "yes/no" — cash handoffs routinely arrive short. A shortfall does
// NOT block the chain waiting on admin review: the receiver accepts what
// they actually got right now (h.amount becomes the real received figure
// immediately, so everything downstream — the next batch up the chain, the
// eventual deposit — moves real cash, never the original overstated claim),
// and every level above this handoff (the cluster manager and collector for
// this cluster, plus admin/finance) is emailed immediately so a shortfall
// is never quietly absorbed at one level and hidden from the rest of the
// chain. The original declared amount and the shortfall stay on the record
// (originalAmount/shortfall) for audit. The separate "dispute" action still
// exists for a receiver who wants to flag something (e.g. suspected fraud,
// refuses to accept it at all) rather than simply accept a shortfall.
function actionConfirmHandoff_(req, user) {
  var h = getById_(SHEETS.HANDOFFS, req.id);
  if (!h) return { ok: false, error: 'not_found' };
  if (h.status !== 'pending') return { ok: false, error: 'not_pending' };
  if (h.fromUserId === user.id) return { ok: false, error: 'conflict_of_interest' };
  if (user.role !== 'admin' && h.toUserId !== user.id) return { ok: false, error: 'forbidden' };

  var declared = Number(h.amount);
  var received = req.receivedAmount === undefined || req.receivedAmount === null || req.receivedAmount === ''
    ? declared : Number(req.receivedAmount);
  var shortfall = Math.round((declared - received) * 100) / 100;

  h.receivedAmount = received;
  h.status = 'confirmed';
  h.confirmedAt = new Date().toISOString();
  h.confirmedBy = user.id;

  var hasVariance = Math.abs(shortfall) > 0.01;
  if (hasVariance) {
    h.originalAmount = declared;
    h.amount = received;
    h.shortfall = shortfall;
    if (h.breakdown) { h.breakdown = Object.assign({}, h.breakdown, { netCashOwed: received }); }
  }

  // Four-eyes on large amounts — never blocks the chain (the receiver's
  // confirmation still lands immediately, same non-blocking philosophy as
  // a shortfall), just flags it for a second admin/finance sign-off and
  // escalates the same way a shortfall does. Threshold 0 = feature off.
  var threshold = secondApprovalThreshold_();
  var needsSecondApproval = threshold > 0 && received >= threshold;
  if (needsSecondApproval) {
    h.requiresSecondApproval = true;
    h.secondApprovalThresholdAtTime = threshold;
  }

  writeRow(SHEETS.HANDOFFS, h);
  logAudit_(
    hasVariance ? (h.toUserId === user.id ? 'confirm_partial' : 'admin_confirm_partial') :
      (h.toUserId === user.id ? 'confirm_handoff' : 'admin_confirm_on_behalf'),
    user.id, h.id
  );
  if (hasVariance) escalateShortfall_(h);
  if (needsSecondApproval) escalateLargeAmount_(h);
  return { ok: true, handoff: h };
}

// Same recipient set as escalateShortfall_/escalateStaleHandoff_ — the
// cluster's manager and collector are exactly the people who need to know a
// large amount just moved through their cluster, not just admin/finance.
function escalateLargeAmount_(handoff) {
  var recipients = {};
  function add(u) { if (u && u.email) recipients[u.id] = u; }

  if (handoff.clusterId) {
    var cluster = getById_(SHEETS.CLUSTERS, handoff.clusterId);
    if (cluster) {
      add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
      add(getById_(SHEETS.USERS, cluster.collectorUserId));
    }
  }
  readSheet(SHEETS.USERS)
    .filter(function (u) { return (u.role === 'admin' || u.role === 'finance') && u.email; })
    .forEach(add);

  var subject = 'تسليم كبير يحتاج موافقة ثانية / Large handoff needs a second sign-off';
  var body = 'التسليم رقم ' + handoff.id + ' بمبلغ ' + Number(handoff.amount).toFixed(2) +
    ' تجاوز الحد المحدد ويحتاج موافقة إدارية/مالية إضافية.\n\n' +
    'Handoff ' + handoff.id + ' (' + Number(handoff.amount).toFixed(2) + ') exceeded the configured threshold and needs a second admin/finance sign-off.';
  Object.keys(recipients).forEach(function (id) {
    try { MailApp.sendEmail(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
  });
}

function actionAcknowledgeSecondApproval_(req, user) {
  requireAdminOrFinance_(user);
  var h = getById_(SHEETS.HANDOFFS, req.id);
  if (!h) return { ok: false, error: 'not_found' };
  if (!h.requiresSecondApproval) return { ok: false, error: 'not_flagged' };
  if (h.secondApprovedBy) return { ok: false, error: 'already_acknowledged' };
  // Four eyes means two different people — nothing upstream of this stops an
  // admin/finance account from also being the assigned collector/cluster
  // manager who confirmed the handoff (validateEntity_ only checks that the
  // two chain roles differ from each other, not that either differs from
  // every admin/finance account), so the confirmer must be blocked here
  // explicitly, same reasoning as the fromUserId/toUserId guard on
  // actionResolveDispute_.
  if (h.confirmedBy === user.id) return { ok: false, error: 'conflict_of_interest' };
  h.secondApprovedBy = user.id;
  h.secondApprovedAt = new Date().toISOString();
  writeRow(SHEETS.HANDOFFS, h);
  logAudit_('acknowledge_second_approval', user.id, h.id);
  return { ok: true, handoff: h };
}

function actionDisputeHandoff_(req, user) {
  var h = getById_(SHEETS.HANDOFFS, req.id);
  if (!h) return { ok: false, error: 'not_found' };
  if (h.status !== 'pending') return { ok: false, error: 'not_pending' };
  if (h.fromUserId === user.id) return { ok: false, error: 'conflict_of_interest' };
  if (user.role !== 'admin' && h.toUserId !== user.id) return { ok: false, error: 'forbidden' };

  h.status = 'disputed';
  h.disputeNote = req.note || '';
  h.disputedAt = new Date().toISOString();
  writeRow(SHEETS.HANDOFFS, h);
  logAudit_(h.toUserId === user.id ? 'dispute_handoff' : 'admin_dispute_on_behalf', user.id, h.id);
  notifyDispute_(h);
  return { ok: true, handoff: h };
}

function releaseConsumed_(h) {
  (h.sourceEntryIds || []).forEach(function (id) {
    var e = getById_(SHEETS.ENTRIES, id);
    if (e) { e.consumedBy = null; writeRow(SHEETS.ENTRIES, e); }
  });
  (h.sourceHandoffIds || []).forEach(function (id) {
    var sh = getById_(SHEETS.HANDOFFS, id);
    if (sh) { sh.consumedBy = null; writeRow(SHEETS.HANDOFFS, sh); }
  });
}

function actionResolveDispute_(req, user) {
  requireAdminOrFinance_(user);
  var h = getById_(SHEETS.HANDOFFS, req.id);
  if (!h) return { ok: false, error: 'not_found' };
  if (h.status !== 'disputed') return { ok: false, error: 'not_disputed' };
  // an admin/finance account that is also a party to this specific handoff
  // (e.g. also holds a store/cluster assignment) may not rule on its own
  // dispute — route it to a different admin.
  if (h.fromUserId === user.id || h.toUserId === user.id) return { ok: false, error: 'conflict_of_interest' };

  if (req.resolution === 'confirm') {
    h.status = 'confirmed';
    h.confirmedAt = new Date().toISOString();
    h.confirmedBy = h.toUserId;
  } else if (req.resolution === 'reject') {
    h.status = 'rejected';
    releaseConsumed_(h);
  } else {
    return { ok: false, error: 'invalid_resolution' };
  }
  h.resolvedBy = user.id;
  h.resolvedAt = new Date().toISOString();
  h.resolutionNote = req.note || '';
  writeRow(SHEETS.HANDOFFS, h);
  logAudit_('resolve_dispute', user.id, h.id);
  return { ok: true, handoff: h };
}

function actionRecordDeposit_(req, user) {
  if (user.role !== 'admin' && collectorClusterIds_(user.id).length === 0) {
    return { ok: false, error: 'forbidden' };
  }

  var held = readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'cluster_to_collector' && h.toUserId === user.id && h.status === 'confirmed' && !h.consumedBy;
  });
  if (!held.length) return { ok: false, error: 'no_held_cash' };
  var amount = held.reduce(function (s, h) { return s + Number(h.amount || 0); }, 0);
  var breakdown = sumBreakdowns_(held.map(function (h) { return h.breakdown; }));
  var perCluster = held.map(function (h) {
    return { clusterId: h.clusterId, amount: h.amount, breakdown: h.breakdown, perLocation: h.perLocation || [] };
  });

  var attachmentId = null;
  if (req.fileBase64) {
    attachmentId = saveDepositSlip_(req.fileBase64, req.fileName, req.fileMime);
  }

  var deposit = {
    id: Utilities.getUuid(),
    kind: 'deposit',
    fromUserId: user.id,
    toUserId: null,
    amount: amount,
    breakdown: breakdown,
    perCluster: perCluster,
    bankReference: req.bankReference || '',
    attachmentId: attachmentId,
    sourceEntryIds: [],
    sourceHandoffIds: held.map(function (h) { return h.id; }),
    consumedBy: null,
    status: 'completed',
    createdAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    confirmedBy: user.id
  };
  writeRow(SHEETS.HANDOFFS, deposit);
  held.forEach(function (h) { h.consumedBy = deposit.id; writeRow(SHEETS.HANDOFFS, h); });
  logAudit_('record_deposit', user.id, deposit.id);
  return { ok: true, handoff: deposit };
}

function actionListHandoffs_(req, user) {
  var rows = readSheet(SHEETS.HANDOFFS);
  if (!isCompanyWide_(user.role)) {
    rows = rows.filter(function (h) { return h.fromUserId === user.id || h.toUserId === user.id; });
  }
  if (req.status) rows = rows.filter(function (h) { return h.status === req.status; });
  if (req.kind) rows = rows.filter(function (h) { return h.kind === req.kind; });
  rows.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return { ok: true, handoffs: rows };
}

// ---------- Attachments (deposit slips) — private Drive, never public ----------

function depositsFolder_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('DEPOSITS_FOLDER_ID');
  var folder = null;
  if (id) {
    try { folder = DriveApp.getFolderById(id); } catch (e) { folder = null; }
  }
  if (!folder) {
    folder = DriveApp.createFolder('BestGas Cash Collection - Deposit Slips');
    p.setProperty('DEPOSITS_FOLDER_ID', folder.getId());
  }
  return folder;
}

function saveDepositSlip_(base64, fileName, mime) {
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, mime || 'image/jpeg', fileName || 'slip.jpg');
  var file = depositsFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  return file.getId();
}

function actionGetFile_(req, user) {
  var handoffs = readSheet(SHEETS.HANDOFFS);
  var allowed = handoffs.some(function (h) {
    return h.attachmentId === req.fileId &&
      (user.role === 'admin' || user.role === 'finance' || h.fromUserId === user.id || h.toUserId === user.id);
  });
  if (!allowed) return { ok: false, error: 'forbidden' };
  var file = DriveApp.getFileById(req.fileId);
  var bytes = file.getBlob().getBytes();
  return { ok: true, base64: Utilities.base64Encode(bytes), mime: file.getMimeType(), name: file.getName() };
}

// ---------- Notifications ----------

function notifyPending_(handoff) {
  var toUser = getById_(SHEETS.USERS, handoff.toUserId);
  if (!toUser || !toUser.email) return;
  try {
    MailApp.sendEmail(toUser.email,
      'طلب استلام نقدية جديد / New cash handoff pending',
      'يوجد طلب استلام مبلغ ' + handoff.amount.toFixed(2) + ' بانتظار تأكيدك.\n' +
      'A handoff of ' + handoff.amount.toFixed(2) + ' is awaiting your confirmation.');
  } catch (e) { /* email is best-effort */ }
}

function notifyDispute_(handoff) {
  var admins = readSheet(SHEETS.USERS).filter(function (u) { return u.role === 'admin' && u.email; });
  admins.forEach(function (a) {
    try {
      MailApp.sendEmail(a.email,
        'اعتراض على مناولة نقدية / Cash handoff disputed',
        'تم الاعتراض على طلب رقم ' + handoff.id + ' بمبلغ ' + handoff.amount.toFixed(2) + '.\n' +
        'Handoff ' + handoff.id + ' (' + handoff.amount.toFixed(2) + ') was disputed.');
    } catch (e) { /* email is best-effort */ }
  });
}

// A shortfall accepted at any one level must not stay visible only to that
// level and to admin — the cluster manager and collector responsible for
// this same cluster are exactly the people who need to know a shortfall
// happened somewhere below them before it reaches (or fails to reach) them,
// so both get emailed alongside every admin/finance account, regardless of
// which of the two handoff kinds (location->cluster or cluster->collector)
// this was.
function escalateShortfall_(handoff) {
  var recipients = {};
  function add(u) { if (u && u.email) recipients[u.id] = u; }

  var clusterId = clusterIdForHandoff_(handoff);
  if (clusterId) {
    var cluster = getById_(SHEETS.CLUSTERS, clusterId);
    if (cluster) {
      add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
      add(getById_(SHEETS.USERS, cluster.collectorUserId));
    }
  }
  readSheet(SHEETS.USERS)
    .filter(function (u) { return (u.role === 'admin' || u.role === 'finance') && u.email; })
    .forEach(add);

  var subject = 'نقص في مبلغ مُستلم / Cash handoff received short';
  var body = 'التسليم رقم ' + handoff.id + ':\n' +
    'المبلغ المُعلن: ' + Number(handoff.originalAmount).toFixed(2) + '\n' +
    'المبلغ المُستلم فعلياً: ' + Number(handoff.amount).toFixed(2) + '\n' +
    'الفرق: ' + Number(handoff.shortfall).toFixed(2) + '\n\n' +
    'Handoff ' + handoff.id + ' was received short.\n' +
    'Declared: ' + Number(handoff.originalAmount).toFixed(2) + '\n' +
    'Actually received: ' + Number(handoff.amount).toFixed(2) + '\n' +
    'Shortfall: ' + Number(handoff.shortfall).toFixed(2);

  Object.keys(recipients).forEach(function (id) {
    try { MailApp.sendEmail(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
  });
}

// A handoff sitting 'pending' too long is a real risk (cash held by one
// person, un-acknowledged) that the receiver alone might not notice or
// might be sitting on — same recipient set as a shortfall (that cluster's
// manager + collector, plus every admin/finance account), same
// best-effort email, never blocks anything.
function escalateStaleHandoff_(handoff, hoursOld) {
  var recipients = {};
  function add(u) { if (u && u.email) recipients[u.id] = u; }
  add(getById_(SHEETS.USERS, handoff.toUserId));
  var clusterId = clusterIdForHandoff_(handoff);
  if (clusterId) {
    var cluster = getById_(SHEETS.CLUSTERS, clusterId);
    if (cluster) {
      add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
      add(getById_(SHEETS.USERS, cluster.collectorUserId));
    }
  }
  readSheet(SHEETS.USERS)
    .filter(function (u) { return (u.role === 'admin' || u.role === 'finance') && u.email; })
    .forEach(add);

  var subject = 'تسليم معلّق منذ فترة طويلة / Handoff pending too long';
  var body = 'التسليم رقم ' + handoff.id + ' بمبلغ ' + Number(handoff.amount).toFixed(2) +
    ' لا يزال بانتظار التأكيد منذ ' + Math.round(hoursOld) + ' ساعة.\n\n' +
    'Handoff ' + handoff.id + ' (' + Number(handoff.amount).toFixed(2) + ') has been pending confirmation for ' + Math.round(hoursOld) + ' hours.';

  Object.keys(recipients).forEach(function (id) {
    try { MailApp.sendEmail(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
  });
}

// A confirmed handoff that's still sitting un-consumed (nobody has batched
// it into the next step up the chain yet) is cash physically held by one
// person with no forward motion — the same real risk as a still-pending
// handoff, just one stage later, and one the aging buckets on the dashboard
// only show passively. Same escalate-once guard (heldEscalatedAt) as
// staleEscalatedAt above, same recipient set, and a 'deposit' is excluded
// since it's the end of the chain by definition, not cash "held" waiting to
// move further.
function escalateHeldTooLong_(handoff, hoursHeld) {
  var recipients = {};
  function add(u) { if (u && u.email) recipients[u.id] = u; }
  add(getById_(SHEETS.USERS, handoff.toUserId));
  var clusterId = clusterIdForHandoff_(handoff);
  if (clusterId) {
    var cluster = getById_(SHEETS.CLUSTERS, clusterId);
    if (cluster) {
      add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
      add(getById_(SHEETS.USERS, cluster.collectorUserId));
    }
  }
  readSheet(SHEETS.USERS)
    .filter(function (u) { return (u.role === 'admin' || u.role === 'finance') && u.email; })
    .forEach(add);

  var holder = getById_(SHEETS.USERS, handoff.toUserId);
  var subject = 'نقدية محتفظ بها لفترة طويلة / Cash held too long';
  var body = 'المبلغ ' + Number(handoff.amount).toFixed(2) + ' ما زال محتفظاً به لدى ' + (holder ? holder.name : handoff.toUserId) +
    ' منذ ' + Math.round(hoursHeld) + ' ساعة ولم يُسلَّم للمرحلة التالية بعد (التسليم رقم ' + handoff.id + ').\n\n' +
    (holder ? holder.name : handoff.toUserId) + ' has been holding ' + Number(handoff.amount).toFixed(2) +
    ' for ' + Math.round(hoursHeld) + ' hours without passing it on to the next stage (handoff ' + handoff.id + ').';

  Object.keys(recipients).forEach(function (id) {
    try { MailApp.sendEmail(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
  });
}

// Confirmed-and-still-held handoffs (the same "held" definition used
// everywhere else — status==='confirmed' && !consumedBy) aged past
// heldThresholdHours_(), aged from the moment they were actually confirmed
// (resolvedAt if this came through a dispute, confirmedAt otherwise — same
// rule as actionHeldCashTrend_ in the reporting layer, so the trend chart
// and this alert never disagree about when "holding" started).
function checkHeldTooLong_() {
  var thresholdMs = heldThresholdHours_() * 3600000;
  var now = Date.now();
  var escalated = 0;
  readSheet(SHEETS.HANDOFFS)
    .filter(function (h) { return h.status === 'confirmed' && !h.consumedBy && h.kind !== 'deposit' && !h.heldEscalatedAt; })
    .forEach(function (h) {
      var heldFromAt = h.resolvedAt || h.confirmedAt;
      if (!heldFromAt) return;
      var ageMs = now - new Date(heldFromAt).getTime();
      if (ageMs < thresholdMs) return;
      escalateHeldTooLong_(h, ageMs / 3600000);
      h.heldEscalatedAt = new Date().toISOString();
      writeRow(SHEETS.HANDOFFS, h);
      escalated++;
    });
  return escalated;
}

// Meant to run on a daily time trigger (installed via
// actionAdminInstallStaleTrigger_) — also callable on demand via
// actionRunStaleCheck_ for a manual "check now" and for tests. Each stale
// handoff is escalated once (staleEscalatedAt guards against emailing the
// same person daily for the same still-pending handoff). Runs the
// held-too-long check (checkHeldTooLong_) in the same pass, so the one
// existing daily trigger covers both aging alerts — no separate trigger to
// install.
function checkStaleHandoffs_() {
  var thresholdMs = staleThresholdHours_() * 3600000;
  var now = Date.now();
  var escalated = 0;
  readSheet(SHEETS.HANDOFFS)
    .filter(function (h) { return h.status === 'pending' && !h.staleEscalatedAt; })
    .forEach(function (h) {
      var ageMs = now - new Date(h.createdAt).getTime();
      if (ageMs < thresholdMs) return;
      escalateStaleHandoff_(h, ageMs / 3600000);
      h.staleEscalatedAt = new Date().toISOString();
      writeRow(SHEETS.HANDOFFS, h);
      escalated++;
    });
  escalated += checkHeldTooLong_();
  return escalated;
}

function actionRunStaleCheck_(req, user) {
  requireAdminOrFinance_(user);
  var beforeHeld = readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.heldEscalatedAt; }).length;
  var beforeStale = readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.staleEscalatedAt; }).length;
  var escalated = checkStaleHandoffs_();
  var afterHeld = readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.heldEscalatedAt; }).length;
  var afterStale = readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.staleEscalatedAt; }).length;
  logAudit_('run_stale_check', user.id, escalated + ' escalated');
  return { ok: true, escalated: escalated, staleEscalated: afterStale - beforeStale, heldEscalated: afterHeld - beforeHeld };
}

function actionAdminInstallStaleTrigger_(req, user) {
  requireAdmin_(user);
  var already = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'checkStaleHandoffs_'; });
  if (already) return { ok: true, alreadyInstalled: true };
  ScriptApp.newTrigger('checkStaleHandoffs_').timeBased().everyDays(1).atHour(6).create();
  logAudit_('admin_install_stale_trigger', user.id, null);
  return { ok: true, alreadyInstalled: false };
}

// ---------- Dashboard ----------

function actionDashboard_(req, user) {
  var handoffs = readSheet(SHEETS.HANDOFFS);
  var pendingForMe = handoffs.filter(function (h) { return h.status === 'pending' && h.toUserId === user.id; });
  var heldByMe = handoffs.filter(function (h) { return h.status === 'confirmed' && h.toUserId === user.id && !h.consumedBy; });
  var disputedInvolvingMe = handoffs.filter(function (h) {
    return h.status === 'disputed' && (h.toUserId === user.id || h.fromUserId === user.id);
  });
  var heldAmount = heldByMe.reduce(function (s, h) { return s + Number(h.amount || 0); }, 0);

  var result = {
    ok: true,
    pendingForMe: pendingForMe,
    heldByMe: heldByMe,
    heldAmount: heldAmount,
    disputedInvolvingMe: disputedInvolvingMe
  };

  if (isCompanyWide_(user.role)) {
    var allHeld = handoffs.filter(function (h) { return h.status === 'confirmed' && !h.consumedBy; });
    var byHolder = {};
    allHeld.forEach(function (h) { byHolder[h.toUserId] = (byHolder[h.toUserId] || 0) + Number(h.amount || 0); });
    result.companyHeldByHolder = byHolder;
    result.companyOutstanding = allHeld.reduce(function (s, h) { return s + Number(h.amount || 0); }, 0);
    result.openDisputes = handoffs.filter(function (h) { return h.status === 'disputed'; });
  }
  return result;
}

// ---------- Sales report ----------

function actionSalesReport_(req, user) {
  if (!isCompanyWide_(user.role) && user.role !== 'cluster_manager') {
    return { ok: false, error: 'forbidden' };
  }

  // A voided entry (a rejected area-manager bulk batch, see
  // actionDeputyRejectBatch_) was never real committed sales activity —
  // exclude it from reporting the same way it's excluded from ever
  // re-entering a handoff.
  var entries = readSheet(SHEETS.ENTRIES).filter(function (e) { return !e.voided; });
  var locations = readSheet(SHEETS.LOCATIONS);
  var locById = {};
  locations.forEach(function (l) { locById[l.id] = l; });

  if (user.role === 'cluster_manager') {
    var myLocationIds = locations
      .filter(function (l) { return clusterManagerOwnsCluster_(user.id, l.clusterId); })
      .map(function (l) { return l.id; });
    entries = entries.filter(function (e) { return myLocationIds.indexOf(e.locationId) >= 0; });
  }

  if (req.dateFrom) entries = entries.filter(function (e) { return e.date >= req.dateFrom; });
  if (req.dateTo) entries = entries.filter(function (e) { return e.date <= req.dateTo; });
  if (req.locationId) entries = entries.filter(function (e) { return e.locationId === req.locationId; });
  if (req.city) entries = entries.filter(function (e) { var l = locById[e.locationId]; return l && l.city === req.city; });
  if (req.zoneId) entries = entries.filter(function (e) { var l = locById[e.locationId]; return l && l.zoneId === req.zoneId; });
  if (req.sourceType) entries = entries.filter(function (e) { return e.sourceType === req.sourceType; });
  if (req.sourceId) entries = entries.filter(function (e) { return e.sourceId === req.sourceId; });
  if (req.productId) entries = entries.filter(function (e) { return e.productId === req.productId; });
  if (req.enteredBy) entries = entries.filter(function (e) { return e.enteredBy === req.enteredBy; });
  if (req.amountMin != null && req.amountMin !== '') {
    var amtMin = Number(req.amountMin);
    entries = entries.filter(function (e) { return entrySalesTotal_(e) >= amtMin; });
  }
  if (req.amountMax != null && req.amountMax !== '') {
    var amtMax = Number(req.amountMax);
    entries = entries.filter(function (e) { return entrySalesTotal_(e) <= amtMax; });
  }

  var totals = computeNet_(entries);
  var outstanding = computeNet_(entries.filter(function (e) { return !e.consumedBy; }));

  var byLocation = {};
  entries.forEach(function (e) {
    if (!byLocation[e.locationId]) byLocation[e.locationId] = [];
    byLocation[e.locationId].push(e);
  });
  var locationRows = Object.keys(byLocation).map(function (id) {
    var t = computeNet_(byLocation[id]);
    var loc = locById[id] || {};
    return { locationId: id, city: loc.city, name: loc.name, totals: t };
  });

  // Product-level breakdown, across both the cash channel (store/car) and
  // the POS channel — the level the user specifically asked to see, since
  // "net cash owed" alone says nothing about what was actually sold.
  var products = readSheet(SHEETS.PRODUCTS);
  var productById = {};
  products.forEach(function (p) { productById[p.id] = p; });
  var byProductMap = {};
  entries.forEach(function (e) {
    var key = e.productId || '__unspecified__';
    if (!byProductMap[key]) byProductMap[key] = { productId: e.productId || null, cashAmount: 0, posAmount: 0, creditAmount: 0, qty: 0, cylindersOut: 0, cylindersIn: 0 };
    var bucket = byProductMap[key];
    // Any entry can carry a cash portion, a card/bank portion, and a credit
    // portion at once now (store/car/pos all support posSales/creditSales),
    // so all three are counted — not either/or like it used to be.
    bucket.posAmount += Number(e.posSales || 0);
    bucket.cashAmount += Number(e.cashSales || 0);
    bucket.creditAmount += Number(e.creditSales || 0);
    bucket.cylindersOut += Number(e.cylindersOut || 0);
    bucket.cylindersIn += Number(e.cylindersIn || 0);
    bucket.qty += 1;
  });
  var productRows = Object.keys(byProductMap).map(function (key) {
    var bucket = byProductMap[key];
    var p = bucket.productId ? productById[bucket.productId] : null;
    return {
      productId: bucket.productId, name: p ? p.name : null,
      cashAmount: bucket.cashAmount, posAmount: bucket.posAmount, creditAmount: bucket.creditAmount,
      total: bucket.cashAmount + bucket.posAmount + bucket.creditAmount, entryCount: bucket.qty,
      cylindersOut: bucket.cylindersOut, cylindersIn: bucket.cylindersIn,
      cylinderBalance: bucket.cylindersOut - bucket.cylindersIn
    };
  }).sort(function (a, b) { return b.total - a.total; });

  // LPG cylinder exchange, by location x product — the operational question
  // is "which branch/car owes how many empties back", not just a company
  // total, so this is deliberately the finer of the two cylinder views.
  var cylByKey = {};
  entries.forEach(function (e) {
    if (!e.productId) return;
    if (!Number(e.cylindersOut) && !Number(e.cylindersIn)) return;
    var key = e.locationId + '|' + e.productId;
    if (!cylByKey[key]) cylByKey[key] = { locationId: e.locationId, productId: e.productId, cylindersOut: 0, cylindersIn: 0 };
    cylByKey[key].cylindersOut += Number(e.cylindersOut || 0);
    cylByKey[key].cylindersIn += Number(e.cylindersIn || 0);
  });
  var cylinderByLocation = Object.keys(cylByKey).map(function (key) {
    var row = cylByKey[key];
    var loc = locById[row.locationId] || {};
    var p = productById[row.productId];
    return {
      locationId: row.locationId, locationName: loc.name, city: loc.city,
      productId: row.productId, productName: p ? p.name : null,
      cylindersOut: row.cylindersOut, cylindersIn: row.cylindersIn,
      cylinderBalance: row.cylindersOut - row.cylindersIn
    };
  }).sort(function (a, b) { return b.cylinderBalance - a.cylinderBalance; });

  // Daily trend (gross sales, all three channels) — feeds the dashboard chart.
  var byDateMap = {};
  entries.forEach(function (e) {
    if (!byDateMap[e.date]) byDateMap[e.date] = 0;
    byDateMap[e.date] += entrySalesTotal_(e);
  });
  var dateRows = Object.keys(byDateMap).sort().map(function (d) { return { date: d, total: byDateMap[d] }; });

  return {
    ok: true, totals: totals, outstanding: outstanding,
    byLocation: locationRows, byProduct: productRows, byDate: dateRows,
    cylinderByLocation: cylinderByLocation,
    entries: entries
  };
}

// ---------- Shortfall accountability ----------
// A handoff's shortfall (declared vs. actually received) is recorded at
// the handoff level — but the handoff can bundle several daily_entries,
// each possibly entered by a different person (a store manager's own cash
// plus one or more drivers' car cash, all swept into one location→cluster
// handoff). There is no way to know with certainty *whose* cash was
// actually short, so this attributes each entry's share of the shortfall
// proportionally to its share of the handoff's total declared cash —
// an honest estimate, not a claim of proven fault. Proportional attribution
// is scoped to location_to_cluster handoffs only, since those are the ones
// that can bundle several entrants' entries into one batch; a shortfall
// discovered later, at the cluster_to_collector step, is the area manager's
// own accountability (cash they had already accepted), not something to pin
// back on a driver. A car_to_location handoff never needs the proportional
// split at all — it only ever carries one driver's own entries, so its
// shortfall is attributed to that driver directly (h.fromUserId).
function actionShortfallByEntrant_(req, user) {
  requireCompanyWide_(user);
  var flagged = readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'location_to_cluster' && h.shortfall != null && Math.abs(Number(h.shortfall)) > 0.01;
  });
  var flaggedCar = readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'car_to_location' && h.shortfall != null && Math.abs(Number(h.shortfall)) > 0.01;
  });

  var byEntrant = {}; // userId -> { userId, totalShortfall, handoffIds:{} }
  var rows = flagged.map(function (h) {
    var entries = (h.sourceEntryIds || []).map(function (id) { return getById_(SHEETS.ENTRIES, id); }).filter(Boolean);
    var totalDeclaredCash = entries.reduce(function (s, e) { return s + Number(e.cashSales || 0); }, 0);
    var entrants = entries.map(function (e) {
      var share = totalDeclaredCash > 0 ? Number(e.cashSales || 0) / totalDeclaredCash : 0;
      var attributed = Math.round(Number(h.shortfall) * share * 100) / 100;
      if (!byEntrant[e.enteredBy]) byEntrant[e.enteredBy] = { userId: e.enteredBy, totalShortfall: 0, handoffIds: {} };
      byEntrant[e.enteredBy].totalShortfall += attributed;
      byEntrant[e.enteredBy].handoffIds[h.id] = true;
      return { userId: e.enteredBy, sourceType: e.sourceType, sourceId: e.sourceId, cashSales: Number(e.cashSales || 0), attributedShortfall: attributed };
    });
    return {
      handoffId: h.id, locationId: h.locationId, originalAmount: h.originalAmount,
      receivedAmount: h.amount, shortfall: h.shortfall, confirmedAt: h.confirmedAt, entrants: entrants
    };
  }).concat(flaggedCar.map(function (h) {
    var attributed = Math.round(Number(h.shortfall) * 100) / 100;
    if (!byEntrant[h.fromUserId]) byEntrant[h.fromUserId] = { userId: h.fromUserId, totalShortfall: 0, handoffIds: {} };
    byEntrant[h.fromUserId].totalShortfall += attributed;
    byEntrant[h.fromUserId].handoffIds[h.id] = true;
    return {
      handoffId: h.id, locationId: h.locationId, originalAmount: h.originalAmount,
      receivedAmount: h.amount, shortfall: h.shortfall, confirmedAt: h.confirmedAt,
      entrants: [{ userId: h.fromUserId, sourceType: 'car', sourceId: h.carId, cashSales: Number(h.originalAmount || h.amount || 0), attributedShortfall: attributed }]
    };
  }));

  var byEntrantList = Object.keys(byEntrant).map(function (uid) {
    var b = byEntrant[uid];
    return { userId: b.userId, totalShortfall: Math.round(b.totalShortfall * 100) / 100, handoffCount: Object.keys(b.handoffIds).length };
  }).sort(function (a, b) { return b.totalShortfall - a.totalShortfall; });

  return { ok: true, byEntrant: byEntrantList, handoffs: rows };
}

// ---------- Dashboard period comparison ----------
// Last 7 days vs. the 7 days before that — a fixed, no-input comparison so
// the dashboard always has something to show without the viewer having to
// configure a date range first. `date` on daily_entries is a plain
// YYYY-MM-DD string (same as everywhere else this app filters by date), so
// comparing as strings avoids any timezone ambiguity from parsing into Date.
function actionDashboardComparison_(req, user) {
  requireCompanyWide_(user);
  var entries = readSheet(SHEETS.ENTRIES);

  function isoDateOffset_(daysAgo) {
    var d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }
  var todayStr = isoDateOffset_(0);
  var currentStart = isoDateOffset_(6);
  var previousStart = isoDateOffset_(13);
  var previousEnd = isoDateOffset_(7);

  function rangeTotals_(fromStr, toStr) {
    var inRange = entries.filter(function (e) { return e.date >= fromStr && e.date <= toStr; });
    var net = computeNet_(inRange);
    var gross = inRange.reduce(function (s, e) { return s + entrySalesTotal_(e); }, 0);
    return { gross: gross, netCashOwed: net.netCashOwed, entryCount: inRange.length };
  }

  return {
    ok: true,
    current: rangeTotals_(currentStart, todayStr),
    previous: rangeTotals_(previousStart, previousEnd)
  };
}

// ---------- Held-cash-by-person trend ----------
// A day-by-day reconstruction of who was holding confirmed-but-not-yet-
// handed-on cash, for the last 14 days. Uses the exact same "held" rule as
// actionDashboard_'s companyHeldByHolder snapshot (status === 'confirmed'
// or resolved-as-confirm, and not yet consumedBy a further handoff) so the
// trend's last day always matches that live snapshot — it just replays the
// same rule at each day's end instead of only "now". No new sheet or
// history table: everything needed (confirmedAt/resolvedAt, consumedBy,
// and the createdAt of whatever consumed it) already lives on the handoff
// rows themselves.
function actionHeldCashTrend_(req, user) {
  requireCompanyWide_(user);
  var days = 14;
  var handoffs = readSheet(SHEETS.HANDOFFS);

  function isoDateOffset_(daysAgo) {
    var d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  }

  var createdAtById = {};
  handoffs.forEach(function (h) { createdAtById[h.id] = h.createdAt; });

  var windows = handoffs.map(function (h) {
    var heldFromAt = h.resolvedAt || h.confirmedAt;
    if (!heldFromAt || !h.toUserId) return null;
    var untilAt = h.consumedBy ? createdAtById[h.consumedBy] : null;
    return {
      holderId: h.toUserId,
      amount: Number(h.amount || 0),
      fromDay: String(heldFromAt).slice(0, 10),
      untilDay: untilAt ? String(untilAt).slice(0, 10) : null
    };
  }).filter(function (w) { return w; });

  var holderIds = {};
  windows.forEach(function (w) { holderIds[w.holderId] = true; });

  var dates = [];
  for (var i = days - 1; i >= 0; i--) dates.push(isoDateOffset_(i));

  var series = dates.map(function (dayStr) {
    var byHolder = {};
    windows.forEach(function (w) {
      if (w.fromDay <= dayStr && (!w.untilDay || w.untilDay > dayStr)) {
        byHolder[w.holderId] = (byHolder[w.holderId] || 0) + w.amount;
      }
    });
    return { date: dayStr, byHolder: byHolder };
  });

  return { ok: true, dates: dates, holderIds: Object.keys(holderIds), series: series };
}

function actionListAudit_(req, user) {
  requireCompanyWide_(user);
  var rows = readSheet(SHEETS.AUDIT);
  rows.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  if (req.limit) rows = rows.slice(0, Number(req.limit));
  return { ok: true, audit: rows };
}
