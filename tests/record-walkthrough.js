/**
 * Records the guideline video of the real app: one branch day travelling the
 * whole chain — branch manager → area manager → Deputy Operations Manager →
 * collector → bank — then the lock it ends in, then what the admin sees. At
 * phone width, with the narration in its own column beside the phone so it
 * never covers the app.
 *
 * Needs the mock backend running fresh (tests/mock-backend-server.js on
 * :8905) and puppeteer + ffmpeg-static available. Not part of the shipped
 * system.
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

var ENCODE_ONLY = process.argv[2] === '--encode-only';
var frameDir = path.join(OUT, 'frames');
if (!ENCODE_ONLY) {
  fs.rmSync(frameDir, { recursive: true, force: true });
  fs.mkdirSync(frameDir, { recursive: true });
}

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
function getText(url) {
  return new Promise(function (resolve, reject) {
    http.get(url, function (res) { var d = ''; res.on('data', function (c) { d += c; }); res.on('end', function () { resolve(d); }); }).on('error', reject);
  });
}

// The day this film follows: three products sold for cash, two delivery
// lines paid to the bank, one credit sale, cylinder insurance collected, fuel
// paid out of the till, and part of the cash banked on the spot (الموازنة).
var PRODUCTS = [
  { name: 'أسطوانة غاز 12.5 كجم', price: 45, locked: true, qty: 40 },
  { name: 'أسطوانة غاز 25 كجم', price: 85, locked: true, qty: 20 },
  { name: 'غاز سائب — لتر', price: 3.5, locked: false, qty: 300 }
];
var DELIVERIES = [[345, 'توصيل 3 طلبات — حي الملقا'], [230, 'توصيل طلبين — حي الياسمين']];
var CREDIT = 900, CREDIT_CUSTOMER = 'مطعم النخيل';
var INSURANCE = 1200, EXPENSE = 350, MOAZANA = 3000;
var VAT_RATE = 0.15;
var CASH_TOTAL = PRODUCTS.reduce(function (s, p) { return s + p.price * p.qty; }, 0);   // 4,550
var DELIVERY = DELIVERIES.reduce(function (s, d) { return s + d[0]; }, 0);                // 575
var VAT_BACK = DELIVERY / (1 + VAT_RATE) * VAT_RATE;                                     // 75
var NET = CASH_TOTAL + INSURANCE - DELIVERY + VAT_BACK - EXPENSE - CREDIT - MOAZANA;      // 1,000
function money(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

var seeded = {};
async function seed() {
  var admin = await api({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' });
  var tok = admin.token;
  async function call(p) { p.token = tok; var r = await api(p); if (r.token) tok = r.token; return r; }

  seeded.products = [];
  for (var i = 0; i < PRODUCTS.length; i++) {
    var p = PRODUCTS[i];
    var r = await call({ action: 'adminSaveEntity', kind: 'product', data: { name: p.name, type: 'goods', unitPrice: p.price, priceLocked: p.locked, active: true } });
    seeded.products.push(Object.assign({ id: r.entity.id }, p));
  }
  seeded.incomeItem = (await call({ action: 'adminSaveEntity', kind: 'income_item', data: { name: 'تأمين أسطوانات', active: true } })).entity;
  await call({ action: 'adminSaveEntity', kind: 'income_item', data: { name: 'تحصيل مبيعات آجلة', active: true } });
  seeded.expenseItem = (await call({ action: 'adminSaveEntity', kind: 'expense_item', data: { name: 'وقود سيارة التوصيل', active: true } })).entity;
  await call({ action: 'adminSaveEntity', kind: 'expense_item', data: { name: 'صيانة بسيطة', active: true } });

  // the Olaya branch manager was invited by the mock seed; accept his
  // invitation the way he would, from the link in his email
  var mail = await getText(BASE + '/__mail?to=olaya.bm@bestgas.sa');
  var m = /[?&]invite=([A-Za-z0-9]+)/.exec(mail);
  if (m) await api({ action: 'acceptInvite', inviteToken: m[1], password: 'Welcome#1' });

  var meta = await call({ action: 'listMeta' });
  seeded.meta = meta;
  seeded.cluster = meta.clusters.filter(function (c) { return c.name.indexOf('North') >= 0; })[0];
  seeded.branch = meta.locations.filter(function (l) { return l.name === 'Olaya'; })[0];
  seeded.store = meta.stores.filter(function (s) { return s.locationId === seeded.branch.id; })[0];
  seeded.tokens = {};
  var people = [['branch', 'olaya.bm@bestgas.sa'], ['area', 'muzafer@bestgas.sa'], ['deputy', 'ahmed@bestgas.sa'], ['collector', 'mazen@bestgas.sa']];
  for (var w = 0; w < people.length; w++) {
    var lg = await api({ action: 'login', email: people[w][1], password: 'Welcome#1' });
    if (!lg.ok) throw new Error('cannot sign in ' + people[w][1] + ': ' + lg.error);
    seeded.tokens[people[w][0]] = { token: lg.token, name: lg.user.name, email: people[w][1] };
  }
  seeded.tokens.admin = { token: tok, name: 'Admin', email: 'admin@bestgas.sa' };
  return seeded;
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

async function say(title, body, hold) {
  await page.evaluate(function (a) { window.stage.say(a.t, a.b); }, { t: title, b: body || '' });
  await sleep(hold != null ? hold : 4600);
}
async function point(html, wait) { await page.evaluate(function (h) { window.stage.point(h); }, html); await sleep(wait || 2600); }
async function chapter(n, name) { await page.evaluate(function (a) { window.stage.chapter(a.n, a.name); }, { n: n, name: name }); }
async function progress(pct, left, right) { await page.evaluate(function (a) { window.stage.progress(a.p, a.l, a.r); }, { p: pct, l: left, r: right }); }
async function caption(text) { await page.evaluate(function (t) { window.stage.caption(t); }, text || ''); }
// A hidden native select is drawn as the designed dropdown button next to
// it, so the ring goes around that.
async function rectOf(sel) {
  return appFrame.evaluate(function (s) {
    var el = document.querySelector(s); if (!el) return null;
    if (el.tagName === 'SELECT' && el._dd) el = el._dd;
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel).catch(function () { return null; });
}
async function ring(sel) {
  if (!sel) { await page.evaluate(function () { window.stage.ring(null); }); return null; }
  var rect = await rectOf(sel);
  await page.evaluate(function (r) { window.stage.ring(r); }, rect);
  return rect;
}
async function tap(sel, opts) {
  opts = opts || {};
  var rect = await ring(sel);
  if (!rect) { console.log('  ! missing: ' + sel); return false; }
  await page.evaluate(function (r) { window.stage.tapAt(r.x + r.width / 2, r.y + r.height / 2); }, rect);
  await sleep(450);
  await appFrame.evaluate(function (s) { var el = document.querySelector(s); if (el) el.click(); }, sel);
  await sleep(opts.wait != null ? opts.wait : 1600);
  if (!opts.keepRing) await ring(null);
  return true;
}
// tag the nth element matching a selector, so later steps can address it
async function tag(sel, index, name) {
  return appFrame.evaluate(function (a) {
    var el = document.querySelectorAll(a.s)[a.i];
    if (!el) return null;
    el.setAttribute('data-rec', a.n);
    return '[data-rec="' + a.n + '"]';
  }, { s: sel, i: index || 0, n: name });
}
async function tapText(text, opts) {
  var sel = await appFrame.evaluate(function (t) {
    [].slice.call(document.querySelectorAll('[data-rec="target"]')).forEach(function (e) { e.removeAttribute('data-rec'); });
    var all = [].slice.call(document.querySelectorAll('button, .sb-item, .bt-scroll button, a'));
    var el = all.filter(function (e) { return e.textContent.trim().indexOf(t) >= 0 && e.offsetParent !== null; })[0]
      || all.filter(function (e) { return e.textContent.trim().indexOf(t) >= 0; })[0];
    if (!el) return null;
    el.setAttribute('data-rec', 'target');
    return '[data-rec="target"]';
  }, text);
  if (!sel) { console.log('  ! no button: ' + text); return false; }
  var ok = await tap(sel, opts);
  await appFrame.evaluate(function () { var e = document.querySelector('[data-rec="target"]'); if (e) e.removeAttribute('data-rec'); }).catch(function () {});
  return ok;
}
async function typeIn(sel, value, opts) {
  opts = opts || {};
  await ring(sel);
  await appFrame.evaluate(function (s) { var e = document.querySelector(s); if (e) { e.focus(); e.value = ''; } }, sel);
  await appFrame.type(sel, String(value), { delay: opts.delay || 90 });
  await appFrame.evaluate(function (s) {
    var e = document.querySelector(s); if (!e) return;
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('blur', { bubbles: true }));
    e.blur();
  }, sel);
  await sleep(opts.wait != null ? opts.wait : 1000);
  if (!opts.keepRing) await ring(null);
}
// Picks through the designed dropdown the way a person would: open it (a
// bottom sheet on a phone), then tap the option.
async function pick(sel, value, opts) {
  opts = opts || {};
  var btnSel = await appFrame.evaluate(function (a) {
    var s = document.querySelector(a.s); if (!s || !s._dd) return null;
    s._dd.setAttribute('data-rec', 'ddbtn');
    return '[data-rec="ddbtn"]';
  }, { s: sel });
  if (!btnSel) { await appFrame.select(sel, String(value)); await sleep(800); return; }
  await tap(btnSel, { wait: 1300 });
  var optSel = await appFrame.evaluate(function (a) {
    var s = document.querySelector(a.s);
    var idx = [].slice.call(s.options).findIndex(function (o) { return o.value === a.v; });
    var li = document.querySelector('.dd-layer .dd-opt[data-i="' + idx + '"]');
    if (!li) return null;
    li.setAttribute('data-rec', 'ddopt');
    return '[data-rec="ddopt"]';
  }, { s: sel, v: String(value) });
  if (optSel) await tap(optSel, { wait: opts.wait != null ? opts.wait : 1100 });
  else { await appFrame.select(sel, String(value)); await sleep(600); }
  await appFrame.evaluate(function () {
    [].slice.call(document.querySelectorAll('[data-rec="ddbtn"],[data-rec="ddopt"]')).forEach(function (e) { e.removeAttribute('data-rec'); });
  }).catch(function () {});
}
async function scrollTo(sel, block) {
  await appFrame.evaluate(function (a) {
    var e = document.querySelector(a.s); if (e && e._dd) e = e._dd;
    if (e) e.scrollIntoView({ block: a.b || 'center', behavior: 'smooth' });
  }, { s: sel, b: block });
  await sleep(1600);
}
async function scrollBy(px) {
  await appFrame.evaluate(function (p) { window.scrollBy({ top: p, behavior: 'smooth' }); }, px);
  await sleep(1900);
}
async function scrollTop() {
  await appFrame.evaluate(function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  await sleep(1200);
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
  await sleep(2800);
  appFrame = page.frames().filter(function (f) { return f.url().indexOf(BASE) === 0 && f !== page.mainFrame(); })[0];
  await sleep(700);
}
async function go(screenText) { return tapText(screenText, { wait: 2200 }); }
async function showLogin() {
  await page.evaluate(function (base) {
    try { localStorage.clear(); localStorage.setItem('bgc_apiUrl', base + '/api'); localStorage.setItem('bgc_lang', 'ar'); } catch (e) {}
    document.getElementById('app').src = '/?signin=' + Date.now();
  }, BASE);
  await sleep(2400);
  appFrame = page.frames().filter(function (fr) { return fr.url().indexOf(BASE) === 0 && fr !== page.mainFrame(); })[0];
  await sleep(400);
}
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
async function tapTab(text) {
  var sel = await appFrame.evaluate(function (t) {
    var b = [].slice.call(document.querySelectorAll('.tabs button')).filter(function (x) { return x.textContent.trim().indexOf(t) === 0; })[0];
    if (!b) return null; b.setAttribute('data-rec', 'tab'); return '[data-rec="tab"]';
  }, text);
  if (sel) { await scrollTo(sel); await tap(sel, { wait: 1800 }); }
  await appFrame.evaluate(function () { var e = document.querySelector('[data-rec="tab"]'); if (e) e.removeAttribute('data-rec'); }).catch(function () {});
}

// ------------------------------------------------------------------ the film
async function main() {
  console.log('seeding…');
  await seed();
  console.log('seeded; branch ' + seeded.branch.name + ', area ' + seeded.cluster.name);

  var browser = await puppeteer.launch({
    headless: 'new',
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1.5 },
    args: ['--force-device-scale-factor=1.5','--hide-scrollbars','--lang=ar','--no-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });
  page = await browser.newPage();
  // the app asks "are you sure?" before approving; the film says yes
  page.on('dialog', function (d) { d.accept(d.type() === 'prompt' ? '' : undefined).catch(function () {}); });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1.5 });
  await page.goto(BASE + '/tests/stage.html', { waitUntil: 'networkidle0' });
  var logo = await page.evaluate(async function (base) {
    var html = await fetch(base + '/index.html').then(function (r) { return r.text(); });
    var m = /<link rel="icon" type="image\/png" href="(data:image\/png;base64,[^"]+)"/.exec(html);
    return m ? m[1] : '';
  }, BASE);
  if (logo) await page.evaluate(function (l) { window.stage.setLogo(l); }, logo);

  var stop = startRecording(page);
  try { await film(); }
  catch (e) { console.log('FILM ERROR: ' + (e && e.stack || e)); }
  stop();
  await sleep(400);
  await browser.close();

  console.log('frames: ' + shots);
  var out = path.join(OUT, 'دليل-نظام-تحصيل-النقدية.mp4');
  await encode(frameDir, out);
}

// Screenshots at this size land slower than the timer asks for, so a fixed
// frame rate would play the film fast. Each frame is held for as long as it
// was actually on screen, read from the file's own write time.
async function encode(dir, out) {
  var files = fs.readdirSync(dir).filter(function (f) { return /\.jpg$/.test(f); }).sort();
  var times = files.map(function (f) { return fs.statSync(path.join(dir, f)).mtimeMs; });
  var list = [];
  for (var i = 0; i < files.length; i++) {
    var dur = i + 1 < files.length ? (times[i + 1] - times[i]) / 1000 : 2;
    dur = Math.max(0.04, Math.min(dur, 3));
    list.push("file '" + path.join(dir, files[i]).replace(/\\/g, '/') + "'", 'duration ' + dur.toFixed(3));
  }
  list.push("file '" + path.join(dir, files[files.length - 1]).replace(/\\/g, '/') + "'");
  var listFile = path.join(path.dirname(dir), 'frames.txt');
  fs.writeFileSync(listFile, list.join('\n'));
  await new Promise(function (resolve, reject) {
    execFile(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25', '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
      { maxBuffer: 64 * 1024 * 1024 },
      function (err, so, se) { if (err) reject(new Error(se || err.message)); else resolve(); });
  });
  var secs = (times[times.length - 1] - times[0]) / 1000 + 2;
  console.log('video: ' + out + ' (' + (fs.statSync(out).size / 1048576).toFixed(1) + ' MB, ' + Math.round(secs) + 's)');
}
if (process.argv[2] === '--encode-only') {
  // re-encode an existing frames folder: node tests/record-walkthrough.js --encode-only <outDir>
  var dirArg = process.argv[3];
  encode(path.join(dirArg, 'frames'), path.join(dirArg, 'دليل-نظام-تحصيل-النقدية.mp4')).then(function () { process.exit(0); });
}

async function film() {
  var TOTAL = 'من ٧';

  // ------------------------------------------------------------ 1. opening
  await chapter('1', 'مقدمة');
  await progress(2, 'الفصل ١ ' + TOTAL, 'دورة يوم كامل');
  await say('دليل نظام تحصيل النقدية والموافقات', 'نتابع يوماً واحداً لفرع العليا من أول إدخال حتى الإيداع في البنك — وكل من يلمس النقدية في الطريق.', 5200);
  await point('<b>مدير الفرع</b> يُدخل اليوم ويسلّم', 1400);
  await point('<b>مدير المنطقة</b> يستلم ويرسل الطلب', 1400);
  await point('<b>نائب مدير العمليات</b> يتحقق ويعتمد', 1400);
  await point('<b>المُحصّل</b> يستلم ويودع في البنك', 1400);
  await point('<b>الأدمن</b> يرى كل شيء — ولا يعدّل ما اعتُمد', 2200);
  await showLogin();
  await say('الدخول', 'كل مستخدم يدخل ببريده وكلمة المرور التي اختارها بنفسه من رابط الدعوة.', 2600);
  await caption('شاشة الدخول');
  await ring('#loginEmail'); await sleep(1500);
  await ring('#loginPw'); await sleep(1500); await ring(null);
  await caption('');

  // -------------------------------------------------- 2. the branch's day
  await chapter('2', 'مدير الفرع — إدخال اليوم');
  await progress(10, 'الفصل ٢ ' + TOTAL, 'إدخال يوم كامل');
  await signInAs('branch');
  await say('مدير فرع العليا يُدخل يومه', 'الشاشة مقسّمة إلى أقسام، كل قسم يُفتح عند الحاجة ويُغلق بزر تأكيد — فلا يضيع رقم.');
  await go('الإدخالات');
  await caption('شاشة الإدخالات');
  await sleep(1400);
  await point('التاريخ لا يقبل يوماً مستقبلياً، والمصدر والفرع يظهران تلقائياً', 2200);
  await ring('#eSource'); await sleep(1600); await ring(null);
  await point('طريقة الإدخال الافتراضية: <b>حسب المنتج</b> (كمية × سعر)', 2000);
  await tap('#eConfirmBasic', { wait: 1800 });
  await caption('تأكيد المصدر والتاريخ — يُطوى في سطر واحد');
  await sleep(1400);

  await say('المبيعات: ثلاثة منتجات', 'السعر يأتي من البيانات الأساسية. المنتج ذو السعر الثابت لا يمكن تعديل سعره عند الإدخال.');
  for (var i = 0; i < seeded.products.length; i++) {
    var p = seeded.products[i];
    if (i > 0) await tap('#eAddLine', { wait: 900 });
    var base = await tag('.eLine', i, 'line' + i);
    await scrollTo(base + ' .lnProduct');
    await pick(base + ' .lnProduct', p.id);
    await typeIn(base + ' .lnQty', p.qty, { delay: 95, wait: 700 });
    await caption(p.name + ' — ' + p.qty + ' × ' + money(p.price) + ' = ' + money(p.qty * p.price));
    if (i === 0) {
      await point('<b>طريقة الدفع</b>: نقدي أو نقاط بيع فقط — الآجل والتوصيل أقسام مستقلة', 2400);
      await ring(base + ' .lnPayment'); await sleep(1400); await ring(null);
    }
    await sleep(1800);
  }
  await caption('المبيعات النقدية ' + money(CASH_TOTAL));
  await scrollTo('#eConfirmLines');
  await tap('#eConfirmLines', { wait: 2000 });
  await caption('');

  await say('رسوم التوصيل — بنود مستقلة', 'تُدفع للبنك ولا تبقى نقداً بيد الفرع: تُخصم قبل الضريبة، وضريبتها تُسترد.');
  await scrollTo('#eDeliveryWrap');
  await tap('#eDeliveryWrap .me-toggle', { wait: 1100 });
  for (var d = 0; d < DELIVERIES.length; d++) {
    if (d > 0) await tap('#eDeliveryAdd', { wait: 900 });
    var dl = await tag('#eDeliveryLines .mline', d, 'dl' + d);
    await scrollTo(dl);
    await typeIn(dl + ' .mlAmount', DELIVERIES[d][0], { delay: 95 });
    await typeIn(dl + ' .mlReason', DELIVERIES[d][1], { delay: 32 });
  }
  await point('رأس القسم يعرض <b>عدد البنود والإجمالي</b> مباشرة', 2000);
  await scrollTo('#eDeliveryWrap .me-confirm');
  await tap('#eDeliveryWrap .me-confirm', { wait: 1800 });

  await say('المبيعات الآجلة', 'ضمن المبيعات لكنها لم تُستلم نقداً — فتُخصم. واسم العميل إلزامي حتى يمكن متابعة المبلغ.');
  await scrollTo('#eCreditWrap');
  await tap('#eCreditWrap .me-toggle', { wait: 1100 });
  var cl = await tag('#eCreditLines .mline', 0, 'cl0');
  await typeIn(cl + ' .mlAmount', CREDIT, { delay: 95 });
  await typeIn(cl + ' .mlReason', CREDIT_CUSTOMER, { delay: 45 });
  await tap('#eCreditWrap .me-confirm', { wait: 1800 });

  await say('نقدية ليست مبيعات', 'ما استُلم لسبب آخر يُضاف، وما صُرف من الصندوق يُخصم — ولكل بند سبب مكتوب.');
  await scrollTo('#eOtherWrap');
  await tap('#eOtherWrap .me-toggle', { wait: 1100 });
  var ol = await tag('#eOtherLines .mline', 0, 'ol0');
  await typeIn(ol + ' .mlAmount', INSURANCE, { delay: 95 });
  await pick(ol + ' .mlItem', seeded.incomeItem.id);
  await typeIn(ol + ' .mlReason', 'تأمين مسترد على 24 أسطوانة', { delay: 32 });
  await tap('#eOtherWrap .me-confirm', { wait: 1600 });
  await scrollTo('#eExpenseWrap');
  await tap('#eExpenseWrap .me-toggle', { wait: 1100 });
  var xl = await tag('#eExpenseLines .mline', 0, 'xl0');
  await typeIn(xl + ' .mlAmount', EXPENSE, { delay: 95 });
  await pick(xl + ' .mlItem', seeded.expenseItem.id);
  await typeIn(xl + ' .mlReason', 'تعبئة وقود سيارة التوصيل', { delay: 32 });
  await tap('#eExpenseWrap .me-confirm', { wait: 1600 });

  await say('الموازنات', 'جزء من النقدية أودعه مدير الفرع في البنك بنفسه قبل التسليم — بمرجع بنكي وبيان.');
  await scrollTo('#eDepositWrap');
  await tap('#eDepositWrap .me-toggle', { wait: 1100 });
  await typeIn('#eDeposit', MOAZANA, { delay: 95 });
  await typeIn('#eDepositRef', 'MZN-OLY-0925', { delay: 40 });
  await typeIn('#eDepositNote', 'موازنة مبيعات نصف اليوم', { delay: 32 });
  await tap('#eDepositWrap .me-confirm', { wait: 1600 });

  await say('المعادلة أمامه قبل الحفظ', 'نفس المعادلة التي سيراها كل من يستلم هذه النقدية بعده.');
  await scrollTo('#eNetPreview', 'start');
  await ring('#eNetPreview');
  await sleep(2400);
  await point(money(CASH_TOTAL) + ' نقدي <b>+</b> ' + money(INSURANCE) + ' تأمين', 2000);
  await point('<b>−</b> ' + money(DELIVERY) + ' توصيل <b>+</b> ' + money(VAT_BACK) + ' ضريبته المستردة', 2000);
  await point('<b>−</b> ' + money(CREDIT) + ' آجل <b>−</b> ' + money(EXPENSE) + ' وقود <b>−</b> ' + money(MOAZANA) + ' موازنة', 2000);
  await point('<b>= ' + money(NET) + '</b> صافي النقدية الواجب تسليمها', 2600);
  await ring(null);
  await scrollTo('#eSubmit');
  await tap('#eSubmit', { wait: 3000 });
  await caption('تم الحفظ — والموازنة سُجّلت إيداعاً بنكياً تلقائياً');
  await sleep(1600);

  await say('الإدخال في القائمة', 'بطاقة واحدة لليوم: المصدر، من أدخل، المبيعات، الخصومات، الصافي، والحالة.');
  if (await waitFor('.el-row', 8000)) {
    await scrollTo('.el-row', 'start');
    await ring('.el-row'); await sleep(2200); await ring(null);
    await tap('.el-row .el-more', { wait: 1800 });
    await scrollBy(260);
    await point('<b>مفتوح</b>: يستطيع مدير الفرع إلغاءه بسبب مكتوب — قبل التسليم فقط', 2800);
    await point('بعد التسليم يُقفل، ولا يعدّله أحد — ولا مدير النظام', 2600);
  }
  await caption('');

  await say('التسليم لمدير المنطقة', 'بضغطة واحدة تُجمع نقدية اليوم وتُرسل لمدير المنطقة ليؤكد استلامها.');
  await go('التسليمات');
  await sleep(1200);
  if (await waitFor('#hCreateLoc', 8000)) {
    await scrollTo('#hCreateLoc');
    await tap('#hCreateLoc', { wait: 2600 });
    await caption('أُرسل التسليم — بانتظار تأكيد مدير المنطقة');
    await sleep(2200);
  }
  await caption('');

  // -------------------------------------------------- 3. the area manager
  await chapter('3', 'مدير المنطقة');
  await progress(38, 'الفصل ٣ ' + TOTAL, 'يستلم ثم يرسل الطلب');
  await signInAs('area');
  await say('مدير المنطقة يعرف منطقته', 'الشاشة الرئيسية تعرض منطقته، ومُحصّلها، وفروعها، ومدير كل فرع وسائقيه وأجهزته.');
  await caption('الرئيسية — منطقتي');
  if (await waitFor('.org', 8000)) { await scrollTo('.org', 'start'); await sleep(2400); await scrollBy(300); await sleep(1600); }
  await caption('');
  await say('يؤكد ما استلمه فعلاً', 'يرى تفصيل المبلغ، ويكتب ما وصله فعلاً — وأي عجز يُسجَّل ويُصعَّد تلقائياً.');
  await go('التسليمات');
  await sleep(1200);
  await point('لا يؤكد الاستلام إلا <b>المستلم نفسه</b> — لا أحد نيابةً عنه', 2400);
  if (await waitFor('#hRecvAmt', 8000)) {
    await scrollTo('#hRecvAmt');
    await ring('#hRecvAmt'); await sleep(1800); await ring(null);
    await tapText('تأكيد الاستلام', { wait: 2800 });
  }
  await say('ثم يرسل طلب التسليم', 'الطلب لا يذهب للمُحصّل مباشرة: يمر أولاً بنائب مدير العمليات ليتحقق منه.');
  if (await waitFor('.ac-card', 8000)) {
    await scrollTo('.ac-card', 'start');
    await ring('.ac-steps'); await sleep(3200); await ring(null);
    await point('<b>١</b> أنت ترسل <b>٢</b> النائب يتحقق <b>٣</b> المُحصّل يؤكد', 2400);
    await ring('.ac-ready'); await sleep(1800); await ring(null);
    await tap('#hCreateClu', { wait: 2800 });
    await caption('أُرسل الطلب لنائب مدير العمليات');
    await sleep(2200);
  }
  await caption('');

  // -------------------------------------------------------- 4. the deputy
  await chapter('4', 'نائب مدير العمليات');
  await progress(55, 'الفصل ٤ ' + TOTAL, 'التحقق والاعتماد');
  await signInAs('deputy');
  await say('نائب مدير العمليات يتحقق', 'يرى كل الفروع وكل التسليمات ولوحات الشركة وفلاترها — دون صلاحية الإعدادات أو الإدخال.');
  await go('اعتمادات نائب مدير العمليات');
  await sleep(1200);
  if (await waitFor('.dpList .list-item', 8000)) {
    await scrollTo('.dpList .list-item', 'start');
    await caption('طلب مدير المنطقة بانتظار تحققه');
    await sleep(2200);
    await point('يعتمده، أو <b>يعيده لمدير المنطقة</b> مع سبب مكتوب للتصحيح', 2600);
    await point('ولا يتحقق من الطلب أحد أطرافه', 2000);
    await tapText('تحقق واعتماد', { wait: 3000 });
    await caption('اعتُمد — ووصل الطلب للمُحصّل الآن');
    await sleep(2200);
  }
  await caption('');

  // ----------------------------------------------------- 5. the collector
  await chapter('5', 'المُحصّل');
  await progress(68, 'الفصل ٥ ' + TOTAL, 'الاستلام والإيداع');
  await signInAs('collector');
  await say('المُحصّل يستلم ثم يودع', 'يرى من اعتمد الطلب، يؤكد المبلغ الذي وصله، ثم يسجل الإيداع البنكي بمرجعه.');
  await go('التسليمات');
  await sleep(1400);
  if (await waitFor('#hRecvAmt', 8000)) {
    await scrollTo('#hRecvAmt');
    await tapText('تأكيد الاستلام', { wait: 3000 });
  }
  if (await waitFor('#hBankRef', 8000)) {
    await scrollTo('#hBankRef');
    await typeIn('#hBankRef', 'SNB-2026-0925-118', { delay: 45 });
    await tap('#hDeposit', { wait: 3000 });
    await caption('أُودع في البنك — اكتملت الدورة');
    await sleep(2200);
  }
  await caption('');

  // ------------------------------------------------------------ 6. the lock
  await chapter('6', 'القفل بعد الاعتماد');
  await progress(80, 'الفصل ٦ ' + TOTAL, 'لا تعديل بعد الاعتماد');
  await signInAs('branch');
  await say('ماذا يرى مدير الفرع الآن؟', 'الإدخال نفسه أصبح «معتمد» ومقفلاً نهائياً — لا زر إلغاء، ولا يعدّله أحد.');
  await go('الإدخالات');
  if (await waitFor('.el-row', 8000)) {
    await scrollTo('.el-row', 'start');
    await ring('.el-row .el-badge'); await sleep(2200); await ring(null);
    await tap('.el-row .el-more', { wait: 1800 });
    await scrollBy(240);
    await point('أي خطأ بعد الاعتماد يُصحَّح بحركة جديدة موثّقة — لا بتعديل القديم', 2800);
    await point('ولا يُقبل إدخال جديد بتاريخ يوم سُلِّم بالفعل', 2400);
  }

  // ------------------------------------------------------------ 7. the admin
  await chapter('7', 'الأدمن');
  await progress(90, 'الفصل ٧ ' + TOTAL, 'الرقابة الكاملة');
  await signInAs('admin');
  await say('الأدمن يرى الشركة كاملة', 'نفس المعادلة مجمّعة على مستوى الشركة، وكل رقم يفتح المعاملات التي كوّنته.');
  await go('لوحة التحكم');
  await caption('لوحة التحكم');
  await sleep(2600);
  await scrollBy(340); await sleep(900);
  await scrollBy(340); await sleep(900);
  await caption('');
  await say('فلاتر التقارير', 'طريقة الدفع (نقدي / نقاط بيع) منفصلة عن نوع الحركة (آجل، توصيل، تحصيلات، مصروفات، موازنات).');
  await go('تقرير المبيعات');
  await sleep(1200);
  await tap('#rFilterToggle', { wait: 1400 });
  await scrollTo('#rPayment');
  await ring('#rPayment'); await sleep(1600);
  await ring('#rMovement'); await sleep(1800); await ring(null);
  await pick('#rMovement', 'credit');
  await scrollTo('#rRun');
  await tap('#rRun', { wait: 2600 });
  await caption('النتيجة: المبيعات الآجلة فقط');
  await sleep(1800);
  await caption('');

  await say('ملف لكل سجل', 'كل فرع ومتجر وسيارة وجهاز ومستخدم له ملف: بياناته، وما يرتبط به، ونشاطه، وسجل تعديلاته.');
  await go('الإدارة');
  await tapTab('الفروع');
  var row = await appFrame.evaluate(function () {
    var r = [].slice.call(document.querySelectorAll('tr.pf-row')).filter(function (t) { return t.textContent.indexOf('Olaya') >= 0; })[0];
    if (!r) return null; r.setAttribute('data-rec', 'olaya'); return '[data-rec="olaya"]';
  });
  if (row) {
    await scrollTo(row);
    await tap(row, { wait: 2600 });
    await scrollBy(420); await sleep(800);
    await scrollBy(420); await sleep(800);
    await scrollBy(420); await sleep(1200);
  }
  await say('سلامة الربط', 'قائمة بكل حلقة ناقصة في دورة التحصيل — ولكل فجوة زر يفتح مكان معالجتها.');
  await tapTab('سلامة الربط');
  await sleep(2400);
  await say('مصفوفة الصلاحيات وقواعد الاعتماد', 'من يستطيع ماذا، ومتى يُقفل كل رقم — مكتوبة في النظام نفسه.');
  await tapTab('مصفوفة الصلاحيات');
  await sleep(1600);
  if (await waitFor('.rules-card', 6000)) {
    await scrollTo('.rules-card', 'start');
    await sleep(2400);
    await scrollBy(360); await sleep(1400);
    await scrollBy(360); await sleep(1400);
  }

  await say('الخلاصة', 'رقم واحد يسير في سلسلة واضحة، لكل خطوة صاحبها، ولا يعتمد أحد ما سلّمه بنفسه.');
  await point('صافي يوم فرع العليا <span class="fig">' + money(NET) + '</span> وصل البنك', 1900);
  await point('والموازنة <span class="fig">' + money(MOAZANA) + '</span> أُودعت مباشرة', 1900);
  await point('كل خطوة مسجّلة باسم فاعلها ووقتها', 1900);
  await progress(100, 'انتهى', 'الناقل الأفضل للغاز');
  await sleep(4600);
}

if (!ENCODE_ONLY) main().catch(function (e) { console.error(e); process.exit(1); });
