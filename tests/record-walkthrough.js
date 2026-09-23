/**
 * Records a narrated walkthrough video of the real app: area manager →
 * deputy → collector → admin, at phone width, with the narration in its own
 * column beside the phone so it never covers the UI.
 *
 * Needs the mock backend running (tests/mock-backend-server.js on :8905) and
 * puppeteer + ffmpeg-static available. Not part of the shipped system.
 *
 *   node tests/record-walkthrough.js [outDir] [port]
 */
var fs = require('fs');
var path = require('path');
var http = require('http');
var { execFile } = require('child_process');

var OUT = process.argv[2] || path.join(require('os').tmpdir(), 'bgc-video');
var PORT = Number(process.argv[3] || 8905);
var BASE = 'http://localhost:' + PORT;
var FPS = 8;
var MODULES = path.join(process.env.TMP || '/tmp', 'claude', 'C--Claude', '1b419b87-2f22-4ee8-bbae-85be9310e0c2', 'scratchpad', 'video', 'node_modules');
var puppeteer = require(path.join(MODULES, 'puppeteer'));
var ffmpeg = require(path.join(MODULES, 'ffmpeg-static'));

var frameDir = path.join(OUT, 'frames');
fs.rmSync(frameDir, { recursive: true, force: true });
fs.mkdirSync(frameDir, { recursive: true });

