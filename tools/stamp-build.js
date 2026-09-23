/**
 * Writes the current build stamp (date + short commit) into index.html, so
 * the running app can say which version it is. "Why isn't my change there?"
 * is almost always a cached copy of the page, and a visible stamp settles
 * that in one glance instead of a round of guessing.
 *
 *   node tools/stamp-build.js      (run before tools/obfuscate.js)
 */
var fs = require('fs');
var path = require('path');
var { execSync } = require('child_process');

var root = path.join(__dirname, '..');
var sha = 'local';
try { sha = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(); } catch (e) {}
var d = new Date();
function p(n) { return (n < 10 ? '0' : '') + n; }
var stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ' · ' + sha;

var file = path.join(root, 'index.html');
var html = fs.readFileSync(file, 'utf8');
if (!/var BUILD_ID = '[^']*';/.test(html)) throw new Error('BUILD_ID not found in index.html');
html = html.replace(/var BUILD_ID = '[^']*';/, "var BUILD_ID = '" + stamp + "';");
fs.writeFileSync(file, html);
console.log('build stamped: ' + stamp);
