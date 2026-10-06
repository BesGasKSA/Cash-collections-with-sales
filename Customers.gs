// ---------- Customers: payments, statements, sales invoices (2026-10-06) ----------
// A credit customer owes what he took on credit (the goods and their delivery
// fee, which is paid later with them) and pays it back two ways:
//   - cash at a branch: an "other collection" line of the branch's day that names
//     him (paymentCustomerId); it is branch cash and travels the handover chain;
//   - a bank transfer: a customer_payments row Finance records with its reference.
// The statement is those debits and credits in order with a running balance.
// Invoices are issued from the app for credit sales not yet invoiced: ZATCA
// Phase 1 (tax invoice for a buyer with a VAT number, simplified otherwise, QR of
// seller name, VAT number, time, total and VAT). An invoice is never edited: a
// wrong one is answered with a credit note, which frees its sales to be invoiced
// again. Nothing here changes an entry row.

var CUST_PAY_ROLES_ = ['admin', 'finance'];
function custCanWrite_(user) { return CUST_PAY_ROLES_.indexOf(user.role) >= 0; }
function custCanRead_(user) { return isCompanyWide_(user.role); }
function companyProfile_() { var c = config_().company; return c && typeof c === 'object' ? c : {}; }
function saVatOk_(v) { return /^3\d{13}3$/.test(String(v || '')); }
function saCrOk_(v) { return /^\d{10}$/.test(String(v || '')); }
var r2_ = function (x) { return Math.round(Number(x || 0) * 100) / 100; };
// The company profile as Settings sends it: text trimmed, numbers checked.
var COMPANY_FIELDS_ = ['nameAr', 'nameEn', 'vatNumber', 'crNumber', 'buildingNo', 'street', 'district', 'city', 'postalCode', 'additionalNo',
  'country', 'phone', 'email', 'iban', 'bankName', 'paymentTermsDays', 'invoiceNote'];
function companyClean_(d) {
  if (!d || typeof d !== 'object') return { error: 'invalid_input' };
  var co = {};
  COMPANY_FIELDS_.forEach(function (k) { if (hasOwn_(d, k) && d[k] != null) co[k] = String(d[k]).trim().slice(0, k === 'invoiceNote' ? 600 : 160); });
  co.vatNumber = (co.vatNumber || '').replace(/\s+/g, ''); co.crNumber = (co.crNumber || '').replace(/\s+/g, '');
  co.iban = (co.iban || '').replace(/\s+/g, '').toUpperCase();
  if (co.vatNumber && !saVatOk_(co.vatNumber)) return { error: 'invalid_vat_number' };
  if (co.crNumber && !saCrOk_(co.crNumber)) return { error: 'invalid_cr_number' };
  if (co.postalCode && !/^\d{5}$/.test(co.postalCode)) return { error: 'invalid_postal_code' };
  if (co.iban && !/^SA\d{22}$/.test(co.iban)) return { error: 'invalid_iban' };
  if (co.paymentTermsDays && !(/^\d{1,3}$/.test(co.paymentTermsDays))) return { error: 'invalid_setting' };
  if (!co.country) co.country = 'SA';
  return { company: co };
}

// ---- payments by bank transfer ----
function actionRecordCustomerPayment_(req, user) {
  if (!custCanWrite_(user)) return { ok: false, error: 'forbidden' };
  var cu = getById_(SHEETS.CUSTOMERS, req.customerId);
  if (!cu) return { ok: false, error: 'unknown_customer' };
  var date = String(req.date || ''), amount = Number(req.amount);
  if (!invDateOk_(date)) return { ok: false, error: 'invalid_date' };
  if (date > todayRiyadh_()) return { ok: false, error: 'future_date' };
  if (!isFinite(amount) || amount <= 0 || amount > 100000000) return { ok: false, error: 'invalid_amount' };
  var ref = String(req.ref || '').trim().slice(0, 120);
  if (!ref) return { ok: false, error: 'deposit_needs_reference' };
  var row = writeRow(SHEETS.CUSTOMER_PAYMENTS, { customerId: cu.id, date: date, amount: r2_(amount), method: 'bank', ref: ref,
    note: String(req.note || '').trim().slice(0, 500), enteredBy: user.id, createdAt: new Date().toISOString(), voided: false });
  logAudit_('customer_payment', user.id, cu.id + ' ' + row.amount + ' ' + (row.txNo || ''));
  return { ok: true, payment: row };
}
function actionVoidCustomerPayment_(req, user) {
  if (!custCanWrite_(user)) return { ok: false, error: 'forbidden' };
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required' };
  var p = getById_(SHEETS.CUSTOMER_PAYMENTS, req.id);
  if (!p) return { ok: false, error: 'not_found' };
  if (p.voided) return { ok: false, error: 'already_voided' };
  p.voided = true; p.voidReason = reason.slice(0, 300); p.voidedBy = user.id; p.voidedAt = new Date().toISOString();
  writeRow(SHEETS.CUSTOMER_PAYMENTS, p);
  logAudit_('customer_payment_void', user.id, p.id);
  return { ok: true, payment: p };
}

