/**
 * Risk.gs — a simple operational risk / complaint register. Anyone
 * authenticated can submit one (reporting a problem should never require
 * special permission); only company-wide roles (admin/finance/accountant/
 * operations_manager) can browse the list, and only admin/finance can
 * change its status — same authority-vs-visibility split as everything
 * else money-adjacent in this app. See CLAUDE.md.
 */

var RISK_TYPES = ['risk', 'complaint'];
var RISK_SEVERITIES = ['low', 'medium', 'high'];
var RISK_STATUSES = ['open', 'in_progress', 'resolved'];

function actionCreateRiskItem_(req, user) {
  if (RISK_TYPES.indexOf(req.type) < 0) return { ok: false, error: 'invalid_type' };
  if (!req.title) return { ok: false, error: 'invalid_input' };
  var severity = RISK_SEVERITIES.indexOf(req.severity) >= 0 ? req.severity : 'medium';

  var item = {
    id: Utilities.getUuid(),
    type: req.type,
    title: String(req.title),
    description: String(req.description || ''),
    severity: severity,
    status: 'open',
    reportedBy: user.id,
    createdAt: new Date().toISOString(),
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: ''
  };
  writeRow(SHEETS.RISK_ITEMS, item);
  logAudit_('create_risk_item', user.id, item.id);
  notifyRiskItem_(item, user);
  return { ok: true, item: item };
}

function actionListRiskItems_(req, user) {
  requireCompanyWide_(user);
  var rows = readSheet(SHEETS.RISK_ITEMS);
  if (req.status) rows = rows.filter(function (r) { return r.status === req.status; });
  if (req.type) rows = rows.filter(function (r) { return r.type === req.type; });
  rows.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return { ok: true, items: rows };
}

function actionUpdateRiskItemStatus_(req, user) {
  requireAdminOrFinance_(user);
  var item = getById_(SHEETS.RISK_ITEMS, req.id);
  if (!item) return { ok: false, error: 'not_found' };
  if (RISK_STATUSES.indexOf(req.status) < 0) return { ok: false, error: 'invalid_status' };
  item.status = req.status;
  item.resolutionNote = req.resolutionNote != null ? String(req.resolutionNote) : item.resolutionNote;
  if (req.status === 'resolved') {
    item.resolvedBy = user.id;
    item.resolvedAt = new Date().toISOString();
  } else {
    item.resolvedBy = null;
    item.resolvedAt = null;
  }
  writeRow(SHEETS.RISK_ITEMS, item);
  logAudit_('update_risk_item', user.id, item.id + ' -> ' + req.status);
  return { ok: true, item: item };
}

// A new high-severity item is worth an immediate email, same as every
// other escalation in this app — low/medium ones just sit in the list for
// whoever reviews it next, no need to interrupt anyone.
function notifyRiskItem_(item, reporter) {
  if (item.severity !== 'high') return;
  var recipients = readSheet(SHEETS.USERS).filter(function (u) { return (u.role === 'admin' || u.role === 'finance') && u.email; });
  var subject = (item.type === 'risk' ? 'خطر تشغيلي عالي الخطورة / High-severity risk reported' : 'شكوى عالية الأهمية / High-severity complaint reported');
  var body = 'العنوان: ' + item.title + '\nالوصف: ' + item.description + '\nمُبلَّغ من: ' + (reporter.name || reporter.id) + '\n\n' +
    'Title: ' + item.title + '\nDescription: ' + item.description + '\nReported by: ' + (reporter.name || reporter.id);
  recipients.forEach(function (u) {
    try { MailApp.sendEmail(u.email, subject, body); } catch (e) { /* best-effort */ }
  });
}
