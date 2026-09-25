/**
 * Reconciliation.gs — bank statement import and matching against recorded
 * deposits. Closes the loop between "the collector said they deposited it"
 * (handoffs of kind 'deposit', self-reported bankReference) and "the bank
 * actually shows it arrived" (an imported statement line). Admin/Finance
 * only — same authority split as dispute resolution (requireAdminOrFinance_
 * in Admin.gs), not just company-wide visibility. See CLAUDE.md.
 */

// A bank line and a deposit match when the amount is equal (to the cent)
// and the dates are within this many days of each other — deposits often
// post to the bank a day or two after being recorded here.
var RECON_DATE_WINDOW_DAYS = 3;
var RECON_AMOUNT_TOLERANCE = 0.01;

function requireReconciliationAccess_(user) {
  if (user.role !== 'admin' && user.role !== 'finance') throw new Error('forbidden');
}
// Seeing the reconciliation is wider than acting on it: the Deputy
// Operations Manager reviews it too, but only Admin/Finance import and match.
function requireReconciliationView_(user) {
  if (user.role !== 'admin' && user.role !== 'finance' && user.role !== 'deputy_operations_manager') throw new Error('forbidden');
}

function unmatchedDeposits_() {
  return readSheet(SHEETS.HANDOFFS).filter(function (h) {
    return h.kind === 'deposit' && h.status === 'completed' && !h.reconciled;
  });
}

function unmatchedBankLines_() {
  return readSheet(SHEETS.BANK_LINES).filter(function (l) { return l.status === 'unmatched'; });
}

function daysBetween_(isoA, isoB) {
  var a = new Date(isoA).getTime(), b = new Date(isoB).getTime();
  return Math.abs(a - b) / 86400000;
}

// Links one bank line to one deposit handoff both ways — never called with
// an already-matched line or an already-reconciled deposit.
function linkReconciliation_(line, deposit, user) {
  line.status = 'matched';
  line.matchedHandoffId = deposit.id;
  line.matchedAt = new Date().toISOString();
  line.matchedBy = user.id;
  writeRow(SHEETS.BANK_LINES, line);

  deposit.reconciled = true;
  deposit.reconciledAt = new Date().toISOString();
  deposit.reconciledLineId = line.id;
  writeRow(SHEETS.HANDOFFS, deposit);
}

// Runs after every import: for each unmatched line, auto-link it only when
// exactly one unmatched deposit fits (same amount, within the date window).
// An ambiguous fit (more than one candidate) is deliberately left for a
// human to resolve manually rather than guessed at.
function autoMatchBankLines_(user) {
  var lines = unmatchedBankLines_();
  var deposits = unmatchedDeposits_();
  var matched = 0;
  lines.forEach(function (line) {
    var candidates = deposits.filter(function (d) {
      return Math.abs(Number(d.amount) - Number(line.amount)) < RECON_AMOUNT_TOLERANCE &&
        daysBetween_(d.confirmedAt || d.createdAt, line.date) <= RECON_DATE_WINDOW_DAYS;
    });
    if (candidates.length === 1) {
      linkReconciliation_(line, candidates[0], user);
      deposits = deposits.filter(function (d) { return d.id !== candidates[0].id; });
      matched++;
    }
  });
  return matched;
}

function actionImportBankStatement_(req, user) {
  requireReconciliationAccess_(user);
  var rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length) return { ok: false, error: 'invalid_input' };
  if (rows.length > 1000) return { ok: false, error: 'too_many_rows' };

  var imported = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    if (!r.date || r.amount == null || r.amount === '') continue;
    writeRow(SHEETS.BANK_LINES, {
      id: Utilities.getUuid(),
      date: r.date,
      amount: Number(r.amount),
      reference: r.reference || '',
      status: 'unmatched',
      matchedHandoffId: null,
      importedBy: user.id
    });
    imported++;
  }
  var matched = autoMatchBankLines_(user);
  logAudit_('import_bank_statement', user.id, imported + ' rows, ' + matched + ' auto-matched');
  return { ok: true, imported: imported, autoMatched: matched };
}

function actionReconciliationSummary_(req, user) {
  requireReconciliationView_(user);
  var allDeposits = readSheet(SHEETS.HANDOFFS).filter(function (h) { return h.kind === 'deposit' && h.status === 'completed'; });
  var reconciledCount = allDeposits.filter(function (d) { return d.reconciled; }).length;
  var unmatchedDep = unmatchedDeposits_().sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  var unmatchedLn = unmatchedBankLines_().sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
  return {
    ok: true,
    totalDeposits: allDeposits.length,
    reconciledCount: reconciledCount,
    unmatchedDeposits: unmatchedDep,
    unmatchedLines: unmatchedLn
  };
}

function actionManualMatchReconciliation_(req, user) {
  requireReconciliationAccess_(user);
  var line = getById_(SHEETS.BANK_LINES, req.lineId);
  var deposit = getById_(SHEETS.HANDOFFS, req.handoffId);
  if (!line || !deposit) return { ok: false, error: 'not_found' };
  if (line.status !== 'unmatched') return { ok: false, error: 'line_already_matched' };
  if (deposit.kind !== 'deposit' || deposit.reconciled) return { ok: false, error: 'deposit_not_eligible' };
  linkReconciliation_(line, deposit, user);
  logAudit_('manual_match_reconciliation', user.id, line.id + ' -> ' + deposit.id);
  return { ok: true };
}

// Undoes a match — mistakes happen (wrong line picked, duplicate statement
// row). Never destructive to the deposit itself, only clears the link.
function actionUnmatchReconciliation_(req, user) {
  requireReconciliationAccess_(user);
  var line = getById_(SHEETS.BANK_LINES, req.lineId);
  if (!line) return { ok: false, error: 'not_found' };
  var deposit = line.matchedHandoffId ? getById_(SHEETS.HANDOFFS, line.matchedHandoffId) : null;

  line.status = 'unmatched';
  line.matchedHandoffId = null;
  line.matchedAt = null;
  line.matchedBy = null;
  writeRow(SHEETS.BANK_LINES, line);

  if (deposit) {
    deposit.reconciled = false;
    deposit.reconciledAt = null;
    deposit.reconciledLineId = null;
    writeRow(SHEETS.HANDOFFS, deposit);
  }
  logAudit_('unmatch_reconciliation', user.id, line.id);
  return { ok: true };
}