// ---- what a customer owes and paid, in order ----
// The invoice an entry belongs to (the latest not credited), keyed by entry id.
function invoicedEntries_() {
  var m = Object.create(null);
  readSheet(SHEETS.SALES_INVOICES).forEach(function (inv) {
    if (inv.kind === 'credit_note' || inv.status !== 'issued') return;
    (inv.sourceEntryIds || []).forEach(function (id) { m[id] = inv; });
  });
  return m;
}
function custEvents_(customerId) {
  var inv = invoicedEntries_(), ev = [];
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided) return;
    if (e.creditCustomerId === customerId && Number(e.creditSales || 0) > 0) {
      var goods = custGross_(e, e.creditSales), fee = custGross_(e, e.creditDeliveryFee);
      ev.push({ date: e.date, at: e.createdAt || '', kind: 'sale', debit: r2_(goods + fee), credit: 0, goods: r2_(goods), fee: r2_(fee),
        items: e.creditItems || null, txNo: e.txNo ? e.txNo + (Number(e.txLine) > 1 ? '/' + e.txLine : '') : '', entryId: e.id,
        invoiceNo: inv[e.id] ? (inv[e.id].txNo || '') : '', invoiceId: inv[e.id] ? inv[e.id].id : null, locationId: e.locationId, by: e.enteredBy });
    }
    if (e.paymentCustomerId === customerId && Number(e.otherCash || 0) > 0) {
      ev.push({ date: e.date, at: e.createdAt || '', kind: 'payment_cash', debit: 0, credit: r2_(e.otherCash), txNo: e.txNo ? e.txNo + (Number(e.txLine) > 1 ? '/' + e.txLine : '') : '',
        entryId: e.id, locationId: e.locationId, by: e.enteredBy, note: e.otherCashReason || '' });
    }
  });
  readSheet(SHEETS.CUSTOMER_PAYMENTS).forEach(function (p) {
    if (p.voided || p.customerId !== customerId) return;
    ev.push({ date: p.date, at: p.createdAt || '', kind: 'payment_bank', debit: 0, credit: r2_(p.amount), txNo: p.txNo || '', ref: p.ref, paymentId: p.id, by: p.enteredBy, note: p.note || '' });
  });
  ev.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || String(a.at).localeCompare(String(b.at)); });
  return ev;
}
function actionCustomerStatement_(req, user) {
  if (!custCanRead_(user)) return { ok: false, error: 'forbidden' };
  var cu = getById_(SHEETS.CUSTOMERS, req.customerId);
  if (!cu) return { ok: false, error: 'unknown_customer' };
  var from = req.dateFrom ? String(req.dateFrom) : '2000-01-01', to = req.dateTo ? String(req.dateTo) : todayRiyadh_();
  if (!invDateOk_(from) && from !== '2000-01-01' || !invDateOk_(to) || from > to) return { ok: false, error: 'invalid_period' };
  var bal = 0, opening = 0, lines = [], tD = 0, tC = 0;
  custEvents_(cu.id).forEach(function (x) {
    if (x.date > to) return;
    if (x.date < from) { bal += x.debit - x.credit; return; }
    if (!lines.length) opening = r2_(bal);
    bal += x.debit - x.credit; tD += x.debit; tC += x.credit;
    x.balance = r2_(bal); lines.push(x);
  });
  if (!lines.length) opening = r2_(bal);
  // what is still unpaid, by age: payments settle the oldest sales first
  var debts = [], paid = 0, today = Date.parse(to + 'T00:00:00Z');
  custEvents_(cu.id).forEach(function (x) { if (x.date > to) return; if (x.debit) debts.push({ date: x.date, left: x.debit }); paid += x.credit; });
  debts.forEach(function (d) { var take = Math.min(d.left, paid); d.left -= take; paid -= take; });
  var aging = { d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
  debts.forEach(function (d) { if (d.left <= 0.004) return; var age = (today - Date.parse(d.date + 'T00:00:00Z')) / 864e5;
    aging[age <= 30 ? 'd0_30' : age <= 60 ? 'd31_60' : age <= 90 ? 'd61_90' : 'd90'] += d.left; });
  Object.keys(aging).forEach(function (k) { aging[k] = r2_(aging[k]); });
  return { ok: true, customer: cu, dateFrom: from, dateTo: to, opening: opening, lines: lines, debit: r2_(tD), credit: r2_(tC), closing: r2_(bal), advance: r2_(paid), aging: aging, company: companyProfile_() };
}
// every customer's position, for the list
function actionCustomerBalances_(req, user) {
  if (!custCanRead_(user)) return { ok: false, error: 'forbidden' };
  var inv = invoicedEntries_(), m = Object.create(null);
  function row(id) { return m[id] || (m[id] = { customerId: id, sales: 0, fees: 0, paidCash: 0, paidBank: 0, uninvoiced: 0, lastSale: '', lastPayment: '', lines: 0 }); }
  readSheet(SHEETS.ENTRIES).forEach(function (e) {
    if (e.voided) return;
    if (e.creditCustomerId && Number(e.creditSales || 0) > 0) {
      var r = row(e.creditCustomerId), g = custGross_(e, e.creditSales), gf = custGross_(e, e.creditDeliveryFee), d = g + gf;
      r.sales += g; r.fees += gf; r.lines++;
      if (!inv[e.id]) r.uninvoiced += d;
      if (e.date > r.lastSale) r.lastSale = e.date;
    }
    if (e.paymentCustomerId && Number(e.otherCash || 0) > 0) { var r1 = row(e.paymentCustomerId); r1.paidCash += Number(e.otherCash); if (e.date > r1.lastPayment) r1.lastPayment = e.date; }
  });
  readSheet(SHEETS.CUSTOMER_PAYMENTS).forEach(function (p) { if (p.voided) return; var r = row(p.customerId); r.paidBank += Number(p.amount || 0); if (p.date > r.lastPayment) r.lastPayment = p.date; });
  var invCount = Object.create(null);
  readSheet(SHEETS.SALES_INVOICES).forEach(function (x) { if (x.kind !== 'credit_note' && x.status === 'issued') invCount[x.customerId] = (invCount[x.customerId] || 0) + 1; });
  var out = Object.keys(m).map(function (k) { var r = m[k];
    ['sales', 'fees', 'paidCash', 'paidBank', 'uninvoiced'].forEach(function (f) { r[f] = r2_(r[f]); });
    r.owed = r2_(r.sales + r.fees); r.paid = r2_(r.paidCash + r.paidBank); r.balance = r2_(r.owed - r.paid); r.invoices = invCount[k] || 0; return r; });
  return { ok: true, balances: out };
}

// ---- sales invoices ----
// ZATCA's QR (Phase 1): tag-length-value of seller name, VAT number, time, total
// with VAT and the VAT, as base64.
function zatcaTlv_(fields) {
  var bytes = [];
  fields.forEach(function (v, i) {
    var str = String(v), b = Utilities.newBlob(str).getBytes();
    while (b.length > 255) { str = str.slice(0, -1); b = Utilities.newBlob(str).getBytes(); }
    bytes.push(i + 1); bytes.push(b.length > 127 ? b.length - 256 : b.length);
    for (var j = 0; j < b.length; j++) bytes.push(b[j]);
  });
  return Utilities.base64Encode(bytes);
}
function actionInvoiceCandidates_(req, user) {
  if (!custCanRead_(user)) return { ok: false, error: 'forbidden' };
  var cu = getById_(SHEETS.CUSTOMERS, req.customerId);
  if (!cu) return { ok: false, error: 'unknown_customer' };
  var inv = invoicedEntries_();
  var list = readSheet(SHEETS.ENTRIES).filter(function (e) { return !e.voided && e.creditCustomerId === cu.id && Number(e.creditSales || 0) > 0 && !inv[e.id]; })
    .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); })
    .map(function (e) { return { id: e.id, date: e.date, txNo: e.txNo || '', locationId: e.locationId, creditSales: custGross_(e, e.creditSales), creditDeliveryFee: custGross_(e, e.creditDeliveryFee), items: e.creditItems || null }; });
  return { ok: true, entries: list };
}
// whether a day's prices were typed with VAT: stamped on the day since 2026-10-06
function entryInclVat_(e) { return typeof e.salesIncludeVat === 'boolean' ? e.salesIncludeVat : salesIncludeVat_(); }
// what a credit sale costs the customer with VAT, the figure the statement and the invoice agree on
function custGross_(e, amount) { amount = Number(amount || 0); return r2_(entryInclVat_(e) ? amount : amount * (1 + entryVatRate_(e))); }
function invLinesOf_(e, products) {
  var rate = entryVatRate_(e), incl = entryInclVat_(e), lines = [];
  function line(name, nameEn, productId, qty, unit, amount) {
    amount = r2_(amount);
    var ex = incl ? r2_(amount / (1 + rate)) : amount, gross = incl ? amount : r2_(amount * (1 + rate));
    lines.push({ entryId: e.id, date: e.date, productId: productId || null, name: name, nameEn: nameEn || '', qty: qty, unitEx: qty ? Math.round(ex / qty * 10000) / 10000 : ex,
      vatRate: rate, ex: ex, vat: r2_(gross - ex), total: gross });
  }
  if (e.creditItems && e.creditItems.length) e.creditItems.forEach(function (it) {
    var p = products[it.productId] || {};
    line(p.name || '', p.nameEn || '', it.productId, Number(it.qty || 0), Number(it.unitPrice || 0), it.amount != null ? it.amount : Number(it.qty || 0) * Number(it.unitPrice || 0));
  });
  else line('بيع آجل', 'Credit sale', null, 0, 0, e.creditSales);
  if (Number(e.creditDeliveryFee || 0) > 0) line('رسوم توصيل', 'Delivery fee', null, 0, 0, e.creditDeliveryFee);
  return lines;
}
function invTotals_(lines) {
  var t = { ex: 0, vat: 0, total: 0 };
  lines.forEach(function (l) { t.ex += l.ex; t.vat += l.vat; t.total += l.total; });
  return { ex: r2_(t.ex), vat: r2_(t.vat), total: r2_(t.total) };
}
function buyerOf_(cu) {
  return { id: cu.id, code: cu.code || '', name: cu.name || '', nameEn: cu.nameEn || '', vatNumber: cu.vatNumber || '', crNumber: cu.crNumber || '', phone: cu.phone || '', email: cu.email || '',
    address: { buildingNo: cu.buildingNo || '', street: cu.street || '', district: cu.district || '', city: cu.city || '', postalCode: cu.postalCode || '', additionalNo: cu.additionalNo || '' } };
}
function actionCreateInvoice_(req, user) {
  if (!custCanWrite_(user)) return { ok: false, error: 'forbidden' };
  var co = companyProfile_();
  if (!String(co.nameAr || '').trim()) return { ok: false, error: 'company_name_required' };
  if (!saVatOk_(co.vatNumber)) return { ok: false, error: 'company_vat_required' };
  var cu = getById_(SHEETS.CUSTOMERS, req.customerId);
  if (!cu) return { ok: false, error: 'unknown_customer' };
  var ids = Array.isArray(req.entryIds) ? req.entryIds.map(String).filter(function (x, i, a) { return a.indexOf(x) === i; }) : [];
  if (!ids.length || ids.length > 300) return { ok: false, error: 'invalid_input' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    var inv = invoicedEntries_(), byId = Object.create(null), products = Object.create(null);
    readSheet(SHEETS.ENTRIES).forEach(function (e) { byId[e.id] = e; });
    readSheet(SHEETS.PRODUCTS).forEach(function (p) { products[p.id] = p; });
    var lines = [];
    for (var i = 0; i < ids.length; i++) {
      var e = byId[ids[i]];
      if (!e || e.voided || e.creditCustomerId !== cu.id || !(Number(e.creditSales || 0) > 0)) return { ok: false, error: 'invalid_invoice_entry', index: i };
      if (inv[e.id]) return { ok: false, error: 'already_invoiced', index: i, invoiceNo: inv[e.id].txNo };
      lines = lines.concat(invLinesOf_(e, products));
    }
    var totals = invTotals_(lines), now = new Date(), buyer = buyerOf_(cu);
    var issuedAt = now.toISOString().slice(0, 19) + 'Z';
    var row = writeRow(SHEETS.SALES_INVOICES, {
      kind: 'invoice', type: saVatOk_(buyer.vatNumber) ? 'standard' : 'simplified', status: 'issued', customerId: cu.id,
      issueDate: todayRiyadh_(), issuedAt: issuedAt, createdAt: now.toISOString(), issuedBy: user.id,
      seller: co, buyer: buyer, lines: lines, totals: totals, sourceEntryIds: ids, note: String(req.note || '').trim().slice(0, 500),
      currency: 'SAR', qr: zatcaTlv_([co.nameAr, co.vatNumber, issuedAt, totals.total.toFixed(2), totals.vat.toFixed(2)])
    });
    logAudit_('invoice_issued', user.id, (row.txNo || row.id) + ' ' + totals.total);
    return { ok: true, invoice: row };
  } finally { try { lock.releaseLock(); } catch (e2) {} }
}
// A credit note answers an invoice: the same lines and totals, its own number,
// the reason; the invoice is marked credited and its sales can be invoiced again.
function actionCreditInvoice_(req, user) {
  if (!custCanWrite_(user)) return { ok: false, error: 'forbidden' };
  var reason = String(req.reason || '').trim();
  if (!reason) return { ok: false, error: 'reason_required' };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    var inv = getById_(SHEETS.SALES_INVOICES, req.id);
    if (!inv || inv.kind === 'credit_note') return { ok: false, error: 'not_found' };
    if (inv.status !== 'issued') return { ok: false, error: 'already_credited' };
    var co = inv.seller || companyProfile_(), now = new Date();
    var issuedAt = now.toISOString().slice(0, 19) + 'Z';
    var cn = writeRow(SHEETS.SALES_INVOICES, {
      kind: 'credit_note', type: inv.type, status: 'issued', customerId: inv.customerId, refInvoiceId: inv.id, refInvoiceNo: inv.txNo || '',
      issueDate: todayRiyadh_(), issuedAt: issuedAt, createdAt: now.toISOString(), issuedBy: user.id, reason: reason.slice(0, 500),
      seller: co, buyer: inv.buyer, lines: inv.lines, totals: inv.totals, sourceEntryIds: inv.sourceEntryIds, currency: 'SAR',
      qr: zatcaTlv_([co.nameAr, co.vatNumber, issuedAt, Number(inv.totals.total).toFixed(2), Number(inv.totals.vat).toFixed(2)])
    });
    inv.status = 'credited'; inv.creditNoteId = cn.id; inv.creditNoteNo = cn.txNo || ''; inv.creditedAt = now.toISOString(); inv.creditedBy = user.id;
    writeRow(SHEETS.SALES_INVOICES, inv);
    logAudit_('invoice_credited', user.id, (inv.txNo || inv.id) + ' > ' + (cn.txNo || cn.id));
    return { ok: true, creditNote: cn, invoice: inv };
  } finally { try { lock.releaseLock(); } catch (e2) {} }
}
function actionListInvoices_(req, user) {
  if (!custCanRead_(user)) return { ok: false, error: 'forbidden' };
  var list = readSheet(SHEETS.SALES_INVOICES).filter(function (x) { return !req.customerId || x.customerId === req.customerId; })
    .sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  return { ok: true, invoices: list };
}
// bank payments, for a customer's page
function actionListCustomerPayments_(req, user) {
  if (!custCanRead_(user)) return { ok: false, error: 'forbidden' };
  return { ok: true, payments: readSheet(SHEETS.CUSTOMER_PAYMENTS).filter(function (p) { return !req.customerId || p.customerId === req.customerId; })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }) };
}

