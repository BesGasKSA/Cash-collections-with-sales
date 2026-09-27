/**
 * Builds the Arabic user guide PDF: runs the real cycle on the mock backend
 * (area manager → Deputy Operations Manager → collector → bank), captures a
 * phone-width screenshot of every step, lays them out beside short numbered
 * steps, and prints the result to A4 with headless Chrome (proper Arabic
 * shaping, no Python needed).
 *
 * Needs the mock backend running fresh (tests/mock-backend-server.js on :8905).
 *
 *   node tests/make-guide.js [outDir] [port]
 */
var fs = require('fs');
var path = require('path');
var http = require('http');

var OUT = process.argv[2] || path.join(require('os').tmpdir(), 'bgc-guide');
var PORT = Number(process.argv[3] || 8905);
var BASE = 'http://localhost:' + PORT;
var MODULES = path.join(process.env.TMP || '/tmp', 'claude', 'C--Claude', '1b419b87-2f22-4ee8-bbae-85be9310e0c2', 'scratchpad', 'video', 'node_modules');
var puppeteer = require(path.join(MODULES, 'puppeteer'));
var SHOTS = path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

function api(payload) {
  return new Promise(function (resolve, reject) {
    var req = http.request(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, function (res) {
      var d = ''; res.on('data', function (c) { d += c; }); res.on('end', function () { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
}
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
function localDay() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

var PRODUCTS = [
  { name: 'أسطوانة غاز 12.5 كجم', price: 45, locked: true, qty: 40 },
  { name: 'أسطوانة غاز 25 كجم', price: 85, locked: true, qty: 20 },
  { name: 'غاز سائب — لتر', price: 3.5, locked: false, qty: 300 }
];
var S = {};
async function seed() {
  var a = await api({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' });
  var tok = a.token;
  async function call(p) { p.token = tok; var r = await api(p); if (r.token) tok = r.token; return r; }
  S.products = [];
  for (var i = 0; i < PRODUCTS.length; i++) {
    var r = await call({ action: 'adminSaveEntity', kind: 'product', data: { name: PRODUCTS[i].name, type: 'goods', unitPrice: PRODUCTS[i].price, priceLocked: PRODUCTS[i].locked, active: true } });
    S.products.push(Object.assign({ id: r.entity.id }, PRODUCTS[i]));
  }
  S.income = (await call({ action: 'adminSaveEntity', kind: 'income_item', data: { name: 'تأمين أسطوانات', active: true } })).entity;
  S.expense = (await call({ action: 'adminSaveEntity', kind: 'expense_item', data: { name: 'وقود سيارة التوصيل', active: true } })).entity;
  var meta = await call({ action: 'listMeta' });
  S.north = meta.clusters.filter(function (c) { return c.name.indexOf('North') >= 0; })[0];
  S.olaya = meta.stores.filter(function (s) { return s.name === 'Olaya Branch'; })[0];
  S.naseemLoc = meta.locations.filter(function (l) { return l.name === 'Naseem'; })[0];
  S.naseem = meta.stores.filter(function (s) { return s.locationId === S.naseemLoc.id; })[0];
  S.tok = { admin: tok };
  for (var who of [['area', 'muzafer@bestgas.sa'], ['deputy', 'ahmed@bestgas.sa'], ['collector', 'mazen@bestgas.sa']]) {
    S.tok[who[0]] = (await api({ action: 'login', email: who[1], password: 'Welcome#1' })).token;
  }
  // the CSV the second way uploads
  var day = localDay();
  var header = 'date,locationName,sourceType,sourceName,product,qty,unitPrice,paymentMethod,deliveryFee,deliveryNote,creditSales,creditCustomer,otherCash,otherCashItem,otherCashReason,expenseAmount,expenseItem,expenseReason,directDeposit,depositRef,depositNote,cylindersOut,cylindersIn,note';
  var qty = [30, 15, 200];
  var lines = [header].concat(PRODUCTS.map(function (p, i) {
    var extra = i === 0 ? [230, 'توصيل طلبين', 600, 'مؤسسة الريان', 800, 'تأمين أسطوانات', 'تأمين مسترد', 225, 'وقود سيارة التوصيل', 'تعبئة وقود', 2000, 'MZN-NSM-01', 'موازنة الصباح']
      : ['', '', '', '', '', '', '', '', '', '', '', '', ''];
    return [day, 'Naseem', 'store', S.naseem.name, p.name, qty[i], p.price, 'cash'].concat(extra, ['', '', '']).join(',');
  }));
  S.csv = path.join(OUT, 'مثال-ملف-المنطقة.csv');
  fs.writeFileSync(S.csv, '﻿' + lines.join('\n'), 'utf8');
}

// ------------------------------------------------------------ the browser
var page;
async function signIn(tok) {
  // switch users from a same-origin page that does not run the app, or the
  // previous user's page writes its own session back over the new one
  await page.goto(BASE + '/__mail?to=none', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (a) {
    localStorage.clear(); localStorage.setItem('bgc_apiUrl', a.base + '/api'); localStorage.setItem('bgc_lang', 'ar');
    if (a.tok) localStorage.setItem('bgc_token', a.tok);
  }, { base: BASE, tok: tok });
  await page.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'networkidle2' });
  await sleep(1800);
}
async function nav(text) {
  await page.evaluate(function (t) {
    var b = [].slice.call(document.querySelectorAll('button, .sb-item')).filter(function (x) { return x.textContent.trim().indexOf(t) === 0; })[0];
    if (b) b.click();
  }, text);
  await sleep(2000);
}
async function tab(text) {
  await page.evaluate(function (t) {
    var b = [].slice.call(document.querySelectorAll('.tabs button')).filter(function (x) { return x.textContent.trim().indexOf(t) === 0; })[0];
    if (b) b.click();
  }, text);
  await sleep(1200);
}
async function setv(sel, v) {
  await page.evaluate(function (a) {
    var e = document.querySelector(a.s); if (!e) return;
    if (e.type === 'checkbox') e.checked = !!a.v; else e.value = a.v;
    ['input', 'change', 'blur'].forEach(function (n) { e.dispatchEvent(new Event(n, { bubbles: true })); });
  }, { s: sel, v: v });
  await sleep(150);
}
async function click(sel, wait) {
  await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel);
  await sleep(wait || 900);
}
async function tagNth(sel, i, name) {
  return page.evaluate(function (a) {
    var e = document.querySelectorAll(a.s)[a.i]; if (!e) return null;
    e.setAttribute('data-g', a.n); return '[data-g="' + a.n + '"]';
  }, { s: sel, i: i, n: name });
}
var shots = {};
async function shot(name, sel) {
  var file = path.join(SHOTS, name + '.png');
  try {
    if (sel) {
      var h = await page.$(sel);
      if (!h) { console.log('  ! no element for ' + name + ': ' + sel); return; }
      await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'center' }); }, sel);
      await sleep(500);
      await h.screenshot({ path: file });
    } else {
      await page.screenshot({ path: file });
    }
    shots[name] = file;
    console.log('  shot ' + name);
  } catch (e) { console.log('  ! shot failed ' + name + ': ' + e.message); }
}

async function capture() {
  var browser = await puppeteer.launch({ headless: 'new', args: ['--lang=ar', '--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage();
  page.on('dialog', function (d) { d.accept(d.type() === 'prompt' ? 'مبلغ الفرع لا يطابق الكشف' : undefined).catch(function () {}); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  // sign-in
  await signIn(null);
  await shot('login');

  // ---- area manager: home and the manual day
  await signIn(S.tok.area);
  await shot('home-hero', '.hero');
  await shot('home-area', '.org .org-area');
  await nav('الإدخالات');
  await setv('#eSource', S.olaya.id);
  await shot('entry-basics', '#eBasicWrap');
  await click('#eConfirmBasic', 1200);
  for (var i = 0; i < S.products.length; i++) {
    if (i > 0) await click('#eAddLine', 700);
    var ln = await tagNth('.eLine', i, 'ln' + i);
    await setv(ln + ' .lnProduct', S.products[i].id);
    await setv(ln + ' .lnQty', S.products[i].qty);
  }
  await shot('entry-lines', '#eLinesWrap');
  await click('#eConfirmLines', 1200);
  await click('#eDeliveryWrap .me-toggle', 700);
  var d0 = await tagNth('#eDeliveryLines .mline', 0, 'd0');
  await setv(d0 + ' .mlAmount', 345); await setv(d0 + ' .mlReason', 'توصيل 3 طلبات — حي الملقا');
  await click('#eDeliveryAdd', 600);
  var d1 = await tagNth('#eDeliveryLines .mline', 1, 'd1');
  await setv(d1 + ' .mlAmount', 230); await setv(d1 + ' .mlReason', 'توصيل طلبين — حي الياسمين');
  await shot('entry-delivery', '#eDeliveryWrap');
  await click('#eDeliveryWrap .me-confirm', 900);
  await click('#eCreditWrap .me-toggle', 700);
  var c0 = await tagNth('#eCreditLines .mline', 0, 'c0');
  await setv(c0 + ' .mlAmount', 900); await setv(c0 + ' .mlReason', 'مطعم النخيل');
  await shot('entry-credit', '#eCreditWrap');
  await click('#eCreditWrap .me-confirm', 900);
  await click('#eOtherWrap .me-toggle', 700);
  var o0 = await tagNth('#eOtherLines .mline', 0, 'o0');
  await setv(o0 + ' .mlAmount', 1200); await setv(o0 + ' .mlItem', S.income.id); await setv(o0 + ' .mlReason', 'تأمين مسترد على 24 أسطوانة');
  await shot('entry-other', '#eOtherWrap');
  await click('#eOtherWrap .me-confirm', 900);
  await click('#eExpenseWrap .me-toggle', 700);
  var x0 = await tagNth('#eExpenseLines .mline', 0, 'x0');
  await setv(x0 + ' .mlAmount', 350); await setv(x0 + ' .mlItem', S.expense.id); await setv(x0 + ' .mlReason', 'تعبئة وقود سيارة التوصيل');
  await click('#eExpenseWrap .me-confirm', 900);
  await click('#eDepositWrap .me-toggle', 700);
  await setv('#eDeposit', 3000); await setv('#eDepositRef', 'MZN-OLY-01'); await setv('#eDepositNote', 'موازنة نصف اليوم');
  await shot('entry-deposit', '#eDepositWrap');
  await click('#eDepositWrap .me-confirm', 900);
  await shot('entry-net', '#eNetPreview');
  await click('#eSubmit', 3000);
  await click('.el-row .el-more', 800);
  await shot('entry-card-open', '.el-row');

  // ---- area manager: the CSV way
  await nav('رفع دفعة المنطقة');
  var fi = await page.$('#abFile');
  if (fi) { await fi.uploadFile(S.csv); await sleep(3500); }
  await shot('csv-preview', '#abPreviewWrap');
  await click('#abSubmit', 3000);

  // ---- area manager: send the manual day's request
  await nav('التسليمات');
  await shot('area-request', '.ac-card');
  await click('#hCreateClu', 3000);
  await shot('area-request-sent', '.ac-card');

  // ---- deputy
  await signIn(S.tok.deputy);
  await nav('اعتمادات نائب مدير العمليات');
  await sleep(1500);
  await shot('deputy-request', '.dpList .list-item');
  await page.evaluate(function () {
    var b = [].slice.call(document.querySelectorAll('.dpList button')).filter(function (x) { return x.textContent.indexOf('تحقق واعتماد') >= 0; })[0];
    if (b) b.click();
  });
  await sleep(2500);
  var batchCard = await page.evaluate(function () {
    var b = document.querySelector('[id^="dApprove-"]'); if (!b) return null;
    var c = b.closest('.card') || b.parentNode; c.setAttribute('data-g', 'batch'); return '[data-g="batch"]';
  });
  if (batchCard) { await shot('deputy-batch', batchCard); await click('[id^="dApprove-"]', 3000); }

  // ---- collector
  await signIn(S.tok.collector);
  await nav('التسليمات');
  await sleep(1200);
  var pend = await page.evaluate(function () {
    var i = document.querySelector('#hRecvAmt'); if (!i) return null;
    var c = i.closest('.list-item'); c.setAttribute('data-g', 'pend'); return '[data-g="pend"]';
  });
  if (pend) await shot('collector-confirm', pend);
  for (var k = 0; k < 2; k++) {
    await page.evaluate(function () {
      var b = [].slice.call(document.querySelectorAll('button')).filter(function (x) { return x.textContent.trim() === 'تأكيد الاستلام'; })[0];
      if (b) b.click();
    });
    await sleep(2500);
  }
  await setv('#hBankRef', 'SNB-2026-0927-204');
  var dep = await page.evaluate(function () {
    var i = document.querySelector('#hBankRef'); if (!i) return null;
    var c = i.closest('.card'); c.setAttribute('data-g', 'dep'); return '[data-g="dep"]';
  });
  if (dep) await shot('collector-deposit', dep);
  await click('#hDeposit', 3000);

  // ---- the lock
  await signIn(S.tok.area);
  await nav('الإدخالات');
  await click('.el-row .el-more', 800);
  await shot('entry-card-approved', '.el-row');

  // ---- admin
  await signIn(S.tok.admin);
  await nav('الإدارة');
  await tab('المناطق');
  await page.evaluate(function () {
    var r = [].slice.call(document.querySelectorAll('tr.pf-row')).filter(function (t) { return t.textContent.indexOf('South') >= 0; })[0];
    if (r) r.click();
  });
  await sleep(1800);
  await shot('admin-area-hero', '.pf-hero');
  var areaForm = await page.evaluate(function () {
    var c = document.querySelector('.pf-card'); if (!c) return null; c.setAttribute('data-g', 'aform'); return '[data-g="aform"]';
  });
  if (areaForm) await shot('admin-area-form', areaForm);
  await tab('سلامة الربط');
  await shot('admin-chain', '.chain');
  await tab('الإعدادات');
  var set1 = await page.evaluate(function () {
    var c = document.querySelector('#cPosSales'); if (!c) return null;
    var card = c.closest('.card'); card.setAttribute('data-g', 'set1'); return '[data-g="set1"]';
  });
  if (set1) await shot('admin-settings', set1);
  var live = await page.evaluate(function () {
    var c = document.querySelector('#cGoLive'); if (!c) return null;
    var card = c.closest('.card'); card.setAttribute('data-g', 'live'); return '[data-g="live"]';
  });
  if (live) await shot('admin-golive', live);
  await tab('مصفوفة الصلاحيات');
  await shot('admin-rules', '.rules-card');

  // brand mark
  S.logo = await page.evaluate(function () { var l = document.querySelector('link[rel="icon"]'); return l ? l.href : ''; });
  await browser.close();
}

// ------------------------------------------------------------ the document
function img(name, cls) {
  if (!shots[name]) return '';
  var b64 = fs.readFileSync(shots[name]).toString('base64');
  return '<figure class="' + (cls || 'ph') + '"><img src="data:image/png;base64,' + b64 + '"></figure>';
}
function step(title, items, shotNames, note) {
  return '<section class="step">' +
    '<div class="txt"><h3>' + title + '</h3><ol>' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>' +
    (note ? '<div class="note">' + note + '</div>' : '') + '</div>' +
    '<div class="figs">' + (shotNames || []).map(function (n) { return img(n); }).join('') + '</div>' +
  '</section>';
}
function chapter(n, title, lead) {
  return '<header class="chap"><span class="cn">' + n + '</span><div><h2>' + title + '</h2>' + (lead ? '<p>' + lead + '</p>' : '') + '</div></header>';
}

function buildHtml() {
  var today = new Date().toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'long', day: 'numeric' });
  var h = [];
  // cover
  h.push('<div class="cover">' +
    (S.logo ? '<img class="logo" src="' + S.logo + '">' : '') +
    '<div class="brand">الناقل الأفضل للغاز</div>' +
    '<h1>دليل استخدام نظام تحصيل النقدية والموافقات</h1>' +
    '<p class="sub">باقات — إدارة تحصيل النقدية</p>' +
    '<div class="flow"><span>مدير المنطقة</span><i>←</i><span>نائب مدير العمليات</span><i>←</i><span>المُحصّل</span><i>←</i><span>البنك</span></div>' +
    '<p class="date">' + today + '</p></div>');

  // the cycle on one page
  h.push('<div class="page">' + chapter('٠', 'الدورة في صفحة واحدة', 'كل ريال يسير في سلسلة واضحة، لكل خطوة صاحبها، ولا يعتمد أحد ما سلّمه بنفسه.') +
    '<table class="roles"><thead><tr><th>الدور</th><th>ماذا يفعل</th><th>الشاشة</th></tr></thead><tbody>' +
    '<tr><td><b>مدير المنطقة</b></td><td>يُدخل يوم أي فرع في منطقته (يدوياً أو بملف CSV)، ثم يرسل طلب التسليم</td><td>الإدخالات · رفع دفعة المنطقة · التسليمات</td></tr>' +
    '<tr><td><b>مدير الفرع</b></td><td>يُدخل يوم فرعه ويسلّمه لمدير المنطقة</td><td>الإدخالات · التسليمات</td></tr>' +
    '<tr><td><b>نائب مدير العمليات</b></td><td>يتحقق من طلب مدير المنطقة ويعتمده أو يعيده بسبب مكتوب، ويعتمد دفعات CSV</td><td>اعتمادات نائب مدير العمليات</td></tr>' +
    '<tr><td><b>المُحصّل</b></td><td>يؤكد ما استلمه فعلاً، ثم يسجّل الإيداع البنكي</td><td>التسليمات</td></tr>' +
    '<tr><td><b>المالية</b></td><td>تحسم الاعتراضات، والموافقة الثانية على المبالغ الكبيرة، والتسوية البنكية</td><td>التسليمات · التسوية البنكية</td></tr>' +
    '<tr><td><b>مدير النظام</b></td><td>المستخدمون والبيانات الأساسية والإعدادات — ولا يؤكد استلاماً نيابةً عن أحد</td><td>الإدارة</td></tr>' +
    '</tbody></table>' +
    '<div class="formula"><h4>معادلة صافي النقدية الواجب تسليمها</h4>' +
    '<p>المبيعات النقدية <b>+</b> التحصيلات غير البيعية <b>−</b> رسوم التوصيل <b>+</b> ضريبة التوصيل المستردة <b>−</b> المبيعات الآجلة <b>−</b> المصروفات <b>−</b> الموازنات</p>' +
    '<p class="ex">مثال فرع العليا: 4,550 + 1,200 − 575 + 75 − 900 − 350 − 3,000 = <b>1,000</b></p></div>' +
    '<div class="rules-short"><h4>ثلاث قواعد يجب معرفتها</h4><ul>' +
    '<li><b>قبل الإرسال</b>: يستطيع من أدخل البيانات إلغاءها بسبب مكتوب (وتُلغى معها الموازنة التابعة لها).</li>' +
    '<li><b>بعد الإرسال</b>: تُقفل، ولا يعدّلها أحد — ولا مدير النظام. وبعد الاعتماد تبقى مقفلة نهائياً.</li>' +
    '<li><b>يوم سُلِّم</b> لا تُضاف إليه أي حركة، ولا يُقبل تاريخ مستقبلي ولا مبلغ سالب.</li>' +
    '</ul></div></div>');

  // 1. sign in
  h.push('<div class="page">' + chapter('١', 'الدخول', '') +
    step('قبول الدعوة والدخول', [
      'تصلك رسالة بريد بعنوان الدعوة — اضغط <b>قبول الدعوة</b> (أو افتح الرابط المكتوب تحت الزر).',
      'اختر كلمة المرور بنفسك — لا أحد غيرك يعرفها.',
      'ادخل ببريدك وكلمة المرور من رابط النظام.',
      'نسيت كلمة المرور؟ اضغط <b>نسيت كلمة المرور</b> أو اطلب من مدير النظام إعادة الإرسال.'
    ], ['login']) + '</div>');

  // 2. area manager
  h.push('<div class="page">' + chapter('٢', 'مدير المنطقة', 'الدورة تبدأ من هنا، بطريقتين لإدخال يوم الفروع.') +
    step('الرئيسية: منطقتي', [
      'تعرض اسم منطقتك ومُحصّلها.',
      'لكل فرع بطاقة: مديره، وسياراته وسائقوها، وأجهزة نقاط البيع وحاملوها.',
      'أي حلقة ناقصة تظهر باللون الأحمر — أبلغ مدير النظام.'
    ], ['home-hero', 'home-area']) + '</div>');
  h.push('<div class="page">' + '<h2 class="sub2">الطريقة ١ — الإدخال اليدوي</h2>' +
    step('المصدر والتاريخ', [
      'افتح <b>الإدخالات</b>.',
      'التاريخ: اليوم تلقائياً (لا يُقبل تاريخ مستقبلي).',
      'اختر المصدر: المتجر أو السيارة أو جهاز نقاط البيع — من فروع منطقتك فقط.',
      'طريقة الإدخال: <b>حسب المنتج</b>. ثم <b>تأكيد المصدر والتاريخ</b>.'
    ], ['entry-basics']) +
    step('المبيعات: بنود المنتجات', [
      'اختر المنتج واكتب الكمية — السعر يأتي من البيانات الأساسية.',
      'المنتج ذو <b>السعر الثابت</b> لا يمكن تعديل سعره.',
      '<b>إضافة منتج</b> لكل بند آخر، ثم <b>تأكيد بنود المنتجات</b>.',
      'الإدخال نقدي فقط حالياً (نقاط البيع متوقفة من الإعدادات).'
    ], ['entry-lines']) + '</div>');
  h.push('<div class="page">' +
    step('رسوم التوصيل', [
      'افتح القسم، واكتب المبلغ والبيان لكل بند.',
      '<b>+ إضافة بند توصيل</b> لأكثر من بند.',
      'تُخصم قبل الضريبة، وضريبتها تُسترد تلقائياً.',
      'رأس القسم يعرض عدد البنود والإجمالي. ثم <b>تأكيد هذا القسم</b>.'
    ], ['entry-delivery']) +
    step('المبيعات الآجلة', [
      'المبلغ + <b>اسم العميل</b> (إلزامي).',
      'تُخصم لأنها ضمن المبيعات ولم تُستلم نقداً.'
    ], ['entry-credit']) + '</div>');
  h.push('<div class="page">' +
    step('تحصيلات غير بيعية والمصروفات', [
      'التحصيلات: مبلغ استُلم لغير البيع (تأمين أسطوانات، سداد آجل...) — تُضاف.',
      'المصروفات: ما صُرف من الصندوق (وقود، صيانة) — تُخصم.',
      'لكل بند: المبلغ، والبند من القائمة، و<b>سبب مكتوب</b>.'
    ], ['entry-other']) +
    step('الموازنات', [
      'مبلغ أُودع في البنك مباشرة قبل التسليم.',
      'اكتب المبلغ و<b>المرجع البنكي</b> (إلزامي) وبيان الموازنة.',
      'لا يمكن أن تتجاوز النقدية المتاحة في اليوم.'
    ], ['entry-deposit']) + '</div>');
  h.push('<div class="page">' +
    step('المعادلة ثم الحفظ', [
      'قبل الحفظ ترى <b>صافي النقدية الواجب تسليمها</b> سطراً بسطر.',
      'هي نفس المعادلة التي يراها نائب مدير العمليات والمُحصّل.',
      'اضغط <b>حفظ الإدخال</b>.'
    ], ['entry-net']) +
    step('الإدخال في القائمة — والإلغاء قبل الإرسال', [
      'كل يوم بطاقة واحدة: المصدر، من أدخل، المبيعات، الخصومات، الصافي، الحالة.',
      'افتح البطاقة بالسهم لترى كل بند وسببه.',
      'الحالة <b>مفتوح — يمكنك إلغاؤه</b>: اكتب سبب الإلغاء واضغط <b>إلغاء هذا الإدخال</b>، ثم أدخله من جديد صحيحاً.',
      'تُلغى معه الموازنة التابعة له — ما لم تطابقها المالية مع كشف البنك.'
    ], ['entry-card-open']) + '</div>');
  h.push('<div class="page">' + '<h2 class="sub2">الطريقة ٢ — ملف CSV</h2>' +
    step('رفع يوم فرع كامل بملف', [
      'افتح <b>رفع دفعة المنطقة</b> واضغط <b>تحميل القالب</b>.',
      'عبّئه في Excel: سطر لكل منتج (الكمية والسعر، نقدي). أعمدة التوصيل والآجل والتحصيلات والمصروفات والموازنة في السطر نفسه.',
      'احفظه بصيغة CSV وارفعه.',
      'تظهر معاينة لكل سطر وحالته، ثم <b>الحساب الفعلي من الخادم</b> — لا يُرسل شيء حتى تكون كل الأسطر سليمة.',
      'اضغط <b>إرسال الدفعة لنائب مدير العمليات للاعتماد</b>.'
    ], ['csv-preview'], 'الأعمدة: date, locationName, sourceType, sourceName, product, qty, unitPrice, paymentMethod, deliveryFee, deliveryNote, creditSales, creditCustomer, otherCash, otherCashItem, otherCashReason, expenseAmount, expenseItem, expenseReason, directDeposit, depositRef, depositNote, cylindersOut, cylindersIn, note') + '</div>');
  h.push('<div class="page">' +
    step('إرسال الطلب لنائب مدير العمليات', [
      'افتح <b>التسليمات</b>: بطاقة <b>طلب تسليم نقدية المنطقة</b> تعرض الخطوات الثلاث والمُحصّل.',
      '<b>جاهز للإرسال</b> يجمع تسليمات الفروع المؤكدة + الأيام التي أدخلتها بنفسك.',
      'اضغط <b>إرسال الطلب لنائب مدير العمليات</b>.',
      'لا يصل للمُحصّل قبل اعتماد النائب. وإن أعاده، يظهر لك السبب لتصحّح وتعيد الإرسال.'
    ], ['area-request', 'area-request-sent']) + '</div>');

  // 3. deputy
  h.push('<div class="page">' + chapter('٣', 'نائب مدير العمليات', 'يرى كل الفروع والتسليمات ولوحات الشركة — دون الإعدادات أو الإدخال.') +
    step('التحقق من طلب مدير المنطقة', [
      'افتح <b>اعتمادات نائب مدير العمليات</b>.',
      'راجع المبلغ وتفصيله (عرض تفاصيل المبلغ).',
      '<b>تحقق واعتماد</b>: يصل الطلب للمُحصّل.',
      '<b>إعادة للتصحيح</b>: اكتب السبب — يصل لمدير المنطقة وتعود النقدية لرصيده.'
    ], ['deputy-request']) +
    step('اعتماد دفعة CSV', [
      'في القسم نفسه: دفعات المناطق بتفصيل كل فرع.',
      '<b>اعتماد</b> ينشئ التسليم للمُحصّل، أو <b>رفض</b> بسبب.'
    ], ['deputy-batch']) + '</div>');

  // 4. collector
  h.push('<div class="page">' + chapter('٤', 'المُحصّل', '') +
    step('تأكيد الاستلام', [
      'افتح <b>التسليمات</b>: ترى من اعتمد الطلب وتفصيل المبلغ.',
      'اكتب <b>المبلغ المستلم فعلاً</b> — أي عجز يُسجَّل ويُصعَّد تلقائياً.',
      'اضغط <b>تأكيد الاستلام</b>. أو <b>اعتراض</b> مع السبب.'
    ], ['collector-confirm']) +
    step('الإيداع البنكي', [
      'اكتب المرجع البنكي وأرفق صورة القسيمة إن وُجدت.',
      'اضغط <b>تسجيل إيداع بنكي</b> — يُودع كل ما استلمته مرة واحدة.'
    ], ['collector-deposit']) + '</div>');

  // 5. the lock
  h.push('<div class="page">' + chapter('٥', 'القفل بعد الاعتماد', '') +
    step('ماذا يرى مُدخِل البيانات بعد الاعتماد', [
      'الحالة <b>معتمد</b> ومقفلة نهائياً — لا زر إلغاء.',
      'لا يعدّلها أحد، ولا مدير النظام.',
      'أي خطأ يُصحَّح بحركة جديدة موثّقة، لا بتعديل القديم.'
    ], ['entry-card-approved']) + '</div>');

  // 6. admin
  h.push('<div class="page">' + chapter('٦', 'مدير النظام', 'البيانات الأساسية والمستخدمون والإعدادات.') +
    step('تغيير مدير منطقة (مثال: إزالة شخص من منطقة ثانية)', [
      '<b>الإدارة ← البيانات الأساسية ← المناطق</b> ثم اضغط المنطقة.',
      'في <b>البيانات</b>: اختر مدير المنطقة الجديد من القائمة ثم <b>حفظ</b>.',
      'القائمة تعرض فقط من دوره مدير منطقة وغير مسند لمنطقة أخرى (لكل منطقة شخص واحد).',
      'لا يوجد مرشح؟ أضفه أولاً من <b>المستخدمون</b> بدور مدير منطقة — يمكن إسناده قبل قبوله الدعوة.',
      'إن ظهرت رسالة «يحمل نقدية أو لديه تسليم مفتوح»: أكمل تسليمات تلك المنطقة أولاً.'
    ], ['admin-area-hero', 'admin-area-form']) + '</div>');
  h.push('<div class="page">' +
    step('سلامة الربط', [
      'قائمة بكل حلقة ناقصة: منطقة بلا مدير أو مُحصّل، فرع بلا متجر، سيارة بلا سائق، شخص معطّل ما زال مسنداً، شخص على منطقتين.',
      'لكل فجوة زر <b>معالجة</b> يفتح مكان إصلاحها.'
    ], ['admin-chain']) +
    step('الإعدادات', [
      '<b>مبيعات نقاط البيع</b>: متوقفة — الإدخال نقدي فقط. فعّلها عند بدء قبول البطاقات.',
      'كل تغيير في الإعدادات يُسجَّل بالقيمة السابقة والجديدة.'
    ], ['admin-settings']) + '</div>');
  h.push('<div class="page">' +
    step('التشغيل الفعلي', [
      'بعد انتهاء الاختبار: اكتب LIVE واضغط <b>تفعيل التشغيل الفعلي</b>.',
      'بعدها يُعطَّل «بدء جولة اختبار جديدة» نهائياً ولا يمكن إعادة تفعيله.'
    ], ['admin-golive']) +
    step('مصفوفة الصلاحيات وقواعد الاعتماد', [
      '<b>الإدارة ← مصفوفة الصلاحيات</b>: من يستطيع ماذا لكل دور.',
      'وتحتها قواعد الاعتماد والقفل كاملة، مكتوبة في النظام نفسه.'
    ], ['admin-rules']) + '</div>');

  // appendix: messages
  h.push('<div class="page">' + chapter('ملحق', 'رسائل قد تظهر لك — وماذا تفعل', '') +
    '<table class="msgs"><thead><tr><th>الرسالة</th><th>السبب</th><th>ماذا تفعل</th></tr></thead><tbody>' +
    [
      ['هذا اليوم سُلِّم بالفعل لهذا المصدر', 'اليوم مغلق بعد التسليم', 'أدخل الحركة بتاريخ اليوم مع بيان واضح'],
      ['لا يمكن إدخال بيانات بتاريخ مستقبلي', 'تاريخ بعد اليوم', 'صحّح التاريخ'],
      ['اكتب اسم العميل لكل بيع آجل', 'بيع آجل بلا عميل', 'أضف اسم العميل'],
      ['الإدخال مقفل', 'أُرسل للمستوى التالي', 'لا تعديل — يُصحَّح بحركة جديدة موثّقة'],
      ['لا يمكن إلغاء الإدخال إلا من قِبل من أدخله', 'لست من أدخله', 'اطلب من صاحبه إلغاءه قبل الإرسال'],
      ['الموازنة طابقتها المالية مع كشف البنك', 'البنك أكّد المبلغ', 'تواصل مع المالية'],
      ['يؤكد الاستلام المستلم نفسه فقط', 'لست المستلم', 'المستلم وحده يؤكد — ويمكن للأدمن تعليقه للمراجعة'],
      ['لا يوجد مُحصّل معيّن لهذه المنطقة', 'حلقة ناقصة', 'مدير النظام يعيّن المُحصّل من المناطق'],
      ['هذا الشخص مسند إلى منطقة أخرى', 'شخص واحد لكل منطقة', 'اختر شخصاً آخر أو أزِله من منطقته أولاً'],
      ['يحمل نقدية أو لديه تسليم مفتوح', 'نقدية في الطريق', 'أكمل التسليم قبل تغيير الشخص أو نقل الموقع'],
      ['لا تتوفر نقدية لإرسالها', 'لا تسليمات مؤكدة ولا إدخالات مفتوحة', 'أكّد استلام الفروع أولاً']
    ].map(function (r) { return '<tr><td><b>' + r[0] + '</b></td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>'; }).join('') +
    '</tbody></table></div>');

  var css = fs.readFileSync(path.join(__dirname, 'guide.css'), 'utf8');
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>دليل المستخدم</title>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap">' +
    '<style>' + css + '</style></head><body>' + h.join('') + '</body></html>';
}

async function printPdf(html) {
  var htmlFile = path.join(OUT, 'guide.html');
  fs.writeFileSync(htmlFile, html, 'utf8');
  var browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  var p = await browser.newPage();
  await p.goto('file:///' + htmlFile.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await p.evaluate(async function () { if (document.fonts) await document.fonts.ready; });
  var out = path.join(OUT, 'دليل-المستخدم-نظام-تحصيل-النقدية.pdf');
  await p.pdf({
    path: out, format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;font-size:8px;color:#8a9a8d;text-align:center;font-family:Arial">— <span class="pageNumber"></span> —</div>',
    margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' }
  });
  await browser.close();
  console.log('pdf: ' + out + ' (' + (fs.statSync(out).size / 1048576).toFixed(1) + ' MB)');
}

(async function () {
  console.log('seeding…'); await seed();
  console.log('capturing…'); await capture();
  console.log('shots: ' + Object.keys(shots).length);
  await printPdf(buildHtml());
})().catch(function (e) { console.error(e); process.exit(1); });
