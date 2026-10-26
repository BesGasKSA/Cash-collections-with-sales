/* Best Gas Cash Collection — push notifications service worker (2026-10-26).
 * Served from the site root next to index.html, registered by the app with its own
 * scope (the GitHub Pages sub-path), never by Firebase's default '/' path.
 * The server sends FCM HTTP v1 web push with a notification part: Firebase draws it
 * and opens its fcm_options.link on a tap. A message without that part (data only)
 * is drawn here, from its data: title, body, tag, dir, lang, open.
 * The web config comes from the registration URL (?c=<json>) when the admin set one,
 * else the company's built-in public config. Messaging only, no analytics.
 */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

var BGC_DEFAULT_WEB = {
  apiKey: 'AIzaSyDSZcEDFJCRTd_-dMPVjfORe1zHpp0TaH8', authDomain: 'bestgas-cash.firebaseapp.com', projectId: 'bestgas-cash',
  storageBucket: 'bestgas-cash.firebasestorage.app', messagingSenderId: '703265582003', appId: '1:703265582003:web:f4f0200d6353090d24b9c6'
};
var BGC_ICON = new URL('assets/icon-192.png', self.registration.scope).href;
var BGC_BADGE = new URL('assets/favicon-32.png', self.registration.scope).href;

function bgcConfig() {
  try {
    var c = new URL(self.location.href).searchParams.get('c');
    if (c) { var o = JSON.parse(c); if (o && o.apiKey && o.projectId && o.messagingSenderId && o.appId) return o; }
  } catch (e) {}
  return BGC_DEFAULT_WEB;
}

// Safari (iPhone, iPad, Mac) may cancel a subscription whose pushes show nothing, and Firebase
// shows nothing while the app is on screen (it hands the message to the page instead). On
// Safari, then, a push that arrives while a window is visible is drawn here as well. Added
// before Firebase so it runs first; Firebase still tells the page (an in-app toast too).
var BGC_SAFARI = /Safari/.test(self.navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|Android/.test(self.navigator.userAgent);
self.addEventListener('push', function (event) {
  if (!BGC_SAFARI || !event.data) return;
  var p = null; try { p = event.data.json(); } catch (e) { return; }
  var d = (p && p.data) || {};
  if (!d.title) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    if (!list.some(function (c) { return c.visibilityState === 'visible'; })) return;   // Firebase shows it
    return self.registration.showNotification(d.title, { body: d.body || '', icon: BGC_ICON, badge: BGC_BADGE, tag: d.tag || 'bgc',
      dir: d.dir === 'rtl' ? 'rtl' : 'ltr', lang: d.lang || '', data: { open: d.open || self.registration.scope } });
  }));
});

firebase.initializeApp(bgcConfig());
var messaging = firebase.messaging();

// a new version takes over at once, so a fix reaches every phone on its next visit
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

messaging.onBackgroundMessage(function (payload) {
  // Firebase has already shown a message that carries a notification part
  if (payload && payload.notification) return;
  var d = (payload && payload.data) || {};
  if (!d.title) return;
  return self.registration.showNotification(d.title, {
    body: d.body || '', icon: BGC_ICON, badge: BGC_BADGE, tag: d.tag || 'bgc', renotify: true,
    dir: d.dir === 'rtl' ? 'rtl' : d.dir === 'ltr' ? 'ltr' : 'auto', lang: d.lang || '',
    data: { open: d.open || self.registration.scope }
  });
});

// a tap on a notification drawn above: focus the app and open the request
self.addEventListener('notificationclick', function (event) {
  var data = event.notification && event.notification.data || {};
  if (data.FCM_MSG) return;   // Firebase's own notification: its handler opens the link
  event.notification.close();
  var scope = self.registration.scope, link = data.open || scope;
  try { if (new URL(link).origin !== new URL(scope).origin) link = scope; } catch (e) { link = scope; }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      if (w.url.indexOf(scope) === 0 && 'focus' in w) {
        // the open app reads ?open= on load: navigate it there, or tell it if it cannot navigate
        if ('navigate' in w) return w.navigate(link).then(function (n) { return (n || w).focus(); }).catch(function () { w.postMessage({ bgcOpen: link }); return w.focus(); });
        w.postMessage({ bgcOpen: link });
        return w.focus();
      }
    }
    return self.clients.openWindow(link);
  }));
});
