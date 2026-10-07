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
// The collector a handover concerns, for alerts: the one it is addressed to,
// or the collector of the branch it came from.
function collectorForHandoff_(handoff) {
  if (handoff.kind === 'cluster_to_collector') return handoff.toUserId;
  if (handoff.locationId) return branchCollector_(handoff.locationId);
  if (handoff.kind === 'deposit' && userHasRole_(handoff.fromUserId, 'collector')) return handoff.fromUserId;
  var c = handoff.clusterId ? getById_(SHEETS.CLUSTERS, handoff.clusterId) : null;
  return c ? c.collectorUserId : null;
}

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
  if (!c || c.clusterManagerUserId !== userId) return false;
  // working in one of several areas: the others are out of reach for this request
  var area = activeAreaOf_(userId);
  return !area || area === clusterId;
}

// Who collects a branch's cash: its own collector, or — for a branch saved
// before collectors moved from areas to branches — its area's collector.
function branchCollector_(locationId) {
  var loc = getById_(SHEETS.LOCATIONS, locationId);
  if (!loc) return null;
  if (loc.collectorUserId) return loc.collectorUserId;
  var c = loc.clusterId ? getById_(SHEETS.CLUSTERS, loc.clusterId) : null;
  return c && c.collectorUserId ? c.collectorUserId : null;
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

  // An area manager enters data for every branch in their own area — the
  // store, its cars and its POS machines — because branches that cannot use
  // the app themselves report their day to them. Deliberately wider than it
  // used to be (it used to be bulk-upload-only, behind a feature toggle),
  // and still bounded by the area they actually manage.
  if (user.role === 'cluster_manager') {
    var loc = getById_(SHEETS.LOCATIONS, locationId);
    if (!loc || !clusterManagerOwnsCluster_(user.id, loc.clusterId)) return { ok: false, error: 'forbidden' };
    return { ok: true, locationId: locationId };
  }

  // A branch worker (2026-09-29) enters the day for the POS device they hold
  // at the counter, nothing else; the branch manager hands that cash over.
  if (user.role === 'branch_worker') {
    if (sourceType !== 'pos') return { ok: false, error: 'forbidden' };
    var bwPos = getById_(SHEETS.POS, sourceId);
    if (!bwPos || bwPos.assignedUserId !== user.id) return { ok: false, error: 'forbidden' };
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
    return !e.voided && e.sourceType === sourceType && e.sourceId === sourceId && e.date === date &&
      (Number(e.cashSales || 0) > 0 || Number(e.posSales || 0) > 0 || Number(e.creditSales || 0) > 0);
  });
}

// The three non-sales money movements share one validator, used by both the
// single-entry form and the bulk import — two copies of these rules would
// drift the moment one of them changed.
//
// Why a reason is mandatory: an unexplained amount on either side is exactly
// the thing the approval chain exists to prevent. The item comes from admin
// master data (income_items / expense_items) so the report can group it; the
// note says what actually happened.
// A credit line names a customer from the list, and may list what was
// taken. Settles the row in place, for both the form and the file import:
// items are checked and their total becomes creditSales (a different amount
// sent alongside is refused), and the customer — by id from the picker, or
// by number or name from a file — is resolved to the record, with a copy of
// its name kept on the row. The cash formula is unchanged: the items only say
// what the credit amount was made of.
function settleCredit_(r) {
  var items = r.creditItems;
  var clean = [];
  if (items != null && items !== '') {
    if (!Array.isArray(items) || items.length > 50) return 'invalid_input';
    var total = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var p = it.productId ? getById_(SHEETS.PRODUCTS, it.productId) : null;
      if (!p || p.active === false) return 'invalid_product';
      var q = Number(it.qty), up = Number(it.unitPrice);
      if (!isFinite(q) || q <= 0) return 'invalid_qty';
      if (!isFinite(up) || up < 0) return 'invalid_price';
      if (p.priceLocked && p.unitPrice != null && p.unitPrice !== '' && Math.abs(up - Number(p.unitPrice)) > 0.005) return 'price_locked';
      var amt = Math.round(q * up * 100) / 100;
      clean.push({ productId: p.id, qty: q, unitPrice: up, amount: amt });
      total += amt;
    }
    total = Math.round(total * 100) / 100;
    if (clean.length) {
      if (r.creditSales != null && r.creditSales !== '' && Number(r.creditSales) !== 0 && Math.abs(Number(r.creditSales) - total) > 0.01) return 'credit_items_mismatch';
      r.creditSales = total;
    }
  }
  r.creditItems = clean.length ? clean : null;
  r.creditDeliveryFee = 0;
  r.creditCommission = 0;
  if (!(Number(r.creditSales || 0) > 0)) { r.creditCustomerId = null; return null; }
  var c;
  if (r.creditCustomerId) {
    c = getById_(SHEETS.CUSTOMERS, r.creditCustomerId);
    if (!c) return 'invalid_customer';
  } else {
    if (!String(r.creditCustomer || '').trim()) return 'customer_required';
    c = findCustomer_(r.creditCustomer);
    if (!c) return 'unknown_customer';
  }
  if (c.active === false) return 'invalid_customer';
  r.creditCustomerId = c.id;
  r.creditCustomer = c.name;
  // The customer's delivery fee per unit, on the units this line took. The
  // server works it out; whatever the client sent is replaced.
  // The fee is an addition to the cash owed, never a deduction; the driver's
  // commission per unit is a deduction.
  var fees = c.deliveryFees || {}, coms = c.commissions || {}, fee = 0, com = 0;
  (r.creditItems || []).forEach(function (it) {
    var per = hasOwn_(fees, it.productId) ? Number(fees[it.productId]) : 0;
    if (per > 0) { it.deliveryFee = Math.round(it.qty * per * 100) / 100; fee += it.deliveryFee; }
    var cm = hasOwn_(coms, it.productId) ? Number(coms[it.productId]) : 0;
    if (cm > 0) { it.commission = Math.round(it.qty * cm * 100) / 100; com += it.commission; }
  });
  r.creditDeliveryFee = Math.round(fee * 100) / 100;
  r.creditCommission = Math.round(com * 100) / 100;
  return null;
}

// A sale through a channel (the Souq Gas app): the channel's delivery fee and
// driver commission per unit, on this row's quantity. The server works both
// out; whatever the client sent is replaced.
function settleChannel_(r) {
  r.channelDeliveryFee = 0; r.channelCommission = 0;
  // Part of a line through a channel (2026-09-29, the simpler way): the line
  // keeps its whole quantity, and channelQtys says how much of it went
  // through each channel; the fee and commission follow that part only.
  var map = r.channelQtys;
  // The driver's commission per unit changes from day to day (2026-09-30):
  // channelComRates {channelId: per unit} on the line replaces the channel's
  // standard rate for that line only; the delivery fee keeps its rate.
  var ov = r.channelComRates, ovClean = null;
  if (ov != null && ov !== '') {
    if (typeof ov !== 'object' || Array.isArray(ov)) return 'invalid_input';
    ovClean = {};
    var ok = safeOwnKeys_(ov);
    if (ok.length > 10) return 'invalid_input';
    for (var j = 0; j < ok.length; j++) {
      if (ov[ok[j]] === '' || ov[ok[j]] == null) continue;
      var rate = Number(ov[ok[j]]);
      if (!isFinite(rate) || rate < 0 || rate > 100000) return 'invalid_amount';
      ovClean[ok[j]] = Math.round(rate * 1000) / 1000;
    }
    if (!Object.keys(ovClean).length) ovClean = null;
  }
  r.channelComRates = ovClean;
  if (map != null && map !== '') {
    if (typeof map !== 'object' || Array.isArray(map)) return 'invalid_input';
    var keys = safeOwnKeys_(map), clean = {}, part = 0, fee0 = 0, com0 = 0;
    if (keys.length > 10) return 'invalid_input';
    for (var i = 0; i < keys.length; i++) {
      var cq = Number(map[keys[i]]);
      if (!isFinite(cq) || cq < 0) return 'invalid_qty';
      if (!(cq > 0)) continue;
      var c0 = getById_(SHEETS.CHANNELS, keys[i]);
      if (!c0 || c0.active === false) return 'invalid_channel';
      clean[keys[i]] = cq; part += cq;
      if (r.productId) {
        fee0 += Math.round(cq * Number((c0.deliveryFees || {})[r.productId] || 0) * 100) / 100;
        var comRate = ovClean && hasOwn_(ovClean, keys[i]) ? ovClean[keys[i]] : Number((c0.commissions || {})[r.productId] || 0);
        com0 += Math.round(cq * comRate * 100) / 100;
      }
    }
    if (part > Number(r.qty || 0) + 1e-9) return 'channel_qty_exceeds';
    r.channelQtys = Object.keys(clean).length ? clean : null;
    r.channelDeliveryFee = Math.round(fee0 * 100) / 100;
    r.channelCommission = Math.round(com0 * 100) / 100;
    r.channelId = null;
    return null;
  }
  r.channelQtys = null;
  if (!r.channelId) { r.channelId = null; return null; }
  var ch = getById_(SHEETS.CHANNELS, r.channelId);
  if (!ch || ch.active === false) return 'invalid_channel';
  var qty = Number(r.qty || 0), pid = r.productId;
  if (qty > 0 && pid) {
    var fee = Number((ch.deliveryFees || {})[pid] || 0), com = ovClean && hasOwn_(ovClean, r.channelId) ? ovClean[r.channelId] : Number((ch.commissions || {})[pid] || 0);
    r.channelDeliveryFee = Math.round(qty * fee * 100) / 100;
    r.channelCommission = Math.round(qty * com * 100) / 100;
  }
  return null;
}

// A credit customer's units are part of the day's product lines (the cash
// figure holds them, and the credit comes off it), so on a day typed by
// product the credit may not name more of an item than the lines sold of it,
// nor an item no line sold: those units would leave no trace in the stock.
// A day typed as amounts only (no quantity anywhere) is not checked here; its
// sales show in the stock as sales without a quantity. (2026-10-05)
function creditOverLines_(rows) {
  var lines = Object.create(null), credit = Object.create(null), byProduct = Object.create(null);
  rows.forEach(function (r) {
    r = r || {};
    var g = r.sourceType + '|' + r.sourceId + '|' + r.date;
    if (r.productId && Number(r.qty) > 0) {
      byProduct[g] = true;
      lines[g + '|' + r.productId] = (lines[g + '|' + r.productId] || 0) + Number(r.qty);
    }
    if (Array.isArray(r.creditItems)) r.creditItems.forEach(function (it) {
      if (it && it.productId && Number(it.qty) > 0) credit[g + '|' + it.productId] = (credit[g + '|' + it.productId] || 0) + Number(it.qty);
    });
  });
  return Object.keys(credit).some(function (k) {
    var g = k.split('|').slice(0, 3).join('|');
    return byProduct[g] && credit[k] > (lines[k] || 0) + 1e-9;
  });
}

// A discount on a product line (2026-10-07): the sale stays at its full price and
// the discount comes off the cash, like credit; on a card line the card amount is
// paid by card (discountOnCard), so the cash is untouched. Sales are always at full price. A reason from the list.
var DISCOUNT_REASONS_ = ['loyal_customer', 'promotion', 'damaged_cylinder', 'price_match', 'manager_approved', 'other'];
function discountLimit_() { var v = Number(config_().discountLimit || 0); return isFinite(v) && v > 0 ? v : 0; }
function checkNonSalesFields_(r, siblingCash) {
  // the item the line sold, when it names one: a real, active product (security
  // review 2026-10-04: "__proto__" as an item broke the stock report for good)
  if (r.productId != null && r.productId !== '') {
    var lineProduct = typeof r.productId === 'string' ? getById_(SHEETS.PRODUCTS, r.productId) : null;
    if (!lineProduct || lineProduct.active === false) return 'invalid_product';
  }
  var creditErr = settleCredit_(r) || settleChannel_(r);
  if (creditErr) return creditErr;
  var disc = Number(r.discountAmount || 0);
  if (!isFinite(disc) || disc < 0) return 'invalid_amount';
  if (disc > 0) {
    if (DISCOUNT_REASONS_.indexOf(String(r.discountReason || '')) < 0) return 'discount_reason_required';
    // a card line is recorded at its full price like a cash one; its discount never touches the cash
    // a cash discount may sit on its own line of the day (the discounts section, 2026-10-07):
    // it is never more than the cash this row and the day's other rows leave in hand
    // this row's own cash in hand counts after its own deductions (credit, transfers, expenses,
    // delivery), like the deposit check below; review 2026-10-07: credit 300 of 300 + discount 50
    var dvat = vatRateOn_(r.date), ddl = Number(r.deliveryFeeBankAmount || 0);
    var rowHand = Number(r.cashSales || 0) - Number(r.creditSales || 0) - Number(r.creditCommission || 0) + Number(r.channelDeliveryFee || 0) - Number(r.channelCommission || 0)
      - Number(r.bankTransferAmount || 0) + Number(r.otherCash || 0) - Number(r.expenseAmount || 0) - ddl + (ddl > 0 ? (ddl / (1 + dvat)) * dvat : 0);
    if (r.discountOnCard === true ? !(Number(r.posSales || 0) > 0) || disc > Number(r.posSales || 0) + 0.005 : disc > rowHand + Math.max(0, Number(siblingCash || 0)) + 0.005) return 'discount_over_sale';
  }
  var other = Number(r.otherCash || 0);
  if (other < 0 || Number(r.expenseAmount || 0) < 0 || Number(r.directDepositAmount || 0) < 0) return 'invalid_amount';
  // a customer's transfer straight into the company account: in the sales
  // figure, but never cash in hand
  var transfer = Number(r.bankTransferAmount || 0);
  if (!isFinite(transfer) || transfer < 0) return 'invalid_amount';
  if (other > 0) {
    var inc = r.otherCashItemId ? getById_(SHEETS.INCOME_ITEMS, r.otherCashItemId) : null;
    if (!inc || inc.active === false) return 'invalid_income_item';
    if (!String(r.otherCashReason || '').trim()) return 'reason_required';
    // cash a credit customer paid at the branch names him, so his statement shows it (2026-10-06)
    if (r.paymentCustomerId && inc.system !== 'customer_payment') r.paymentCustomerId = null;
    if (r.paymentCustomerId) {
      var payer = typeof r.paymentCustomerId === 'string' ? getById_(SHEETS.CUSTOMERS, r.paymentCustomerId) : null;
      if (!payer) return 'unknown_customer';
      if (payer.active === false) return 'invalid_customer';
    } else if (inc.system === 'customer_payment') return 'customer_required';
  }
  var exp = Number(r.expenseAmount || 0);
  if (exp > 0) {
    var ex = r.expenseItemId ? getById_(SHEETS.EXPENSE_ITEMS, r.expenseItemId) : null;
    if (!ex || ex.active === false) return 'invalid_expense_item';
    if (!String(r.expenseReason || '').trim()) return 'reason_required';
  }
  // A credit sale is money the branch is owed; without a name on it nobody
  // can chase it.
  // A negative figure would quietly take cash off what is owed.
  var nums = [r.cashSales, r.posSales, r.creditSales, r.deliveryFeeBankAmount, r.qty, r.unitPrice, r.cylindersOut, r.cylindersIn];
  for (var ni = 0; ni < nums.length; ni++) {
    if (nums[ni] == null || nums[ni] === '') continue;
    var nv = Number(nums[ni]);
    if (!isFinite(nv) || nv < 0) return 'invalid_amount';
  }
  var dep = Number(r.directDepositAmount || 0);
  if (dep > 0) {
    if (!String(r.directDepositRef || '').trim()) return 'deposit_needs_reference';
    // You can only bank cash you actually hold: everything this entry adds
    // to the hand, minus what it already takes out.
    var vat = vatRateOn_(r.date);
    var delivery = Number(r.deliveryFeeBankAmount || 0);
    // `siblingCash` is the cash on the OTHER rows of the same submission for
    // the same source and date: one real day gets split across several rows
    // in product mode, and the deposit rides on the first of them.
    var inHand = Number(r.cashSales || 0) - Number(r.creditSales || 0) - Number(r.creditCommission || 0) + Number(r.channelDeliveryFee || 0) - Number(r.channelCommission || 0) - transfer + Number(siblingCash || 0) + other
      - delivery + (delivery > 0 ? (delivery / (1 + vat)) * vat : 0) - exp - (r.discountOnCard === true ? 0 : disc);
    if (dep > inHand + 0.005) return 'deposit_exceeds_cash';
  }
  return null;
}