// The income item a branch's cash from a credit customer is filed under, made once.
function seedCustomerPaymentItemOnce_() {
  runOnce_('SEEDED_CUSTOMER_PAYMENT_ITEM', function () {
    if (readSheet(SHEETS.INCOME_ITEMS).some(function (i) { return i.system === 'customer_payment'; })) return;
    var lock = LockService.getScriptLock(); lock.waitLock(30000);
    try {
      freshenExec_();
      var row = { name: 'تحصيل من عميل آجل', system: 'customer_payment', active: true, createdAt: new Date().toISOString() };
      if (hasOwn_(CODE_PREFIX_, 'income_item')) row.code = nextCode_('income_item');
      writeRow(SHEETS.INCOME_ITEMS, row);
    } finally { try { lock.releaseLock(); } catch (e) {} }
  });
}
function customerPaymentItemId_() {
  var it = readSheet(SHEETS.INCOME_ITEMS).filter(function (i) { return i.system === 'customer_payment' && i.active !== false; })[0];
  return it ? it.id : null;
}

// The company profile, filled once from a private seed kept only in the Apps
// Script deploy folder (CompanySeed.js, never in this public repo), while
// Settings still has no VAT number. A profile typed in Settings is never touched.
function seedCompanyOnce_() {
  runOnce_('SEEDED_COMPANY_PROFILE', function () {
    if (typeof COMPANY_SEED_ === 'undefined' || !COMPANY_SEED_) return;
    var cfg = config_();
    if (cfg.company && cfg.company.vatNumber) return;
    var co = companyClean_(COMPANY_SEED_);
    if (co.error) return;
    cfg.company = co.company;
    writeRow(SHEETS.CONFIG, cfg);
    logAudit_('company_profile_seeded', 'system', co.company.vatNumber);
  });
}
