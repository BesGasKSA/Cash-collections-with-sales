/**
 * MicrosoftMail.gs -- send notifications from the bestgas.sa Microsoft 365
 * mailbox through Microsoft Graph instead of MailApp.
 *
 * DEPLOY ONLY AFTER the Microsoft setup is done: this is the only file that
 * calls UrlFetchApp, which adds Google's "connect to an external service"
 * permission. Pushing it before the script owner approves that permission
 * (Run > testMicrosoftMail in the editor) can block every web-app request.
 * Code.gs sendMail_ detects whether this file is present and falls back to
 * MailApp when it is not.
 */
function graphMailConfig_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    tenant: p.getProperty('GRAPH_TENANT_ID'),
    clientId: p.getProperty('GRAPH_CLIENT_ID'),
    secret: p.getProperty('GRAPH_CLIENT_SECRET'),
    sender: p.getProperty('GRAPH_SENDER')
  };
  return (cfg.tenant && cfg.clientId && cfg.secret && cfg.sender) ? cfg : null;
}

function graphToken_(cfg) {
  var cache = CacheService.getScriptCache();
  var key = 'graphToken_' + cfg.clientId;
  var cached = cache.get(key);
  if (cached) return cached;
  var res = UrlFetchApp.fetch('https://login.microsoftonline.com/' + encodeURIComponent(cfg.tenant) + '/oauth2/v2.0/token', {
    method: 'post',
    payload: {
      client_id: cfg.clientId,
      client_secret: cfg.secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    },
    muteHttpExceptions: true
  });
  var parsed = {};
  try { parsed = JSON.parse(res.getContentText()); } catch (e) { /* non-JSON error page */ }
  if (res.getResponseCode() !== 200 || !parsed.access_token) {
    throw new Error('graph_token_failed: ' + (parsed.error_description || res.getResponseCode()));
  }
  // Refresh five minutes before Microsoft's expiry; CacheService caps at 6h.
  var ttl = Math.max(60, Math.min(21600, Number(parsed.expires_in || 3600) - 300));
  cache.put(key, parsed.access_token, ttl);
  return parsed.access_token;
}

function sendViaGraph_(cfg, to, subject, body) {
  var res = UrlFetchApp.fetch('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(cfg.sender) + '/sendMail', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + graphToken_(cfg) },
    payload: JSON.stringify({
      message: {
        subject: subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }]
      },
      saveToSentItems: true
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 202) {
    throw new Error('graph_send_failed: ' + res.getResponseCode() + ' ' + String(res.getContentText()).slice(0, 300));
  }
}


function testMicrosoftMail() {
  var cfg = graphMailConfig_();
  if (!cfg) throw new Error('Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_SENDER in Project Settings > Script properties first.');
  sendViaGraph_(cfg, cfg.sender, 'Best Gas Cash Collection — Microsoft mail test', 'If you can read this, notifications now send from ' + cfg.sender + '.');
  Logger.log('Test email sent via Microsoft Graph to ' + cfg.sender);
}