// ---------------------------------------------------------------- API helper
function api(payload) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify(payload);
    var req = http.request(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// The day this walkthrough tells the story of: seven products sold for cash,
// cylinder insurance collected, fuel paid out of the till, and part of the
// cash banked on the spot as a موازنة.
var DAY = new Date().toISOString().slice(0, 10);
var PRODUCTS = [
  { name: 'أسطوانة غاز 12.5 كجم', price: 45, locked: true, qty: 40 },
  { name: 'أسطوانة غاز 25 كجم', price: 85, locked: true, qty: 20 },
  { name: 'أسطوانة غاز 50 كجم', price: 160, locked: true, qty: 10 },
  { name: 'غاز سائب — لتر', price: 3.5, locked: false, qty: 300 },
  { name: 'منظّم ضغط', price: 60, locked: false, qty: 15 },
  { name: 'خرطوم غاز', price: 25, locked: false, qty: 25 },
  { name: 'صمّام أمان', price: 18, locked: false, qty: 30 }
];
var INSURANCE = 1200, EXPENSE = 350, MOAZANA = 3000;
var CASH_TOTAL = PRODUCTS.reduce(function (s, p) { return s + p.price * p.qty; }, 0); // 8,215
var NET = CASH_TOTAL + INSURANCE - EXPENSE - MOAZANA;                                 // 6,065
function money(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

var seeded = {};
async function seed() {
  var admin = await api({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' });
  var tok = admin.token;
  async function call(p) { p.token = tok; var r = await api(p); if (r.token) tok = r.token; return r; }

  seeded.products = [];
  for (var i = 0; i < PRODUCTS.length; i++) {
    var p = PRODUCTS[i];
    var r = await call({ action: 'adminSaveEntity', kind: 'product', data: { name: p.name, type: 'goods', unitPrice: p.price, priceLocked: p.locked } });
    seeded.products.push(Object.assign({ id: r.entity.id }, p));
  }
  var inc = await call({ action: 'adminSaveEntity', kind: 'income_item', data: { name: 'تأمين أسطوانات' } });
  var inc2 = await call({ action: 'adminSaveEntity', kind: 'income_item', data: { name: 'تحصيل مبيعات آجلة' } });
  var exp = await call({ action: 'adminSaveEntity', kind: 'expense_item', data: { name: 'وقود سيارة التوصيل' } });
  var exp2 = await call({ action: 'adminSaveEntity', kind: 'expense_item', data: { name: 'صيانة بسيطة' } });
  seeded.incomeItem = inc.entity; seeded.expenseItem = exp.entity;

  var meta = await call({ action: 'listMeta' });
  seeded.meta = meta;
  seeded.cluster = meta.clusters.filter(function (c) { return c.name.indexOf('North') >= 0; })[0] || meta.clusters[0];
  seeded.branches = meta.locations.filter(function (l) { return l.clusterId === seeded.cluster.id; });
  seeded.stores = meta.stores.filter(function (s) {
    return seeded.branches.some(function (b) { return b.id === s.locationId; });
  });
  seeded.tokens = {};
  for (var who of [['area', 'muzafer@bestgas.sa'], ['deputy', 'ahmed@bestgas.sa'], ['collector', 'mazen@bestgas.sa']]) {
    var lg = await api({ action: 'login', email: who[1], password: 'Welcome#1' });
    seeded.tokens[who[0]] = { token: lg.token, name: lg.user.name, email: who[1] };
  }
  seeded.tokens.admin = { token: tok, name: 'Admin', email: 'admin@bestgas.sa' };
  return seeded;
}

// ------------------------------------------------------------- the CSV file
function writeCsv() {
  var b = seeded.branches[1] || seeded.branches[0];
  var store = seeded.stores.filter(function (s) { return s.locationId === b.id; })[0];
  var header = 'date,locationName,sourceType,sourceName,product,qty,unitPrice,paymentMethod,otherCash,otherCashItem,otherCashReason,expenseAmount,expenseItem,expenseReason,directDeposit,depositRef,depositNote,cylindersOut,cylindersIn,note';
  var lines = [header];
  PRODUCTS.forEach(function (p, i) {
    var extra = i === 0
      ? [INSURANCE, 'تأمين أسطوانات', 'تأمين مسترد على 24 أسطوانة', EXPENSE, 'وقود سيارة التوصيل', 'تعبئة وقود سيارة التوصيل', MOAZANA, 'MZN-' + DAY.replace(/-/g, '') + '-2', 'موازنة مبيعات نصف اليوم'].join(',')
      : ',,,,,,,,';
    lines.push([DAY, b.name, 'store', store.name, p.name, p.qty, p.price, 'cash', extra, '', '', ''].join(','));
  });
  var file = path.join(OUT, 'رفع-دفعة-المنطقة.csv');
  fs.writeFileSync(file, '﻿' + lines.join('\n'), 'utf8');
  return { file: file, branch: b, store: store };
}

// ------------------------------------------------------------------ recorder
var shots = 0, recording = false, busy = false;
function startRecording(page) {
  recording = true;
  var timer = setInterval(async function () {
    if (!recording) { clearInterval(timer); return; }
    if (busy) return;
    busy = true;
    try {
      await page.screenshot({ path: path.join(frameDir, String(shots++).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 82 });
    } catch (e) { /* a frame during navigation is not worth failing over */ }
    busy = false;
  }, Math.round(1000 / FPS));
  return function () { recording = false; };
}

// ------------------------------------------------------------------- driving
var page, appFrame;
var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function stage(fn, args) { return page.evaluate(fn, args); }
async function say(title, body, hold) {
  await page.evaluate(function (a) { window.stage.say(a.t, a.b); }, { t: title, b: body || '' });
  await sleep(hold != null ? hold : 2600);
}
async function point(html, wait) { await page.evaluate(function (h) { window.stage.point(h); }, html); await sleep(wait || 1700); }
async function chapter(n, name) { await page.evaluate(function (a) { window.stage.chapter(a.n, a.name); }, { n: n, name: name }); }
async function progress(pct, left, right) { await page.evaluate(function (a) { window.stage.progress(a.p, a.l, a.r); }, { p: pct, l: left, r: right }); }
async function caption(text) { await page.evaluate(function (t) { window.stage.caption(t); }, text || ''); }
async function ring(sel) {
  if (!sel) { await page.evaluate(function () { window.stage.ring(null); }); return; }
  var rect = await appFrame.evaluate(function (s) {
    var el = document.querySelector(s); if (!el) return null;
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
  await page.evaluate(function (r) { window.stage.ring(r); }, rect);
  return rect;
}
async function tap(sel, opts) {
  opts = opts || {};
  var rect = await ring(sel);
  if (!rect) { console.log('  ! missing: ' + sel); return false; }
  await page.evaluate(function (r) { window.stage.tapAt(r.x + r.width / 2, r.y + r.height / 2); }, rect);
  await sleep(420);
  await appFrame.evaluate(function (s) { var el = document.querySelector(s); if (el) el.click(); }, sel);
  await sleep(opts.wait != null ? opts.wait : 900);
  if (!opts.keepRing) await ring(null);
  return true;
}
async function tapText(text, opts) {
  var sel = await appFrame.evaluate(function (t) {
    var all = [].slice.call(document.querySelectorAll('button, .sb-item, .bt-scroll button, a'));
    var el = all.filter(function (e) { return e.textContent.trim().indexOf(t) >= 0 && e.offsetParent !== null; })[0];
    if (!el) return null;
    el.setAttribute('data-rec', 'target');
    return '[data-rec="target"]';
  }, text);
  if (!sel) { console.log('  ! no button: ' + text); return false; }
  var ok = await tap(sel, opts);
  await appFrame.evaluate(function () { var e = document.querySelector('[data-rec="target"]'); if (e) e.removeAttribute('data-rec'); });
  return ok;
}
async function typeIn(sel, value, opts) {
  opts = opts || {};
  await ring(sel);
  await appFrame.focus(sel).catch(function () {});
  await appFrame.evaluate(function (s) { var e = document.querySelector(s); if (e) { e.value = ''; } }, sel);
  await appFrame.type(sel, String(value), { delay: opts.delay || 45 });
  await appFrame.evaluate(function (s) {
    var e = document.querySelector(s); if (!e) return;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('blur', { bubbles: true }));
  }, sel);
  await sleep(opts.wait != null ? opts.wait : 500);
  if (!opts.keepRing) await ring(null);
}
async function pick(sel, value, opts) {
  opts = opts || {};
  await ring(sel);
  await appFrame.select(sel, String(value));
  await sleep(opts.wait != null ? opts.wait : 650);
  if (!opts.keepRing) await ring(null);
}
async function scrollTo(sel, block) {
  await appFrame.evaluate(function (a) {
    var e = document.querySelector(a.s); if (e) e.scrollIntoView({ block: a.b || 'center', behavior: 'smooth' });
  }, { s: sel, b: block });
  await sleep(900);
}
async function scrollBy(px) {
  await appFrame.evaluate(function (p) { window.scrollBy({ top: p, behavior: 'smooth' }); }, px);
  await sleep(1100);
}
async function signInAs(who) {
  var t = seeded.tokens[who];
  await page.evaluate(function (a) {
    try {
      localStorage.clear();
      localStorage.setItem('bgc_apiUrl', a.base + '/api');
      localStorage.setItem('bgc_lang', 'ar');
      localStorage.setItem('bgc_token', a.token);
    } catch (e) {}
    document.getElementById('app').src = '/?t=' + Date.now();
  }, { base: BASE, token: t.token });
  await sleep(2600);
  appFrame = page.frames().filter(function (f) { return f.url().indexOf(BASE) === 0 && f !== page.mainFrame(); })[0];
  await sleep(600);
}
async function go(screenText) { return tapText(screenText, { wait: 1800 }); }
// A signed-out load, so the sign-in screen plays its entrance animation.
async function showLogin() {
  await page.evaluate(function (base) {
    try { localStorage.clear(); localStorage.setItem('bgc_apiUrl', base + '/api'); localStorage.setItem('bgc_lang', 'ar'); } catch (e) {}
    document.getElementById('app').src = '/?signin=' + Date.now();
  }, BASE);
  await sleep(2200);
  appFrame = page.frames().filter(function (fr) { return fr.url().indexOf(BASE) === 0 && fr !== page.mainFrame(); })[0];
  await sleep(400);
}
// Some buttons only exist once a server round trip lands (the bulk batch's
// preview, a handoff list). Wait for them instead of tapping into thin air.
async function waitFor(sel, ms) {
  var deadline = Date.now() + (ms || 12000);
  while (Date.now() < deadline) {
    var there = await appFrame.evaluate(function (s) {
      var e = document.querySelector(s); return !!(e && e.offsetParent !== null);
    }, sel).catch(function () { return false; });
    if (there) return true;
    await sleep(400);
  }
  console.log('  ! never appeared: ' + sel);
  return false;
}
async function waitForAny(sels, ms) {
  var deadline = Date.now() + (ms || 12000);
  while (Date.now() < deadline) {
    var hit = await appFrame.evaluate(function (list) {
      for (var i = 0; i < list.length; i++) {
        var e = document.querySelector(list[i]);
        if (e && e.offsetParent !== null) return list[i];
      }
      return null;
    }, sels).catch(function () { return null; });
    if (hit) return hit;
    await sleep(400);
  }
  console.log('  ! none appeared: ' + sels.join(', '));
  return null;
}

// ------------------------------------------------------------------ the film
async function main() {
  console.log('seeding…');
  await seed();
  var csv = writeCsv();
  console.log('products seeded, csv at ' + csv.file);

  var browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1.5 },
    args: ['--force-device-scale-factor=1.5','--hide-scrollbars','--lang=ar','--no-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 });
  await page.goto(BASE + '/tests/stage.html', { waitUntil: 'networkidle0' });
  // brand mark for the narration column, taken from the app itself
  var logo = await page.evaluate(async function (base) {
    var html = await fetch(base + '/index.html').then(function (r) { return r.text(); });
    var m = /<link rel="icon" type="image\/png" href="(data:image\/png;base64,[^"]+)"/.exec(html);
    return m ? m[1] : '';
  }, BASE);
  if (logo) await page.evaluate(function (l) { window.stage.setLogo(l); }, logo);

  var stop = startRecording(page);
  try { await film(csv); }
  catch (e) { console.log('FILM ERROR: ' + (e && e.stack || e)); }
  stop();
  await sleep(400);
  await browser.close();

  console.log('frames: ' + shots);
  var out = path.join(OUT, 'bestgas-walkthrough.mp4');
  await new Promise(function (resolve, reject) {
    execFile(ffmpeg, ['-y', '-framerate', String(FPS), '-i', path.join(frameDir, '%05d.jpg'),
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'medium', '-crf', '24',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
      function (err, so, se) { if (err) reject(new Error(se || err.message)); else resolve(); });
  });
  console.log('video: ' + out + ' (' + (fs.statSync(out).size / 1048576).toFixed(1) + ' MB, ' + (shots / FPS).toFixed(0) + 's)');
}

async function film(csv) {
  // ---------------------------------------------------------------- opening
  await chapter('1', 'مقدمة');
  await progress(2, 'الفصل ١ من ٥', 'مدير المنطقة');
  await say('يوم كامل في نظام تحصيل النقدية', 'نتابع خطوة بخطوة: مدير المنطقة يدخل بيانات يوم كامل، ثم الاعتماد، ثم المحصّل، ثم لوحات الأدمن والتقارير.', 3400);
  await showLogin();
  await caption('شاشة الدخول');
  await sleep(2600);
  await point('كل مستخدم يدخل ببريده وكلمة مروره التي اختارها من رابط الدعوة', 2400);
  await ring('#loginEmail'); await sleep(1200);
  await ring('#loginPw'); await sleep(1200); await ring(null);
  await caption('');
  await signInAs('area');
  await sleep(1400);
  await point('<b>٧ منتجات</b> بيعت نقداً في فرع واحد', 1100);
  await point('<b>تأمين أسطوانات</b> — نقدية من غير البيع <span class="fig">' + money(INSURANCE) + '</span>', 1100);
  await point('<b>مصروفات</b> وقود دُفعت من النقدية <span class="fig">' + money(EXPENSE) + '</span>', 1100);
  await point('<b>موازنة</b> أُودعت بالبنك مباشرة <span class="fig">' + money(MOAZANA) + '</span>', 1400);

  // -------------------------------------------------- 2. the area dashboard
  await chapter('2', 'لوحة مدير المنطقة');
  await progress(14, 'الفصل ٢ من ٥', 'اللوحة والفلاتر');
  await say('أولاً: ما الذي يراه مدير المنطقة؟', 'الشاشة الرئيسية تفتح على ملخّص فروعه هو فقط — لا يرى فروع منطقة أخرى.');
  await caption('الشاشة الرئيسية — بيانات فروعه فقط');
  await sleep(3000);
  await scrollBy(260);
  await point('بطاقات الإجراءات المعلّقة أولاً', 900);
  await scrollBy(320);
  await point('ثم <b>ملخص المبيعات</b> شامل ضريبة القيمة المضافة', 900);
  await scrollBy(320);
  await point('ثم <b>ملخص التحصيل والإيداع</b> — المعادلة سطراً بسطر', 2200);
  await sleep(1600);
  await scrollBy(260);
  await point('كل سطر قابل للضغط ليفتح المعاملات التي كوّنته', 2200);
  await caption('');

  // ------------------------------------------------------------ 3. the report
  await say('الفلاتر: كيف يصل لأي رقم بالضبط؟', 'شاشة تقرير المبيعات تجمع كل الفلاتر في مكان واحد، وكلها محصورة في نطاق صلاحيته.');
  await go('تقرير المبيعات');
  await caption('تقرير المبيعات');
  await sleep(1200);
  await tap('#rFilterToggle', { wait: 1200 });
  await scrollTo('#rFilterBody', 'start');
  await point('<b>من تاريخ / إلى تاريخ</b>', 700);
  await typeIn('#rFrom', DAY.slice(0, 8) + '01', { delay: 25, wait: 400 });
  await typeIn('#rTo', DAY, { delay: 25, wait: 500 });
  await point('<b>الفرع</b> — فروع منطقته فقط', 700);
  await ring('#rLoc'); await sleep(900); await ring(null);
  await point('<b>طريقة الدفع</b> — نقدي، شبكة، آجل، توصيل، تحصيلات، مصروفات، موازنات', 900);
  await ring('#rPayment'); await sleep(1000); await ring(null);
  await point('<b>السائق</b> و<b>مُدخِل البيانات</b> و<b>المنتج</b> و<b>حدود المبلغ</b>', 1000);
  await scrollTo('#rRun');
  await tap('#rRun', { wait: 2200 });
  await caption('النتيجة محصورة في فروعه هو');
  await sleep(1400);
  await caption('');

  // ------------------------------------------------- 4. manual entry, in full
  await chapter('3', 'الإدخال اليدوي');
  await progress(34, 'الفصل ٣ من ٥', 'إدخال يوم كامل يدوياً');
  await say('المثال الأول: إدخال يدوي', 'يوم كامل لفرع واحد: سبعة منتجات نقداً، تأمين، مصروفات، وموازنة — بدون تفويت أي رقم.');
  await go('الإدخالات');
  await caption('شاشة الإدخالات');
  await sleep(1200);
  await pick('#eType', 'store');
  var storeId = seeded.stores[0].id;
  await pick('#eSource', storeId);
  await point('الفرع يظهر تلقائياً بعد اختيار المصدر', 900);
  await pick('#eMode', 'product');
  await caption('وضع المنتجات: كل سطر منتج بكميته وسعره');
  await sleep(1200);

  for (var i = 0; i < seeded.products.length; i++) {
    var p = seeded.products[i];
    if (i > 0) await tap('#eAddLine', { wait: 700 });
    var lineSel = '.eLine:nth-of-type(' + (i + 1) + ')';
    await appFrame.evaluate(function (a) {
      var line = document.querySelectorAll('.eLine')[a.i];
      if (line) line.setAttribute('data-rec', 'line' + a.i);
    }, { i: i });
    var base = '[data-rec="line' + i + '"] ';
    await scrollTo(base + '.lnProduct');
    await pick(base + '.lnProduct', p.id, { wait: 500 });
    await typeIn(base + '.lnQty', p.qty, { delay: 70, wait: 450 });
    await caption(p.name + ' — ' + p.qty + ' × ' + money(p.price) + ' = ' + money(p.qty * p.price));
    if (i === 0) await point('السعر يأتي من <b>بيانات المنتج</b>، والإجمالي الفرعي يُحسب فوراً', 1800);
    if (p.locked && i === 0) await point('هذا المنتج سعره <b>ثابت</b> — لا يمكن تعديله عند الإدخال', 1800);
    await sleep(1300);
  }
  await caption('إجمالي المبيعات النقدية ' + money(CASH_TOTAL));
  await sleep(1600);
  await caption('');

  await say('النقدية التي ليست مبيعات', 'ثلاثة أقسام منفصلة تحت الإدخال: ما استُلم، وما صُرف، وما أُودع في البنك مباشرة.');
  // collections
  await scrollTo('#eOtherWrap');
  await tap('#eOtherWrap .me-toggle', { wait: 700 });
  await typeIn('#eOther', INSURANCE, { delay: 70 });
  await pick('#eOtherItem', seeded.incomeItem.id);
  await typeIn('#eOtherReason', 'تأمين مسترد على 24 أسطوانة', { delay: 28 });
  await point('<b>تحصيلات غير بيعية</b> — البند من البيانات الأساسية، والسبب إلزامي', 2400);
  await sleep(900);
  // expenses
  await scrollTo('#eExpenseWrap');
  await tap('#eExpenseWrap .me-toggle', { wait: 700 });
  await typeIn('#eExpense', EXPENSE, { delay: 70 });
  await pick('#eExpenseItem', seeded.expenseItem.id);
  await typeIn('#eExpenseReason', 'تعبئة وقود سيارة التوصيل', { delay: 28 });
  await point('<b>مصروفات نقدية</b> — تُخصم من النقدية الواجب تسليمها', 2400);
  await sleep(900);
  // moazana
  await scrollTo('#eDepositWrap');
  await tap('#eDepositWrap .me-toggle', { wait: 700 });
  await typeIn('#eDeposit', MOAZANA, { delay: 70 });
  await typeIn('#eDepositRef', 'MZN-' + DAY.replace(/-/g, '') + '-1', { delay: 28 });
  await typeIn('#eDepositNote', 'موازنة مبيعات نصف اليوم', { delay: 28 });
  await point('<b>الموازنات</b> — أودعها من يحمل النقدية بنفسه قبل التسليم', 2400);
  await point('المرجع البنكي و<b>بيان الموازنة</b> يرافقان الإيداع في سجلّه', 2200);

  await say('المعادلة تُحسب أمامه مباشرة', 'نفس المعادلة التي يراها المستلم لاحقاً — لا مفاجآت عند التسليم.');
  await scrollTo('#eNetPreview');
  await ring('#eNetPreview');
  await sleep(2600);
  await point(money(CASH_TOTAL) + ' نقدي <b>+</b> ' + money(INSURANCE) + ' تحصيلات', 900);
  await point('<b>−</b> ' + money(EXPENSE) + ' مصروفات <b>−</b> ' + money(MOAZANA) + ' موازنة', 900);
  await point('<b>= ' + money(NET) + '</b> صافي الواجب تسليمه', 1400);
  await ring(null);
  await scrollTo('#eSubmit');
  await tap('#eSubmit', { wait: 2600 });
  await caption('تم الحفظ — والموازنة سجّلت إيداعاً بنكياً تلقائياً');
  await sleep(2000);
  await caption('');

  // ------------------------------------------------------------- 5. the CSV
  await chapter('4', 'الرفع من ملف CSV');
  await progress(62, 'الفصل ٤ من ٥', 'نفس اليوم بملف واحد');
  await say('المثال الثاني: نفس البيانات بملف CSV', 'لفرع آخر، وبدل الإدخال سطراً سطراً: قالب واحد يرفع اليوم كامل ويذهب لاعتماد نائب مدير العمليات.');
  await go('رفع دفعة المنطقة');
  await caption('رفع دفعة المنطقة');
  await sleep(1500);
  await point('الأعمدة: التاريخ، الفرع، المصدر، المنتج، الكمية، السعر، طريقة الدفع', 1000);
  await point('ثم: <b>otherCash</b> و<b>expenseAmount</b> و<b>directDeposit</b> ببياناتها', 1200);
  var fileInput = await appFrame.$('input[type="file"]');
  if (fileInput) {
    await ring('input[type="file"]');
    await fileInput.uploadFile(csv.file);
    await sleep(2200);
    await ring(null);
  }
  await caption('معاينة قبل الإرسال: كل سطر وحالته');
  await scrollBy(320);
  await sleep(1600);
  await point('لا يُرسل شيء حتى تكون كل الأسطر سليمة', 900);
  // the server computes the real breakdown first (dryRun), and only then
  // does the submit button exist
  if (await waitFor('#abSubmit', 15000)) {
    await scrollTo('#abSubmit');
    await caption('الحساب الفعلي من الخادم قبل الإرسال');
    await sleep(1600);
    await point('نفس المعادلة: نقدي + تحصيلات − مصروفات − موازنة', 1100);
    await tap('#abSubmit', { wait: 3200 });
  }
  await caption('بانتظار اعتماد نائب مدير العمليات');
  await sleep(1800);
  await caption('');

  // --------------------------------------------------- 6. deputy + collector
  await chapter('5', 'الاعتماد ثم المحصّل');
  await progress(78, 'الفصل ٥ من ٥', 'الاعتماد والتسليم والإيداع');
  await say('نائب مدير العمليات يعتمد الدفعة', 'خطوة واحدة تفصل بين رفع البيانات ووصولها للمحصّل.');
  await signInAs('deputy');
  await go('اعتماد دفعات المنطقة');
  await sleep(1600);
  await caption('مراجعة الدفعة قبل الاعتماد');
  await scrollBy(300);
  await sleep(1400);
  var approveSel = await waitForAny(['[id^="dApprove-"]'], 12000);
  if (approveSel) { await scrollTo(approveSel); await tap(approveSel, { wait: 3200 }); }
  await caption('اعتُمدت — وأنشأت تسليماً للمحصّل');
  await sleep(1600);
  await caption('');

  await say('المحصّل يستلم ثم يودع', 'يرى المبلغ ومصدره بالتفصيل، يؤكّد ما استلمه فعلاً، ثم يودعه في البنك بمرجع وقسيمة.');
  await signInAs('collector');
  await go('التسليمات');
  await caption('التسليمات بانتظاره');
  await sleep(3000);
  await scrollBy(260);
  await point('يرى التفصيل: نقدي، تحصيلات، مصروفات، موازنات', 1200);
  await sleep(800);
  if (await tapText('تأكيد الاستلام', { wait: 3000 })) await caption('أكّد الاستلام بالمبلغ الذي وصله فعلاً');
  await sleep(1800);
  await scrollBy(260);
  if (await waitFor('#hDeposit', 12000)) {
    await scrollTo('#hDeposit');
    await point('يسجّل الإيداع بمرجع بنكي وصورة القسيمة', 1000);
    await tap('#hDeposit', { wait: 3000 });
    await caption('أُودعت في البنك — واكتملت الدورة');
  }
  await sleep(1800);
  await caption('');

  // ------------------------------------------------------------- 7. the admin
  await chapter('6', 'لوحات الأدمن والتقارير');
  await progress(92, 'الخلاصة', 'الأدمن يرى كل شيء');
  await say('وأخيراً: ماذا يرى الأدمن؟', 'نفس الأرقام مجمّعة على مستوى الشركة، وكل رقم يفتح المعاملات التي تكوّن منها.');
  await signInAs('admin');
  await go('لوحة التحكم');
  await caption('لوحة التحكم — على مستوى الشركة كاملة');
  await sleep(3200);
  await scrollBy(300);
  await point('<b>ملخص المبيعات</b> شامل الضريبة', 900);
  await scrollBy(320);
  await point('<b>ملخص التحصيل</b>: نقدي + تحصيلات − توصيل − مصروفات − مودع', 1300);
  await scrollBy(300);
  await point('<b>أين النقدية الآن؟</b> — مع من بالضبط', 1800);
  await caption('كل رقم قابل للضغط');
  await sleep(1200);
  // every figure opens the transactions behind it, and每 transaction opens
  // its own document — show that, don't just claim it
  var rowSel = await appFrame.evaluate(function () {
    var row = document.querySelectorAll('.st-row.click')[0];
    if (!row) return null;
    row.setAttribute('data-rec', 'metric');
    return '[data-rec="metric"]';
  });
  if (rowSel) {
    await scrollTo(rowSel);
    await tap(rowSel, { wait: 2600 });
    await caption('المعاملات التي كوّنت هذا الرقم');
    await sleep(2600);
    var txSel = await appFrame.evaluate(function () {
      var tx = document.querySelectorAll('.dr .tx')[0];
      if (!tx) return null;
      tx.setAttribute('data-rec', 'tx');
      return '[data-rec="tx"]';
    });
    if (txSel) {
      await tap(txSel, { wait: 2600 });
      await caption('ومنها إلى مستند المعاملة نفسه');
      await sleep(3000);
    }
    await caption('');
  }
  await say('تمّت الدورة كاملة', 'من إدخال مدير المنطقة، إلى الاعتماد، إلى استلام المحصّل وإيداعه، إلى لوحات الأدمن — بنفس المعادلة في كل شاشة.');
  await point('صافي ما سُلّم من الإدخال اليدوي <span class="fig">' + money(NET) + '</span>', 900);
  await point('والموازنة <span class="fig">' + money(MOAZANA) + '</span> ظهرت إيداعاً بنكياً', 900);
  await point('والتسوية البنكية تطابقها مع كشف البنك', 1200);
  await progress(100, 'انتهى', 'الناقل الأفضل للغاز');
  await sleep(4200);
}

main().catch(function (e) { console.error(e); process.exit(1); });