// Cash the other rows of this submission leave in hand, for the same source
// and date: what they bring in, less what they take out, including the
// الموازنات they bank themselves (so two lines cannot bank the same cash).
function siblingCash_(rows, index) {
  var me = rows[index] || {};
  var sum = 0;
  var vat = vatRateOn_(me.date);
  for (var i = 0; i < rows.length; i++) {
    if (i === index) continue;
    var o = rows[i] || {};
    if (o.sourceType === me.sourceType && o.sourceId === me.sourceId && o.date === me.date) {
      var dl = Number(o.deliveryFeeBankAmount || 0);
      sum += Number(o.cashSales || 0) - Number(o.creditSales || 0) - Number(o.creditCommission || 0) + Number(o.channelDeliveryFee || 0) - Number(o.channelCommission || 0) - Number(o.bankTransferAmount || 0)
        + Number(o.otherCash || 0) - Number(o.expenseAmount || 0) - dl + (dl > 0 ? (dl / (1 + vat)) * vat : 0)
        - Number(o.directDepositAmount || 0) - (o.discountOnCard === true ? 0 : Number(o.discountAmount || 0));
    }
  }
  return sum;
}

// A الموازنة names the branch's POS device (when it has one) and carries a
// photo its author uploaded. Checked where the branch is known. An admin's
// file import may carry neither: those rows come from paper, after the fact.
function checkDepositSlip_(r, user, locationId) {
  if (!(Number(r.directDepositAmount || 0) > 0)) return null;
  // a day entered for one POS machine banks its الموازنة on that machine
  // (2026-09-29): no device named means that one, another one is refused
  if (r.sourceType === 'pos' && r.sourceId) {
    if (!r.directDepositPosId) r.directDepositPosId = r.sourceId;
    else if (r.directDepositPosId !== r.sourceId) return 'deposit_pos_mismatch';
  }
  if (user.role === 'admin' && !r.directDepositPhotoId) return null;
  if (!r.directDepositPhotoId) return 'deposit_needs_photo';
  var ph = getById_(SHEETS.ENTRY_PHOTOS, r.directDepositPhotoId);
  if (!ph || ph.uploadedBy !== user.id || ph.usedBy) return 'invalid_photo';
  var devices = readSheet(SHEETS.POS).filter(function (m) {
    return m.active !== false && resolveSourceLocation_('pos', m.id) === locationId;
  });
  // A day entered for the branch itself (2026-10-01) may bank one الموازنة for
  // all its devices together: no device named means the branch as a whole. A
  // car's day still says which device.
  if (r.directDepositPosId) {
    if (!devices.some(function (m) { return m.id === r.directDepositPosId; })) return 'invalid_pos';
  } else if (devices.length && r.sourceType !== 'store') return 'deposit_needs_pos';
  return null;
}
function claimPhoto_(photoId, entryId) {
  if (!photoId) return;
  var ph = getById_(SHEETS.ENTRY_PHOTOS, photoId);
  if (!ph) return;
  ph.usedBy = entryId;
  writeRow(SHEETS.ENTRY_PHOTOS, ph);
}
// The photo goes up before the entry, so the entry request stays small.
var ENTRY_PHOTO_ROLES_ = ['admin', 'store_manager', 'driver', 'cluster_manager', 'branch_worker'];
function actionUploadEntryPhoto_(req, user) {
  if (ENTRY_PHOTO_ROLES_.indexOf(user.role) < 0) return { ok: false, error: 'forbidden' };
  var b64 = String(req.fileBase64 || '');
  if (!b64 || b64.length > 8000000) return { ok: false, error: 'invalid_input' };
  var fileId = saveDepositSlip_(b64, req.fileName, req.fileMime);
  writeRow(SHEETS.ENTRY_PHOTOS, { id: fileId, uploadedBy: user.id, createdAt: new Date().toISOString(), usedBy: null });
  return { ok: true, fileId: fileId };
}

// The non-sales columns every entry row carries, whichever path created it.
function nonSalesFields_(r) {
  return {
    discountAmount: Number(r.discountAmount || 0) > 0 ? Math.round(Number(r.discountAmount) * 100) / 100 : 0,
    discountReason: Number(r.discountAmount || 0) > 0 ? String(r.discountReason || '') : '',
    discountOnCard: Number(r.discountAmount || 0) > 0 && r.discountOnCard === true,
    // over the limit in Settings: flagged for Finance, never blocked
    discountFlag: discountLimit_() > 0 && Number(r.discountAmount || 0) > discountLimit_(),
    // what the discount was for, in the author's words (the discounts section, 2026-10-07)
    discountNote: Number(r.discountAmount || 0) > 0 ? String(r.discountNote || '').trim().slice(0, 1000) : '',
    otherCash: Number(r.otherCash || 0),
    otherCashItemId: Number(r.otherCash || 0) > 0 ? r.otherCashItemId : null,
    otherCashReason: Number(r.otherCash || 0) > 0 ? String(r.otherCashReason || '').trim().slice(0, 1000) : '',
    paymentCustomerId: Number(r.otherCash || 0) > 0 ? (r.paymentCustomerId || null) : null,
    expenseAmount: Number(r.expenseAmount || 0),
    expenseItemId: Number(r.expenseAmount || 0) > 0 ? r.expenseItemId : null,
    expenseReason: Number(r.expenseAmount || 0) > 0 ? String(r.expenseReason || '').trim().slice(0, 1000) : '',
    directDepositAmount: Number(r.directDepositAmount || 0),
    directDepositRef: Number(r.directDepositAmount || 0) > 0 ? String(r.directDepositRef || '').trim() : '',
    // What the deposit was for, in the depositor's own words. The company
    // calls these deposits "الموازنات", which is what the form suggests.
    directDepositNote: Number(r.directDepositAmount || 0) > 0 ? String(r.directDepositNote || '').trim().slice(0, 1000) : '',
    directDepositPosId: Number(r.directDepositAmount || 0) > 0 ? (r.directDepositPosId || null) : null,
    directDepositPhotoId: Number(r.directDepositAmount || 0) > 0 ? (r.directDepositPhotoId || null) : null,
    bankTransferAmount: Number(r.bankTransferAmount || 0),
    // what a delivery-fee line was for, and who owes a credit sale
    deliveryNote: Number(r.deliveryFeeBankAmount || 0) > 0 ? String(r.deliveryNote || '').trim().slice(0, 1000) : '',
    creditCustomer: Number(r.creditSales || 0) > 0 ? String(r.creditCustomer || '').trim() : '',
    creditCustomerId: Number(r.creditSales || 0) > 0 ? (r.creditCustomerId || null) : null,
    creditItems: Number(r.creditSales || 0) > 0 && r.creditItems && r.creditItems.length ? r.creditItems : null,
    creditDeliveryFee: Number(r.creditSales || 0) > 0 ? Number(r.creditDeliveryFee || 0) : 0,
    creditCommission: Number(r.creditSales || 0) > 0 ? Number(r.creditCommission || 0) : 0,
    channelId: r.channelId || null,
    channelQtys: r.channelQtys || null,
    channelDeliveryFee: Number(r.channelDeliveryFee || 0),
    channelCommission: Number(r.channelCommission || 0),
    channelComRates: r.channelComRates || null,
    // the rules the day was worked out by (2026-10-04): a later change never rewrites it
    creditFeeRule: 2,
    // whether the day's prices were typed with VAT (2026-10-06): its invoice and statement read it
    salesIncludeVat: salesIncludeVat_(),
    // the rate in force on the day's own date: a past day entered late keeps it
    vatRate: vatRateOn_(r.date)
  };
}

// Cash banked at the source is still a deposit: it is written as the same
// kind:'deposit' row the collector's deposit creates, so bank reconciliation,
// the 'deposited' totals and the deposit document all pick it up with no
// special cases — only `direct:true` and sourceEntryIds tell them apart.
function recordDirectDeposit_(entry, user) {
  var deposit = {
    id: Utilities.getUuid(),
    kind: 'deposit',
    direct: true,
    fromUserId: user.id,
    toUserId: null,
    locationId: entry.locationId,
    amount: Number(entry.directDepositAmount || 0),
    breakdown: { storeCash: 0, carCash: 0, posCash: 0, deliveryFee: 0, posSales: 0, creditSales: 0, vatOnDelivery: 0,
      otherCash: 0, expenses: 0, directDeposit: 0, netCashOwed: Number(entry.directDepositAmount || 0) },
    bankReference: entry.directDepositRef || '',
    note: entry.directDepositNote || '',
    attachmentId: entry.directDepositPhotoId || null,
    posId: entry.directDepositPosId || null,
    sourceEntryIds: [entry.id],
    sourceHandoffIds: [],
    consumedBy: null,
    status: 'completed',
    createdAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    confirmedBy: user.id
  };
  writeRow(SHEETS.HANDOFFS, deposit);
  logAudit_('direct_deposit', user.id, deposit.id);
  return deposit;
}

// The company's calendar day, in Riyadh.
function todayRiyadh_() {
  return Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd');
}

// A day a source has already handed over is closed: nothing more may be
// added to it, because anything added there (an expense, a credit sale, a
// الموازنة) would quietly change figures the next level has accepted. Today
// stays open, so a second handover in the same day still works. Future dates
// are never accepted.
function entryDateError_(sourceType, sourceId, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return 'invalid_date';
  var today = todayRiyadh_();
  if (date > today) return 'future_date';
  if (date < today) {
    var handed = readSheet(SHEETS.ENTRIES).some(function (e) {
      return e.sourceType === sourceType && e.sourceId === sourceId && e.date === date && e.consumedBy && !e.voided;
    });
    if (handed) return 'day_closed';
  }
  return null;
}

// Cancelling an entry: only its own author, only before it has been handed
// over, always with a reason, and never by deleting the row. A cancelled
// entry stays on file (voided) and drops out of every total. Several ids go
// together (one submission's rows) and all-or-nothing.
function actionVoidEntries_(req, user) {
  var ids = Array.isArray(req.ids) ? req.ids : (req.id ? [req.id] : []);
  var reason = String(req.reason || '').trim();
  if (!ids.length) return { ok: false, error: 'invalid_input' };
  if (!reason) return { ok: false, error: 'reason_required' };
  var rows = [], deposits = [];
  for (var i = 0; i < ids.length; i++) {
    var e = getById_(SHEETS.ENTRIES, ids[i]);
    if (!e) return { ok: false, error: 'not_found' };
    if (e.voided) return { ok: false, error: 'already_voided' };
    // not even an admin: the person who wrote it is the only one who may
    // take it back, so nobody else can make someone's figure disappear
    if (e.enteredBy !== user.id) return { ok: false, error: 'not_your_entry' };
    if (e.consumedBy) return { ok: false, error: 'entry_locked' };
    if (user.role === 'cluster_manager' && activeAreaOf_(user.id)) { var vl = getById_(SHEETS.LOCATIONS, e.locationId); if (!vl || vl.clusterId !== activeAreaOf_(user.id)) return { ok: false, error: 'other_area' }; }
    // a credit sale on an issued tax invoice: a credit note first (2026-10-06)
    if (e.creditCustomerId && invoicedEntries_()[e.id]) return { ok: false, error: 'entry_invoiced' };
    // Its الموازنة goes with it — unless Finance has already matched that
    // deposit to the bank statement: then the bank has confirmed the money
    // moved, and the day stays as it is.
    var dep = directDepositOf_(e.id);
    if (dep && dep.reconciled) return { ok: false, error: 'deposit_reconciled' };
    if (dep) deposits.push(dep);
    rows.push(e);
  }
  var at = new Date().toISOString();
  rows.forEach(function (e) {
    e.voided = true; e.voidedAt = at; e.voidedBy = user.id; e.voidReason = reason;
    writeRow(SHEETS.ENTRIES, e);
    logAudit_('void_entry', user.id, e.id);
    // its slip photo is free again, so the corrected day can carry the same slip (2026-10-06)
    if (e.directDepositPhotoId) {
      var ph = getById_(SHEETS.ENTRY_PHOTOS, e.directDepositPhotoId);
      if (ph && ph.usedBy === e.id) { ph.usedBy = null; writeRow(SHEETS.ENTRY_PHOTOS, ph); }
    }
  });
  deposits.forEach(function (d) {
    d.status = 'voided'; d.voidedAt = at; d.voidedBy = user.id; d.voidReason = reason;
    writeRow(SHEETS.HANDOFFS, d);
    logAudit_('void_direct_deposit', user.id, d.id);
  });
  return { ok: true, voided: rows.length, depositsVoided: deposits.length };
}

// The bank deposit a day's الموازنة wrote, if it is still standing.
function directDepositOf_(entryId) {
  return readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'deposit' && h.direct && h.status !== 'voided' && (h.sourceEntryIds || []).indexOf(entryId) >= 0;
  })[0] || null;
}

