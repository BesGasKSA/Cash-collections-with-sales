/**
 * Builds the Arabic inventory guide (A4 PDF + HTML): seeds one branch's month on
 * the mock backend (an iron cylinder counted full and empty, an empty-cylinder
 * sale drawing from it, a regulator that runs short, a hose never counted),
 * captures phone-width screenshots of every step, lays them out beside numbered
 * steps and prints with headless Chrome. Made-up data only.
 *
 * Needs the mock backend running fresh (tests/mock-backend-server.js on :8905).
 *
 *   node tests/make-inventory-guide.js [outDir] [port]
 */
var fs = require('fs');
var path = require('path');
var http = require('http');

var OUT = process.argv[2] || path.join(require('os').tmpdir(), 'bgc-inventory-guide');
var PORT = Number(process.argv[3] || 8905);
var BASE = 'http://localhost:' + PORT;
var MODULES = path.join(process.env.TMP || '/tmp', 'claude', 'C--Claude', '1b419b87-2f22-4ee8-bbae-85be9310e0c2', 'scratchpad', 'video', 'node_modules');
var puppeteer = require(path.join(MODULES, 'puppeteer'));
var CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
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
function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function addDays(s, n) { var d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return iso(d); }

// ------------------------------------------------------------ the month on the mock
var S = {};
async function seed() {
  var a = await api({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' });
  var tok = a.token;
  async function call(p) { p.token = tok; var r = await api(p); if (r.token) tok = r.token; if (!r.ok) console.log('  ! ' + p.action + ': ' + r.error); return r; }
  await call({ action: 'setLanguage', language: 'ar' });   // the guide is in Arabic
  var meta = await call({ action: 'listMeta' });
  S.olayaLoc = meta.locations[0];
  S.olaya = meta.stores.filter(function (s) { return s.locationId === S.olayaLoc.id; })[0];
  // the products as the guide sets them up
  S.cyl = (await call({ action: 'adminSaveEntity', kind: 'product', data: { name: 'أسطوانة حديد 12.5 كجم — تبديل', type: 'goods', cylinder: true,
    stockName: 'أسطوانة حديد 12.5 كجم', unitPrice: 18, priceLocked: true, unitCost: 11.5, emptyCost: 140, active: true } })).entity;
  S.emptySale = (await call({ action: 'adminSaveEntity', kind: 'product', data: { name: 'أسطوانة حديد فارغة — بيع', type: 'goods', stockOf: S.cyl.id,
    stockEffect: 'sell_empty', unitPrice: 160, priceLocked: true, active: true } })).entity;
  S.reg = (await call({ action: 'adminSaveEntity', kind: 'product', data: { name: 'منظم غاز', type: 'goods', unitPrice: 45, unitCost: 28, active: true } })).entity;
  S.hose = (await call({ action: 'adminSaveEntity', kind: 'product', data: { name: 'خرطوم غاز 1.5 م', type: 'goods', unitPrice: 25, unitCost: 12, active: true } })).entity;
  // the days: the count on the 1st, a refill on the 2nd, a transfer and damage on the 3rd, sales on the 3rd and today
  S.today = iso(new Date());
  S.d1 = S.today.slice(0, 8) + '01';
  S.d2 = addDays(S.d1, 1) > S.today ? S.today : addDays(S.d1, 1);
  S.d3 = addDays(S.d1, 2) > S.today ? S.today : addDays(S.d1, 2);
  var L = S.olayaLoc.id;
  var moves = [
    { productId: S.cyl.id, state: 'full', kind: 'opening', qty: 120, date: S.d1, note: 'جرد افتتاحي صباح أول الشهر' },
    { productId: S.cyl.id, state: 'empty', kind: 'opening', qty: 40, date: S.d1, note: 'جرد افتتاحي صباح أول الشهر' },
    { productId: S.reg.id, kind: 'opening', qty: 3, date: S.d1, note: 'جرد افتتاحي' },
    { productId: S.cyl.id, state: 'full', kind: 'purchase', qty: 60, date: S.d2, note: 'فاتورة تعبئة 4471' },
    { productId: S.reg.id, kind: 'return', qty: 2, date: S.d2, note: 'مرتجع من مطعم الريف' },
    { productId: S.cyl.id, state: 'full', kind: 'transfer_out', qty: 10, date: S.d3, note: 'إلى فرع النسيم' },
    { productId: S.cyl.id, state: 'empty', kind: 'damage', qty: 1, date: S.d3, note: 'صمام تالف' }
  ];
  for (var i = 0; i < moves.length; i++) await call(Object.assign({ action: 'addInventoryMove', locationId: L }, moves[i]));
  // sales come from the day entries' product lines
  var sales = [
    { productId: S.reg.id, qty: 6, unitPrice: 45, date: S.d3 },
    { productId: S.cyl.id, qty: 30, unitPrice: 18, date: S.today },
    { productId: S.emptySale.id, qty: 2, unitPrice: 160, date: S.today },
    { productId: S.hose.id, qty: 3, unitPrice: 25, date: S.today }
  ];
  for (var j = 0; j < sales.length; j++) {
    var s = sales[j];
    await call({ action: 'createDailyEntry', date: s.date, sourceType: 'store', sourceId: S.olaya.id, productId: s.productId, qty: s.qty, unitPrice: s.unitPrice, cashSales: s.qty * s.unitPrice });
  }
  // a sale typed as an amount only, to show the warning
  await call({ action: 'createDailyEntry', date: S.today, sourceType: 'store', sourceId: S.olaya.id, productId: S.reg.id, cashSales: 90 });
  var rep = await call({ action: 'getInventoryReport', dateFrom: S.d1, dateTo: S.today, locationId: L });
  S.rows = rep.rows || [];
  S.tok = tok;
}

// ------------------------------------------------------------ the browser
var page, shots = {};
async function signIn(tok) {
  await page.goto(BASE + '/__mail?to=none', { waitUntil: 'domcontentloaded' });
  await page.evaluate(function (a) {
    localStorage.clear(); localStorage.setItem('bgc_apiUrl', a.base + '/api'); localStorage.setItem('bgc_lang', 'ar');
    if (a.tok) localStorage.setItem('bgc_token', a.tok);
  }, { base: BASE, tok: tok });
  await page.goto(BASE + '/?t=' + Date.now(), { waitUntil: 'networkidle2' });
  await sleep(1800);
}
// a screen in the bottom bar, or in its "more" sheet
async function navTo(label, ready) {
  var found = await page.evaluate(function (t) {
    var b = [].slice.call(document.querySelectorAll('.bt-scroll button, .sb-item')).filter(function (x) { return x.textContent.trim().indexOf(t) === 0; })[0];
    if (b) { b.click(); return true; } return false;
  }, label);
  if (!found) {
    await page.evaluate(function () { var m = document.querySelector('.bt-more'); if (m) m.click(); });
    await sleep(700);
    await page.evaluate(function (t) {
      var b = [].slice.call(document.querySelectorAll('.bt-sheet button, .bt-sheet a')).filter(function (x) { return x.textContent.trim().indexOf(t) >= 0; })[0];
      if (b) b.click();
    }, label);
  }
  await sleep(2200);
  if (ready && !(await page.$(ready))) console.log('  ! screen not reached: ' + label);
}
async function setv(sel, v) {
  await page.evaluate(function (a) {
    var e = document.querySelector(a.s); if (!e) return;
    if (e.type === 'checkbox') e.checked = !!a.v; else e.value = a.v;
    ['input', 'change', 'blur'].forEach(function (n) { e.dispatchEvent(new Event(n, { bubbles: true })); });
  }, { s: sel, v: v });
  await sleep(250);
}
async function click(sel, wait) {
  await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.click(); }, sel);
  await sleep(wait || 900);
}
async function shot(name, sel) {
  var file = path.join(SHOTS, name + '.png');
  try {
    var h = sel ? await page.$(sel) : null;
    if (sel && !h) { console.log('  ! no element for ' + name + ': ' + sel); return; }
    if (h) {
      await page.evaluate(function (s) { var e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'start' }); }, sel);
      await sleep(500);
      await h.screenshot({ path: file });
    } else await page.screenshot({ path: file });
    shots[name] = file;
    console.log('  shot ' + name);
  } catch (e) { console.log('  ! shot failed ' + name + ': ' + e.message); }
}

