/**
 * Produces every Collection report's Excel and PDF, and the Comparison's, from the real
 * client against tests/mock-backend-server.js, then checks each PDF opens in pdf.js.
 * Excel files are checked afterwards in real Excel: tests/export-opens-in-excel.ps1.
 *
 *   node tests/mock-backend-server.js 8921        (and seed it through the API)
 *   node tests/export-reports.cjs 8921 [--langs en,ar,ur] [--shots]
 *
 * Headless Chrome over the DevTools Protocol (Node's own WebSocket). The page's
 * downloads are caught (a blob link's click) and posted to the mock's POST /__save,
 * which keeps them in .superpowers/exports. The PDF is the HTML the app writes into its
 * print window, printed here with Page.printToPDF at the page size the report asks for.
 * The mock's seeded sign-in is test-only.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.argv[2] || 8921);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const LANGS = String(arg('--langs', 'en,ar,ur')).split(',');
const SHOTS = process.argv.includes('--shots');
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(__dirname, '..', '.superpowers', 'exports');
const SHOT_DIR = path.join(__dirname, '..', '.superpowers', 'crp');
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const CDP = 9341;
const REPORTS = ['summary', 'mix', 'exceptions', 'movers', 'collectors', 'transit', 'statement', 'transfers', 'areas', 'branches', 'cities', 'branchStmt', 'heat',
  'trend', 'aging', 'sla', 'deposits', 'recon', 'shorts', 'returns', 'corrections', 'dates', 'top'];
// every report in English; three reports and the Comparison in Arabic and Urdu
const SUBSET = ['summary', 'mix', 'collectors'];
const NAV = { en: ['Collection reports', 'Comparison'], ar: ['تقارير التحصيل', 'المقارنة'], ur: ['وصولی رپورٹس', 'موازنہ'] };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(p) { return (await fetch(BASE + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })).json(); }
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  return { ws, send: (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}
// downloads and the print window, caught and sent to the mock
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
async function main() {
  if (!CHROME) throw new Error('No Chrome');
  fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(SHOT_DIR, { recursive: true });
  const login = await api({ action: 'login', email: 'admin@bestgas.sa', password: 'Bootstrap#1' });
  if (!login.ok) throw new Error('mock sign-in failed: ' + login.error);
  const profile = path.join(os.tmpdir(), 'crp-exp-' + Date.now());
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const produced = [], problems = [];
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).find(t => t.type === 'page'); } catch { await sleep(250); } }
    const { ws, send } = await connect(target.webSocketDebuggerUrl);
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '/' }); await sleep(1500);
    let count = 0;
    for (const lang of LANGS) {
      await evaluate(send, `localStorage.setItem('bgc_apiUrl', '${BASE}/api'); localStorage.setItem('bgc_token', ${JSON.stringify(login.token)}); localStorage.setItem('bgc_lang', '${lang}');
        sessionStorage.setItem('bgc_crp', JSON.stringify({ rep: 'summary', preset: 'month', lv: 'city' })); sessionStorage.setItem('bgc_cmp', JSON.stringify({ preset: 'month', mode: 'period', n: 2, by: 'area', metric: 'net' })); true`);
      await send('Page.reload'); await sleep(4000);
      await evaluate(send, HOOKS); count = 0;
      const ok = await evaluate(send, `(async function(){ var b = [].find.call(document.querySelectorAll('button'), function(x){ return x.textContent.trim() === ${JSON.stringify(NAV[lang][0])}; }); if (!b) return false; b.click(); await new Promise(function(r){ setTimeout(r, 3500); }); return !!document.querySelector('.crp-ci'); })()`);
      if (!ok) { problems.push(lang + ': the reports screen did not open'); continue; }
      const list = lang === 'en' ? REPORTS : SUBSET;
      for (const id of list) {
        const name = `crp-${lang}-${id}`;
        await evaluate(send, `window.__name = ${JSON.stringify(name)}; (async function(){ document.querySelector('.crp-ci[data-id="${id}"]').click(); await new Promise(function(r){ setTimeout(r, 900); }); return true; })()`);
        const err = await evaluate(send, `(function(){ var e = document.querySelector('.crp-main .msg.err'); return e ? e.textContent : ''; })()`);
        if (err) { problems.push(name + ': ' + err); continue; }
        await evaluate(send, `document.querySelector('.crp-hero .ex-xl').click(); true`); count++; await waitSaved(send, count, name + '.xlsx');
        await evaluate(send, `document.querySelector('.crp-hero .ex-pdf').click(); true`); count++; await waitSaved(send, count, name + '.html');
        produced.push(name);
      }
      // the Comparison, same template
      const cmpOk = await evaluate(send, `(async function(){ var b = [].find.call(document.querySelectorAll('button'), function(x){ return x.textContent.trim() === ${JSON.stringify(NAV[lang][1])}; }); if (!b) return false; b.click(); await new Promise(function(r){ setTimeout(r, 5000); }); return !!document.querySelector('.cmp .crp-hero'); })()`);
      if (!cmpOk) problems.push(lang + ': the Comparison did not open');
      else {
        const name = `crp-${lang}-comparison`;
        await evaluate(send, `window.__name = ${JSON.stringify(name)}; document.querySelector('.cmp .crp-hero .ex-xl').click(); true`); count++; await waitSaved(send, count, name + '.xlsx');
        await evaluate(send, `document.querySelector('.cmp .crp-hero .ex-pdf').click(); true`); count++; await waitSaved(send, count, name + '.html');
        produced.push(name);
      }
    }
    await sleep(1000);
    // print each page the app wrote, at the size its CSS asks for
    for (const name of produced) {
      const html = path.join(OUT, name + '.html');
      if (!fs.existsSync(html)) { problems.push(name + ': no print page'); continue; }
      await send('Page.navigate', { url: `${BASE}/.superpowers/exports/${encodeURIComponent(name)}.html` }); await sleep(1800);
      try { await evaluate(send, 'document.fonts.ready.then(function(){ return true; })'); } catch {}
      const { data } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, transferMode: 'ReturnAsBase64' });
      fs.writeFileSync(path.join(OUT, name + '.pdf'), Buffer.from(data, 'base64'));
    }
    // every PDF opens in pdf.js; a picture of a sample page
    await send('Page.navigate', { url: `${BASE}/.superpowers/exports/${encodeURIComponent(produced[0])}.html` }); await sleep(800);
    await evaluate(send, `new Promise(function(res, rej){ var s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = function(){ pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(true); }; s.onerror = rej; document.head.appendChild(s); })`);
    const report = [];
    for (const name of produced) {
      const r = await evaluate(send, `(async function(){ try { var d = await pdfjsLib.getDocument('/.superpowers/exports/${encodeURIComponent(name)}.pdf').promise; var p = await d.getPage(1); var vp = p.getViewport({ scale: 1 }); var tc = await p.getTextContent(); return { pages: d.numPages, w: Math.round(vp.width), h: Math.round(vp.height), text: tc.items.length }; } catch (e) { return { error: String(e && e.message || e) }; } })()`);
      report.push(name + '.pdf: ' + (r.error ? 'FAILS ' + r.error : `opens, ${r.pages} page(s), ${r.w > r.h ? 'landscape' : 'portrait'}, ${r.text} text runs`));
      if (r.error || !r.pages) problems.push(name + '.pdf does not open');
    }
    if (SHOTS) {
      for (const name of ['crp-en-summary', 'crp-ar-mix', 'crp-en-comparison']) {
        if (!produced.includes(name)) continue;
        const url = await evaluate(send, `(async function(){ var d = await pdfjsLib.getDocument('/.superpowers/exports/${name}.pdf').promise; var p = await d.getPage(1); var vp = p.getViewport({ scale: 1.6 }); var c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; return c.toDataURL('image/png'); })()`);
        fs.writeFileSync(path.join(SHOT_DIR, 'export-pdf-' + name.replace('crp-', '') + '.png'), Buffer.from(url.split(',')[1], 'base64'));
      }
    }
    console.log(report.join('\n'));
    console.log(`\nproduced ${produced.length} report(s), ${produced.length * 2} files (xlsx + pdf)`);
    ws.close();
  } finally { chrome.kill(); }
  if (problems.length) { console.log('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
}
main().catch(e => { console.error(e); process.exit(1); });