function actionCreateEntry_(req, user) {
  if (!req.date || !req.sourceType || !req.sourceId) return { ok: false, error: 'source_required' };
  var scope = checkEntryScope_(user, req.sourceType, req.sourceId);
  if (!scope.ok) return { ok: false, error: scope.error };
  var dateErr = entryDateError_(req.sourceType, req.sourceId, req.date);
  if (dateErr) return { ok: false, error: dateErr };

  if (Number(req.deliveryFeeBankAmount || 0) > 0 &&
    !deliveryNeedsSale_(req.sourceType, req.sourceId, req.date, req.cashSales, req.posSales, false, req.creditSales)) {
    return { ok: false, error: 'delivery_without_sale' };
  }
  if (creditOverLines_([req])) return { ok: false, error: 'credit_over_lines' };
  var nonSalesErr = checkNonSalesFields_(req) || checkDepositSlip_(req, user, scope.locationId);
  if (nonSalesErr) return { ok: false, error: nonSalesErr };

  var entry = {
    id: Utilities.getUuid(),
    date: req.date,
    sourceType: req.sourceType,
    sourceId: req.sourceId,
    locationId: scope.locationId,
    enteredBy: user.id,
    createdAt: new Date().toISOString(),
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
    note: String(req.note || '').slice(0, 1000),
    // rows saved together from one form share this, so the list can show
    // them as the one day's entry they are
    submissionId: req.submissionId ? String(req.submissionId).slice(0, 64) : null,
    consumedBy: null
  };
  var extra = nonSalesFields_(req);
  safeOwnKeys_(extra).forEach(function (k) { entry[k] = extra[k]; });
  writeRow(SHEETS.ENTRIES, entry);
  claimPhoto_(entry.directDepositPhotoId, entry.id);
  var directDeposit = entry.directDepositAmount > 0 ? recordDirectDeposit_(entry, user) : null;
  logAudit_('create_entry', user.id, entry.id);
  return { ok: true, entry: entry, deposit: directDeposit };
}

// Bulk version of actionCreateEntry_ for CSV/Excel import — same per-row
// scope check and field shape, just looped, so a bad row can't silently
// corrupt a good one. Capped well under Apps Script's execution limit.
function actionImportEntries_(req, user) {
  var rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length) return { ok: false, error: 'invalid_input' };
  if (rows.length > 500) return { ok: false, error: 'too_many_rows' };
  if (creditOverLines_(rows)) return { ok: false, error: 'credit_over_lines' };

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
      results.push({ row: i, ok: false, error: 'source_required' });
      continue;
    }
    var scope = checkEntryScope_(user, r.sourceType, r.sourceId);
    if (!scope.ok) {
      results.push({ row: i, ok: false, error: scope.error });
      continue;
    }
    var rowDateErr = entryDateError_(r.sourceType, r.sourceId, r.date);
    if (rowDateErr) {
      results.push({ row: i, ok: false, error: rowDateErr });
      continue;
    }
    if (Number(r.deliveryFeeBankAmount || 0) > 0 &&
      !deliveryNeedsSale_(r.sourceType, r.sourceId, r.date, r.cashSales, r.posSales, batchHasSale(r.sourceType, r.sourceId, r.date), r.creditSales)) {
      results.push({ row: i, ok: false, error: 'delivery_without_sale' });
      continue;
    }
    var rowErr = checkNonSalesFields_(r, siblingCash_(rows, i)) || checkDepositSlip_(r, user, scope.locationId);
    if (rowErr) {
      results.push({ row: i, ok: false, error: rowErr });
      continue;
    }
    var entry = {
      id: Utilities.getUuid(),
      date: r.date,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      locationId: scope.locationId,
      enteredBy: user.id,
    createdAt: new Date().toISOString(),
      productId: r.productId || null,
      cashSales: Number(r.cashSales || 0),
      deliveryFeeBankAmount: Number(r.deliveryFeeBankAmount || 0),
      posSales: Number(r.posSales || 0),
      creditSales: Number(r.creditSales || 0),
      qty: r.qty != null && r.qty !== '' ? Number(r.qty) : null,
      unitPrice: r.unitPrice != null && r.unitPrice !== '' ? Number(r.unitPrice) : null,
      cylindersOut: Number(r.cylindersOut || 0),
      cylindersIn: Number(r.cylindersIn || 0),
      note: String(r.note || '').slice(0, 1000),
      submissionId: r.submissionId ? String(r.submissionId).slice(0, 64) : null,
      consumedBy: null
    };
    var rowExtra = nonSalesFields_(r);
    safeOwnKeys_(rowExtra).forEach(function (k) { entry[k] = rowExtra[k]; });
    writeRow(SHEETS.ENTRIES, entry);
    claimPhoto_(entry.directDepositPhotoId, entry.id);
    if (entry.directDepositAmount > 0) recordDirectDeposit_(entry, user);
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
  } else if (user.role === 'driver' || user.role === 'branch_worker') {
    rows = rows.filter(function (e) { return e.enteredBy === user.id; });
  } else {
    rows = [];
  }

  if (req.locationId) rows = rows.filter(function (e) { return e.locationId === req.locationId; });
  if (req.date) rows = rows.filter(function (e) { return e.date === req.date; });

  rows.sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
  // Where each entry stands, worked out here so the list and the rules can
  // never disagree: open (its author may still cancel it), submitted (in a
  // handover or batch awaiting the next level — locked), approved (the next
  // level confirmed it — locked for good), or voided.
  var hStatus = {}, bankMatched = {};
  readSheet(SHEETS.HANDOFFS).forEach(function (h) {
    hStatus[h.id] = h.status;
    if (h.kind === 'deposit' && h.direct && h.reconciled && h.status !== 'voided') {
      (h.sourceEntryIds || []).forEach(function (id) { bankMatched[id] = true; });
    }
  });
  readSheet(SHEETS.AREA_BULK_BATCHES).forEach(function (b) { hStatus[b.id] = b.status; });
  rows.forEach(function (e) {
    var st = e.consumedBy ? hStatus[e.consumedBy] : null;
    e.lockState = e.voided ? 'voided'
      : !e.consumedBy ? 'open'
      : (st === 'confirmed' || st === 'completed' || st === 'deputy_approved') ? 'approved'
      : 'submitted';
    // why an open entry cannot be cancelled, when it cannot
    e.voidBlock = e.lockState !== 'open' ? null
      : e.enteredBy !== user.id ? 'not_author'
      : bankMatched[e.id] ? 'deposit_reconciled'
      : null;
    e.canVoid = e.lockState === 'open' && !e.voidBlock;
  });
  // where each one stands now, from the same walk the journey uses, so the list
  // and the timeline cannot disagree (never lets a bad row break the list)
  try {
    var jc = jrCtx_(user);
    rows.forEach(function (e) { try { var sg = jrStage_(jc, e); if (sg) e.stage = sg; } catch (x) { /* the list still stands */ } });
  } catch (x) { /* the list still stands */ }
  return { ok: true, entries: rows };
}

// Cash or approvals still in motion around a person: entries they wrote
// that are not handed over yet, handoffs from or to them still open, and
// confirmed cash they received and have not passed on.
function personBusy_(userId) {
  if (!userId) return false;
  var busyEntry = readSheet(SHEETS.ENTRIES).some(function (e) { return e.enteredBy === userId && !e.consumedBy && !e.voided; });
  if (busyEntry) return true;
  return readSheet(SHEETS.HANDOFFS).some(function (h) {
    if (h.kind === 'deposit') return false;
    var open = h.status === 'pending' || h.status === 'disputed' || h.status === 'pending_deputy';
    if (open && (h.fromUserId === userId || h.toUserId === userId)) return true;
    return h.toUserId === userId && h.status === 'confirmed' && !h.consumedBy;
  });
}
// The same for a place: a branch, or one store / car / POS machine.
function placeBusy_(kind, id) {
  var entries = readSheet(SHEETS.ENTRIES).filter(function (e) { return !e.consumedBy && !e.voided; });
  if (kind === 'location') {
    if (entries.some(function (e) { return e.locationId === id; })) return true;
    return readSheet(SHEETS.HANDOFFS).some(function (h) {
      if (h.locationId !== id || h.kind === 'deposit') return false;
      return h.status === 'pending' || h.status === 'disputed' || (h.status === 'confirmed' && !h.consumedBy);
    });
  }
  if (entries.some(function (e) { return e.sourceType === kind && e.sourceId === id; })) return true;
  if (kind === 'car') {
    return readSheet(SHEETS.HANDOFFS).some(function (h) {
      return h.carId === id && (h.status === 'pending' || h.status === 'disputed' || (h.status === 'confirmed' && !h.consumedBy));
    });
  }
  return false;
}

function unconsumedEntriesForLocation_(locationId) {
  return readSheet(SHEETS.ENTRIES).filter(function (e) { return e.locationId === locationId && !e.consumedBy && !e.voided; });
}

// Gross "total sales" for one entry — cash + POS + credit, regardless of
// cash-collection risk. Used for report filtering/aggregation only; never
// for computeNet_'s cash-owed formula, which credit sales stay out of.
// A day's sales: the typed sales figure plus card sales. What was sold on
// credit is already inside the typed figure (see computeNet_), so adding
// creditSales again counted it twice (fixed 2026-09-28).
function entrySalesTotal_(e) {
  return Number(e.cashSales || 0) + Number(e.posSales || 0);
}

// mirrors the xlsx formula, extended to POS: a POS machine can also take cash
// (not just card) and can also carry its own delivery fee paid to the bank —
// both are real cash risk / real deductions exactly like a car's, so they
// feed the same net-cash formula. posSales stays card/bank-only, no cash risk.
// A store or car can carry its own mounted POS terminal too, so a store/car
// entry can also report card/bank posSales alongside its cash — same
// no-cash-risk treatment as a dedicated 'pos' source, just logged on the
// store's/car's own entry instead of a separate pos_machines row.
//
// Delivery fees apply to EVERY source type, including a branch store: the
// branch sells with delivery too, and the fee is paid to the bank, not held
// as cash. Restricting it to car/pos silently dropped a branch's (and an
// area manager's bulk-uploaded) delivery lines out of the formula.
//
// Three more things move cash at the source without being a sale:
//   otherCash  — money collected for something else (an old credit sale paid
//                off, a cylinder deposit, scrap): real cash in hand, so it is
//                ADDED to what must be handed over.
//   expenses   — cash paid out of the takings (fuel, a small repair): the
//                money is gone, so it is DEDUCTED.
//   directDeposit — cash taken straight to the bank at the source: already
//                banked, so it is DEDUCTED and only the remainder travels up
//                the handoff chain.
//
// netCashOwed = cash(branch+car+pos) + otherCash - deliveryFee + vatOnDelivery
//               - expenses - directDeposit - creditSales
function computeNet_(entries) {
  var storeCash = 0, carCash = 0, posCash = 0, deliveryFee = 0, posSales = 0, creditSales = 0;
  var otherCash = 0, expenses = 0, directDeposit = 0, bankTransfers = 0, creditDeliveryFees = 0, creditCommissions = 0;
  var channelDeliveryFees = 0, channelCommissions = 0, creditDeliveryUnpaid = 0, vatOnDelivery = 0, discounts = 0, vatHist = vatHistory_();
  entries.forEach(function (e) {
    // The credit customer's delivery fee is earned but paid later with the goods,
    // never in cash: from 2026-10-04 it is shown with the sales AND taken off
    // again (the user: "we add it in sales but did not deduct it again"). A day
    // saved before then keeps the figure it was handed over with.
    if (Number(e.creditFeeRule) >= 2) creditDeliveryUnpaid += Number(e.creditDeliveryFee || 0);
    // each day at the VAT rate it was saved with
    var dFee = Number(e.deliveryFeeBankAmount || 0);
    if (dFee > 0) { var vr = entryVatRate_(e, vatHist); vatOnDelivery += dFee / (1 + vr) * vr; }
    channelDeliveryFees += Number(e.channelDeliveryFee || 0);
    channelCommissions += Number(e.channelCommission || 0);
    creditDeliveryFees += Number(e.creditDeliveryFee || 0);
    creditCommissions += Number(e.creditCommission || 0);
    bankTransfers += Number(e.bankTransferAmount || 0);
    // a discount given in cash comes off the cash (on a card line the card amount is already net)
    if (e.discountOnCard !== true) discounts += Number(e.discountAmount || 0);
    // A sale on credit is part of the day's takings figure the branch
    // enters, but no money came in for it — so it is DEDUCTED below,
    // exactly like an expense or a موازنة. (Until 2026-09-23 it was simply
    // excluded; that only works if the cash figure was typed net of
    // credit, which is not how the branches actually report.)
    creditSales += Number(e.creditSales || 0);
    deliveryFee += Number(e.deliveryFeeBankAmount || 0);
    posSales += Number(e.posSales || 0);
    otherCash += Number(e.otherCash || 0);
    expenses += Number(e.expenseAmount || 0);
    directDeposit += Number(e.directDepositAmount || 0);
    if (e.sourceType === 'store') storeCash += Number(e.cashSales || 0);
    else if (e.sourceType === 'car') carCash += Number(e.cashSales || 0);
    else if (e.sourceType === 'pos') posCash += Number(e.cashSales || 0);
  });
  // a customer's bank transfer is inside the sales figure like a credit
  // sale, but the money went straight to the bank: it comes off too
  var netCashOwed = storeCash + carCash + posCash + otherCash - deliveryFee + vatOnDelivery - expenses - directDeposit - creditSales - bankTransfers - creditCommissions
    // a credit customer's delivery fee: added, and on a day saved from 2026-10-04 taken off again
    + creditDeliveryFees - creditDeliveryUnpaid + channelDeliveryFees - channelCommissions - discounts;
  return {
    storeCash: storeCash, carCash: carCash, posCash: posCash, deliveryFee: deliveryFee,
    posSales: posSales, creditSales: creditSales, vatOnDelivery: vatOnDelivery,
    otherCash: otherCash, expenses: expenses, directDeposit: directDeposit, bankTransfers: bankTransfers,
    creditDeliveryFees: creditDeliveryFees, creditDeliveryUnpaid: creditDeliveryUnpaid, creditCommissions: creditCommissions,
    channelDeliveryFees: channelDeliveryFees, channelCommissions: channelCommissions, discounts: discounts, netCashOwed: netCashOwed
  };
}

// A cluster-to-collector handoff batches several already-confirmed
// location handoffs, and a deposit batches several cluster handoffs — each
// carries its own breakdown already, so the batch's breakdown is just their
// sum, never recomputed from entries (that would double-apply the VAT
// clawback). Without this, receivers only ever saw one flat total with no
// way to see what it was made of.
function sumBreakdowns_(breakdowns) {
  var out = { storeCash: 0, carCash: 0, posCash: 0, deliveryFee: 0, posSales: 0, creditSales: 0, vatOnDelivery: 0,
    otherCash: 0, expenses: 0, directDeposit: 0, bankTransfers: 0, creditDeliveryFees: 0, creditDeliveryUnpaid: 0, creditCommissions: 0, channelDeliveryFees: 0, channelCommissions: 0,
    shortfall: 0, discounts: 0, netCashOwed: 0 };
  breakdowns.forEach(function (b) {
    if (!b) return;
    out.shortfall += Number(b.shortfall || 0);
    out.discounts += Number(b.discounts || 0);
    out.channelDeliveryFees += Number(b.channelDeliveryFees || 0);
    out.channelCommissions += Number(b.channelCommissions || 0);
    out.creditCommissions += Number(b.creditCommissions || 0);
    out.creditDeliveryFees += Number(b.creditDeliveryFees || 0);
    out.creditDeliveryUnpaid += Number(b.creditDeliveryUnpaid || 0);
    out.bankTransfers += Number(b.bankTransfers || 0);
    out.storeCash += Number(b.storeCash || 0);
    out.carCash += Number(b.carCash || 0);
    out.posCash += Number(b.posCash || 0);
    out.deliveryFee += Number(b.deliveryFee || 0);
    out.posSales += Number(b.posSales || 0);
    out.creditSales += Number(b.creditSales || 0);
    out.vatOnDelivery += Number(b.vatOnDelivery || 0);
    out.otherCash += Number(b.otherCash || 0);
    out.expenses += Number(b.expenses || 0);
    out.directDeposit += Number(b.directDeposit || 0);
    out.netCashOwed += Number(b.netCashOwed || 0);
  });
  return out;
}

