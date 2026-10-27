// ---------- Push notifications (2026-10-26) ----------
// The user (urgent): "enable push notifications in the mobile layout, the mobile app and
// the desktop version". Web push through Firebase Cloud Messaging HTTP v1: Apps Script
// cannot sign VAPID (ECDSA) itself, FCM does. The server only needs an OAuth token for
// the Firebase service account: a JWT signed RS256 (Utilities.computeRsaSha256Signature)
// traded at oauth2.googleapis.com, kept in CacheService for 50 minutes.
//
// Configuration lives in script properties, set by the admin from Settings:
//   PUSH_WEB    the Firebase web config (public; a built-in default ships with the app)
//   PUSH_VAPID  the Web Push certificate's public key (public)
//   PUSH_SA     the service account JSON (PRIVATE: never returned by any action)
// Devices are rows of `push_tokens` {userId, token, platform, ua, createdAt, lastSeenAt,
// active}. Every email in Notify.gs also pushes (nmSend_ -> pushTo_), in the reader's own
// language, with the same ?open= link; people without email (drivers by iqama) get push
// only. Sending is best-effort: it waits for the cash lock, and never fails an action.
//
// No top-level code reads SHEETS here: clasp may load this file before الرمز (Code.gs).

// the company's Firebase project (public by design: it identifies the project, it grants nothing)
var PUSH_DEFAULT_WEB_ = {
  apiKey: 'AIzaSyDSZcEDFJCRTd_-dMPVjfORe1zHpp0TaH8', authDomain: 'bestgas-cash.firebaseapp.com', projectId: 'bestgas-cash',
  storageBucket: 'bestgas-cash.firebasestorage.app', messagingSenderId: '703265582003', appId: '1:703265582003:web:f4f0200d6353090d24b9c6'
};
// its Web Push certificate's public key (VAPID), public as well
var PUSH_DEFAULT_VAPID_ = 'BAJRJ0ltn21nT17JdspGUzde5sCN14GnqlJ-yv_NfBpoXvDYsUfbmI1yYOSUI84Zo8TImHoOFj41HhAa6n8AWhA';
var PUSH_WEB_KEYS_ =['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
var PUSH_SCOPE_ = 'https://www.googleapis.com/auth/firebase.messaging';
var PUSH_TOKEN_URL_ = 'https://oauth2.googleapis.com/token';
var PUSH_AT_KEY_ = 'push_at';
var PUSH_TTL_SEC_ = 86400;          // a phone off for a day still gets it when it comes back
var PUSH_MAX_DEVICES_ = 10;          // per person; the oldest beyond this are switched off
var PUSH_SEEN_MS_ = 20 * 3600 * 1000; // a device re-registered sooner than this is not written again
var PUSH_MAX_ROWS_ = 20;             // rows a person keeps, active or not (review 2026-10-26)
var PUSH_PRUNE_MS_ = 30 * 86400000;   // an inactive row older than this is deleted

// Reads a pasted web config: JSON, or the snippet the Firebase console shows
// (`const firebaseConfig = { apiKey: "…", … };`, unquoted keys).
function pushParseWeb_(v) {
  if (v && typeof v === 'object') return v;
  var s = String(v || ''), o = null;
  try { o = JSON.parse(s); } catch (e) { o = null; }
  if (!o || typeof o !== 'object') {
    o = {};
    var re = /([A-Za-z]+)\s*:\s*["']([^"']*)["']/g, m;
    while ((m = re.exec(s))) o[m[1]] = m[2];
  }
  return o;
}
function pushCleanWeb_(o) {
  if (!o || typeof o !== 'object') return null;
  var w = {};
  PUSH_WEB_KEYS_.forEach(function (k) { if (o[k] != null && String(o[k]).trim()) w[k] = String(o[k]).trim().slice(0, 200); });
  if (!w.apiKey || !w.projectId || !w.messagingSenderId || !w.appId) return null;
  if (!/^[a-z0-9-]{4,40}$/.test(w.projectId) || !/^\d{4,20}$/.test(w.messagingSenderId)) return null;
  return w;
}
function pushParseSa_(v) {
  var o = null;
  if (v && typeof v === 'object') o = v; else { try { o = JSON.parse(String(v || '')); } catch (e) { o = null; } }
  if (!o || typeof o !== 'object') return null;
  if (o.type !== 'service_account' || !o.project_id || !o.client_email || !/-----BEGIN PRIVATE KEY-----/.test(String(o.private_key || ''))) return null;
  return { type: 'service_account', project_id: String(o.project_id), private_key_id: String(o.private_key_id || ''), private_key: String(o.private_key),
    client_email: String(o.client_email), token_uri: PUSH_TOKEN_URL_ };
}
function pushWeb_() {
  var p = scriptProps_(), w = null;
  if (p.PUSH_WEB) { try { w = pushCleanWeb_(JSON.parse(p.PUSH_WEB)); } catch (e) { w = null; } }
  return w || PUSH_DEFAULT_WEB_;
}
function pushSa_() {
  var p = scriptProps_();
  if (!p.PUSH_SA) return null;
  try { return pushParseSa_(JSON.parse(p.PUSH_SA)); } catch (e) { return null; }
}
function pushVapid_() { return scriptProps_().PUSH_VAPID || PUSH_DEFAULT_VAPID_; }
function pushReady_() {
  var sa = pushSa_();
  return !!(sa && pushVapid_() && sa.project_id === pushWeb_().projectId);
}
// what every client may read (meta.config.push): never the service account
function pushPublic_() {
  return { ready: pushReady_(), web: pushWeb_(), vapidKey: pushVapid_() || null };
}
// what the admin's card reads: whether a service account is in, not what it is
function pushAdminView_() {
  var sa = pushSa_(), web = pushWeb_();
  var devices = 0;
  try { devices = readSheet(SHEETS.PUSH_TOKENS).filter(function (r) { return r.active === true; }).length; } catch (e) {}
  return { ok: true, push: { ready: pushReady_(), web: web, webIsDefault: !scriptProps_().PUSH_WEB, vapidKey: pushVapid_() || null, vapidIsDefault: !scriptProps_().PUSH_VAPID,
    serviceAccountSet: !!sa, projectId: web.projectId, serviceAccountProject: sa ? sa.project_id : null, devices: devices } };
}

function actionAdminGetPushConfig_(req, user) {
  if (!user || user.role !== 'admin') return { ok: false, error: 'forbidden' };
  return pushAdminView_();
}

// Admin → Settings → Push notifications. Each part may be sent on its own; a blank keeps it.
function actionAdminSetPushConfig_(req, user) {
  if (!user || user.role !== 'admin') return { ok: false, error: 'forbidden' };
  var d = req.data || {}, set = [];
  var web = null, vapid = null, sa = null;
  function given(v) { return v != null && String(typeof v === 'object' ? 'x' : v).trim() !== ''; }
  // one request asks for one thing: going back to the built-in project while sending a key or a
  // config of another, or removing the service account while sending one, is a malformed request
  if ((d.resetWeb === true && (given(d.vapidKey) || given(d.webConfig))) || (d.clear === true && given(d.serviceAccount))) return { ok: false, error: 'invalid_input' };
  if (d.webConfig != null && String(typeof d.webConfig === 'object' ? 'x' : d.webConfig).trim()) {
    web = pushCleanWeb_(pushParseWeb_(d.webConfig));
    if (!web) return { ok: false, error: 'invalid_push_web' };
  }
  if (d.vapidKey != null && String(d.vapidKey).trim()) {
    vapid = String(d.vapidKey).trim();
    // an uncompressed P-256 public key: 65 bytes, 87 characters of base64url
    if (!/^[A-Za-z0-9_-]{80,100}={0,2}$/.test(vapid)) return { ok: false, error: 'invalid_push_vapid' };
    vapid = vapid.replace(/=+$/, '');
  }
  if (d.serviceAccount != null && String(typeof d.serviceAccount === 'object' ? 'x' : d.serviceAccount).trim()) {
    sa = pushParseSa_(d.serviceAccount);
    if (!sa) return { ok: false, error: 'invalid_push_sa' };
  }
  // the web config this save leaves in force: a new one, the built-in one on a reset, or the saved one
  var projectId = (web || (d.resetWeb === true ? PUSH_DEFAULT_WEB_ : pushWeb_())).projectId;
  var saNow = sa || (d.clear === true ? null : pushSa_());
  if (saNow && saNow.project_id !== projectId) return { ok: false, error: 'push_project_mismatch' };
  if (web) { setScriptProp_('PUSH_WEB', JSON.stringify(web)); set.push('web'); }
  if (vapid) { setScriptProp_('PUSH_VAPID', vapid); set.push('vapid'); }
  if (sa) { setScriptProp_('PUSH_SA', JSON.stringify(sa)); set.push('service_account'); }
  if (d.clear === true) { setScriptProp_('PUSH_SA', ''); set.push('cleared'); }
  if (d.resetWeb === true) { setScriptProp_('PUSH_WEB', ''); setScriptProp_('PUSH_VAPID', ''); set.push('web_default'); }
  if (set.length) {
    try { CacheService.getScriptCache().remove(PUSH_AT_KEY_); } catch (e) {}
    // listMeta answers are cached under the sheets' versions: a new config must reach them
    bumpVersion_(SHEETS.CONFIG);
    logAudit_('admin_set_push', user.id, set.join(','));
  }
  return pushAdminView_();
}

// ---------- devices ----------
function pushCleanToken_(t) {
  t = String(t == null ? '' : t).trim();
  return t.length >= 8 && t.length <= 4096 && /^[A-Za-z0-9_:\-.]+$/.test(t) ? t : null;
}
function actionRegisterPushToken_(req, user) {
  var t = pushCleanToken_(req.pushToken);
  if (!t) return { ok: false, error: 'invalid_push_token' };
  var platform = ['ios', 'android', 'desktop', 'other'].indexOf(req.platform) >= 0 ? req.platform : 'other';
  var ua = String(req.ua || '').slice(0, 300), now = new Date().toISOString();
  var rows = readSheet(SHEETS.PUSH_TOKENS);
  var row = rows.filter(function (r) { return r.token === t; })[0];
  // the app re-sends its token once a session: a device seen in the last day writes nothing
  if (row && row.userId === user.id && row.active === true && row.platform === platform &&
      Date.now() - new Date(row.lastSeenAt || 0).getTime() < PUSH_SEEN_MS_) return { ok: true, id: row.id, pushOn: user.pushOn !== false, ready: pushReady_() };
  // nobody needs to register thirty devices in ten minutes
  var cache = CacheService.getScriptCache(), rk = 'push_reg_' + user.id, rn = Number(cache.get(rk) || 0);
  if (rn >= 30) return { ok: false, error: 'too_many_requests' };
  cache.put(rk, String(rn + 1), 600);
  // the read, the write and the tidying run under the script lock against a fresh read, so two
  // devices registering at once cannot both pass the limits or write one token twice (review 2026-10-26)
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    row = readSheet(SHEETS.PUSH_TOKENS).filter(function (r) { return r.token === t; })[0];
    if (row) {
      // the same phone signed in by someone else now belongs to them (a shared phone)
      if (row.userId !== user.id) { row.movedFrom = row.userId; row.userId = user.id; row.createdAt = now; }
      row.active = true; row.lastSeenAt = now; row.platform = platform; if (ua) row.ua = ua;
      delete row.deactivatedAt; delete row.deactivatedReason;
    } else {
      row = { userId: user.id, token: t, platform: platform, ua: ua, createdAt: now, lastSeenAt: now, active: true };
    }
    writeRow(SHEETS.PUSH_TOKENS, row);
    pushTidyUser_(user.id, row.token, now);
    return { ok: true, id: row.id, pushOn: user.pushOn !== false, ready: pushReady_() };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}
// A person's rows, under the caller's lock: at most PUSH_MAX_DEVICES_ active (the oldest are
// switched off), inactive rows older than PUSH_PRUNE_MS_ deleted, and PUSH_MAX_ROWS_ rows in all,
// active or not (the oldest inactive ones go first). `keep` is the device just registered.
function pushTidyUser_(userId, keep, now) {
  function seen(r) { return String(r.active === true ? r.lastSeenAt || '' : r.deactivatedAt || r.lastSeenAt || ''); }
  var mine = readSheet(SHEETS.PUSH_TOKENS).filter(function (r) { return r.userId === userId; });
  mine.filter(function (r) { return r.active === true; })
    .sort(function (a, b) { return (b.token === keep) - (a.token === keep) || seen(b).localeCompare(seen(a)); })
    .slice(PUSH_MAX_DEVICES_).forEach(function (r) { r.active = false; r.deactivatedAt = now; r.deactivatedReason = 'too_many'; writeRow(SHEETS.PUSH_TOKENS, r); });
  var cutoff = new Date(Date.now() - PUSH_PRUNE_MS_).toISOString(), drop = [];
  mine.forEach(function (r) { if (r.active !== true && r.token !== keep && seen(r) && seen(r) < cutoff) drop.push(r.id); });
  var left = mine.filter(function (r) { return drop.indexOf(r.id) < 0; })
    .sort(function (a, b) { return (b.active === true) - (a.active === true) || (b.token === keep) - (a.token === keep) || seen(b).localeCompare(seen(a)); });
  left.slice(PUSH_MAX_ROWS_).forEach(function (r) { if (r.token !== keep) drop.push(r.id); });
  if (drop.length) pushDeleteRows_(drop);
}
// Deletes these rows of push_tokens (bottom up, so the row numbers stay right). The caller holds the lock.
function pushDeleteRows_(ids) {
  var sh = sheet_(SHEETS.PUSH_TOKENS);
  var idx = ids.map(function (id) { return findRow_(sh, id); }).filter(function (i) { return i > 1; }).sort(function (a, b) { return b - a; });
  idx.forEach(function (i) { sh.deleteRow(i); });
  bumpVersion_(SHEETS.PUSH_TOKENS);
}
// A device FCM says is gone, switched off under the script lock against a fresh read of its row.
function pushMarkDead_(token, reason) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    var r = readSheet(SHEETS.PUSH_TOKENS).filter(function (x) { return x.token === token; })[0];
    if (!r || r.active !== true) return false;
    r.active = false; r.deactivatedAt = new Date().toISOString(); r.deactivatedReason = reason;
    writeRow(SHEETS.PUSH_TOKENS, r);
    return true;
  } finally { try { lock.releaseLock(); } catch (e) {} }
}
function actionUnregisterPushToken_(req, user) {
  var t = pushCleanToken_(req.pushToken);
  if (!t) return { ok: false, error: 'invalid_push_token' };
  var row = readSheet(SHEETS.PUSH_TOKENS).filter(function (r) { return r.token === t && r.userId === user.id; })[0];
  if (!row) return { ok: false, error: 'not_found' };
  if (row.active !== false) { row.active = false; row.deactivatedAt = new Date().toISOString(); row.deactivatedReason = 'user'; writeRow(SHEETS.PUSH_TOKENS, row); }
  return { ok: true };
}
function actionSetPushPref_(req, user) {
  var u = getById_(SHEETS.USERS, user.id);
  if (!u) return { ok: false, error: 'not_found' };
  u.pushOn = req.on !== false;
  writeRow(SHEETS.USERS, u);
  return { ok: true, pushOn: u.pushOn };
}
// "Send a test notification to me": straight away, and says what happened
function actionSendTestPush_(req, user) {
  if (!pushReady_()) return { ok: false, error: 'push_not_ready' };
  var cache = CacheService.getScriptCache(), k = 'push_test_' + user.id;
  var n = Number(cache.get(k) || 0);
  if (n >= 10) return { ok: false, error: 'too_many_requests' };
  cache.put(k, String(n + 1), 600);
  var lang = userLang_(user), c = NM_[lang] || NM_.en;
  var r = pushSendNow_(user.id, { title: PUSH_TEST_[lang].t, body: PUSH_TEST_[lang].b, open: DEFAULT_APP_URL, tag: 'bgc-test', lang: lang, dir: c.dir }, true);
  return { ok: true, devices: r.devices, sent: r.sent, failed: r.failed, removed: r.removed, error: r.error || undefined, why: r.why || undefined };
}
var PUSH_TEST_ = {
  en: { t: 'Test notification', b: 'Notifications reach this device. You will hear about every request that needs you.' },
  ar: { t: 'إشعار تجريبي', b: 'الإشعارات تصل إلى هذا الجهاز. ستُبلَّغ بكل طلب ينتظرك.' },
  ur: { t: 'آزمائشی اطلاع', b: 'اطلاعات اس ڈیوائس تک پہنچ رہی ہیں۔ آپ کو ہر اس درخواست کی خبر ملے گی جو آپ کی منتظر ہے۔' }
};

