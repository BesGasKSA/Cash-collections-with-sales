/**
 * Rebuilds the Apps Script global environment under Node's `vm` module so
 * Code.gs / Admin.gs / Collection.gs run unmodified, against an in-memory
 * fake Spreadsheet instead of the real Google Sheet. Same approach as the
 * rental-contracts sibling project's .gs test harness: real code, fake host.
 */
var vm = require('vm');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

function makeSheet(name) {
  var rows = []; // array of [id, jsonString, updatedAtIso]
  return {
    name: name,
    // `rows` holds every appended row INCLUDING the header (appendRow is
    // used for both), so it already equals the real sheet's last-row
    // number 1:1 — row r (1-indexed) is rows[r-1]. No "+1 for header": that
    // was double-counting it and let the header itself leak back out as a
    // phantom data row (id:"id", data:"data", updatedAt:"updatedAt").
    getLastRow: function () { return rows.length; },
    setFrozenRows: function () {},
    getRange: function (r1, c1, numRows, numCols) {
      return {
        getValues: function () {
          var out = [];
          for (var i = 0; i < numRows; i++) {
            var rowIndex = r1 - 1 + i;
            out.push(rows[rowIndex] ? rows[rowIndex].slice(c1 - 1, c1 - 1 + numCols) : ['', '', '']);
          }
          return out;
        },
        setValues: function (vals) {
          for (var i = 0; i < vals.length; i++) {
            var rowIndex = r1 - 1 + i;
            var full = rows[rowIndex] || ['', '', ''];
            for (var j = 0; j < vals[i].length; j++) full[c1 - 1 + j] = vals[i][j];
            rows[rowIndex] = full;
          }
        }
      };
    },
    appendRow: function (arr) { rows.push(arr.slice()); },
    deleteRow: function (r) { rows.splice(r - 1, 1); },
    _rows: rows
  };
}

function buildContext() {
  var sheets = {};
  var scriptProps = {};
  var cache = {};
  var driveFiles = {};
  var driveFolders = {};
  var mailLog = [];
  var idCounter = 0;

  var SpreadsheetApp = {
    getActiveSpreadsheet: function () {
      return {
        getSheetByName: function (name) { return sheets[name] || null; },
        insertSheet: function (name) { var s = makeSheet(name); sheets[name] = s; return s; }
      };
    }
  };

  var PropertiesService = {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return scriptProps.hasOwnProperty(k) ? scriptProps[k] : null; },
        setProperty: function (k, v) { scriptProps[k] = v; }
      };
    }
  };

  var CacheService = {
    getScriptCache: function () {
      return {
        get: function (k) { return cache.hasOwnProperty(k) ? cache[k] : null; },
        put: function (k, v) { cache[k] = v; },
        remove: function (k) { delete cache[k]; }
      };
    }
  };

  var LockService = {
    getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; }
  };

  function toBuf(x) { return Buffer.isBuffer(x) ? x : Buffer.from(x); }

  var Utilities = {
    getUuid: function () { idCounter++; return 'uuid-' + idCounter + '-' + crypto.randomBytes(4).toString('hex'); },
    computeHmacSha256Signature: function (payload, key) {
      return Array.from(crypto.createHmac('sha256', toBuf(key)).update(toBuf(payload)).digest());
    },
    base64EncodeWebSafe: function (bytesOrStr) {
      var buf = Array.isArray(bytesOrStr) ? Buffer.from(bytesOrStr) : Buffer.from(String(bytesOrStr));
      return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    base64DecodeWebSafe: function (str) {
      var b64 = str.replace(/-/g, '+').replace(/_/g, '/');
      return Array.from(Buffer.from(b64, 'base64'));
    },
    base64Encode: function (bytes) { return Buffer.from(bytes).toString('base64'); },
    base64Decode: function (str) { return Array.from(Buffer.from(str, 'base64')); },
    newBlob: function (bytesOrStr, mime, name) {
      var buf = Array.isArray(bytesOrStr) ? Buffer.from(bytesOrStr) : Buffer.from(String(bytesOrStr));
      var blobName = name || 'blob';
      return {
        getDataAsString: function () { return buf.toString('utf8'); },
        getBytes: function () { return Array.from(buf); },
        setName: function (n) { blobName = n; return this; },
        getName: function () { return blobName; }
      };
    }
  };

  var MailApp = { sendEmail: function (to, subject, body) { mailLog.push({ to: to, subject: subject, body: body }); } };
  var GmailApp = {
    sendEmail: function (to, subject, body, options) {
      mailLog.push({ to: to, subject: subject, body: body, from: options && options.from, fromName: options && options.name });
    }
  };

  function makeFile(id, blob) {
    var name = blob.getName ? blob.getName() : 'file';
    return {
      id: id,
      setSharing: function () { return this; },
      getId: function () { return id; },
      getBlob: function () { return blob; },
      getMimeType: function () { return 'application/octet-stream'; },
      getName: function () { return name; }
    };
  }

  var DriveApp = {
    Access: { PRIVATE: 'PRIVATE' }, Permission: { NONE: 'NONE' },
    createFolder: function (name) {
      idCounter++;
      var id = 'folder-' + idCounter;
      var folder = {
        getId: function () { return id; },
        createFile: function (blob) {
          idCounter++;
          var fid = 'file-' + idCounter;
          var f = makeFile(fid, blob);
          driveFiles[fid] = f;
          return f;
        }
      };
      driveFolders[id] = folder;
      return folder;
    },
    getFolderById: function (id) { if (!driveFolders[id]) throw new Error('no folder'); return driveFolders[id]; },
    getFileById: function (id) { if (!driveFiles[id]) throw new Error('no file'); return driveFiles[id]; }
  };

  var ContentService = {
    MimeType: { JSON: 'JSON' },
    createTextOutput: function (text) {
      return { _text: text, setMimeType: function () { return this; } };
    }
  };

  var triggers = [];
  var ScriptApp = {
    getProjectTriggers: function () { return triggers.slice(); },
    newTrigger: function (handlerFn) {
      var built = { handlerFunction: handlerFn, timeBased: false };
      var builder = {
        timeBased: function () { built.timeBased = true; return builder; },
        everyDays: function (n) { built.everyDays = n; return builder; },
        atHour: function (h) { built.atHour = h; return builder; },
        create: function () {
          var trigger = { getHandlerFunction: function () { return handlerFn; } };
          triggers.push(trigger);
          return trigger;
        }
      };
      return builder;
    }
  };

  var sandbox = {
    SpreadsheetApp: SpreadsheetApp, PropertiesService: PropertiesService, CacheService: CacheService,
    LockService: LockService, Utilities: Utilities, MailApp: MailApp, GmailApp: GmailApp, DriveApp: DriveApp,
    ContentService: ContentService, ScriptApp: ScriptApp, Logger: { log: function () {} },
    console: console
  };

  var files = ['Code.gs', 'Admin.gs', 'Collection.gs', 'Reconciliation.gs', 'Risk.gs'];
  var src = files.map(function (f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); }).join('\n');
  var context = vm.createContext(sandbox);
  vm.runInContext(src, context, { filename: 'apps-script-bundle.js' });

  context._debug = { sheets: sheets, scriptProps: scriptProps, cache: cache, mailLog: mailLog };
  return context;
}

module.exports = { buildContext: buildContext };