// A handover received short (or over) changes what travels on, so the
// difference becomes a part of the breakdown, added to any difference already
// in it from a stage below. Rewriting only netCashOwed (until 2026-10-03) left
// the parts adding up to the declared figure at every later stage: the
// statement said 600 while the amount said 580, and it read as the amount
// changing between stages.
function receivedBreakdown_(b, received, shortfall) {
  if (!b) return b;
  return Object.assign({}, b, { netCashOwed: received, shortfall: Math.round((Number(b.shortfall || 0) + shortfall) * 100) / 100 });
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
// The car an entry's cash rides in: the car itself, or the car a POS machine is
// mounted on (2026-09-29: every driver's POS sits on his car, so a driver's
// POS day must go through his own handover like a car day).
function entryCarId_(e, posById) {
  if (e.sourceType === 'car') return e.sourceId;
  if (e.sourceType === 'pos') { var p = posById[e.sourceId]; if (p && p.ownerType === 'car') return p.ownerId; }
  return null;
}
function posById_() { var m = {}; readSheet(SHEETS.POS).forEach(function (p) { m[p.id] = p; }); return m; }

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

  var posMap = posById_();
  var entries = readSheet(SHEETS.ENTRIES).filter(function (e) {
    return entryCarId_(e, posMap) === car.id && !e.consumedBy && !e.voided;
  });
  if (!entries.length) return { ok: false, error: 'no_entries' };
  var totals = computeNet_(entries);
  if (totals.netCashOwed <= 0) return { ok: false, error: 'nothing_owed' };

  var handoff = {
    id: Utilities.getUuid(),
    kind: 'car_to_location',
    // the driver holds this cash, whoever pressed the button
    fromUserId: user.role === 'admin' ? car.driverUserId : user.id,
    createdBy: user.id,
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
  var allUnconsumed = unconsumedEntriesForLocation_(location.id), posMap = posById_();
  var directEntries = allUnconsumed.filter(function (e) {
    // what the area manager entered for this branch is his cash, handed on
    // in his own request (createClusterHandoff_), never by the branch manager
    if (e.enteredBy === cluster.clusterManagerUserId) return false;
    return !entryCarId_(e, posMap) || (store && e.enteredBy === store.storeManagerUserId);
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
    fromUserId: user.role === 'admin' && store && store.storeManagerUserId ? store.storeManagerUserId : user.id,
    createdBy: user.id,
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

// The area manager's request to the collectors: one handoff per branch, each
// to that branch's own collector (branchCollector_), so an area served by
// two collectors sends each of them only their branches' cash.
// req.locationId limits it to one branch; without it every branch with ready
// cash is sent. Each still waits for the Deputy Operations Manager
// (pending_deputy) before its collector sees it.
function createClusterHandoff_(req, user) {
  var cluster = getById_(SHEETS.CLUSTERS, req.clusterId);
  if (!cluster) return { ok: false, error: 'not_found' };
  if (user.role !== 'admin' && !clusterManagerOwnsCluster_(user.id, cluster.id)) return { ok: false, error: 'forbidden' };
  var areaLocIds = readSheet(SHEETS.LOCATIONS).filter(function (l) { return l.clusterId === cluster.id; })
    .map(function (l) { return l.id; });
  if (req.locationId && areaLocIds.indexOf(req.locationId) < 0) return { ok: false, error: 'not_found' };

  // A returned request is corrected and sent again as its next version
  // (2026-10-05): the returned row stays as it is (only resubmittedAs is
  // written on it), the new one carries the history.
  var prior = null, onlyLoc = req.locationId || null, correctionNote = '';
  if (req.resubmitOf) {
    prior = getById_(SHEETS.HANDOFFS, req.resubmitOf);
    var priorErr = resendError_(prior, cluster, user);
    if (priorErr) return { ok: false, error: priorErr };
    if (req.locationId && req.locationId !== prior.locationId) return { ok: false, error: 'invalid_location' };
    correctionNote = String(req.correctionNote || '').trim();
    if (!correctionNote || correctionNote.length > 1000) return { ok: false, error: 'note_required' };
    onlyLoc = prior.locationId;
  }
  function wanted(locId) { return !onlyLoc || locId === onlyLoc; }

  var held = readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'location_to_cluster' && h.clusterId === cluster.id && h.status === 'confirmed' && !h.consumedBy && wanted(h.locationId);
  });
  // A branch day the area manager entered himself is cash he collected
  // himself: it travels in his own request, not through the branch
  // manager's handover (createLocationHandoff_ leaves it out).
  var ownEntries = readSheet(SHEETS.ENTRIES).filter(function (e) {
    return !e.consumedBy && !e.voided && e.enteredBy === cluster.clusterManagerUserId && areaLocIds.indexOf(e.locationId) >= 0 && wanted(e.locationId);
  });
  if (!held.length && !ownEntries.length) return { ok: false, error: prior ? 'nothing_owed' : 'no_held_cash' };

  var groups = {}, order = [];
  function group(locId) {
    if (!groups[locId]) { groups[locId] = { locationId: locId, held: [], own: [] }; order.push(locId); }
    return groups[locId];
  }
  held.forEach(function (h) { group(h.locationId).held.push(h); });
  ownEntries.forEach(function (e) { group(e.locationId).own.push(e); });

  // settle every branch before writing anything: one branch without a
  // collector stops the request rather than sending half of it
  var plans = [];
  for (var i = 0; i < order.length; i++) {
    var g = groups[order[i]];
    var perLocation = g.held.map(function (h) {
      return { locationId: h.locationId, amount: h.amount, breakdown: h.breakdown };
    });
    if (g.own.length) {
      var t = computeNet_(g.own);
      perLocation.push({ locationId: g.locationId, amount: t.netCashOwed, breakdown: t, enteredByAreaManager: true });
    }
    var amount = perLocation.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
    // a branch whose ready cash nets to nothing stays ready; its next day nets it off
    if (amount <= 0) continue;
    var collectorId = branchCollector_(g.locationId);
    if (!collectorId) return { ok: false, error: 'no_collector', locationId: g.locationId };
    if (collectorId === user.id || collectorId === cluster.clusterManagerUserId) return { ok: false, error: 'conflict_of_interest', locationId: g.locationId };
    plans.push({ g: g, perLocation: perLocation, amount: amount, collectorId: collectorId });
  }
  if (!plans.length) return { ok: false, error: 'nothing_owed' };

  var handoffs = plans.map(function (p) {
    var handoff = {
      id: Utilities.getUuid(),
      kind: 'cluster_to_collector',
      fromUserId: user.role === 'admin' ? cluster.clusterManagerUserId : user.id,
      createdBy: user.id,
      toUserId: p.collectorId,
      clusterId: cluster.id,
      locationId: p.g.locationId,
      amount: p.amount,
      breakdown: sumBreakdowns_(p.perLocation.map(function (x) { return x.breakdown; })),
      perLocation: p.perLocation,
      sourceEntryIds: p.g.own.map(function (e) { return e.id; }),
      sourceHandoffIds: p.g.held.map(function (h) { return h.id; }),
      consumedBy: null,
      // the Deputy Operations Manager validates it before the collector sees it
      status: 'pending_deputy',
      createdAt: new Date().toISOString()
    };
    if (prior) {
      handoff.resubmitOf = prior.id;
      handoff.revision = Number(prior.revision || 1) + 1;
      handoff.correctionNote = correctionNote;
      handoff.history = (prior.history || []).concat([{
        revision: Number(prior.revision || 1), amount: prior.amount, perLocation: prior.perLocation || [],
        returnReason: prior.returnReason || '', returnedBy: prior.deputyReturnedBy || null,
        returnedAt: prior.deputyReturnedAt || null, correctionNote: prior.correctionNote || ''
      }]);
    }
    writeRow(SHEETS.HANDOFFS, handoff);
    p.g.held.forEach(function (h) { h.consumedBy = handoff.id; writeRow(SHEETS.HANDOFFS, h); });
    p.g.own.forEach(function (e) { e.consumedBy = handoff.id; writeRow(SHEETS.ENTRIES, e); });
    // any other returned request of this branch and area manager can no longer
    // be resent: the cash it released is in this one now
    readSheet(SHEETS.HANDOFFS).forEach(function (r) {
      if (r.kind === 'cluster_to_collector' && r.status === 'returned' && !r.resubmittedAs && !r.supersededBy &&
        r.locationId === p.g.locationId && r.fromUserId === handoff.fromUserId && (!prior || r.id !== prior.id)) {
        r.supersededBy = handoff.id;
        writeRow(SHEETS.HANDOFFS, r);
      }
    });
    if (prior && !prior.resubmittedAs) { prior.resubmittedAs = handoff.id; writeRow(SHEETS.HANDOFFS, prior); }
    logAudit_(prior ? 'area_handoff_resubmit' : 'create_handoff_cluster', user.id, handoff.id);
    notifyDeputyPendingHandoff_(handoff);
    return handoff;
  });
  return { ok: true, handoff: handoffs[0], handoffs: handoffs };
}

// Why a returned area request cannot be corrected and sent again by this
// person, or null. The returned row is never edited: the only thing written on
// it is resubmittedAs (or supersededBy when a normal request took its cash).
function resendError_(prior, cluster, user) {
  if (!prior || prior.kind !== 'cluster_to_collector') return 'not_found';
  if (prior.clusterId !== cluster.id) return 'forbidden';
  if (user.role !== 'admin' && prior.fromUserId !== user.id) return 'forbidden';
  if (prior.status !== 'returned') return 'not_returned';
  // made before per-branch requests: it spans several branches, so it is not resent
  if (!prior.locationId) return 'legacy_request';
  if (prior.resubmittedAs) return 'already_resubmitted';
  if (prior.supersededBy) return 'superseded';
  // its branch handovers or entries already went into another request
  var gone = (prior.sourceHandoffIds || []).some(function (id) {
    var sh = getById_(SHEETS.HANDOFFS, id);
    return sh && sh.consumedBy;
  }) || (prior.sourceEntryIds || []).some(function (id) {
    var e = getById_(SHEETS.ENTRIES, id);
    return e && !e.voided && e.consumedBy;
  });
  return gone ? 'superseded' : null;
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
//
// req.dryRun: true runs every validation and computes the exact same
// breakdown/perLocation the Deputy will eventually see, WITHOUT writing
// anything — no entries, no batch row, no email. This lets the area
// manager review the real, server-computed numbers (the same computeNet_
// formula, not a client-side reimplementation that could drift from it)
// before committing. The client calls this first for the preview, then
// calls again without dryRun (identical payload) to actually submit.
function actionBulkSubmitAreaBatch_(req, user) {
  if (!areaManagerBulkUploadEnabled_()) return { ok: false, error: 'feature_disabled' };
  var cluster = getById_(SHEETS.CLUSTERS, req.clusterId);
  if (!cluster) return { ok: false, error: 'not_found' };
  if (user.role !== 'admin' && (user.role !== 'cluster_manager' || !clusterManagerOwnsCluster_(user.id, cluster.id))) {
    return { ok: false, error: 'forbidden' };
  }

  // A batch the deputy rejected is corrected and sent again as itself
  // (2026-10-05): same id, its next version, the rejected version kept on it.
  var prior = null;
  if (req.resubmitOf) {
    prior = getById_(SHEETS.AREA_BULK_BATCHES, req.resubmitOf);
    var priorErr = resubmitError_(prior, user);
    if (priorErr) return { ok: false, error: priorErr };
    if (prior.clusterId !== cluster.id) return { ok: false, error: 'forbidden' };
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
      errors.push({ row: i, error: 'source_required' });
      continue;
    }
    var scope = checkClusterBulkEntryScope_(user, cluster.id, r.sourceType, r.sourceId);
    if (!scope.ok) {
      errors.push({ row: i, error: scope.error });
      continue;
    }
    var bulkDateErr = entryDateError_(r.sourceType, r.sourceId, r.date);
    if (bulkDateErr) {
      errors.push({ row: i, error: bulkDateErr });
      continue;
    }
    if (Number(r.deliveryFeeBankAmount || 0) > 0 &&
      !deliveryNeedsSale_(r.sourceType, r.sourceId, r.date, r.cashSales, r.posSales, batchHasSale(r.sourceType, r.sourceId, r.date), r.creditSales)) {
      errors.push({ row: i, error: 'delivery_without_sale' });
      continue;
    }
    var nonSales = checkNonSalesFields_(r, siblingCash_(rows, i));
    if (nonSales) {
      errors.push({ row: i, error: nonSales });
      continue;
    }
    prepared.push({ row: r, locationId: scope.locationId });
  }
  if (errors.length) return { ok: false, error: 'invalid_rows', results: errors };
  if (creditOverLines_(rows)) return { ok: false, error: 'credit_over_lines' };

  var batchId = prior ? prior.id : Utilities.getUuid();
  var isDryRun = !!req.dryRun;
  var entries = prepared.map(function (p) {
    var r = p.row;
    var e = {
      id: Utilities.getUuid(),
      date: r.date,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      locationId: p.locationId,
      enteredBy: user.id,
    createdAt: new Date().toISOString(),
      productId: r.productId || null,
      cashSales: Number(r.cashSales || 0),
      deliveryFeeBankAmount: Number(r.deliveryFeeBankAmount || 0),
      posSales: Number(r.posSales || 0),
      creditSales: Number(r.creditSales || 0),
      qty: r.qty != null && r.qty !== '' ? Number(r.qty) : null,
      unitPrice: r.unitPrice != null && r.unitPrice !== '' ? Number(r.unitPrice) : null,
      cylindersOut: Number(r.cylindersOut || 0),
      cylindersIn: Number(r.cylindersIn || 0),
      note: String(r.note || '').slice(0, 1000),
      batchId: batchId,
      consumedBy: batchId,
      voided: false
    };
    var rowExtra = nonSalesFields_(r);
    safeOwnKeys_(rowExtra).forEach(function (k) { e[k] = rowExtra[k]; });
    return e;
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

  if (prior) {
    batch.createdAt = prior.createdAt;
    batch.resubmittedAt = new Date().toISOString();
    batch.revision = Number(prior.revision || 1) + 1;
    batch.history = (prior.history || []).concat([{
      revision: Number(prior.revision || 1), entryIds: prior.entryIds, netCashOwed: prior.breakdown ? prior.breakdown.netCashOwed : 0,
      rejectionNote: prior.rejectionNote || '', rejectedBy: prior.deputyActedBy || null, rejectedAt: prior.deputyActedAt || null,
      submittedAt: prior.resubmittedAt || prior.createdAt
    }]);
  }

  if (isDryRun) {
    return { ok: true, dryRun: true, batch: batch };
  }

  if (prior) {
    // two taps on "send again" must not both go through
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var fresh = getById_(SHEETS.AREA_BULK_BATCHES, prior.id);
      var freshErr = resubmitError_(fresh, user);
      if (freshErr) return { ok: false, error: freshErr };
      entries.forEach(function (e) { writeRow(SHEETS.ENTRIES, e); });
      writeRow(SHEETS.AREA_BULK_BATCHES, batch);
    } finally { try { lock.releaseLock(); } catch (e) {} }
    logAudit_('resubmit_area_batch', user.id, batch.id + ' v' + batch.revision);
    notifyDeputyPendingBatch_(batch);
    return { ok: true, batch: batch };
  }

  entries.forEach(function (e) { writeRow(SHEETS.ENTRIES, e); });
  writeRow(SHEETS.AREA_BULK_BATCHES, batch);
  logAudit_('bulk_submit_area_batch', user.id, batch.id);
  notifyDeputyPendingBatch_(batch);
  return { ok: true, batch: batch };
}

// Why a batch cannot be corrected and sent again by this person, or null.
function resubmitError_(batch, user) {
  if (!batch) return 'not_found';
  if (batch.uploadedBy !== user.id && user.role !== 'admin') return 'forbidden';
  if (user.role === 'cluster_manager' && activeAreaOf_(user.id) && batch.clusterId !== activeAreaOf_(user.id)) return 'other_area';
  if (batch.status !== 'deputy_rejected') return 'not_rejected';
  return null;
}
// The fields an area row is sent with; the rest of an entry is worked out again.
var BATCH_ROW_FIELDS_ = ['date', 'sourceType', 'sourceId', 'productId', 'qty', 'unitPrice', 'cashSales', 'posSales', 'creditSales',
  'creditCustomerId', 'channelQtys', 'channelComRates', 'deliveryFeeBankAmount', 'deliveryNote', 'otherCash', 'otherCashItemId',
  'otherCashReason', 'expenseAmount', 'expenseItemId', 'expenseReason', 'directDepositAmount', 'directDepositRef', 'directDepositNote',
  'directDepositPosId', 'paymentCustomerId', 'discountAmount', 'discountReason', 'discountOnCard', 'discountNote', 'bankTransferAmount', 'cylindersOut', 'cylindersIn', 'note'];
function actionAreaBatchRows_(req, user) {
  var batch = getById_(SHEETS.AREA_BULK_BATCHES, req.id);
  var err = resubmitError_(batch, user);
  if (err) return { ok: false, error: err };
  var byId = Object.create(null);
  readSheet(SHEETS.ENTRIES).forEach(function (e) { byId[e.id] = e; });
  var rows = (batch.entryIds || []).map(function (id) { return byId[id]; }).filter(Boolean).map(function (e) {
    var r = {};
    BATCH_ROW_FIELDS_.forEach(function (k) { if (e[k] != null && e[k] !== '' && e[k] !== 0) r[k] = e[k]; });
    if (e.creditItems) r.creditItems = e.creditItems.map(function (it) { return { productId: it.productId, qty: it.qty, unitPrice: it.unitPrice }; });
    return r;
  });
  return { ok: true, batch: batch, rows: rows };
}

function actionListAreaBulkBatches_(req, user) {
  var rows = readSheet(SHEETS.AREA_BULK_BATCHES);
  if (user.role === 'cluster_manager') {
    rows = rows.filter(function (b) { return b.uploadedBy === user.id && (!activeAreaOf_(user.id) || b.clusterId === activeAreaOf_(user.id)); });
  } else if (user.role !== 'deputy_operations_manager' && !isCompanyWide_(user.role)) {
    rows = [];
  }
  if (req.status) rows = rows.filter(function (b) { return b.status === req.status; });
  rows.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return { ok: true, batches: rows };
}

// The area-bulk dry-run preview (actionBulkSubmitAreaBatch_ with
// req.dryRun) computes a per-product VAT breakdown client-side from the
// CSV rows still sitting in memory — but that detail is gone the moment
// the batch is actually submitted, since area_bulk_batches only stores the
// aggregate breakdown/perLocation, not a per-product one. This re-derives
// the same product-level detail after the fact, straight from the batch's
// own entries (batchId ties every daily_entries row back to it), so the
// area manager and the Deputy can both check product/qty/subtotal/VAT for
// an already-submitted batch, not just during the upload moment. Same
// access rule as actionListAreaBulkBatches_: the uploading cluster manager,
// or Deputy/company-wide roles — never a stranger's batch.
function actionAreaBulkBatchDetail_(req, user) {
  var batch = getById_(SHEETS.AREA_BULK_BATCHES, req.id);
  if (!batch) return { ok: false, error: 'not_found' };
  if (user.role === 'cluster_manager') {
    if (batch.uploadedBy !== user.id) return { ok: false, error: 'forbidden' };
    if (activeAreaOf_(user.id) && batch.clusterId !== activeAreaOf_(user.id)) return { ok: false, error: 'other_area' };
  } else if (user.role !== 'deputy_operations_manager' && !isCompanyWide_(user.role)) {
    return { ok: false, error: 'forbidden' };
  }

  // the current version's lines: a corrected batch keeps its rejected lines under the same batchId
  var mine = Object.create(null);
  (batch.entryIds || []).forEach(function (id) { mine[id] = true; });
  var entries = readSheet(SHEETS.ENTRIES).filter(function (e) { return e.batchId === batch.id && mine[e.id]; });
  var products = readSheet(SHEETS.PRODUCTS);
  var productById = Object.create(null);
  products.forEach(function (p) { productById[p.id] = p; });

  var vatHist = vatHistory_();
  var byProductMap = Object.create(null);
  entries.forEach(function (e) {
    var key = e.productId || '__unspecified__';
    if (!byProductMap[key]) byProductMap[key] = { productId: e.productId || null, qty: 0, subtotal: 0, base: 0 };
    // Every bulk-upload row routes its qty*unitPrice subtotal into exactly
    // one of these four fields depending on paymentMethod (see
    // actionBulkSubmitAreaBatch_/renderAreaBulk) — summing all four per
    // entry recovers that same subtotal without re-deriving it from
    // qty*unitPrice, so it still works even if either was left blank.
    var sub = Number(e.cashSales || 0) + Number(e.posSales || 0) + Number(e.creditSales || 0) + Number(e.deliveryFeeBankAmount || 0);
    byProductMap[key].subtotal += sub;
    byProductMap[key].base += sub / (1 + entryVatRate_(e, vatHist));
    byProductMap[key].qty += Number(e.qty || 0);
  });
  var byProduct = Object.keys(byProductMap).map(function (key) {
    var bucket = byProductMap[key];
    var p = bucket.productId ? productById[bucket.productId] : null;
    var base = bucket.base;
    var vat = bucket.subtotal - bucket.base;
    return {
      productId: bucket.productId, name: p ? p.name : null, type: p ? p.type : null,
      qty: bucket.qty, subtotal: bucket.subtotal, base: base, vat: vat
    };
  }).sort(function (a, b) { return b.subtotal - a.subtotal; });

  return { ok: true, batch: batch, byProduct: byProduct };
}

// Hand-builds a cluster_to_collector-shaped handoff directly rather than
// routing the Deputy's decision through actionConfirmHandoff_/dispute — see
// CLAUDE.md for the full reasoning. Short version: confirmHandoff_ exists to
// capture a *received-cash* variance (shortfall/originalAmount), and the
// Deputy isn't receiving cash here, they're approving whether the uploaded
// *data* is accurate before any cash claim exists; forcing this through that
// machinery would permanently no-op the shortfall path for every bulk batch.
function actionDeputyApproveBatch_(req, user) {
  if (!isAreaApprover_(user.role) && user.role !== 'admin') return { ok: false, error: 'forbidden' };
  var batch = getById_(SHEETS.AREA_BULK_BATCHES, req.id);
  if (!batch) return { ok: false, error: 'not_found' };
  // 'approving' is a run that stopped half-way (a timeout on a big batch):
  // approving again finishes it without writing anything twice
  if (batch.status !== 'pending_deputy' && batch.status !== 'approving') return { ok: false, error: 'not_pending' };
  // Structurally near-impossible today (a user holds exactly one role), but
  // checked explicitly anyway — a self-check is never implied by the role
  // requirement alone (see CLAUDE.md Trap #3).
  if (batch.uploadedBy === user.id) return { ok: false, error: 'conflict_of_interest' };

  var cluster = getById_(SHEETS.CLUSTERS, batch.clusterId);
  if (!cluster) return { ok: false, error: 'not_found' };

  // One handover per branch, each to that branch's own collector. A branch
  // whose day nets to nothing (banked directly, say) sends none: its entries
  // stay settled by this approval. Every branch is checked before anything
  // is written, so a branch without a collector stops the whole approval.
  // one read of the entries, not one per line (a big batch timed out here)
  var entryById = {};
  readSheet(SHEETS.ENTRIES).forEach(function (e) { entryById[e.id] = e; });
  var entryLoc = {};
  batch.entryIds.forEach(function (id) { var e = entryById[id]; if (e) entryLoc[id] = e.locationId; });
  var plans = [];
  for (var i = 0; i < (batch.perLocation || []).length; i++) {
    var pl = batch.perLocation[i];
    if (Number(pl.amount || 0) <= 0) continue;
    var collectorId = branchCollector_(pl.locationId);
    if (!collectorId) return { ok: false, error: 'no_collector', locationId: pl.locationId };
    if (collectorId === user.id || collectorId === batch.uploadedBy) return { ok: false, error: 'conflict_of_interest', locationId: pl.locationId };
    plans.push({ pl: pl, collectorId: collectorId, entryIds: batch.entryIds.filter(function (id) { return entryLoc[id] === pl.locationId; }) });
  }

  // mark the run first, so a timeout leaves 'approving', not 'pending_deputy'
  if (batch.status !== 'approving') { batch.status = 'approving'; batch.approvingSince = new Date().toISOString(); writeRow(SHEETS.AREA_BULK_BATCHES, batch); }
  var already = {};
  readSheet(SHEETS.HANDOFFS).forEach(function (h) { if (h.viaBulkBatch === batch.id && h.kind === 'cluster_to_collector') already[h.locationId] = h; });
  var handoffOfEntry = {};
  var handoffs = plans.map(function (p) {
    if (already[p.pl.locationId]) {
      p.entryIds.forEach(function (id) { handoffOfEntry[id] = already[p.pl.locationId].id; });
      return already[p.pl.locationId];
    }
    var handoff = {
      id: Utilities.getUuid(),
      kind: 'cluster_to_collector',
      fromUserId: batch.uploadedBy,
      toUserId: p.collectorId,
      clusterId: cluster.id,
      locationId: p.pl.locationId,
      amount: p.pl.amount,
      breakdown: p.pl.breakdown,
      perLocation: [p.pl],
      sourceEntryIds: p.entryIds,
      sourceHandoffIds: [],
      consumedBy: null,
      status: 'pending',
      createdAt: new Date().toISOString(),
      viaBulkBatch: batch.id
    };
    writeRow(SHEETS.HANDOFFS, handoff);
    p.entryIds.forEach(function (id) { handoffOfEntry[id] = handoff.id; });
    return handoff;
  });
  var uploader = getById_(SHEETS.USERS, batch.uploadedBy) || user;
  var banked = {};
  readSheet(SHEETS.HANDOFFS).forEach(function (h) {
    if (h.kind === 'deposit' && h.direct && h.status !== 'voided') (h.sourceEntryIds || []).forEach(function (id) { banked[id] = true; });
  });
  batch.entryIds.forEach(function (id) {
    var e = entryById[id];
    if (!e) return;
    // an entry of a branch with nothing to hand over stays with the batch
    if (handoffOfEntry[id] && e.consumedBy !== handoffOfEntry[id]) { e.consumedBy = handoffOfEntry[id]; writeRow(SHEETS.ENTRIES, e); }
    // Cash the branch banked itself, reported through the upload: the
    // deposit record is created now, not at upload time, so a rejected
    // batch never leaves a deposit behind (and a resumed run never twice).
    if (Number(e.directDepositAmount || 0) > 0 && !banked[id]) recordDirectDeposit_(e, uploader);
  });

  batch.status = 'deputy_approved';
  batch.deputyActedBy = user.id;
  batch.deputyActedAt = new Date().toISOString();
  batch.resultHandoffIds = handoffs.map(function (h) { return h.id; });
  batch.resultHandoffId = handoffs.length ? handoffs[0].id : null;
  writeRow(SHEETS.AREA_BULK_BATCHES, batch);

  logAudit_('deputy_approve_batch', user.id, batch.id + ' -> ' + (batch.resultHandoffIds.join(',') || 'no cash to hand over'));
  handoffs.forEach(function (h) { notifyPending_(h); });
  return { ok: true, batch: batch, handoff: handoffs[0] || null, handoffs: handoffs };
}

// Rejected entries are marked voided (not just released back to unconsumed)
// so a corrected re-upload can never double-count them — see CLAUDE.md for
// the double-counting gap this closes: a straight release would leave the
// old rejected rows floating in the unconsumed pool while the corrected
// resubmit creates a brand new set of entries for the same real-world cash.
function actionDeputyRejectBatch_(req, user) {
  if (!isAreaApprover_(user.role) && user.role !== 'admin') return { ok: false, error: 'forbidden' };
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
    return (isAreaApprover_(u.role) || u.role === 'admin' || u.role === 'finance') && u.email;
  });
  recipients.forEach(function (u) {
    try {
      sendMail_(u.email,
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
    sendMail_(uploader.email,
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
  if (h.fromUserId === user.id || h.createdBy === user.id) return { ok: false, error: 'conflict_of_interest' };
  // Only the person the cash was handed to can say it arrived — nobody, an
  // admin included, confirms a receipt on someone else's behalf.
  if (h.toUserId !== user.id) return { ok: false, error: 'receiver_only' };
  if (!inActiveArea_(user, h)) return { ok: false, error: 'other_area' };

  var declared = Number(h.amount);
  var received = req.receivedAmount === undefined || req.receivedAmount === null || req.receivedAmount === ''
    ? declared : Number(req.receivedAmount);
  if (!isFinite(received) || received < 0) return { ok: false, error: 'invalid_amount' };
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
    h.breakdown = receivedBreakdown_(h.breakdown, received, shortfall);
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
  logAudit_(hasVariance ? 'confirm_partial' : 'confirm_handoff', user.id, h.id);
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
    if (cluster) add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
  }
  add(getById_(SHEETS.USERS, collectorForHandoff_(handoff)));
  readSheet(SHEETS.USERS)
    .filter(function (u) { return (u.role === 'admin' || u.role === 'finance') && u.email; })
    .forEach(add);

  var subject = 'تسليم كبير يحتاج موافقة ثانية / Large handoff needs a second sign-off';
  var body = 'التسليم رقم ' + handoff.id + ' بمبلغ ' + Number(handoff.amount).toFixed(2) +
    ' تجاوز الحد المحدد ويحتاج موافقة إدارية/مالية إضافية.\n\n' +
    'Handoff ' + handoff.id + ' (' + Number(handoff.amount).toFixed(2) + ') exceeded the configured threshold and needs a second admin/finance sign-off.';
  Object.keys(recipients).forEach(function (id) {
    try { sendMail_(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
  });
}

// ---------- The deputy's check on the area manager -> collector handover ----------
// Who checks an area manager's request (2026-10-07): the Deputy Operations Manager
// or the Operations Manager, whichever acts first; an admin stands in. Never a party
// to the handover (deputyHandoffGuard_).
var AREA_APPROVER_ROLES_ = ['deputy_operations_manager', 'operations_manager'];
function isAreaApprover_(role) { return AREA_APPROVER_ROLES_.indexOf(role) >= 0; }
function requireDeputy_(user) {
  if (!isAreaApprover_(user.role) && user.role !== 'admin') throw new Error('forbidden');
}
function deputyHandoffGuard_(h, user) {
  if (!h) return 'not_found';
  if (h.kind !== 'cluster_to_collector') return 'invalid_kind';
  if (h.status !== 'pending_deputy') return 'not_pending';
  // nobody validates a handover they are part of
  if (h.fromUserId === user.id || h.toUserId === user.id || h.createdBy === user.id) return 'conflict_of_interest';
  return null;
}
function actionDeputyValidateHandoff_(req, user) {
  requireDeputy_(user);
  var h = getById_(SHEETS.HANDOFFS, req.id);
  var err = deputyHandoffGuard_(h, user);
  if (err) return { ok: false, error: err };
  h.status = 'pending';
  h.deputyValidatedBy = user.id;
  h.deputyValidatedAt = new Date().toISOString();
  h.deputyNote = String(req.note || '').trim();
  writeRow(SHEETS.HANDOFFS, h);
  logAudit_('deputy_validate_handoff', user.id, h.id);
  notifyPending_(h);
  return { ok: true, handoff: h };
}
function actionDeputyReturnHandoff_(req, user) {
  requireDeputy_(user);
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required' };
  var h = getById_(SHEETS.HANDOFFS, req.id);
  var err = deputyHandoffGuard_(h, user);
  if (err) return { ok: false, error: err };
  h.status = 'returned';
  h.deputyReturnedBy = user.id;
  h.deputyReturnedAt = new Date().toISOString();
  h.returnReason = reason;
  writeRow(SHEETS.HANDOFFS, h);
  // the branch handovers go back to the area manager's held cash, to be
  // corrected and sent again
  releaseConsumed_(h);
  logAudit_('deputy_return_handoff', user.id, h.id);
  var mgr = getById_(SHEETS.USERS, h.fromUserId);
  if (mgr && mgr.email) {
    try {
      sendMail_(mgr.email, 'أُعيد طلب التسليم للتصحيح / Handover returned for correction',
        'أعاد نائب مدير العمليات طلب تسليمك للمُحصّل بمبلغ ' + Number(h.amount).toFixed(2) + ' للتصحيح.\nالسبب: ' + reason +
        '\n\nThe Deputy Operations Manager returned your handover to the collector (' + Number(h.amount).toFixed(2) + ') for correction.\nReason: ' + reason);
    } catch (e) { /* best-effort */ }
  }
  return { ok: true, handoff: h };
}
function notifyDeputyPendingHandoff_(h) {
  var to = readSheet(SHEETS.USERS).filter(function (u) {
    return u.active !== false && u.email && (isAreaApprover_(u.role) || u.role === 'admin');
  });
  var subject = 'طلب تسليم من مدير منطقة بانتظار تحققك / Area handover awaiting your validation';
  if (h.resubmitOf) subject = 'طلب تسليم مصحَّح (النسخة ' + h.revision + ') بانتظار تحققك / Corrected area handover (version ' + h.revision + ') awaiting your validation';
  var note = '';
  if (h.resubmitOf) {
    var was = (h.history || [])[(h.history || []).length - 1] || {};
    note = '\n\nالنسخة السابقة: ' + Number(was.amount || 0).toFixed(2) + ' — سبب الإعادة: ' + (was.returnReason || '') + '\nملاحظة التصحيح: ' + h.correctionNote +
      '\n\nPrevious version: ' + Number(was.amount || 0).toFixed(2) + ' — returned because: ' + (was.returnReason || '') + '\nCorrection note: ' + h.correctionNote;
  }
  var body = 'طلب مدير المنطقة ' + (getById_(SHEETS.USERS, h.fromUserId) || {}).name + ' تسليم ' + Number(h.amount).toFixed(2) +
    ' للمُحصّل، ويحتاج تحققك قبل وصوله إليه.\n\nAn area manager\'s handover of ' + Number(h.amount).toFixed(2) + ' to the collector needs your validation before it reaches them.' + note;
  to.forEach(function (u) { try { sendMail_(u.email, subject, body); } catch (e) { /* best-effort */ } });
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
  if (h.confirmedBy === user.id || h.resolvedBy === user.id) return { ok: false, error: 'conflict_of_interest' };
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
  if (!inActiveArea_(user, h)) return { ok: false, error: 'other_area' };

  h.status = 'disputed';
  h.disputeNote = req.note || '';
  h.disputedAt = new Date().toISOString();
  // who raised it: they may not settle it too (security review 2026-10-04)
  h.disputedBy = user.id;
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
  if (h.fromUserId === user.id || h.toUserId === user.id || h.createdBy === user.id) return { ok: false, error: 'conflict_of_interest' };
  // an admin who flagged a handover on someone's behalf and then settled it
  // would have confirmed it alone, at any amount (security review 2026-10-04)
  if (h.disputedBy === user.id) return { ok: false, error: 'conflict_of_interest' };

  var flagLarge = false;
  if (req.resolution === 'confirm') {
    // The amount the receiver actually got, when the dispute was a shortage;
    // left out, the declared amount stands.
    var declared = Number(h.amount);
    var received = req.receivedAmount === undefined || req.receivedAmount === null || req.receivedAmount === ''
      ? declared : Number(req.receivedAmount);
    if (!isFinite(received) || received < 0) return { ok: false, error: 'invalid_amount' };
    var shortfall = Math.round((declared - received) * 100) / 100;
    h.receivedAmount = received;
    if (Math.abs(shortfall) > 0.01) {
      h.originalAmount = declared;
      h.amount = received;
      h.shortfall = shortfall;
      h.breakdown = receivedBreakdown_(h.breakdown, received, shortfall);
    }
    h.status = 'confirmed';
    h.confirmedAt = new Date().toISOString();
    // the person who settled it is the one who approved it
    h.confirmedBy = user.id;
    h.confirmedViaDispute = true;
    var threshold = secondApprovalThreshold_();
    if (threshold > 0 && received >= threshold) {
      h.requiresSecondApproval = true;
      h.secondApprovalThresholdAtTime = threshold;
      flagLarge = true;
    }
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
  if (flagLarge) escalateLargeAmount_(h);
  if (h.shortfall) escalateShortfall_(h);
  return { ok: true, handoff: h };
}

function actionRecordDeposit_(req, user) {
  // Whoever holds confirmed collector cash can bank it — including a
  // collector moved off their area since, who would otherwise be left holding
  // cash nobody can move.

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
    rows = rows.filter(function (h) { return (h.fromUserId === user.id || h.toUserId === user.id) && inActiveArea_(user, h); });
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

// Only photo and PDF types are stored: the type comes back to every viewer
// inside a data: address, so a crafted one must never reach the page.
function slipMime_(mime) {
  var m = String(mime || '').toLowerCase();
  return /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/.test(m) ? m : 'image/jpeg';
}
function saveDepositSlip_(base64, fileName, mime) {
  var bytes = Utilities.base64Decode(base64);
  var blob = Utilities.newBlob(bytes, slipMime_(mime), String(fileName || 'slip.jpg').replace(/[^\w.\-\u0600-\u06FF ]/g, '_').slice(0, 80));
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
    sendMail_(toUser.email,
      'طلب استلام نقدية جديد / New cash handoff pending',
      'يوجد طلب استلام مبلغ ' + handoff.amount.toFixed(2) + ' بانتظار تأكيدك.\n' +
      'A handoff of ' + handoff.amount.toFixed(2) + ' is awaiting your confirmation.');
  } catch (e) { /* email is best-effort */ }
}

function notifyDispute_(handoff) {
  var admins = readSheet(SHEETS.USERS).filter(function (u) { return u.role === 'admin' && u.email; });
  admins.forEach(function (a) {
    try {
      sendMail_(a.email,
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
    if (cluster) add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
  }
  add(getById_(SHEETS.USERS, collectorForHandoff_(handoff)));
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
    try { sendMail_(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
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
    if (cluster) add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
  }
  add(getById_(SHEETS.USERS, collectorForHandoff_(handoff)));
  readSheet(SHEETS.USERS)
    .filter(function (u) { return (u.role === 'admin' || u.role === 'finance') && u.email; })
    .forEach(add);

  var subject = 'تسليم معلّق منذ فترة طويلة / Handoff pending too long';
  var body = 'التسليم رقم ' + handoff.id + ' بمبلغ ' + Number(handoff.amount).toFixed(2) +
    ' لا يزال بانتظار التأكيد منذ ' + Math.round(hoursOld) + ' ساعة.\n\n' +
    'Handoff ' + handoff.id + ' (' + Number(handoff.amount).toFixed(2) + ') has been pending confirmation for ' + Math.round(hoursOld) + ' hours.';

  Object.keys(recipients).forEach(function (id) {
    try { sendMail_(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
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
    if (cluster) add(getById_(SHEETS.USERS, cluster.clusterManagerUserId));
  }
  add(getById_(SHEETS.USERS, collectorForHandoff_(handoff)));
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
    try { sendMail_(recipients[id].email, subject, body); } catch (e) { /* best-effort */ }
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
  requireManager_(user);
  var already = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'checkStaleHandoffs_'; });
  if (already) return { ok: true, alreadyInstalled: true };
  ScriptApp.newTrigger('checkStaleHandoffs_').timeBased().everyDays(1).atHour(6).create();
  logAudit_('admin_install_stale_trigger', user.id, null);
  return { ok: true, alreadyInstalled: false };
}

// ---------- Dashboard ----------

function actionDashboard_(req, user) {
  var handoffs = readSheet(SHEETS.HANDOFFS).filter(function (h) { return inActiveArea_(user, h); });
  var pendingForMe = handoffs.filter(function (h) {
    if (h.status === 'pending' && h.toUserId === user.id) return true;
    return isAreaApprover_(user.role) && h.status === 'pending_deputy';
  });
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

// ---------- Everything waiting on the signed-in person (2026-10-05) ----------
// One read-only list for the welcome popup, the bell and the home hero. Each
// item points at a screen that already exists and is scoped exactly like it:
// a person is told only about what they may act on. Nothing is written.
// kind order below is the order the client lists them in.
var PENDING_KINDS_ = ['confirm_receipt', 'deputy_validate', 'deputy_batch', 'returned_fix', 'batch_rejected',
  'send_ready', 'car_handover', 'dispute_open', 'second_approval', 'deposit_due', 'risk_high'];
function actionMyPendingActions_(req, user) {
  var items = [];
  function add(kind, o) { o.kind = kind; items.push(o); }
  var handoffs = readSheet(SHEETS.HANDOFFS).filter(function (h) { return inActiveArea_(user, h); });
  var isMoney = user.role === 'admin' || user.role === 'finance';
  var users = readSheet(SHEETS.USERS);
  var activeDeputy = users.some(function (u) { return isAreaApprover_(u.role) && u.active !== false; });
  var isDeputy = isAreaApprover_(user.role) || (user.role === 'admin' && !activeDeputy);
  var clusters = readSheet(SHEETS.CLUSTERS);

  handoffs.forEach(function (h) {
    if (h.status === 'pending' && h.toUserId === user.id) {
      add('confirm_receipt', { count: 1, amount: Number(h.amount || 0), refId: h.id, locationId: h.locationId || null, since: h.createdAt });
    }
    if (isDeputy && h.kind === 'cluster_to_collector' && h.status === 'pending_deputy' && !deputyHandoffGuard_(h, user)) {
      add('deputy_validate', { count: 1, amount: Number(h.amount || 0), refId: h.id, locationId: h.locationId || null, since: h.createdAt });
    }
    if (h.kind === 'cluster_to_collector' && h.status === 'returned' && h.fromUserId === user.id &&
        !h.resubmittedAs && !h.supersededBy && h.locationId) {
      var cl = clusters.filter(function (c) { return c.id === h.clusterId; })[0];
      if (cl && !resendError_(h, cl, user)) add('returned_fix', { count: 1, amount: Number(h.amount || 0), refId: h.id, locationId: h.locationId, since: h.deputyReturnedAt || h.createdAt });
    }
    if (isMoney && h.status === 'disputed' && h.fromUserId !== user.id && h.toUserId !== user.id && h.disputedBy !== user.id) {
      add('dispute_open', { count: 1, amount: Number(h.amount || 0), refId: h.id, locationId: h.locationId || null, since: h.disputedAt || h.createdAt });
    }
    if (isMoney && h.requiresSecondApproval && !h.secondApprovedBy && h.confirmedBy !== user.id && h.resolvedBy !== user.id) {
      add('second_approval', { count: 1, amount: Number(h.amount || 0), refId: h.id, locationId: h.locationId || null, since: h.confirmedAt || h.createdAt });
    }
  });

  var batches = readSheet(SHEETS.AREA_BULK_BATCHES);
  batches.forEach(function (b) {
    var net = Number((b.breakdown || {}).netCashOwed || 0);
    if (isDeputy && b.status === 'pending_deputy' && b.uploadedBy !== user.id) {
      add('deputy_batch', { count: 1, amount: net, refId: b.id, since: b.createdAt });
    }
    if (b.status === 'deputy_rejected' && b.uploadedBy === user.id) {
      if (user.role !== 'cluster_manager' || !activeAreaOf_(user.id) || b.clusterId === activeAreaOf_(user.id)) add('batch_rejected', { count: 1, amount: net, refId: b.id, since: b.deputyActedAt || b.createdAt });
    }
  });

  // cash ready to pass up: confirmed handovers held, and the person's own open entries
  var entries = null;
  function openEntries_() {
    if (!entries) entries = readSheet(SHEETS.ENTRIES).filter(function (e) { return !e.consumedBy && !e.voided; });
    return entries;
  }
  function ready_(held, own) {
    var amount = held.reduce(function (s, h) { return s + Number(h.amount || 0); }, 0) + (own.length ? computeNet_(own).netCashOwed : 0);
    var since = held.map(function (h) { return h.confirmedAt || h.createdAt; }).concat(own.map(function (e) { return e.createdAt; })).filter(Boolean).sort()[0];
    return { count: held.length + own.length, amount: amount, since: since };
  }
  if (user.role === 'cluster_manager') {
    var myLocs = {};
    readSheet(SHEETS.LOCATIONS).forEach(function (l) {
      if (clusterManagerOwnsCluster_(user.id, l.clusterId)) myLocs[l.id] = true;
    });
    var heldC = handoffs.filter(function (h) { return h.kind === 'location_to_cluster' && h.status === 'confirmed' && h.toUserId === user.id && !h.consumedBy && inActiveArea_(user, h); });
    var ownC = openEntries_().filter(function (e) { return e.enteredBy === user.id && myLocs[e.locationId]; });
    var rc = ready_(heldC, ownC);
    if (rc.count && rc.amount > 0) add('send_ready', rc);
  } else if (user.role === 'store_manager') {
    var posMap = posById_();
    var heldS = handoffs.filter(function (h) { return h.kind === 'car_to_location' && h.status === 'confirmed' && h.toUserId === user.id && !h.consumedBy; });
    var ownS = openEntries_().filter(function (e) { return e.enteredBy === user.id && !entryCarId_(e, posMap); });
    var rs = ready_(heldS, ownS);
    if (rs.count && rs.amount > 0) add('send_ready', rs);
  } else if (user.role === 'driver') {
    var myCars = {};
    readSheet(SHEETS.CARS).forEach(function (c) { if (c.driverUserId === user.id) myCars[c.id] = true; });
    var pm = posById_();
    var ownD = openEntries_().filter(function (e) { var cid = entryCarId_(e, pm); return cid && myCars[cid]; });
    if (ownD.length) {
      var net = computeNet_(ownD).netCashOwed;
      if (net > 0) add('car_handover', { count: ownD.length, amount: net, since: ownD.map(function (e) { return e.createdAt; }).filter(Boolean).sort()[0] });
    }
  } else if (user.role === 'collector') {
    var heldK = handoffs.filter(function (h) { return h.kind !== 'deposit' && h.status === 'confirmed' && h.toUserId === user.id && !h.consumedBy; });
    if (heldK.length) add('deposit_due', {
      count: heldK.length,
      amount: heldK.reduce(function (s, h) { return s + Number(h.amount || 0); }, 0),
      since: heldK.map(function (h) { return h.confirmedAt || h.createdAt; }).filter(Boolean).sort()[0]
    });
  }

  if (isMoney) {
    var risks = readSheet(SHEETS.RISK_ITEMS).filter(function (r) { return r.severity === 'high' && r.status === 'open'; });
    if (risks.length) add('risk_high', { count: risks.length, since: risks.map(function (r) { return r.createdAt; }).filter(Boolean).sort()[0] });
  }

  items.sort(function (a, b) {
    var k = PENDING_KINDS_.indexOf(a.kind) - PENDING_KINDS_.indexOf(b.kind);
    if (k) return k;
    return new Date(a.since || 0) - new Date(b.since || 0);
  });
  return { ok: true, items: items, total: items.length };
}

// ---------- Every entry's journey (2026-10-05) ----------
// One read-only walk over the links the records already carry, so a person can
// open an entry, a handover or an area batch and see its whole path as steps:
// who did what and when, the reason where it was returned, disputed or
// cancelled, and what it is waiting for now. Nothing is stored for it.
//   entry -> consumedBy (a handover or a batch) -> that handover's consumedBy ...
//   handover -> sourceEntryIds / sourceHandoffIds (down), consumedBy (up)
//   area request versions -> resubmitOf / resubmittedAs
//   batch -> history, entryIds, resultHandoffIds
//   deposit -> reconciled / reconciledAt / reconciledLineId
// A step is { k, st: done | bad | wait, at, by, byName, to, toName, amount, short,
// ref, reason, note, rev, loc }. A step is a person's action (done), a refusal
// (bad: returned, disputed, rejected, cancelled) or what comes next (wait).
// Scope is the screens' own: a person gets the journey of what they may already
// see (listEntries / listHandoffs / listAreaBulkBatches), and a step that belongs
// to a handover they are not part of keeps its actor and time but loses its figures.
var JR_MAX_DEPTH_ = 12;
var JR_MAX_SOURCES_ = 8;

function jrCtx_(user) {
  var c = { user: user, hById: Object.create(null), eById: Object.create(null), bById: Object.create(null), uById: Object.create(null),
    locById: Object.create(null), clusterById: Object.create(null), storeByLoc: Object.create(null), carById: Object.create(null),
    byEntry: Object.create(null), bySource: Object.create(null), siblings: Object.create(null), memo: Object.create(null), lines: null, posMap: null,
    myLocs: Object.create(null), myStore: null, handoffs: readSheet(SHEETS.HANDOFFS), entries: readSheet(SHEETS.ENTRIES) };
  c.handoffs.forEach(function (h) {
    c.hById[h.id] = h;
    if (h.kind !== 'deposit' || h.direct) (h.sourceEntryIds || []).forEach(function (id) { (c.byEntry[id] = c.byEntry[id] || []).push(h); });
    (h.sourceHandoffIds || []).forEach(function (id) { (c.bySource[id] = c.bySource[id] || []).push(h); });
  });
  c.entries.forEach(function (e) {
    c.eById[e.id] = e;
    if (e.submissionId) (c.siblings[e.submissionId] = c.siblings[e.submissionId] || []).push(e);
  });
  readSheet(SHEETS.AREA_BULK_BATCHES).forEach(function (b) { c.bById[b.id] = b; });
  readSheet(SHEETS.USERS).forEach(function (u) { c.uById[u.id] = u; });
  readSheet(SHEETS.LOCATIONS).forEach(function (l) { c.locById[l.id] = l; });
  readSheet(SHEETS.CLUSTERS).forEach(function (cl) { c.clusterById[cl.id] = cl; });
  readSheet(SHEETS.STORES).forEach(function (s) { c.storeByLoc[s.locationId] = s; });
  readSheet(SHEETS.CARS).forEach(function (car) { c.carById[car.id] = car; });
  if (user.role === 'cluster_manager') {
    Object.keys(c.locById).forEach(function (id) {
      var cl = c.clusterById[c.locById[id].clusterId];
      if (cl && clusterManagerOwnsCluster_(user.id, cl.id)) c.myLocs[id] = true;
    });
  } else if (user.role === 'store_manager') {
    c.myStore = storeOfManager_(user.id);
  }
  return c;
}
function jrName_(c, id) { var u = id ? c.uById[id] : null; return u ? u.name : ''; }
function jrVisibleEntry_(c, e) {
  var u = c.user;
  if (isCompanyWide_(u.role)) return true;
  if (u.role === 'cluster_manager') return c.myLocs[e.locationId] === true;
  if (u.role === 'store_manager') return !!c.myStore && e.locationId === c.myStore.locationId;
  if (u.role === 'driver' || u.role === 'branch_worker') return e.enteredBy === u.id;
  return false;
}
function jrVisibleHandoff_(c, h) { return isCompanyWide_(c.user.role) || h.fromUserId === c.user.id || h.toUserId === c.user.id; }
function jrVisibleBatch_(c, b) {
  if (c.user.role === 'cluster_manager') return b.uploadedBy === c.user.id;
  return c.user.role === 'deputy_operations_manager' || isCompanyWide_(c.user.role);
}
function jrStep_(c, k, st, o) {
  var s = { k: k, st: st };
  o = o || {};
  Object.keys(o).forEach(function (key) { if (o[key] != null && o[key] !== '') s[key] = o[key]; });
  if (s.by) s.byName = jrName_(c, s.by);
  if (s.to) s.toName = jrName_(c, s.to);
  return s;
}
function jrLatest_(c, h) {
  var n = 0;
  while (h.resubmittedAs && c.hById[h.resubmittedAs] && n++ < 20) h = c.hById[h.resubmittedAs];
  return h;
}
// an area request's versions, oldest first, ending at h
function jrVersions_(c, h) {
  var list = [h], seen = {}, cur = h;
  seen[h.id] = true;
  while (cur.resubmitOf && c.hById[cur.resubmitOf] && !seen[cur.resubmitOf]) {
    cur = c.hById[cur.resubmitOf]; seen[cur.id] = true; list.unshift(cur);
  }
  return list;
}
function jrMatchSteps_(c, dep) {
  if (dep.status === 'voided') return [jrStep_(c, 'voided', 'bad', { at: dep.voidedAt, by: dep.voidedBy, reason: dep.voidReason })];
  if (dep.reconciled) {
    if (!c.lines) { c.lines = Object.create(null); readSheet(SHEETS.BANK_LINES).forEach(function (l) { c.lines[l.id] = l; }); }
    var line = dep.reconciledLineId ? c.lines[dep.reconciledLineId] : null;
    return [jrStep_(c, 'matched', 'done', { at: dep.reconciledAt, by: line ? line.matchedBy : null })];
  }
  return [jrStep_(c, 'match_wait', 'wait', {})];
}
// the steps of one handover on its own
function jrHandoffSteps_(c, h, o) {
  o = o || {};
  var vis = jrVisibleHandoff_(c, h), steps = [];
  var declared = h.originalAmount != null ? h.originalAmount : h.amount;
  if (h.kind === 'deposit') {
    steps.push(jrStep_(c, h.direct ? 'direct_deposit' : 'deposited', 'done', { at: h.confirmedAt || h.createdAt, by: h.fromUserId,
      amount: vis ? h.amount : null, ref: vis ? h.bankReference : null, loc: h.locationId }));
    return steps.concat(jrMatchSteps_(c, h));
  }
  var sentKey = { car_to_location: 'car_sent', location_to_cluster: 'branch_sent' }[h.kind] || 'area_sent';
  if (!h.viaBulkBatch) {
    if (o.resent) steps.push(jrStep_(c, 'area_resent', 'done', { at: h.createdAt, by: h.fromUserId, rev: h.revision, note: h.correctionNote, amount: vis ? declared : null, loc: h.locationId }));
    else steps.push(jrStep_(c, sentKey, 'done', { at: h.createdAt, by: h.fromUserId, to: h.toUserId, amount: vis ? declared : null, loc: h.locationId }));
  }
  if (h.kind === 'cluster_to_collector' && !h.viaBulkBatch) {
    if (h.status === 'pending_deputy') { steps.push(jrStep_(c, 'deputy_wait', 'wait', {})); return steps; }
    if (h.status === 'returned') {
      steps.push(jrStep_(c, 'deputy_returned', 'bad', { at: h.deputyReturnedAt, by: h.deputyReturnedBy, reason: h.returnReason }));
      if (h.supersededBy && !h.resubmittedAs) steps.push(jrStep_(c, 'superseded', 'done', {}));
      else if (!h.resubmittedAs) steps.push(jrStep_(c, 'fix_wait', 'wait', { to: h.fromUserId }));
      return steps;
    }
    if (h.deputyValidatedAt) steps.push(jrStep_(c, 'deputy_ok', 'done', { at: h.deputyValidatedAt, by: h.deputyValidatedBy }));
  }
  var received = h.receivedAmount != null ? h.receivedAmount : h.amount;
  var short = Number(h.shortfall || 0) ? h.shortfall : null;
  if (h.status === 'pending') { steps.push(jrStep_(c, 'recv_wait', 'wait', { to: h.toUserId })); return steps; }
  if (h.status === 'disputed') {
    steps.push(jrStep_(c, 'disputed', 'bad', { at: h.disputedAt, by: h.disputedBy || h.toUserId, reason: h.disputeNote }));
    steps.push(jrStep_(c, 'settle_wait', 'wait', {}));
    return steps;
  }
  if (h.disputedAt) steps.push(jrStep_(c, 'disputed', 'bad', { at: h.disputedAt, by: h.disputedBy || h.toUserId, reason: h.disputeNote }));
  if (h.resolvedAt) {
    if (h.status === 'rejected') steps.push(jrStep_(c, 'settled_rejected', 'bad', { at: h.resolvedAt, by: h.resolvedBy, reason: h.resolutionNote }));
    else steps.push(jrStep_(c, 'settled_ok', 'done', { at: h.resolvedAt, by: h.resolvedBy, amount: vis ? received : null, short: vis ? short : null, reason: h.resolutionNote }));
  } else if (h.confirmedAt) {
    steps.push(jrStep_(c, 'received', 'done', { at: h.confirmedAt, by: h.confirmedBy || h.toUserId, amount: vis ? received : null, short: vis ? short : null }));
  }
  return steps;
}
// an area batch up to the deputy's decision
function jrBatchSteps_(c, b) {
  var vis = jrVisibleBatch_(c, b), steps = [];
  (b.history || []).forEach(function (v) {
    steps.push(jrStep_(c, 'batch_up', 'done', { at: v.submittedAt, by: b.uploadedBy, rev: v.revision, amount: vis ? v.netCashOwed : null }));
    steps.push(jrStep_(c, 'batch_rej', 'bad', { at: v.rejectedAt, by: v.rejectedBy, reason: v.rejectionNote }));
  });
  var rev = Number(b.revision || 1);
  var amount = vis && b.breakdown ? b.breakdown.netCashOwed : null;
  if (rev > 1) steps.push(jrStep_(c, 'batch_resent', 'done', { at: b.resubmittedAt || b.createdAt, by: b.uploadedBy, rev: rev, amount: amount }));
  else steps.push(jrStep_(c, 'batch_up', 'done', { at: b.createdAt, by: b.uploadedBy, amount: amount }));
  if (b.status === 'deputy_approved') steps.push(jrStep_(c, 'batch_ok', 'done', { at: b.deputyActedAt, by: b.deputyActedBy }));
  else if (b.status === 'deputy_rejected') {
    steps.push(jrStep_(c, 'batch_rej', 'bad', { at: b.deputyActedAt, by: b.deputyActedBy, reason: b.rejectionNote }));
    steps.push(jrStep_(c, 'batch_fix', 'wait', { to: b.uploadedBy }));
  } else steps.push(jrStep_(c, 'batch_wait', 'wait', {}));
  return steps;
}
function jrVersionSteps_(c, h) {
  var out = [];
  jrVersions_(c, h).forEach(function (v, i) { out = out.concat(jrHandoffSteps_(c, v, { resent: i > 0 })); });
  return out;
}
// a handover and everything after it: its versions, then the handover that took
// its cash, up to the bank
function jrPath_(c, h, o) {
  o = o || {};
  h = jrLatest_(c, h);
  var key = h.id + '|' + (o.skipBatch ? 1 : 0) + '|' + (o.depth || 0);
  if (c.memo[key]) return c.memo[key];
  var out = [];
  if (h.viaBulkBatch && !o.skipBatch && c.bById[h.viaBulkBatch]) out = out.concat(jrBatchSteps_(c, c.bById[h.viaBulkBatch]));
  out = out.concat(jrVersionSteps_(c, h));
  if (h.status === 'confirmed' && h.kind !== 'deposit') {
    var parent = h.consumedBy ? c.hById[h.consumedBy] : null;
    if (parent && (o.depth || 0) < JR_MAX_DEPTH_) out = out.concat(jrPath_(c, parent, { depth: (o.depth || 0) + 1 }));
    else {
      // not taken up (any more): earlier requests that were returned or rejected
      // released it, and they stay in its journey
      var seen = Object.create(null);
      (c.bySource[h.id] || []).map(function (p) { return jrLatest_(c, p); }).filter(function (p) {
        if (seen[p.id] || (p.status !== 'rejected' && p.status !== 'returned')) return false;
        return (seen[p.id] = true);
      }).sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); }).forEach(function (p) {
        out = out.concat(jrVersionSteps_(c, p));
      });
      if (!out.length || out[out.length - 1].st !== 'wait') out.push(jrStep_(c, 'pass_wait', 'wait', { to: h.toUserId, kind: h.kind }));
    }
  }
  c.memo[key] = out;
  return out;
}
// what a handover is made of, one condensed step per source, lowest first
function jrDown_(c, h, out, depth) {
  if (depth > JR_MAX_DEPTH_ || out.length >= 40) return;
  var srcs = (h.sourceHandoffIds || []).map(function (id) { return c.hById[id]; }).filter(Boolean);
  srcs.slice(0, JR_MAX_SOURCES_).forEach(function (s) {
    jrDown_(c, s, out, depth + 1);
    out.push(jrStep_(c, 'src_handoff', 'done', { kind: s.kind, at: s.confirmedAt || s.createdAt, by: s.fromUserId, to: s.toUserId,
      amount: jrVisibleHandoff_(c, s) ? s.amount : null, loc: s.locationId }));
  });
  if (srcs.length > JR_MAX_SOURCES_) out.push(jrStep_(c, 'src_more', 'done', { n: srcs.length - JR_MAX_SOURCES_ }));
  var es = (h.sourceEntryIds || []).map(function (id) { return c.eById[id]; }).filter(Boolean);
  if (es.length) {
    var seen = es.map(function (e) { return e.createdAt; }).filter(Boolean).sort()[0];
    var allVisible = es.every(function (e) { return jrVisibleEntry_(c, e); });
    out.push(jrStep_(c, 'src_entries', 'done', { n: es.length, at: seen, day: es.map(function (e) { return e.date; }).sort()[0], by: es[0].enteredBy,
      amount: allVisible ? computeNet_(es).netCashOwed : null, loc: es[0].locationId }));
  }
}
function jrOpenKey_(c, e) {
  if (!c.posMap) c.posMap = posById_();
  var store = c.storeByLoc[e.locationId], loc = c.locById[e.locationId], area = loc ? c.clusterById[loc.clusterId] : null;
  var carId = entryCarId_(e, c.posMap);
  if (carId && !(store && e.enteredBy === store.storeManagerUserId)) return { k: 'open_car', to: c.carById[carId] ? c.carById[carId].driverUserId : e.enteredBy };
  if (area && e.enteredBy === area.clusterManagerUserId) return { k: 'open_area', to: area.clusterManagerUserId };
  return { k: 'open_branch', to: store ? store.storeManagerUserId : null };
}
function jrEntrySteps_(c, e) {
  var steps = [];
  var group = e.submissionId && c.siblings[e.submissionId] ? c.siblings[e.submissionId].filter(function (x) { return !x.voided && jrVisibleEntry_(c, x); }) : (e.voided ? [] : [e]);
  var net = group.length ? computeNet_(group).netCashOwed : 0;
  var batch = e.batchId ? c.bById[e.batchId] : null;
  var cancelled = e.voided && e.voidReason;
  // a line of a rejected version is not in any handover: it follows its batch
  if (batch && !cancelled && e.voided) return jrBatchJourney_(c, batch);
  if (batch && !cancelled) steps = steps.concat(jrBatchSteps_(c, batch));
  else steps.push(jrStep_(c, 'entered', 'done', { at: e.createdAt, day: e.date, by: e.enteredBy, amount: group.length ? net : null, loc: e.locationId }));
  if (cancelled) { steps.push(jrStep_(c, 'voided', 'bad', { at: e.voidedAt, by: e.voidedBy, reason: e.voidReason })); return steps; }
  var dep = null, firsts = [];
  (c.byEntry[e.id] || []).forEach(function (h) { if (h.kind === 'deposit') { if (h.direct && h.status !== 'voided') dep = h; } else firsts.push(h); });
  if (dep) {
    steps.push(jrStep_(c, 'direct_deposit', 'done', { at: dep.confirmedAt || dep.createdAt, by: dep.fromUserId, amount: e.directDepositAmount, ref: e.directDepositRef, loc: dep.locationId }));
    if (dep.reconciled) jrMatchSteps_(c, dep).forEach(function (s) { steps.push(s); });
  }
  var main = e.consumedBy ? c.hById[e.consumedBy] : null;
  var mainIds = Object.create(null);
  if (main) jrVersions_(c, jrLatest_(c, main)).forEach(function (v) { mainIds[v.id] = true; });
  firsts.sort(function (a, b) { return new Date(a.createdAt) - new Date(b.createdAt); });
  firsts.forEach(function (h) {
    if (mainIds[h.id]) return;
    // an earlier attempt: rejected after a dispute, or returned and waiting for its correction
    jrHandoffSteps_(c, h, {}).forEach(function (s) { steps.push(s); });
  });
  if (main) {
    steps = steps.concat(jrPath_(c, main, { skipBatch: true }));
  } else if (batch && batch.status === 'deputy_approved' && e.consumedBy === batch.id) {
    steps.push(jrStep_(c, 'batch_nocash', 'done', {}));
  } else if (!e.voided && net > 0.005 && !(batch && batch.status !== 'deputy_approved') && !steps.some(function (s) { return s.st === 'wait'; })) {
    var open = jrOpenKey_(c, e);
    steps.push(jrStep_(c, open.k, 'wait', { to: open.to }));
  }
  // a banked-at-source day waits for the bank statement only when nothing else is pending
  if (dep && !dep.reconciled && !steps.some(function (s) { return s.st === 'wait'; })) steps.push(jrStep_(c, 'match_wait', 'wait', {}));
  return steps;
}
function jrStage_(c, e) {
  var steps = jrEntrySteps_(c, e), last = steps[steps.length - 1];
  if (!last) return null;
  var s = { k: last.k, st: last.st };
  if (last.at) s.at = last.at;
  if (last.byName) s.byName = last.byName;
  if (last.toName) s.toName = last.toName;
  if (last.rev) s.rev = last.rev;
  if (last.kind) s.kind = last.kind;
  return s;
}

// the batch's own steps, and for an approved one the handovers it produced
function jrBatchJourney_(c, b) {
  var steps = jrBatchSteps_(c, b);
  if (b.status === 'deputy_approved') {
    var results = (b.resultHandoffIds || []).map(function (id) { return c.hById[id]; }).filter(Boolean)
      .sort(function (x, y) { return new Date(x.createdAt) - new Date(y.createdAt); });
    if (!results.length) steps.push(jrStep_(c, 'batch_nocash', 'done', {}));
    results.forEach(function (r) {
      jrPath_(c, r, { skipBatch: true }).forEach(function (s) { var cp = Object.assign({}, s); if (!cp.loc) cp.loc = r.locationId; steps.push(cp); });
    });
  }
  return steps;
}

function actionGetJourney_(req, user) {
  var c = jrCtx_(user), steps = [], subject;
  if (req.entryId) {
    var e = c.eById[req.entryId];
    if (!e) return { ok: false, error: 'not_found' };
    if (!jrVisibleEntry_(c, e)) return { ok: false, error: 'forbidden' };
    subject = { type: 'entry', id: e.id };
    steps = jrEntrySteps_(c, e);
  } else if (req.handoffId) {
    var h = c.hById[req.handoffId];
    if (!h) return { ok: false, error: 'not_found' };
    if (!jrVisibleHandoff_(c, h)) return { ok: false, error: 'forbidden' };
    subject = { type: 'handoff', id: h.id };
    var down = [];
    h = jrLatest_(c, h);
    jrDown_(c, h, down, 0);
    steps = down.concat(jrPath_(c, h, {}));
  } else if (req.batchId) {
    var b = c.bById[req.batchId];
    if (!b) return { ok: false, error: 'not_found' };
    if (!jrVisibleBatch_(c, b)) return { ok: false, error: 'forbidden' };
    subject = { type: 'batch', id: b.id };
    steps = jrBatchJourney_(c, b);
  } else return { ok: false, error: 'invalid_input' };
  return { ok: true, subject: subject, steps: steps };
}

// The dashboard screen used to fire three separate web-app requests
// (getSalesReport + listHandoffs + listDashboard) in parallel from the
// client. Each Apps Script web-app invocation carries its own fixed
// execution overhead on top of whatever it actually does, so three
// requests cost roughly three times that overhead even though readSheet's
// own cache makes the underlying Sheet reads cheap. Bundling all three
// into one action and one round trip is what actually cuts perceived
// dashboard load time -- readSheet's cache means calling all three
// original functions here costs no extra Sheet reads over calling them
// separately.
function actionDashboardAll_(req, user) {
  var report = actionSalesReport_(req, user);
  if (!report.ok) return report;
  var handoffs = actionListHandoffs_(req, user);
  if (!handoffs.ok) return handoffs;
  var dashboard = actionDashboard_(req, user);
  if (!dashboard.ok) return dashboard;
  return { ok: true, report: report, handoffs: handoffs, dashboard: dashboard };
}

// ---------- Sales report ----------

function actionSalesReport_(req, user) {
  // A branch manager reads their own branch's report; an area manager
  // their own area's; everyone company-wide sees all of it. The scoping
  // below is what keeps the filters honest — a filter the client sends for
  // someone else's branch simply narrows an already-scoped set.
  if (!isCompanyWide_(user.role) && user.role !== 'cluster_manager' && user.role !== 'store_manager') {
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

  if (user.role === 'store_manager') {
    var myStore = storeOfManager_(user.id);
    entries = myStore ? entries.filter(function (e) { return e.locationId === myStore.locationId; }) : [];
  }

  if (req.clusterId) {
    entries = entries.filter(function (e) { var l = locById[e.locationId]; return l && l.clusterId === req.clusterId; });
  }
  // Payment method filters on how the money arrived, not on the source.
  // Payment method is how a sale was paid (cash or card); movement type is
  // everything else that moves the cash figure. The old combined values
  // still work on paymentMethod, for a cached client.
  var MOVE_FIELDS_ = { cash: 'cashSales', pos: 'posSales', credit: 'creditSales', delivery: 'deliveryFeeBankAmount',
    other: 'otherCash', expense: 'expenseAmount', deposit: 'directDepositAmount' };
  [req.paymentMethod, req.movementType].forEach(function (key) {
    var field = key && hasOwn_(MOVE_FIELDS_, key) ? MOVE_FIELDS_[key] : null;
    if (field) entries = entries.filter(function (e) { return Number(e[field] || 0) > 0; });
  });
  // The person behind the source (a car's driver, a POS machine's holder),
  // which is a different question from who typed the entry in.
  if (req.driverUserId) {
    var myCars = readSheet(SHEETS.CARS).filter(function (c) { return c.driverUserId === req.driverUserId; }).map(function (c) { return c.id; });
    var myPos = readSheet(SHEETS.POS).filter(function (p) { return p.assignedUserId === req.driverUserId; }).map(function (p) { return p.id; });
    entries = entries.filter(function (e) {
      return (e.sourceType === 'car' && myCars.indexOf(e.sourceId) >= 0) ||
        (e.sourceType === 'pos' && myPos.indexOf(e.sourceId) >= 0);
    });
  }

  if (req.dateFrom) entries = entries.filter(function (e) { return e.date >= req.dateFrom; });
  if (req.dateTo) entries = entries.filter(function (e) { return e.date <= req.dateTo; });
  if (req.locationId) entries = entries.filter(function (e) { return e.locationId === req.locationId; });
  if (req.city) entries = entries.filter(function (e) { var l = locById[e.locationId]; return l && l.city === req.city; });
  if (req.zoneId) entries = entries.filter(function (e) { var l = locById[e.locationId]; return l && l.zoneId === req.zoneId; });
  if (req.sourceType) entries = entries.filter(function (e) { return e.sourceType === req.sourceType; });
  if (req.sourceId) entries = entries.filter(function (e) { return e.sourceId === req.sourceId; });
  if (req.customerId) entries = entries.filter(function (e) { return e.creditCustomerId === req.customerId; });
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

  // credit owed per registered customer
  var custById = {};
  readSheet(SHEETS.CUSTOMERS).forEach(function (c) { custById[c.id] = c; });
  var byCustMap = {};
  entries.forEach(function (e) {
    if (!e.creditCustomerId || !(Number(e.creditSales || 0) > 0)) return;
    var row = byCustMap[e.creditCustomerId] || (byCustMap[e.creditCustomerId] = { customerId: e.creditCustomerId, creditSales: 0, count: 0, qty: 0, itemMap: Object.create(null), linesWithoutQty: 0, deliveryFee: 0, commission: 0 });
    row.creditSales += Number(e.creditSales || 0);
    row.count++;
    row.deliveryFee += Number(e.creditDeliveryFee || 0);
    row.commission += Number(e.creditCommission || 0);
    // quantities come from creditItems only; a line with an amount and no
    // items has an unknown quantity, counted apart and never as zero
    var got = false;
    (e.creditItems || []).forEach(function (it) {
      var q = Number(it.qty || 0);
      if (!(q > 0)) return;
      got = true;
      var x = row.itemMap[it.productId] || (row.itemMap[it.productId] = { productId: it.productId, qty: 0, amount: 0 });
      x.qty += q;
      x.amount += it.amount != null ? Number(it.amount) : q * Number(it.unitPrice || 0);
      row.qty += q;
    });
    if (!got) row.linesWithoutQty++;
  });
  var customerRows = Object.keys(byCustMap).map(function (id) {
    var c = custById[id] || {};
    var row = byCustMap[id];
    row.creditSales = Math.round(row.creditSales * 100) / 100;
    row.deliveryFee = Math.round(row.deliveryFee * 100) / 100;
    row.commission = Math.round(row.commission * 100) / 100;
    row.items = Object.keys(row.itemMap).map(function (pid) {
      var x = row.itemMap[pid], p = productById[pid];
      return { productId: pid, name: p ? p.name : null, qty: x.qty, amount: Math.round(x.amount * 100) / 100 };
    }).sort(function (a, b) { return b.qty - a.qty; });
    delete row.itemMap;
    row.code = c.code || null;
    row.name = c.name || null;
    return row;
  }).sort(function (a, b) { return b.creditSales - a.creditSales; });

  return {
    ok: true, totals: totals, outstanding: outstanding,
    byLocation: locationRows, byProduct: productRows, byDate: dateRows, byCustomer: customerRows,
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
  var entries = readSheet(SHEETS.ENTRIES).filter(function (e) { return !e.voided; });

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
    if (h.status !== 'confirmed') return null;
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