// ---------- sending ----------
// someone a notification can reach: an email, or a device with push on
function pushHasDevice_(userId) {
  if (!userId || !pushReady_()) return false;
  var u = getById_(SHEETS.USERS, userId);
  if (!u || u.active === false || u.pushOn === false) return false;
  return readSheet(SHEETS.PUSH_TOKENS).some(function (r) { return r.userId === userId && r.active === true; });
}
function nmReach_(u) {
  if (!u || u.active === false) return false;
  if (u.email) return true;
  try { return pushHasDevice_(u.id); } catch (e) { return false; }
}

// One notification to one person's devices: best-effort, never inside the cash lock.
// msg: {title, body, open, tag, lang, dir}
// Inside a request (route_ opens exec_().pushBatch) everything an action sends is gathered and
// goes out at the end of the request in one fetchAll, after every lock is released and only
// when the action did not throw (review 2026-10-26: one confirm alerted six people one after
// another). Outside a request (a time trigger, a direct call) it waits for the cash lock.
function pushTo_(userId, msg) {
  try {
    if (!userId || !msg) return;
    var ex = exec_();
    if (ex.pushBatch) { ex.pushBatch.push({ userId: userId, msg: msg }); return; }
    afterCashLock_(function () { try { pushSendMany_([{ userId: userId, msg: msg }]); } catch (e) { console.error('push: ' + e); } });
  } catch (e) { console.error('push: ' + e); }
}
// A time trigger (checkStaleHandoffs_, checkHeldTooLong_) gathers its pushes the same way:
// begin returns true only when it opened the batch (a check run from a request leaves it to route_).
function pushBatchBegin_() { var ex = exec_(); if (ex.pushBatch) return false; ex.pushBatch = []; return true; }
function pushBatchEnd_(opened) { if (opened) pushFlush_(); }
// route_ calls this once the action has returned
function pushFlush_() {
  var ex = exec_(), q = ex.pushBatch || [];
  ex.pushBatch = null;
  if (!q.length) return;
  // one notification per person and request, whatever several code paths asked for
  var seen = Object.create(null), list = [];
  q.forEach(function (it) { var k = it.userId + '|' + (it.msg.tag || pushTagOf_(it.msg.open)) + '|' + it.msg.title; if (!seen[k]) { seen[k] = 1; list.push(it); } });
  try { pushSendMany_(list); } catch (e) { console.error('push flush: ' + e); }
}