async function capture() {
  var opts = { headless: 'new', args: ['--lang=ar', '--no-sandbox', '--disable-dev-shm-usage'] };
  if (fs.existsSync(CHROME)) opts.executablePath = CHROME;
  var browser = await puppeteer.launch(opts);
  page = await browser.newPage();
  page.on('dialog', function (d) { d.dismiss().catch(function () {}); });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await signIn(S.tok);

  // the inventory screen, for the branch
  await navTo('المخزون', '.inv-bar');
  await setv('#ivLoc', S.olayaLoc.id);
  await sleep(2500);
  await sleep(1500);
  await shot('inv-live', '.inv-live');
  await shot('inv-bar', '.inv-bar');
  await shot('inv-eq', '.inv-eq');
  await setv('#ivVal', true);
  await sleep(600);
  await shot('inv-eq-val', '.inv-eq');
  await setv('#ivVal', false);
  await sleep(600);
  await click('.inv-card .pv-depth button[data-depth="4"]', 900);
  await shot('inv-levels', '.inv-card');
  await click('.inv-card .pv-depth button[data-depth="5"]', 900);
  await shot('inv-sellers', '.inv-card');
  // the movement form, filled but not saved
  await setv('.inv-add .ivaProd', S.cyl.id);
  await setv('.inv-add .ivaState', 'full');
  await setv('.inv-add .ivaKind', 'purchase');
  await setv('.inv-add .ivaQty', '60');
  await setv('.inv-add .ivaNote', 'فاتورة تعبئة 4471');
  await shot('inv-add', '.inv-add');
  await setv('.inv-add .ivaKind', 'opening');
  await setv('.inv-add .ivaState', 'empty');
  await setv('.inv-add .ivaQty', '40');
  await setv('.inv-add .ivaNote', 'جرد افتتاحي صباح أول الشهر');
  await shot('inv-add-opening', '.inv-add');
  await shot('inv-moves', '.inv-moves');

  // the live card on the home screen
  await navTo('الرئيسية', '.hero');
  await sleep(2500);
  await shot('home-live', '.inv-live');

  // setting the items up: Admin > Products > add
  await navTo('الإدارة', '.adm-tabs');
  await page.evaluate(function () {
    var b = [].slice.call(document.querySelectorAll('.adm-tabs button')).filter(function (x) { return x.textContent.trim().indexOf('المنتجات') === 0; })[0];
    if (b) b.click();
  });
  await sleep(1500);
  await click('.ent-addBtn', 900);
  var card = await page.evaluate(function () { var s = document.querySelector('.ent-save'); if (!s) return null; var c = s.closest('.card'); c.setAttribute('data-g', 'padd'); return '[data-g="padd"]'; });
  if (card) {
    var F = function (k) { return card + ' [data-k="' + k + '"]'; };
    await setv(F('name'), 'أسطوانة حديد 12.5 كجم — تبديل');
    await setv(F('type'), 'goods');
    await setv(F('unitPrice'), '18');
    await setv(F('priceLocked'), true);
    await setv(F('unitCost'), '11.5');
    await setv(F('cylinder'), true);
    await setv(F('stockName'), 'أسطوانة حديد 12.5 كجم');
    await setv(F('emptyCost'), '140');
    await shot('prod-cyl', card);
    await setv(F('name'), 'أسطوانة حديد فارغة — بيع');
    await setv(F('unitPrice'), '160');
    await setv(F('unitCost'), '');
    await setv(F('cylinder'), false);
    await setv(F('stockName'), '');
    await setv(F('emptyCost'), '');
    await setv(F('stockOf'), S.cyl.id);
    await setv(F('stockEffect'), 'sell_empty');
    await shot('prod-child', card);
  }
  S.logo = await page.evaluate(function () { var l = document.querySelector('link[rel="icon"]'); return l ? l.href : ''; });
  await browser.close();
}

