/**
 * Browser check of the welcome popup and the smart dashboards (2026-10-26), against
 * tests/mock-backend-server.js. Own headless Chrome over the DevTools Protocol (Node's own
 * WebSocket), never the shared browser pane. Screenshots go to .superpowers/magic/.
 *
 *   node tests/mock-backend-server.js 8928
 *   node tests/magic-check.cjs 8928 [--langs en,ar,ur] [--only welcome|screens] [--screens home,entries]
 *
 * Prints every console error and uncaught exception per page; exits 1 when there is any.
 * The mock's seeded sign-in is test-only.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.argv[2] || 8928);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LANGS = String(arg('--langs', 'en,ar,ur')).split(',');
const ONLY = arg('--only', '');
const SCREENS = String(arg('--screens', 'home,dashboard,entries,handoffs,collections,colReports,comparison,profit,customers,reconciliation,risk,report')).split(',');
const SIZES = String(arg('--sizes', 'phone,desk')).split(',');
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '.superpowers', 'magic');
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const CDP = 9367;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p) { return (await fetch(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })).json(); }
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else if (m.method) events.push(m); });
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  return { ws, events, send: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}
function errorsOf(events, from) {
  const out = [];
  events.slice(from).forEach(m => {
    if (m.method === 'Runtime.exceptionThrown') out.push('exception: ' + (m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text).split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') out.push('console.error: ' + m.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 200));
    // the app's GET warm-up ping to the API (index.html, fetch(state.apiUrl, {method:'GET'})) is a 404 on the mock,
    // which answers POST /api only; the live Apps Script answers doGet. Not an error of the page.
    const known404 = /status of 404/.test(m.params.entry && m.params.entry.text || '') && /\/api$/.test(m.params.entry && m.params.entry.url || '');
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !known404 && !/favicon|fonts\.g|net::ERR_/.test(m.params.entry.text + (m.params.entry.url || ''))) out.push('log: ' + m.params.entry.text.slice(0, 200) + ' ' + (m.params.entry.url || ''));
  });
  return out;
}
// downloads and the print window, caught and sent to the mock's POST /__save (as tests/export-reports.cjs)
const HOOKS = `(function(){
  if (window.__hooked) return; window.__hooked = true; window.__saved = [];
  window.__name = 'export';
  HTMLAnchorElement.prototype.click = function(){
    var href = this.href || '', file = window.__name + (/\\.xlsx$/i.test(this.download || '') ? '.xlsx' : '');
    if (href.indexOf('blob:') === 0) fetch(href).then(function(r){ return r.blob(); }).then(function(b){ return fetch('/__save?name=' + encodeURIComponent(file), { method: 'POST', body: b }); }).then(function(){ window.__saved.push(file); });
  };
  window.open = function(){
    var buf = '';
    return { document: { open: function(){}, write: function(h){ buf += h; }, close: function(){
      var page = buf.replace(/<script>document\\.fonts[\\s\\S]*?<\\/script>/, '');
      var file = window.__name + '.html';
      fetch('/__save?name=' + encodeURIComponent(file), { method: 'POST', body: new Blob([page], { type: 'text/html' }) }).then(function(){ window.__saved.push(file); });
    } } };
  };
  window.confirm = function(){ return true; };
})();`;
async function waitSaved(send, n, label) {
  for (let i = 0; i < 80; i++) { const c = await evaluate(send, 'window.__saved.length'); if (c >= n) return; await sleep(250); }
  throw new Error('nothing saved for ' + label);
}
// the page may reload itself once (checkBuild_ when the session flag was cleared): wait until the app runs
async function waitApp(send) {
  for (let i = 0; i < 60; i++) { try { if (await evaluate(send, "document.readyState === 'complete' && !!document.querySelector('#screenBody')")) return true; } catch (e) {} await sleep(250); }
  return false;
}
async function shot(send, file) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
}
async function size(send, s) {
  if (s === 'phone') await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  else await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
}
async function main() {
  if (!CHROME) throw new Error('No Chrome');
  // --seed: the North area manager sends his branches' cash to the collectors, the deputy validates, and the
  // collectors receive it, so Collections and its reports have money to show (the mock seeds none that far)
  if (process.argv.includes('--seed')) {
    const lg = async (e) => (await api({ action: 'login', email: e, password: 'Welcome#1' })).token;
    const mz = await lg('muzafer@bestgas.sa'), dp = await lg('ahmed@bestgas.sa');
    const meta = await api({ action: 'listMeta', token: mz });
    const me = (await api({ action: 'whoami', token: mz })).user || {};
    const area = (meta.clusters || []).find(c => c.clusterManagerUserId === me.id);
    const sent = await api({ action: 'createHandoff', token: mz, kind: 'cluster_to_collector', clusterId: area && area.id });
    const list = (sent.handoffs || (sent.handoff ? [sent.handoff] : []));
    for (const h of list) {
      const v = await api({ action: 'deputyValidateHandoff', token: dp, id: h.id });
      const coll = (meta.users || []).find(u => u.id === h.toUserId);
      if (coll && coll.email && v.ok) { const ct = await lg(coll.email); await api({ action: 'confirmHandoff', token: ct, id: h.id, receivedAmount: h.amount }); }
    }
    console.log('seeded ' + list.length + ' collection request(s)' + (sent.ok ? '' : ': ' + sent.error));
  }
  fs.mkdirSync(OUT, { recursive: true });
  const EMAIL = arg('--user', 'admin@bestgas.sa');
  const login = await api({ action: 'login', email: EMAIL, password: EMAIL === 'admin@bestgas.sa' ? 'Bootstrap#1' : 'Welcome#1' });
  if (!login.ok) throw new Error('mock sign-in failed: ' + login.error);
  const profile = path.join(os.tmpdir(), 'magic-chk-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const problems = [], report = [];
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find(t => t.type === 'page'); } catch { await sleep(250); } }
    const { ws, send, events } = await connect(target.webSocketDebuggerUrl);
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await size(send, 'desk');
    await send('Page.navigate', { url: BASE + '/' }); await sleep(1500);
    for (const lang of LANGS) {
      await api({ action: 'setLanguage', token: login.token, language: lang });
      for (const sz of SIZES) {
        await size(send, sz);
        // the welcome: a fresh sign-in (the session flag cleared), on Home
        if (!ONLY || ONLY === 'welcome') {
          const from = events.length;
          await evaluate(send, `localStorage.setItem('bgc_apiUrl', '${BASE}/api'); localStorage.setItem('bgc_token', ${JSON.stringify(login.token)}); localStorage.setItem('bgc_lang', '${lang}'); sessionStorage.clear(); sessionStorage.setItem('bgc_updTried', '1'); true`);
          await send('Page.reload'); await sleep(2500); await waitApp(send);
          if ((await evaluate(send, 'document.documentElement.lang')) !== lang) problems.push('welcome ' + lang + ' ' + sz + ': page opened in ' + (await evaluate(send, 'document.documentElement.lang')));
          await waitApp(send); await sleep(2500);
          const w = await evaluate(send, `(function(){ var o = document.querySelector('.wl-ov'); if (!o) return { shown: false, n: document.querySelectorAll('.pa-ov').length };
            var c = o.querySelector('.wl-card'), st = o.querySelector('.wl-stage'), r = c.getBoundingClientRect();
            return { shown: true, n: document.querySelectorAll('.pa-ov').length, title: o.querySelector('#wlTitle').textContent, line: o.querySelector('#wlLine').textContent,
              stageBg: getComputedStyle(st).backgroundColor, focus: document.activeElement && document.activeElement.className, w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
              rows: o.querySelectorAll('.wl-row').length, clear: !!o.querySelector('.wl-clear'), dir: document.documentElement.dir, font: getComputedStyle(o.querySelector('#wlTitle')).fontFamily.split(',')[0] }; })()`);
          await sleep(1300);
          await shot(send, `welcome-${lang}-${sz}.png`);
          report.push(`welcome ${lang} ${sz}: ${JSON.stringify(w)}`);
          if (!w.shown) problems.push(`welcome ${lang} ${sz}: not shown`);
          else {
            if (w.n !== 1) problems.push(`welcome ${lang} ${sz}: ${w.n} popups`);
            if (w.stageBg !== 'rgb(77, 109, 81)') problems.push(`welcome ${lang} ${sz}: stage is ${w.stageBg}`);
            if (w.w > w.vw || w.h > w.vh) problems.push(`welcome ${lang} ${sz}: card ${w.w}x${w.h} over the ${w.vw}x${w.vh} screen`);
            // keyboard: Tab stays inside, Esc closes, the bell opens the plain list
            const k = await evaluate(send, `(async function(){ var card = document.querySelector('.wl-card'); var out = [];
              for (var i = 0; i < 6; i++) { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); out.push(card.contains(document.activeElement)); }
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise(function(r){ setTimeout(r, 400); });
              var gone = !document.querySelector('.wl-ov');
              var bell = document.querySelector('#notifBell'); if (bell) bell.click(); await new Promise(function(r){ setTimeout(r, 500); });
              var plain = !!document.querySelector('.pa-ov:not(.wl-ov)') || !!document.querySelector('.act-sheet, .ms-act, [class*="act-"]');
              var wl = !!document.querySelector('.wl-ov');
              var bg = document.querySelector('.pa-ov .pa-bg'); if (bg) bg.click(); return { trapped: out.every(Boolean), escCloses: gone, bellPlain: plain && !wl }; })()`);
            report.push(`  keys: ${JSON.stringify(k)}`);
            if (!k.trapped || !k.escCloses || !k.bellPlain) problems.push(`welcome ${lang} ${sz}: keyboard ${JSON.stringify(k)}`);
          }
          errorsOf(events, from).forEach(e => problems.push(`welcome ${lang} ${sz}: ${e}`));
          // a reload in the same tab: no second welcome
          await send('Page.reload'); await sleep(1500); await waitApp(send); await sleep(1500);
          const again = await evaluate(send, `!!document.querySelector('.wl-ov')`);
          if (again) problems.push(`welcome ${lang} ${sz}: shown again after a reload`);
        }
        if (!ONLY || ONLY === 'screens') {
          await evaluate(send, `localStorage.setItem('bgc_apiUrl', '${BASE}/api'); localStorage.setItem('bgc_token', ${JSON.stringify(login.token)}); localStorage.setItem('bgc_lang', '${lang}'); sessionStorage.setItem('bgc_pendShown_' + ${JSON.stringify(login.user.id)}, '1'); sessionStorage.setItem('bgc_updTried', '1'); sessionStorage.setItem('bgc_col', JSON.stringify({ preset: '${process.env.SDP || 'lastMonth'}' })); sessionStorage.setItem('bgc_crp', JSON.stringify({ rep: 'summary', preset: '${process.env.SDP || 'lastMonth'}' })); true`);
          await send('Page.reload'); await sleep(1500); await waitApp(send); await sleep(1500);
          for (const scr of SCREENS) {
            const from = events.length;
            await evaluate(send, `(function(){ var bg = document.querySelector('.pa-ov .pa-bg'); if (bg) bg.click(); var b = document.querySelector('.sb-item[data-k="${scr}"]'); if (!b) return 'no nav'; b.click(); return true; })()`);
            await sleep(scr === 'comparison' || scr === 'profit' ? 4500 : 3000);
            if (scr === 'report') { await evaluate(send, `(function(){ var r = document.querySelector('#rRun'); if (r) r.click(); return true; })()`); await sleep(3500); }
            const info = await evaluate(send, `(function(){ var sd = document.querySelector('.card.sd'); var de = document.documentElement;
              return { sd: !!sd, kpis: sd ? sd.querySelectorAll('.sd-kpi').length : 0, charts: sd ? sd.querySelectorAll('.sd-chart').length : 0, ins: sd ? sd.querySelectorAll('.sd-in').length : 0,
                overflow: de.scrollWidth > de.clientWidth + 1 ? de.scrollWidth + '>' + de.clientWidth : '', err: (document.querySelector('#screenBody .msg.err') || {}).textContent || '' }; })()`);
            report.push(`${scr} ${lang} ${sz}: ${JSON.stringify(info)}`);
            if (!info.sd) problems.push(`${scr} ${lang} ${sz}: no dashboard`);
            if (info.overflow) problems.push(`${scr} ${lang} ${sz}: page scrolls sideways ${info.overflow}`);
            await evaluate(send, `window.scrollTo(0, 0); true`); await sleep(1300);
            await shot(send, `${scr}-${lang}-${sz}.png`);
            errorsOf(events, from).forEach(e => problems.push(`${scr} ${lang} ${sz}: ${e}`));
          }
        }
        // exports: each screen's first Excel and PDF button; the workbook is read back with ExcelJS: its first sheet
        // is the Dashboard and every figure on it is a figure of a totals line of the export, to the cent
        if (ONLY === 'exports' && sz === 'desk') {
          await evaluate(send, `localStorage.setItem('bgc_apiUrl', '${BASE}/api'); localStorage.setItem('bgc_token', ${JSON.stringify(login.token)}); localStorage.setItem('bgc_lang', '${lang}'); sessionStorage.setItem('bgc_pendShown_' + ${JSON.stringify(login.user.id)}, '1'); sessionStorage.setItem('bgc_updTried', '1'); sessionStorage.setItem('bgc_col', JSON.stringify({ preset: '${process.env.SDP || 'lastMonth'}' })); sessionStorage.setItem('bgc_crp', JSON.stringify({ rep: 'summary', preset: '${process.env.SDP || 'lastMonth'}' })); true`);
          await send('Page.reload'); await sleep(1500); await waitApp(send); await sleep(1500);
          await evaluate(send, HOOKS);
          let count = 0;
          for (const scr of String(arg('--ex', 'entries,handoffs,collections,colReports,comparison,report,profit')).split(',')) {
            const from = events.length, name = `magic-${lang}-${scr}`;
            await evaluate(send, `(function(){ var b = document.querySelector('.sb-item[data-k="${scr}"]'); if (b) b.click(); return true; })()`);
            await sleep(scr === 'comparison' || scr === 'profit' ? 5000 : 3500);
            if (scr === 'report') { await evaluate(send, `(function(){ var r = document.querySelector('#rRun'); if (r) r.click(); return true; })()`); await sleep(4000); }
            if (scr === 'entries') { await evaluate(send, `(function(){ var b = document.querySelector('.el-view [data-v="list"], .el-view button:last-child'); if (b) b.click(); return true; })()`); await sleep(1500); }
            const has = await evaluate(send, `window.__name = ${JSON.stringify(name)}; (function(){ var x = document.querySelector('#screenBody .rp-all') || document.querySelector('#screenBody .ex-xl') || document.querySelector('#screenBody .ex-bar .ex-btn'); if (!x) return false; x.click(); return true; })()`);
            if (!has) { problems.push(`${name}: no Excel button`); continue; }
            count++; try { await waitSaved(send, count, name + '.xlsx'); } catch (e) { problems.push(String(e.message)); continue; }
            const hasPdf = await evaluate(send, `(function(){ var x = document.querySelector('#screenBody .rp-all-pdf') || document.querySelector('#screenBody .ex-pdf') || document.querySelector('#screenBody .ex-bar .ex-btn:nth-child(2)'); if (!x) return false; x.click(); return true; })()`);
            if (hasPdf) { count++; try { await waitSaved(send, count, name + '.html'); } catch (e) { problems.push(String(e.message)); } }
            errorsOf(events, from).forEach(e => problems.push(`${name}: ${e}`));
            const chk = await evaluate(send, `(async function(){
              if (!window.ExcelJS) await new Promise(function(res, rej){ var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
              await new Promise(function(r){ setTimeout(r, 400); });
              var buf = await (await fetch('/.superpowers/exports/${name}.xlsx?_=' + Date.now())).arrayBuffer(), wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
              var ws0 = wb.worksheets[0], vals = [];
              ws0.eachRow(function(row, r){ row.eachCell(function(c){ if (typeof c.value === 'number' && c.numFmt) vals.push({ r: r, v: c.value }); }); });
              var nums = function(ws){ var o = []; ws.eachRow(function(row){ row.eachCell(function(c){ var v = c.value; if (v && typeof v === 'object' && 'result' in v) v = v.result; if (typeof v === 'number') o.push(v); }); }); return o; };
              var found = wb.worksheets.slice(1).filter(function(ws){ var n = nums(ws); return vals.every(function(x){ return n.some(function(y){ return Math.abs(y - x.v) < 0.005; }); }); }).map(function(ws){ return ws.name; });
              var pdfHtml = await (await fetch('/.superpowers/exports/${name}.html?_=' + Date.now())).text().catch(function(){ return ''; });
              return { first: ws0.name, sheets: wb.worksheets.length, images: ws0.getImages().length, figures: vals.map(function(x){ return x.v; }), equalIn: found, pdfDash: /class="dash"/.test(pdfHtml), rtl: !!(ws0.views[0] && ws0.views[0].rightToLeft) };
            })()`);
            report.push(`${name}: ${JSON.stringify(chk)}`);
            if (chk.sheets > 1 && chk.first !== (lang === 'en' ? 'Dashboard' : chk.first)) problems.push(`${name}: first sheet is ${chk.first}`);
            if (!chk.figures.length) problems.push(`${name}: no figures on the Dashboard sheet`);
            if (!chk.equalIn.length && chk.figures.some(function(v){ return Math.abs(v) > 0.004; })) problems.push(`${name}: Dashboard figures not found on a totals line`);
            if (hasPdf && !chk.pdfDash) problems.push(`${name}: the PDF has no dashboard page`);
            if ((lang !== 'en') !== chk.rtl) problems.push(`${name}: sheet direction wrong`);
          }
        }
      }
    }
    console.log(report.join('\n'));
    ws.close();
  } finally { chrome.kill(); }
  if (problems.length) { console.log('\nPROBLEMS:\n' + problems.join('\n')); process.exit(1); }
  console.log('\nno problems');
}
main().catch(e => { console.error(e); process.exit(1); });
