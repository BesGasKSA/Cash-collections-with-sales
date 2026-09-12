/**
 * Builds index.protected.html — an obfuscated distributable copy of
 * index.html for actual deployment/sharing.
 *
 * index.html stays the readable source and is what gets edited going
 * forward. This script never modifies it. Run after every change to
 * index.html:
 *
 *   node tools/obfuscate.js
 *
 * What this buys you, and what it doesn't:
 * - Defeats casual "view source" / copy-paste of the UI and business logic.
 * - Does NOT protect any secret, because there is no secret to protect —
 *   every real authorization check (who can see what, who can approve what,
 *   password verification) already runs server-side in Code.gs/Admin.gs/
 *   Collection.gs, which this file never touches. A determined person can
 *   always deobfuscate client-side JS; this only raises the bar for casual
 *   copying, it is not a substitute for the server-side checks that already
 *   do the real security work.
 *
 * The XOR key travels with the file (it has to, to run in the browser) —
 * this is obfuscation, not encryption. Don't rely on it to hide anything
 * that would matter if read.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, '..', 'index.protected.html');

const html = fs.readFileSync(SRC, 'utf8');
const openTag = '<script>';
const closeTag = '</script>';
const start = html.indexOf(openTag);
const end = html.indexOf(closeTag, start);
if (start === -1 || end === -1) {
  throw new Error('Could not find the main <script> block in index.html — obfuscation aborted, nothing written.');
}

const before = html.slice(0, start);
const jsSource = html.slice(start + openTag.length, end);
const after = html.slice(end + closeTag.length);

function randomKey(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let k = '';
  for (let i = 0; i < len; i++) k += chars[Math.floor(Math.random() * chars.length)];
  return k;
}

const key = randomKey(24);
const srcBytes = Buffer.from(jsSource, 'utf8');
const keyBytes = Buffer.from(key, 'utf8');
const xored = Buffer.alloc(srcBytes.length);
for (let i = 0; i < srcBytes.length; i++) xored[i] = srcBytes[i] ^ keyBytes[i % keyBytes.length];
const payload = xored.toString('base64');

const loader = `<script>
(function(){
  var __k = ${JSON.stringify(key)};
  var __p = ${JSON.stringify(payload)};
  var bin = atob(__p);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var kb = []; for (var j = 0; j < __k.length; j++) kb.push(__k.charCodeAt(j));
  for (var i2 = 0; i2 < bytes.length; i2++) bytes[i2] ^= kb[i2 % kb.length];
  var src = new TextDecoder('utf-8').decode(bytes);
  var s = document.createElement('script');
  s.text = src;
  document.body.appendChild(s);
})();
</script>`;

fs.writeFileSync(OUT, before + loader + after);
console.log('Wrote', OUT, '(' + (xored.length / 1024).toFixed(1) + ' KB payload)');