// ------------------------------------------------------------ the document
function img(name) {
  if (!shots[name]) return '';
  return '<figure class="ph"><img src="data:image/png;base64,' + fs.readFileSync(shots[name]).toString('base64') + '"></figure>';
}
function step(title, items, shotNames, note) {
  return '<section class="step"><div class="txt"><h3>' + title + '</h3><ol>' + items.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>' +
    (note ? '<div class="tip">' + note + '</div>' : '') + '</div><div class="figs">' + (shotNames || []).map(img).join('') + '</div></section>';
}
function chapter(n, title, lead) {
  return '<header class="chap"><span class="cn">' + n + '</span><div><h2>' + title + '</h2>' + (lead ? '<p>' + lead + '</p>' : '') + '</div></header>';
}
function table(head, rows, cls) {
  return '<table' + (cls ? ' class="' + cls + '"' : '') + '><thead><tr>' + head.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>' +
    rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
}
function rowOf(productId, state) { return S.rows.filter(function (r) { return r.productId === productId && (r.state || null) === (state || null); })[0] || {}; }
function n(v) { return v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 }); }

function buildHtml() {
  var full = rowOf(S.cyl.id, 'full'), empty = rowOf(S.cyl.id, 'empty'), reg = rowOf(S.reg.id, null);
  var today = new Date().toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'long', day: 'numeric' });
  var h = [];
  h.push('<div class="cover">' + (S.logo ? '<img class="logo" src="' + S.logo + '">' : '') +
    '<div class="brand">الناقل الأفضل للغاز</div><h1>دليل المخزون</h1>' +
    '<p class="sub">الجرد الافتتاحي · الحركات · الأسطوانات مليان وفارغ · القراءة والتصدير</p>' +
    '<div class="flow"><span>رصيد أول المدة</span><i>+</i><span>الوارد</span><i>−</i><span>المبيعات والصادر</span><i>=</i><span>رصيد آخر المدة</span></div>' +
    '<p class="date">' + today + '</p></div>');

  // 0. on one page
  h.push('<div class="page">' + chapter('٠', 'المخزون في صفحة واحدة', 'كل صنف مخزني في كل فرع له رصيد يُحسب يومياً من الجرد والحركات والمبيعات المسجّلة، دون إدخال المبيعات مرتين.') +
    '<div class="formula"><h4>المعادلة</h4>' +
    '<p>رصيد أول المدة <b>+</b> المشتريات <b>+</b> مرتجع المطاعم <b>+</b> فوارغ عائدة من التبديل <b>+</b> نقل وارد من فرع <b>=</b> المتاح للاستخدام</p>' +
    '<p>المتاح للاستخدام <b>−</b> المبيعات <b>−</b> التالف <b>−</b> فوارغ أُرسلت للتعبئة <b>−</b> نقل صادر إلى فرع <b>=</b> رصيد آخر المدة</p>' +
    '<p class="ex">القيم بسعر التكلفة: الكمية × تكلفة الوحدة (وللأسطوانة الفارغة: تكلفة الأسطوانة الفارغة).</p></div>' +
    table(['الدور', 'ماذا يرى', 'ماذا يسجّل'], [
      ['<b>مدير النظام والمالية</b>', 'كل الفروع', 'كل الحركات، والإعداد، وإلغاء أي حركة بسبب'],
      ['<b>مدير المنطقة</b>', 'فروع منطقته', 'حركات فروع منطقته، وإلغاء حركات فروعه بسبب'],
      ['<b>مدير الفرع</b>', 'فرعه', 'حركات فرعه، وإلغاء ما سجّله هو بسبب'],
      ['<b>المحاسب والعمليات ونائب مدير العمليات</b>', 'كل الفروع (قراءة)', '—'],
      ['<b>السائق وعامل الفرع والمحصّل</b>', '—', '— (مبيعاتهم تدخل المخزون تلقائياً من إدخالاتهم)']
    ]) +
    '<div class="rules-short"><h4>خمس قواعد</h4><ul>' +
    '<li><b>الجرد الافتتاحي مرة واحدة</b> لكل صنف في كل فرع (وللأسطوانة: المليان والفارغ كلٌّ على حدة). بعده يصبح رصيد آخر كل يوم رصيدَ أول اليوم التالي تلقائياً.</li>' +
    '<li><b>المبيعات لا تُسجَّل في المخزون</b>: تُحسب من بنود المنتجات في الإدخالات اليومية (الكمية). البيع المُدخل بمبلغ فقط بلا كمية لا يُخصم ويظهر له تنبيه.</li>' +
    '<li><b>لا تعديل ولا حذف</b>: الحركة الخاطئة تُلغى بسبب مكتوب وتبقى ظاهرة في السجل، ثم تُسجَّل الصحيحة.</li>' +
    '<li><b>لا تاريخ مستقبلي</b>، والكمية رقم أكبر من صفر.</li>' +
    '<li><b>الخدمات بلا مخزون</b> (رسوم التوصيل مثلاً)، والمنتج الذي يسحب من صنف آخر لا تُسجَّل له حركات؛ تُسجَّل على الصنف الذي يحمل المخزون.</li>' +
    '</ul></div></div>');

  // 1. setting the items up
  h.push('<div class="page">' + chapter('١', 'تجهيز الأصناف', 'مرة واحدة، من الإدارة أو المالية: الإدارة ← البيانات الأساسية ← المنتجات.') +
    step('صنف الأسطوانة (يُعدّ مليان وفارغ)', [
      '<b>نوع المنتج</b>: مخزني.',
      'سعر الوحدة، وفعّل <b>سعر ثابت</b> إن كان السعر موحداً لكل الفروع.',
      '<b>تكلفة الوحدة</b>: تكلفة تعبئة الأسطوانة المليانة (تُستخدم في القيم والأرباح).',
      'فعّل <b>أسطوانة (تُعدّ مليان وفارغ)</b>، واكتب <b>اسم صنف المخزون</b> كما يُعدّ في الفرع.',
      '<b>تكلفة الأسطوانة الفارغة</b>: قيمة الأسطوانة نفسها، لتقييم الفوارغ.',
      'بيع هذا الصنف نفسه في الإدخالات = <b>تبديل</b>: تخرج مليانة وتعود فارغة.'
    ], ['prod-cyl']) +
    '</div><div class="page">' +
    step('منتج يسحب من صنف الأسطوانة', [
      'مثال: «أسطوانة حديد فارغة — بيع»، أو بيع أسطوانة مليانة جديدة بغازها.',
      '<b>يسحب من مخزون صنف</b>: اختر صنف الأسطوانة.',
      '<b>أثره على المخزون</b>: اختر بحسب البيع (الجدول أدناه).',
      'لا تُسجَّل له حركات مخزون؛ مبيعاته تُخصم من صنف الأسطوانة.'
    ], ['prod-child']) +
    table(['أثره على المخزون', 'المليان', 'الفارغ', 'مثال'], [
      ['<b>تبديل</b>', 'يخرج واحد', 'يعود واحد', 'العميل يسلّم فارغة ويستلم مليانة'],
      ['<b>بيع أسطوانة فارغة</b>', '—', 'يخرج واحد', 'بيع أسطوانة فارغة بلا غاز'],
      ['<b>بيع أسطوانة مليانة</b>', 'يخرج واحد', '—', 'بيع أسطوانة جديدة بغازها دون استرجاع فارغة'],
      ['<b>شراء مليان (تعبئة)</b>', 'يدخل العدد', 'يخرج العدد نفسه للتعبئة', 'حركة «مشتريات» على المليان']
    ]) +
    '<div class="tip"><b>تكلفة الوحدة وتاريخها</b>: التكلفة الجديدة تسري من اليوم، والمبيعات السابقة تبقى على تكلفتها. لتصحيح تكلفة أُدخلت خطأً بتاريخ سابق يُطلب سبب التصحيح. كل تغيير في السعر أو التكلفة يُحفظ في <b>سجل تغيّر الأسعار والرسوم والعمولات</b> في ملف المنتج.</div>' +
    '<div class="tip"><b>منتج له حركات مخزون</b> لا يتحول إلى خدمة، ولا يُلغى عنه وصف الأسطوانة، حتى لا يضيع تاريخه.</div></div>');

  // 2. the screen
  h.push('<div class="page">' + chapter('٢', 'شاشة المخزون', 'من القائمة: المخزون.') +
    step('الفترة والفرع', [
      '<b>من / إلى</b>: فترة التقرير (لا تتجاوز اليوم). أو <b>هذا الشهر</b> / <b>الشهر الماضي</b>.',
      '<b>الفرع</b>: فرع واحد أو <b>كل الفروع</b> المسموحة لك.',
      '<b>عرض القيم بالتكلفة بدل الكميات</b>: يقلب الأرقام بين الكميات وقيمتها بسعر التكلفة.',
      'كل ما قبل تاريخ «من» يدخل في رصيد أول المدة تلقائياً.'
    ], ['inv-bar']) +
    step('بطاقة المعادلة', [
      'كل خطوة من المعادلة رقم واحد، ومعها <b>يُضاف</b> أو <b>يُخصم</b>.',
      'الخطوات التي لا قيمة لها في الفترة (النقل، الفوارغ) تختفي.',
      'تحت البطاقة تنبيهات: أصناف بلا جرد افتتاحي، ومبيعات بلا كمية.'
    ], ['inv-eq']) + '</div>');
  h.push('<div class="page">' +
    step('القيم بسعر التكلفة', [
      'فعّل <b>عرض القيم</b>: الرقم الكبير بالريال، والكمية تحته.',
      'إن لم تُسجَّل تكلفة الوحدة للأصناف بعد تبقى الكميات ظاهرة مع تنبيه.'
    ], ['inv-eq-val']) +
    step('المخزون بالمستويات', [
      'المدينة › المنطقة › الفرع › الصنف › جهة البيع.',
      '<b>افتح حتى</b>: اختر المستوى المطلوب بضغطة، أو اضغط أي سطر لفتحه.',
      'الأسطوانة تظهر سطرين: <b>مليان</b> و<b>فارغ</b>.',
      '<b>عجز</b> بالأحمر: المبيعات أكثر من الرصيد، راجع الحركات (الرقم يظهر بلا إشارة سالب).',
      '<b>لم يُسجَّل رصيد أول المدة بعد</b>: الصنف لا يدخل الأرصدة حتى يُجرد.',
      'البحث يقبل اسم مدينة أو فرع أو صنف أو جهاز.'
    ], ['inv-levels']) + '</div>');
  h.push('<div class="page">' +
    step('جهة البيع', [
      'المستوى الخامس يبين من باع كل صنف: المتجر أو السيارة أو جهاز نقاط البيع، وكم باع.',
      'يفيد في معرفة مصدر العجز.'
    ], ['inv-sellers']) +
    step('التصدير والطباعة', [
      '<b>تصدير Excel</b>: كل المستويات بمجاميعها وطيّها، الكميات والقيم جنباً إلى جنب، وورقة ثانية بكل الحركات.',
      '<b>PDF</b>: ما هو مفتوح على الشاشة.',
      'الفترة والفرع المختاران يظهران في رأس الملف.'
    ], []) + '</div>');

  // live stock
  h.push('<div class="page">' + chapter('٢-أ', 'المخزون الآن (مباشر)', 'الرصيد الفعلي في هذه اللحظة، دائماً أمامك.') +
    step('على الشاشة الرئيسية', [
      'بطاقة <b>المخزون الآن</b> تحت الترحيب مباشرة، لكل من يرى المخزون: الإدارة والمالية والمحاسب ومدير العمليات ونائبه ومدير المنطقة ومدير الفرع.',
      'لكل صنف رقم واحد كبير: الموجود الآن. والأسطوانة بطاقتان: <b>مليان</b> و<b>فارغ</b>.',
      'تحت الرقم قيمته بالتكلفة. وفي الأسفل <b>قيمة المخزون الآن</b> ووقت آخر تحديث.',
      'البطاقة الحمراء مع كلمة <b>عجز</b>: المبيعات أكثر من الرصيد. راجع الحركات.',
      'تتحدث وحدها كل دقيقة، أو اضغط <b>تحديث الآن</b>. و<b>تفاصيل المخزون</b> تفتح شاشة المخزون.'
    ], ['home-live']) +
    step('في شاشة المخزون', [
      'البطاقة نفسها أعلى الشاشة، فوق اختيار الفترة.',
      'تتبع الفرع المختار: كل الفروع، أو فرع واحد.',
      'تشمل كل جرد وحركة وبيع مسجّل حتى هذه اللحظة، مهما كانت الفترة المختارة تحتها.'
    ], ['inv-live'], 'قيمة الأسطوانة المليانة = تكلفة الغاز + تكلفة الأسطوانة الفارغة، لأنها أسطوانة فيها غاز. والفارغة بتكلفة الأسطوانة وحدها.') + '</div>');

  // 3. opening count
  h.push('<div class="page">' + chapter('٣', 'الجرد الافتتاحي (رصيد أول المدة)', 'أول خطوة لكل صنف في كل فرع، ومرة واحدة فقط.') +
    step('تسجيل الجرد', [
      'اعدّ الصنف فعلياً في الفرع صباح يوم الجرد.',
      'في <b>تسجيل حركة مخزون</b>: الفرع، الصنف، وللأسطوانة <b>مليان أو فارغ</b>.',
      '<b>نوع الحركة</b>: رصيد أول المدة. اكتب الكمية وتاريخ يوم الجرد.',
      'للأسطوانة: سجّل المليان، ثم الفارغ كحركة ثانية.',
      'الجرد هو بداية ذلك اليوم: مبيعات اليوم نفسه تُخصم منه، وما قبله لا يُحسب.'
    ], ['inv-add-opening'], 'جرد مسجَّل من قبل؟ تظهر رسالة: رصيد أول المدة مسجَّل لهذا الصنف في هذا الفرع. سجّل الفرق كمشتريات أو تالف، أو ألغِ الجرد السابق بسبب ثم سجّله صحيحاً.') + '</div>');

  // 4. movements
  h.push('<div class="page">' + chapter('٤', 'تسجيل الحركات', 'كل ما يدخل الفرع أو يخرج منه غير البيع.') +
    step('حركة جديدة', [
      'الفرع، الصنف (ومليان/فارغ للأسطوانة)، نوع الحركة، الكمية، التاريخ.',
      '<b>ملاحظة</b>: رقم فاتورة الشراء، أو اسم المطعم، أو سبب التلف، أو الفرع الآخر.',
      'اضغط <b>حفظ الحركة</b>؛ تتحدث المعادلة والجدول فوراً.'
    ], ['inv-add']) +
    table(['نوع الحركة', 'متى', 'أثرها'], [
      ['<b>مشتريات</b>', 'استلام بضاعة من المورد', 'يُضاف. شراء أسطوانات مليانة = تعبئة: يخرج العدد نفسه من الفوارغ تلقائياً'],
      ['<b>مرتجع من المطاعم</b>', 'عميل أعاد صنفاً', 'يُضاف'],
      ['<b>تالف</b>', 'صنف لا يصلح للبيع', 'يُخصم — اكتب السبب'],
      ['<b>نقل صادر إلى فرع</b>', 'إرسال كمية لفرع آخر', 'يُخصم من هذا الفرع'],
      ['<b>نقل وارد من فرع</b>', 'استلام كمية من فرع آخر', 'يُضاف لهذا الفرع']
    ]) +
    '<div class="tip"><b>النقل بين الفروع</b> حركتان: «نقل صادر» في الفرع المرسِل و«نقل وارد» في الفرع المستلم، بالكمية والتاريخ نفسيهما، واكتب اسم الفرع الآخر في الملاحظة.</div></div>');

  // 5. sales
  h.push('<div class="page">' + chapter('٥', 'المبيعات', 'لا تُسجَّل في شاشة المخزون أبداً.') +
    '<div class="rules-short"><h4>كيف تدخل المبيعات المخزون</h4><ul>' +
    '<li>من <b>الإدخالات اليومية</b>: كل بند منتج (الكمية × السعر) يُخصم بكميته من فرع مصدره (المتجر أو السيارة أو الجهاز).</li>' +
    '<li>بيع صنف الأسطوانة نفسه = تبديل: يخرج مليان ويعود فارغ بالعدد نفسه.</li>' +
    '<li>المنتج الذي يسحب من صنف آخر يُخصم من ذلك الصنف بحسب أثره (بيع فارغة، بيع مليانة).</li>' +
    '<li>المبيعات الآجلة جزء من بنود المنتجات فلا تُحسب مرتين. لذلك لا يقبل النظام آجلاً لصنف بكمية أكبر من كميته في بنود المنتجات، ولا لصنف ليس في البنود: أضف كميته في البنود أولاً.</li>' +
    '<li>مبيعات سوق غاز جزء من كمية البند نفسه، فتُخصم مرة واحدة.</li>' +
    '<li>دفعة مدير المنطقة تُخصم من المخزون فور إرسالها. إن رفضها نائب مدير العمليات عادت الكميات، وعند تصحيحها وإعادة إرسالها تُخصم الكميات المصححة فقط.</li>' +
    '<li>بيع أُدخل <b>بمبلغ فقط بلا كمية</b> لا يُخصم من المخزون، ويظهر تنبيه بعدده ومبلغه: أدخله بطريقة المنتج (كمية × سعر).</li>' +
    '<li>إلغاء إدخال يوم يُرجع كمياته إلى المخزون تلقائياً.</li>' +
    '</ul></div></div>');

  // 6. voiding
  h.push('<div class="page">' + chapter('٦', 'حركات المخزون المسجلة وإلغاء الخطأ', '') +
    step('السجل', [
      'كل الحركات في الفترة: التاريخ، الفرع، الصنف، النوع، الكمية، الملاحظة، ومن سجّلها.',
      'زر <b>إلغاء الحركة</b> (×) يطلب <b>سبب الإلغاء</b>.',
      'الحركة الملغاة تبقى في السجل مشطوبة ومعها سببها، ولا تدخل الأرصدة.',
      'يلغي الحركة: من سجّلها في فرعه، ومدير المنطقة لفروعه، والإدارة والمالية لأي فرع.'
    ], ['inv-moves']) + '</div>');

  // 7. branch sheet
  h.push('<div class="page">' + chapter('٧', 'كميات المخزون من ورقة الفرع اليومية', 'لمدير المنطقة عند رفع ورقة الفرع (Daily Branches Report).') +
    '<div class="rules-short"><ul>' +
    '<li>في <b>رفع دفعة المنطقة</b> ارفع ورقة الفرع كما هي. يقرأ النظام كتلة الكميات أعلى الورقة: رصيد أول المدة، المشتريات، النقل منه وإليه، ونهاية اليوم، لكل صنف مليان وفارغ.</li>' +
    '<li>يعرض النظام لكل صنف <b>نهاية اليوم في الملف</b> بجانب <b>نهاية اليوم حسب النظام</b> المحسوبة من مبيعات الأجهزة في الورقة نفسها، ويعلّم ما <b>لا يطابق الملف</b>.</li>' +
    '<li>زر <b>حفظ كميات المخزون</b> يحفظها منفصلة عن دفعة النقدية، ولا تحتاج اعتماد نائب مدير العمليات. الجرد الافتتاحي يُحفظ فقط لما ليس له جرد بعد.</li>' +
    '<li>الورقة الواحدة ليوم واحد تُحفظ مرة واحدة؛ المحاولة الثانية تظهر: كميات هذا اليوم محفوظة من قبل.</li>' +
    '<li>إن لم تكن الأسطوانات مربوطة بمنتجات البيع، يظهر للإدارة والمالية زر <b>إعداد الأسطوانات تلقائياً</b>: يعلّم أصناف التبديل كأسطوانات ويربط بها أصناف بيع الفوارغ كما تحسبها الورقة.</li>' +
    '</ul></div></div>');

  // the branch sheet's formula and the system
  h.push('<div class="page">' + chapter('٧-أ', 'معادلة ورقة الفرع والنظام', 'درست صيغ ورقة الفروع اليومية في كل الفروع وقارنتها بالنظام.') +
    '<div class="formula"><h4>الصيغة المشتركة في كل الأوراق</h4>' +
    '<p>المليان آخر اليوم = مليان أول اليوم <b>+</b> مشتريات المليان <b>−</b> مبيعات التبديل</p>' +
    '<p>الفارغ آخر اليوم = (مليان أول اليوم + فارغ أول اليوم) <b>−</b> المبيع من الأسطوانات <b>−</b> المليان آخر اليوم</p>' +
    '<p class="ex">أي: الفارغ + العائد من التبديل − المرسل للتعبئة − الأسطوانات المبيعة. وهذه بالضبط معادلة النظام.</p></div>' +
    table(['ما في الورقة', 'في النظام'], [
      ['<b>نقل من الفرع (وارد)</b>: لا تحسبه أي ورقة', 'يُضاف للفرع المستلم'],
      ['<b>نقل إلى الفرع (صادر)</b>: تحسبه بعض الأوراق فقط، ونقل المليان فيها يزيد الفوارغ خطأً', 'يُخصم من الحالة المنقولة فقط (مليان أو فارغ)'],
      ['<b>مشتريات في عمود الفارغ</b>: تعبئة في ورقة، وأسطوانات مليانة جديدة في أخرى، وفوارغ جديدة في ثالثة', 'فوارغ جديدة تُضاف للفارغ'],
      ['<b>فارغ 5 كيلو</b> في إحدى الأوراق يقرأ أعمدة الوذفة', 'كل صنف من أرقامه هو'],
      ['<b>بيع أسطوانة (بيع)</b>: يُخصم من الفارغ في كل الأوراق', 'كذلك: «بيع أسطوانة فارغة» من الفارغ']
    ]) +
    '<div class="tip">لذلك عند رفع ورقة فيها نقل وارد، أو نقل مليان صادر، أو مشتريات في عمود الفارغ، قد يختلف «نهاية اليوم في الملف» عن «حسب النظام». رقم النظام هو الصحيح، والفرق من صيغة الورقة. اطلب توحيد الصيغة في أوراق الفروع.</div></div>');

  // 8. worked example
  h.push('<div class="page">' + chapter('٨', 'مثال كامل: فرع ' + (S.olayaLoc.name || '') + ' في شهر', 'نفس الأرقام الظاهرة في صور هذا الدليل.') +
    table(['الحركة', 'التاريخ', 'المليان', 'الفارغ'], [
      ['جرد افتتاحي', S.d1, '120', '40'],
      ['مشتريات مليان (تعبئة)', S.d2, '+ 60', '− 60 (للتعبئة)'],
      ['نقل صادر إلى فرع النسيم', S.d3, '− 10', '—'],
      ['تالف (صمام)', S.d3, '—', '− 1'],
      ['بيع تبديل 30 أسطوانة', S.today, '− 30', '+ 30'],
      ['بيع أسطوانتين فارغتين', S.today, '—', '− 2'],
      ['<b>رصيد آخر المدة</b>', '', '<b>' + n(full.ending) + '</b>', '<b>' + n(empty.ending) + '</b>']
    ], 'calc') +
    '<div class="formula"><h4>كما تحسبه الشاشة</h4>' +
    '<p>المليان: ' + n(full.opening) + ' + ' + n(full.purchases) + ' = ' + n(full.available) + ' متاح، − ' + n(full.sales) + ' مبيعات − ' + n(full.transfersOut) + ' نقل صادر = <b>' + n(full.ending) + '</b></p>' +
    '<p>الفارغ: ' + n(empty.opening) + ' + ' + n(empty.exchangeIn) + ' عائد من التبديل = ' + n(empty.available) + ' متاح، − ' + n(empty.sales) + ' مبيعات − ' + n(empty.damaged) + ' تالف − ' + n(empty.refillOut) + ' للتعبئة = <b>' + n(empty.ending) + '</b></p>' +
    '<p>منظم الغاز: ' + n(reg.opening) + ' + ' + n(reg.returns) + ' مرتجع = ' + n(reg.available) + ' متاح، − ' + n(reg.sales) + ' مبيعات = <b>عجز ' + n(Math.abs(reg.ending || 0)) + '</b> → راجع: بيع مُدخل خطأ؟ مشتريات لم تُسجَّل؟</p>' +
    '<p class="ex">القيمة: ' + n(full.ending) + ' مليان × (11.50 غاز + 140 أسطوانة) + ' + n(empty.ending) + ' فارغ × 140 = <b>' + n((full.ending || 0) * 151.5 + (empty.ending || 0) * 140) + ' ر.س</b></p></div></div>');

  // 9. messages
  h.push('<div class="page">' + chapter('٩', 'رسائل قد تظهر لك — وماذا تفعل', '') +
    table(['الرسالة', 'السبب', 'ماذا تفعل'], [
      ['رصيد أول المدة مسجَّل لهذا الصنف في هذا الفرع', 'جرد افتتاحي ثانٍ', 'سجّل الفرق كمشتريات أو تالف، أو ألغِ الجرد السابق بسبب ثم أعد تسجيله'],
      ['المخزون يُسجَّل على صنف الأسطوانة نفسه', 'اخترت منتجاً يسحب من صنف آخر', 'اختر صنف الأسطوانة'],
      ['اختر مليانة أو فارغة لصنف الأسطوانة', 'لم تُحدَّد الحالة', 'اختر مليان أو فارغ'],
      ['هذا الصنف خدمة وليس له مخزون', 'الصنف نوعه خدمات', 'غيّر نوعه في المنتجات إن كان مخزنياً'],
      ['لهذا الصنف حركات مخزون، فلا يمكن تحويله إلى خدمة', 'له تاريخ مخزون', 'أنشئ صنف خدمة جديداً بدل تغييره'],
      ['اكتب الكمية: رقم أكبر من صفر', 'كمية فارغة أو صفر أو نص', 'اكتب رقماً موجباً'],
      ['لا يمكن إدخال بيانات بتاريخ مستقبلي', 'تاريخ بعد اليوم', 'صحّح التاريخ'],
      ['راجع الفترة: تاريخ البداية قبل تاريخ النهاية', '«من» بعد «إلى»', 'صحّح الفترة'],
      ['كميات هذا اليوم محفوظة من قبل', 'ورقة الفرع لليوم نفسه رُفعت', 'لا شيء؛ أو ألغِ حركاتها ثم أعد الرفع'],
      ['لا تملك صلاحية لتنفيذ هذا الإجراء', 'فرع خارج صلاحيتك', 'سجّل لفروعك فقط، أو اطلب من مدير المنطقة أو المالية'],
      ['سبب الإلغاء مطلوب', 'إلغاء بلا سبب', 'اكتب السبب'],
      ['كمية الآجل لصنف أكبر من كميته في بنود المنتجات', 'آجل لصنف لم يُسجَّل في البنود أو بكمية أكبر', 'أضف الكمية في بنود المنتجات (الآجل جزء من المبيعات)']
    ], 'msgs') + '</div>');

  // 10. questions
  h.push('<div class="page">' + chapter('١٠', 'أسئلة متكررة', '') +
    table(['السؤال', 'الجواب'], [
      ['بعت لكن المخزون لم ينقص', 'البيع أُدخل بمبلغ فقط بلا كمية، أو اليوم قبل تاريخ الجرد الافتتاحي، أو الصنف بلا جرد. أدخل البيع بالكمية.'],
      ['لماذا يظهر «عجز»؟', 'المبيعات والصادر أكثر من المتاح: مشتريات لم تُسجَّل، أو نقل وارد ناقص، أو جرد افتتاحي أقل من الحقيقي، أو بيع بكمية خاطئة.'],
      ['هل أسجّل رصيد أول كل شهر؟', 'لا. الجرد الافتتاحي مرة واحدة؛ بعده يُحسب رصيد أول كل فترة من الحركات. عند جرد فعلي لاحق سجّل الفرق كتالف أو مشتريات بملاحظة «فرق جرد».'],
      ['لماذا لا تظهر القيم بالريال؟', 'لم تُسجَّل تكلفة الوحدة للأصناف. أضفها في المنتجات (أو تكاليف الوحدة في الربحية).'],
      ['شراء أسطوانات مليانة قلّل الفوارغ؟', 'نعم، الشراء المليان تعبئة: يخرج العدد نفسه من الفوارغ إلى التعبئة. إن كان شراء أسطوانات جديدة بلا تسليم فوارغ فسجّل الفرق نقلاً وارداً للفارغ أو صحّح بملاحظة.'],
      ['سجّلت حركة خاطئة', 'ألغِها بسبب من سجل الحركات، ثم سجّل الصحيحة.'],
      ['تغيّرت تكلفة الصنف؛ هل تتغير قيمة المخزون السابق؟', 'لا. التكلفة الجديدة من اليوم، والسابق على تكلفته. تصحيح تاريخ سابق يحتاج سبباً ويُحفظ في السجل.']
    ]) + '</div>');

  var css = fs.readFileSync(path.join(__dirname, 'guide.css'), 'utf8') +
    '.tip{margin-top:3mm;padding:2.5mm 3.5mm;background:#f7f4ec;border:1px solid var(--line);border-radius:2.5mm;font-size:9.5pt;line-height:1.7;}' +
    '.tip b{color:var(--green-dark);}' +
    'table.calc td:nth-child(n+3){text-align:center;font-variant-numeric:tabular-nums;}' +
    'table.calc tr:last-child td{background:var(--cream);}';
  return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>دليل المخزون</title>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap">' +
    '<style>' + css + '</style></head><body>' + h.join('') + '</body></html>';
}

async function printPdf(html) {
  var htmlFile = path.join(OUT, 'دليل-المخزون.html');
  fs.writeFileSync(htmlFile, html, 'utf8');
  var opts = { headless: 'new', args: ['--no-sandbox'] };
  if (fs.existsSync(CHROME)) opts.executablePath = CHROME;
  var browser = await puppeteer.launch(opts);
  var p = await browser.newPage();
  await p.goto('file:///' + htmlFile.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await p.evaluate(async function () { if (document.fonts) await document.fonts.ready; });
  var out = path.join(OUT, 'دليل-المخزون.pdf');
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
  console.log('report rows: ' + S.rows.length);
  console.log('capturing…'); await capture();
  console.log('shots: ' + Object.keys(shots).length);
  await printPdf(buildHtml());
})().catch(function (e) { console.error(e); process.exit(1); });
