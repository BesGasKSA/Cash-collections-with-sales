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

function actionCreateEntry_(req, user) {
  if (!req.date || !req.sourceType || !req.sourceId) return { ok: false, error: 'invalid_input' };
  var scope = checkEntryScope_(user, req.sourceType, req.sourceId);
  if (!scope.ok) return { ok: false, error: scope.error };

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
  return readSheet(SHEETS.ENTRIES).filter(function (e) { return e.locationId === locationId && !e.consumedBy; });
}

// mirrors the xlsx formula exactly:
// netCashOwed = branchCash + carCash - deliveryFeeBankAmount + vatOnDelivery
function computeNet_(entries) {
  var storeCash = 0, carCash = 0, deliveryFee = 0, posSales = 0;
  entries.forEach(function (e) {
    if (e.sourceType === 'store') {
      storeCash += Number(e.cashSales || 0);
    } else if (e.sourceType === 'car') {
      carCash += Number(e.cashSales || 0);
      deliveryFee += Number(e.deliveryFeeBankAmount || 0);
    } else if (e.sourceType === 'pos') {
      posSales += Number(e.posSales || 0);
    }
  });
  var vat = vatRate_();
  var vatOnDelivery = deliveryFee > 0 ? (deliveryFee / (1 + vat)) * vat : 0;
  var netCashOwed = storeCash + carCash - deliveryFee + vatOnDelivery;
  return {
    storeCash: storeCash, carCash: carCash, deliveryFee: deliveryFee,
    posSales: posSales, vatOnDelivery: vatOnDelivery, netCashOwed: netCashOwed
  };
}

// A cluster-to-collector handoff batches several already-confirmed
// location handoffs, and a deposit batches several cluster handoffs — each
// carries its own breakdown already, so the batch's breakdown is just their
// sum, never recomputed from entries (that would double-apply the VAT
// clawback). Without this, receivers only ever saw one flat total with no
// way to see what it was made of.
function sumBreakdowns_(breakdowns) {
  var out = { storeCash: 0, carCash: 0, deliveryFee: 0, posSales: 0, vatOnDelivery: 0, netCashOwed: 0 };
  breakdowns.forEach(function (b) {
    if (!b) return;
    out.storeCash += Number(b.storeCash || 0);
    out.carCash += Number(b.carCash || 0);
    out.deliveryFee += Number(b.deliveryFee || 0);
    out.posSales += Number(b.posSales || 0);
    out.vatOnDelivery += Number(b.vatOnDelivery || 0);
    out.netCashOwed += Number(b.netCashOwed || 0);
  });
  return out;
}

// ---------- Handoffs (the approval gate) ----------

function actionCreateHandoff_(req, user) {
  if (req.kind === 'location_to_cluster') return createLocationHandoff_(req, user);
  if (req.kind === 'cluster_to_collector') return createClusterHandoff_(req, user);
  return { ok: false, error: 'invalid_kind' };
}

function createLocationHandoff_(req, user) {
  var location = getById_(SHEETS.LOCATIONS, req.locationId);
  if (!location) return { ok: false, error: 'not_found' };

  if (user.role !== 'admin') {
    var store = storeOfManager_(user.id);
    if (user.role !== 'store_manager' || !store || store.locationId !== location.id) {
      return { ok: false, error: 'forbidden' };
    }
  }

  var cluster = getById_(SHEETS.CLUSTERS, location.clusterId);
  if (!cluster || !cluster.clusterManagerUserId) return { ok: false, error: 'no_cluster_manager' };
  if (cluster.clusterManagerUserId === user.id) return { ok: false, error: 'conflict_of_interest' };

  var entries = unconsumedEntriesForLocation_(location.id);
  if (!entries.length) return { ok: false, error: 'no_entries' };
  var totals = computeNet_(entries);
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
    sourceEntryIds: entries.map(function (e) { return e.id; }),
    sourceHandoffIds: [],
    consumedBy: null,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  writeRow(SHEETS.HANDOFFS, handoff);
  entries.forEach(function (e) { e.consumedBy = handoff.id; writeRow(SHEETS.ENTRIES, e); });
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

  writeRow(SHEETS.HANDOFFS, h);
  logAudit_(
    hasVariance ? (h.toUserId === user.id ? 'confirm_partial' : 'admin_confirm_partial') :
      (h.toUserId === user.id ? 'confirm_handoff' : 'admin_confirm_on_behalf'),
    user.id, h.id
  );
  if (hasVariance) escalateShortfall_(h);
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

  var entries = readSheet(SHEETS.ENTRIES);
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
    if (!byProductMap[key]) byProductMap[key] = { productId: e.productId || null, cashAmount: 0, posAmount: 0, qty: 0 };
    var bucket = byProductMap[key];
    if (e.sourceType === 'pos') bucket.posAmount += Number(e.posSales || 0);
    else bucket.cashAmount += Number(e.cashSales || 0);
    bucket.qty += 1;
  });
  var productRows = Object.keys(byProductMap).map(function (key) {
    var bucket = byProductMap[key];
    var p = bucket.productId ? productById[bucket.productId] : null;
    return {
      productId: bucket.productId, name: p ? p.name : null,
      cashAmount: bucket.cashAmount, posAmount: bucket.posAmount,
      total: bucket.cashAmount + bucket.posAmount, entryCount: bucket.qty
    };
  }).sort(function (a, b) { return b.total - a.total; });

  // Daily trend (gross sales, both channels) — feeds the dashboard chart.
  var byDateMap = {};
  entries.forEach(function (e) {
    if (!byDateMap[e.date]) byDateMap[e.date] = 0;
    byDateMap[e.date] += Number(e.cashSales || 0) + Number(e.posSales || 0);
  });
  var dateRows = Object.keys(byDateMap).sort().map(function (d) { return { date: d, total: byDateMap[d] }; });

  return {
    ok: true, totals: totals, outstanding: outstanding,
    byLocation: locationRows, byProduct: productRows, byDate: dateRows,
    entries: entries
  };
}

function actionListAudit_(req, user) {
  requireCompanyWide_(user);
  var rows = readSheet(SHEETS.AUDIT);
  rows.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  if (req.limit) rows = rows.slice(0, Number(req.limit));
  return { ok: true, audit: rows };
}
