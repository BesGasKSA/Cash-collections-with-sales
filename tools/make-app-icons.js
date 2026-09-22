/**
 * Builds the square app icons (browser tab + phone home screen) from the
 * logo lockup embedded in index.html.
 *
 * Why: LOGO_B64 is the full lockup (emblem + both wordmarks, 555x457) drawn
 * in cream on a TRANSPARENT background. Used directly as a favicon it showed
 * as an all-white blob on light browser tabs, and the wordmarks vanish at
 * 16px. The icon is just the circular emblem (its box in the source is
 * x:148-392, y:43-287) on solid Best Gas green.
 *
 * Output: prints JSON {favicon, touch} as base64 PNGs; with --write it
 * patches index.html in place (static <link rel="icon"> + ICON_B64).
 *
 * No dependencies: PNG decode/encode via Node's built-in zlib.
 *   node tools/make-app-icons.js --write
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var GREEN = [0x4D, 0x6D, 0x51];
var CROP = { x: 148, y: 43, w: 244, h: 244 };

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('not a PNG');
  var w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) throw new Error('expected 8-bit RGBA, non-interlaced');
  var idat = [], off = 8;
  while (off < buf.length) {
    var len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  var raw = zlib.inflateSync(Buffer.concat(idat));
  var stride = w * 4, out = Buffer.alloc(w * h * 4), prev = Buffer.alloc(stride);
  for (var y = 0; y < h; y++) {
    var ft = raw[y * (stride + 1)], line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    var cur = Buffer.alloc(stride);
    for (var i = 0; i < stride; i++) {
      var a = i >= 4 ? cur[i - 4] : 0, b = prev[i], c = i >= 4 ? prev[i - 4] : 0, x = line[i], v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else { var p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      cur[i] = v & 255;
    }
    cur.copy(out, y * stride); prev = cur;
  }
  return { w: w, h: h, px: out };
}

function encodePng(w, h, rgba) {
  var raw = Buffer.alloc((w * 4 + 1) * h);
  for (var y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  function chunk(type, data) {
    var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    var td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    var crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Bilinear sample of the source (premultiplied), coordinates in source pixels.
function sample(src, sx, sy) {
  var x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0, acc = [0, 0, 0, 0];
  [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]].forEach(function (k) {
    var x = Math.min(src.w - 1, Math.max(0, x0 + k[0])), y = Math.min(src.h - 1, Math.max(0, y0 + k[1]));
    var i = (y * src.w + x) * 4, a = src.px[i + 3] / 255;
    acc[0] += src.px[i] * a * k[2]; acc[1] += src.px[i + 1] * a * k[2]; acc[2] += src.px[i + 2] * a * k[2]; acc[3] += a * k[2];
  });
  return acc; // premultiplied rgb (0-255), alpha (0-1)
}

// size: output px; radius: corner radius as a fraction of size (0 = full square);
// pad: inset of the emblem as a fraction of size.
function makeIcon(src, size, radius, pad) {
  var out = Buffer.alloc(size * size * 4), SS = 4, r = radius * size, inset = pad * size, inner = size - 2 * inset;
  function inBg(x, y) {
    if (r <= 0) return true;
    var cx = Math.min(Math.max(x, r), size - r), cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
  }
  for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
    var R = 0, G = 0, B = 0, A = 0;
    for (var j = 0; j < SS; j++) for (var i = 0; i < SS; i++) {
      var px = x + (i + 0.5) / SS, py = y + (j + 0.5) / SS;
      if (!inBg(px, py)) continue;
      var cr = GREEN[0], cg = GREEN[1], cb = GREEN[2];
      var u = (px - inset) / inner, v = (py - inset) / inner;
      if (u >= 0 && u <= 1 && v >= 0 && v <= 1) {
        var s = sample(src, CROP.x + u * CROP.w - 0.5, CROP.y + v * CROP.h - 0.5);
        cr = s[0] + cr * (1 - s[3]); cg = s[1] + cg * (1 - s[3]); cb = s[2] + cb * (1 - s[3]);
      }
      R += cr; G += cg; B += cb; A += 1;
    }
    var o = (y * size + x) * 4, n = SS * SS;
    if (A) { out[o] = Math.round(R / A); out[o + 1] = Math.round(G / A); out[o + 2] = Math.round(B / A); }
    out[o + 3] = Math.round(A / n * 255);
  }
  return encodePng(size, size, out);
}

var file = path.join(__dirname, '..', 'index.html');
var html = fs.readFileSync(file, 'utf8');
var m = /var LOGO_B64 = '([^']+)'/.exec(html);
if (!m) throw new Error('LOGO_B64 not found');
var src = decodePng(Buffer.from(m[1], 'base64'));

var favicon = makeIcon(src, 64, 0.22, 0.07).toString('base64');   // rounded tile for browser tabs
var touch = makeIcon(src, 180, 0, 0.12).toString('base64');        // full square: iOS/Android apply their own mask

if (process.argv.indexOf('--write') < 0) {
  process.stdout.write(JSON.stringify({ favicon: favicon.length, touch: touch.length }) + '\n');
  if (process.argv[2]) {
    fs.writeFileSync(path.join(process.argv[2], 'favicon.png'), Buffer.from(favicon, 'base64'));
    fs.writeFileSync(path.join(process.argv[2], 'touch.png'), Buffer.from(touch, 'base64'));
  }
  process.exit(0);
}

// Patch index.html: the static tab icon, plus an ICON_B64 constant the
// runtime uses for the apple-touch icon and the Android manifest.
var linkRe = /(<link rel="icon" type="image\/png" href="data:image\/png;base64,)[^"]+(")/;
if (!linkRe.test(html)) throw new Error('static icon link not found');
html = html.replace(linkRe, function (_, a, b) { return a + favicon + b; });
if (/var ICON_B64 = '[^']*';/.test(html)) {
  html = html.replace(/var ICON_B64 = '[^']*';/, function () { return "var ICON_B64 = '" + touch + "';"; });
} else {
  html = html.replace("var LOGO_SRC = 'data:image/png;base64,' + LOGO_B64;", function (s) {
    return "// Square app icon (emblem on solid green) for the home screen/manifest --\n" +
      "// generated by tools/make-app-icons.js; the lockup above has a transparent\n" +
      "// background and reads as a white blob at icon sizes.\n" +
      "var ICON_B64 = '" + touch + "';\n" + s;
  });
}
fs.writeFileSync(file, html);
console.log('index.html patched: favicon ' + favicon.length + ' b64 chars, touch icon ' + touch.length);