function pushB64url_(v) { return Utilities.base64EncodeWebSafe(v).replace(/=+$/, ''); }
// The service account's OAuth token, cached 50 minutes (it lasts an hour).
function pushAccessToken_(sa, fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) { var hit = null; try { hit = cache.get(PUSH_AT_KEY_); } catch (e) {} if (hit) return hit; }
  var now = Math.floor(Date.now() / 1000);
  var head = pushB64url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var claims = pushB64url_(JSON.stringify({ iss: sa.client_email, scope: PUSH_SCOPE_, aud: PUSH_TOKEN_URL_, iat: now, exp: now + 3600 }));
  var input = head + '.' + claims;
  var sig = pushB64url_(Utilities.computeRsaSha256Signature(input, sa.private_key));
  var res = UrlFetchApp.fetch(PUSH_TOKEN_URL_, { method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input + '.' + sig } });
  if (res.getResponseCode() !== 200) {
    // Google's own words travel with it (e.g. invalid_grant: Invalid JWT Signature), so the admin's test says why
    var ge = null; try { ge = JSON.parse(res.getContentText()); } catch (eJ) {}
    var err = new Error('push_oauth_' + res.getResponseCode());
    err.why = ('OAuth HTTP ' + res.getResponseCode() + (ge && ge.error ? ' ' + (typeof ge.error === 'string' ? ge.error : (ge.error.status || '')) : '') + (ge && (ge.error_description || (ge.error && ge.error.message)) ? ': ' + (ge.error_description || ge.error.message) : '')).slice(0, 240);
    throw err;
  }
  var at = JSON.parse(res.getContentText()).access_token;
  if (!at) throw new Error('push_oauth_empty');
  try { cache.put(PUSH_AT_KEY_, at, 3000); } catch (e) {}
  return at;
}

// the request's id from its ?open=what:id link, for one notification per request
function pushTagOf_(link) {
  var m = /[?&]open=([^&#]+)/.exec(String(link || ''));
  if (!m) return 'bgc';
  var v = ''; try { v = decodeURIComponent(m[1]); } catch (e) { v = m[1]; }
  var id = v.indexOf(':') >= 0 ? v.slice(v.indexOf(':') + 1) : v;
  return ('bgc-' + id).slice(0, 120);
}

function pushMessage_(token, msg) {
  var lang = msg.lang === 'ar' || msg.lang === 'ur' ? msg.lang : 'en';
  var dir = msg.dir || (lang === 'en' ? 'ltr' : 'rtl');
  var link = msg.open || DEFAULT_APP_URL, tag = msg.tag || pushTagOf_(link);
  var title = String(msg.title || '').slice(0, 200), body = String(msg.body || '').slice(0, 500);
  return { message: {
    token: token,
    webpush: {
      headers: { Urgency: 'high', TTL: String(PUSH_TTL_SEC_) },
      notification: { title: title, body: body, icon: DEFAULT_APP_URL + 'assets/icon-192.png', badge: DEFAULT_APP_URL + 'assets/favicon-32.png',
        tag: tag, renotify: true, dir: dir, lang: lang },
      fcm_options: { link: link }
    },
    // read by the service worker when it draws the notification itself, and by the open app
    data: { title: title, body: body, open: link, tag: tag, dir: dir, lang: lang }
  } };
}

// Sends now to one person. Returns {devices, sent, failed, removed}. Never throws.
function pushSendNow_(userId, msg, ignorePref) {
  return pushSendMany_([{ userId: userId, msg: msg, ignorePref: !!ignorePref }])[0];
}
// Sends several notifications in one UrlFetchApp.fetchAll. items: [{userId, msg, ignorePref}].
// Returns one {devices, sent, failed, removed} per item. Never throws.
function pushSendMany_(items) {
  var outs = items.map(function () { return { devices: 0, sent: 0, failed: 0, removed: 0 }; });
  try {
    var sa = pushSa_();
    if (!sa || !pushReady_()) { outs.forEach(function (o) { o.error = 'push_not_ready'; }); return outs; }
    var all = readSheet(SHEETS.PUSH_TOKENS);
    var jobs = [];   // {i: item index, row}
    items.forEach(function (it, i) {
      var u = getById_(SHEETS.USERS, it.userId);
      if (!u || u.active === false || (!it.ignorePref && u.pushOn === false)) return;
      all.forEach(function (r) { if (r.userId === it.userId && r.active === true) { jobs.push({ i: i, row: r }); outs[i].devices++; } });
    });
    if (!jobs.length) return outs;
    var at = pushAccessToken_(sa);
    var url = 'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(sa.project_id) + '/messages:send';
    function reqs(token) {
      return jobs.map(function (j) { return { url: url, method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + token }, payload: JSON.stringify(pushMessage_(j.row.token, items[j.i].msg)) }; });
    }
    var res = UrlFetchApp.fetchAll(reqs(at));
    // a token revoked early (a key rotated): one fresh token, one retry
    if (res.some(function (x) { return x.getResponseCode() === 401; })) {
      at = pushAccessToken_(sa, true);
      res = UrlFetchApp.fetchAll(reqs(at));
    }
    var now = new Date().toISOString(), gone = Object.create(null);
    res.forEach(function (x, k) {
      var j = jobs[k], o = outs[j.i], code = x.getResponseCode(), body = '';
      try { body = x.getContentText() || ''; } catch (e) {}
      if (code >= 200 && code < 300) { o.sent++; return; }
      o.failed++;
      // Google's own reason, for the person testing (no secret in it): HTTP code, status and message
      if (!o.why) { var ge = null; try { ge = (JSON.parse(body) || {}).error || null; } catch (eJ) {} o.why = ('HTTP ' + code + (ge && ge.status ? ' ' + ge.status : '') + (ge && ge.message ? ': ' + ge.message : '')).slice(0, 240); }
      // the device is gone (UNREGISTERED, 404) or its token is not a token (INVALID_ARGUMENT naming
      // the registration token, 400). Any other 400 is the message's fault, not the device's.
      var dead = code === 404 || /UNREGISTERED/.test(body) || (code === 400 && /registration token/i.test(body));
      if (dead && !gone[j.row.token]) {
        gone[j.row.token] = 1;
        try { if (pushMarkDead_(j.row.token, code === 404 || /UNREGISTERED/.test(body) ? 'unregistered' : 'invalid_token')) o.removed++; } catch (e) {}
      }
    });
  } catch (e) { var msg = String(e && e.message || e).slice(0, 80), why = e && e.why ? String(e.why) : ''; outs.forEach(function (o) { o.error = msg; if (why && !o.why) o.why = why; }); console.error('push send: ' + e + (why ? ' ' + why : '')); }
  return outs;
}

// Run once from the Apps Script editor (Run > approvePushPermission) to grant the internet permission
// (script.external_request) that sending notifications needs. Changes nothing; it only asks Google once.
function approvePushPermission() {
  var code = UrlFetchApp.fetch(PUSH_TOKEN_URL_, { muteHttpExceptions: true }).getResponseCode();
  Logger.log("Permission approved. Google reachable: HTTP " + code + ". Now press Send a test notification in the app.");
}
