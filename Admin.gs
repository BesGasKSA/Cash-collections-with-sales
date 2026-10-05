/**
 * Admin.gs — user management + full control over the entity hierarchy:
 * Location (parent) -> Store, Cars (children) -> POS machines (children of
 * Store or Car, each linked to the employee/driver carrying it) -> Clusters.
 * All admin* actions require role === 'admin' (enforced by requireAdmin_).
 */

var ENTITY_SHEET = {
  location: SHEETS.LOCATIONS,
  store: SHEETS.STORES,
  car: SHEETS.CARS,
  pos: SHEETS.POS,
  cluster: SHEETS.CLUSTERS,
  zone: SHEETS.ZONES,
  product: SHEETS.PRODUCTS,
  income_item: SHEETS.INCOME_ITEMS,
  expense_item: SHEETS.EXPENSE_ITEMS,
  customer: SHEETS.CUSTOMERS,
  city: SHEETS.CITIES,
  channel: SHEETS.CHANNELS,
  cost_type: SHEETS.COST_TYPES,
  // what a branch holds and counts (LPG Task 1b): the sales items name it
  stock_item: SHEETS.STOCK_ITEMS
};

// child sheet + the field on the child that points at the parent, used to
// block deletes that would orphan children.
var ENTITY_CHILDREN = {
  // a place with cost lines keeps its row, or the months already reported would lose them
  // (a voided line does not count: `live`)
  location: [{ sheet: SHEETS.STORES, field: 'locationId' }, { sheet: SHEETS.CARS, field: 'locationId' }, { sheet: SHEETS.COST_LINES, field: 'centreId', centreType: 'location', live: true }],
  store: [{ sheet: SHEETS.POS, field: 'ownerId', ownerType: 'store' }, { sheet: SHEETS.COST_LINES, field: 'centreId', centreType: 'store', live: true }],
  car: [{ sheet: SHEETS.POS, field: 'ownerId', ownerType: 'car' }, { sheet: SHEETS.COST_LINES, field: 'centreId', centreType: 'car', live: true }],
  cluster: [{ sheet: SHEETS.LOCATIONS, field: 'clusterId' }, { sheet: SHEETS.COST_LINES, field: 'centreId', centreType: 'cluster', live: true }],
  // a cost type with lines on it stays on file (deactivate instead)
  cost_type: [{ sheet: SHEETS.COST_LINES, field: 'typeId', live: true }],
  zone: [{ sheet: SHEETS.LOCATIONS, field: 'zoneId' }],
  pos: [],
  // a product with existing sales history stays selectable in entry forms
  // (deactivate instead) but blocking delete protects the report from
  // orphaned productIds it can no longer label.
  // a product holding stock counted on it before the inventory items (old moves) stays too
  product: [{ sheet: SHEETS.ENTRIES, field: 'productId' }, { sheet: SHEETS.INV_MOVES, field: 'productId' }],
  // same reasoning as product: an item already used by an entry stays
  // selectable history, so deactivate rather than delete.
  income_item: [{ sheet: SHEETS.ENTRIES, field: 'otherCashItemId' }],
  expense_item: [{ sheet: SHEETS.ENTRIES, field: 'expenseItemId' }],
  // a customer with credit history stays on file (deactivate instead)
  customer: [{ sheet: SHEETS.ENTRIES, field: 'creditCustomerId' }],
  // a channel with sales on it stays on file (deactivate instead)
  channel: [{ sheet: SHEETS.ENTRIES, field: 'channelId' }],
  // a city is referenced by name, not id — see actionAdminDeleteEntity_
  city: [],
  // an inventory item with movements, or one a sales item sells from or takes back, stays on file
  stock_item: [{ sheet: SHEETS.INV_MOVES, field: 'stockItemId' }, { sheet: SHEETS.PRODUCTS, field: 'stockItemId' }, { sheet: SHEETS.PRODUCTS, field: 'returnItemId' }]
};

function requireAdmin_(user) {
  if (user.role !== 'admin') throw new Error('forbidden');
}
// Every module but the user accounts: the admin and the finance manager
// (2026-09-29). Creating, changing and inviting users stays with the admin.
function requireManager_(user) {
  if (user.role !== 'admin' && user.role !== 'finance') throw new Error('forbidden');
}
function requireAdminOrFinance_(user) {
  if (user.role !== 'admin' && user.role !== 'finance') throw new Error('forbidden');
}

// Company-wide *visibility* (dashboard/report/audit) is broader than
// company-wide *authority* (resolving disputes, managing users/entities).
// Accountant and Operations Manager can see everything Finance/Admin see,
// but only Admin/Finance can act on a dispute — deliberately kept on
// requireAdminOrFinance_ above, not folded into this. Deputy Operations
// Manager (added with the area-manager bulk-upload feature) is a second
// worked example of the same split: full company-wide visibility, but its
// only *authority* is approving/rejecting a bulk batch — gated separately
// in Collection.gs, never implied by membership here. See CLAUDE.md.
var COMPANY_WIDE_ROLES = ['admin', 'finance', 'accountant', 'operations_manager', 'deputy_operations_manager'];
function isCompanyWide_(role) { return COMPANY_WIDE_ROLES.indexOf(role) >= 0; }
function requireCompanyWide_(user) {
  if (!isCompanyWide_(user.role)) throw new Error('forbidden');
}

// ---------- Users ----------

function validRole_(r) {
  return ['admin', 'finance', 'accountant', 'operations_manager', 'deputy_operations_manager', 'cluster_manager', 'store_manager', 'collector', 'driver', 'branch_worker'].indexOf(r) >= 0;
}

// New users are *invited*, not handed a temporary password: the email carries
// a single-use link, the person picks their own password on the accept page,
// and their status moves invited -> accepted (link used) -> active (first
// real sign-in). See userStatus_ in Code.gs for how the admin list reads it.
function actionAdminCreateUser_(req, user) {
  requireAdmin_(user);
  var d = req.data || {};
  var email = String(d.email || '').trim(), iq = normIqama_(d.iqamaId);
  if (!String(d.name || '').trim()) return { ok: false, error: 'name_required' };
  // an email sends an invitation; an iqama number gives a temporary password
  if (!email && !iq) return { ok: false, error: 'login_required' };
  if (!validRole_(d.role)) return { ok: false, error: 'role_required' };
  if (email && userByEmail_(email)) return { ok: false, error: 'email_exists' };
  if (iq && userByIqama_(iq)) return { ok: false, error: 'iqama_exists' };
  if (!email) return createIqamaUser_(d, iq, user);

  var newUser = {
    id: Utilities.getUuid(),
    name: d.name,
    email: String(d.email).trim(),
    role: d.role,
    active: true,
    language: d.language || 'en', languageChosen: !!d.language,
    locationId: d.locationId || null,
    clusterId: d.clusterId || null,
    iqamaId: d.iqamaId || null,
    salt: null,
    pass: null,
    mustChangePw: false,
    createdAt: new Date().toISOString()
  };
  var token = issueInvite_(newUser, user);
  // the employee number and the write under one lock
  var userLock = LockService.getScriptLock();
  userLock.waitLock(30000);
  try {
    freshenExec_();
    newUser.code = nextCode_('user');
    writeRow(SHEETS.USERS, newUser);
  } finally {
    try { userLock.releaseLock(); } catch (e) {}
  }
  var base = inviteAppUrl_(req);
  var sent = sendInvitation_(newUser, token, user, base);
  logAudit_('admin_invite_user', user.id, newUser.id);
  fillTranslations_(translatableOf_({ name: newUser.name }));
  return { ok: true, user: publicUser_(newUser), inviteSent: sent, inviteUrl: base + '?invite=' + encodeURIComponent(token) };
}

var INVITE_TTL_DAYS = 7;
var DEFAULT_APP_URL = 'https://besgasksa.github.io/Cash-collections-with-sales/';

// Stamps a fresh single-use invitation on u (caller writes the row). Only a
// keyed hash of the token is stored, so a copy of the Users sheet can't be
// turned into working invitation links.
function issueInvite_(u, inviter) {
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/[^A-Za-z0-9]/g, '');
  var now = Date.now();
  u.inviteStatus = 'invited';
  u.inviteTokenHash = inviteHash_(token);
  u.invitedAt = new Date(now).toISOString();
  u.invitedBy = inviter ? inviter.id : (u.invitedBy || null);
  u.inviteExpiresAt = new Date(now + INVITE_TTL_DAYS * 86400000).toISOString();
  return token;
}

function inviteHash_(token) {
  return 'i1:' + hmac_(String(token), secret_() + '|invite');
}

function userByInviteToken_(token) {
  if (!token || String(token).length < 20) return null;
  var h = inviteHash_(token);
  var rows = readSheet(SHEETS.USERS);
  for (var i = 0; i < rows.length; i++) if (rows[i].inviteTokenHash === h) return rows[i];
  return null;
}

// The accept link points back at whichever copy of the client the admin is
// using: the live site or a local preview. Nothing else: an invitation email
// is genuine company mail, and a link to someone else's site would hand them
// the one-time token (2026-09-28).
function inviteAppUrl_(req) {
  var u = String((req && req.appUrl) || '').split('#')[0].split('?')[0];
  if (u.indexOf(DEFAULT_APP_URL) === 0 && /^[^\s"'<>]+$/.test(u) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>]*$/.test(u)) {
    return /\/$/.test(u) ? u : u.replace(/[^\/]*$/, '');
  }
  return DEFAULT_APP_URL;
}

// Resend (new link, fresh 7 days; the old link stops working). Only for
// people who haven't set a password through an invitation yet.
function actionAdminResendInvite_(req, user) {
  requireAdmin_(user);
  var target = getById_(SHEETS.USERS, req.id);
  if (!target) return { ok: false, error: 'not_found' };
  if (target.active === false) return { ok: false, error: 'user_inactive' };
  var st = userStatus_(target);
  if (st !== 'invited' && st !== 'invite_expired') return { ok: false, error: 'already_accepted' };
  var token = issueInvite_(target, user);
  writeRow(SHEETS.USERS, target);
  var base2 = inviteAppUrl_(req);
  var sent = sendInvitation_(target, token, user, base2);
  logAudit_('admin_resend_invite', user.id, target.id);
  return { ok: true, user: publicUser_(target), inviteSent: sent, inviteUrl: base2 + '?invite=' + encodeURIComponent(token) };
}

// Public (no session): what the accept page needs to greet the person.
function actionInviteInfo_(req) {
  var u = userByInviteToken_(req.inviteToken);
  if (!u) return { ok: true, status: 'invalid' };
  var st = inviteTokenState_(u);
  var out = { ok: true, status: st, language: userLang_(u) };
  if (st === 'valid') {
    out.name = u.name; out.email = u.email; out.role = u.role; out.expiresAt = u.inviteExpiresAt;
    var inviter = u.invitedBy ? getById_(SHEETS.USERS, u.invitedBy) : null;
    out.inviterName = inviter ? inviter.name : null;
  }
  if (st === 'used') out.email = u.email;
  return out;
}

function inviteTokenState_(u) {
  if (u.active === false) return 'invalid';
  if (u.inviteStatus !== 'invited') return 'used';
  if (u.inviteExpiresAt && new Date(u.inviteExpiresAt).getTime() < Date.now()) return 'expired';
  return 'valid';
}

// Public (no session): the person accepts and sets their own password.
function actionAcceptInvite_(req) {
  var u = userByInviteToken_(req.inviteToken);
  if (!u) return { ok: false, error: 'invite_invalid' };
  var st = inviteTokenState_(u);
  if (st === 'used') return { ok: false, error: 'invite_used' };
  if (st === 'expired') return { ok: false, error: 'invite_expired' };
  if (st !== 'valid') return { ok: false, error: 'invite_invalid' };
  var pw = String(req.password || '').trim();
  if (pw.length < 8) return { ok: false, error: 'weak_password' };
  var salt = randomSalt_();
  u.salt = salt;
  u.pass = hashPw_(pw, salt);
  u.mustChangePw = false;
  u.inviteStatus = 'accepted';
  u.acceptedAt = new Date().toISOString();
  writeRow(SHEETS.USERS, u);
  logAudit_('invite_accepted', u.id, null);
  return { ok: true, email: u.email };
}

var ROLE_NAMES_ = {
  admin: ['مدير النظام', 'System Administrator', 'سسٹم ایڈمن'],
  finance: ['المالية', 'Finance', 'فنانس'],
  accountant: ['محاسب', 'Accountant', 'اکاؤنٹنٹ'],
  operations_manager: ['مدير العمليات', 'Operations Manager', 'آپریشنز منیجر'],
  deputy_operations_manager: ['نائب مدير العمليات', 'Deputy Operations Manager', 'نائب آپریشنز منیجر'],
  cluster_manager: ['مدير منطقة', 'Area Manager', 'علاقہ منیجر'],
  store_manager: ['مدير فرع', 'Branch Manager', 'برانچ منیجر'],
  collector: ['المحصّل', 'Collector', 'کلکٹر'],
  driver: ['السائق', 'Driver', 'ڈرائیور'],
  branch_worker: ['عامل فرع', 'Branch Worker', 'برانچ ورکر']
};

function htmlEsc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Returns true when the email went out. A failure never blocks the account:
// the admin sees 'not sent' and can press Resend.
// The invitation, in the invitee's own language (their language setting):
// one greeting, one sentence, what they are joining, one button, the three
// steps that follow, and the link written out in case the button fails.
var INVITE_COPY_ = {
  ar: {
    dir: 'rtl', align: 'right',
    subject: 'دعوة للانضمام إلى نظام تحصيل النقدية | الناقل الأفضل للغاز',
    pre: '{who} أضافك بصفتك {role}. اضغط «قبول الدعوة» واختر كلمة المرور.',
    hi: 'أهلاً {name}،',
    lead: '{who} أضافك إلى نظام تحصيل النقدية في الناقل الأفضل للغاز بصفتك {role}.',
    email: 'البريد', role: 'الصلاحية', until: 'الدعوة صالحة حتى',
    button: 'قبول الدعوة',
    steps: ['اضغط «قبول الدعوة».', 'اختر كلمة مرور من 8 أحرف أو أكثر.', 'ادخل إلى النظام ببريدك وكلمة المرور الجديدة.'],
    fallback: 'إذا لم يعمل الزر، انسخ هذا الرابط وافتحه في المتصفح:',
    foot: 'هذا الرابط لك وحدك، ويعمل مرة واحدة حتى {date}. إذا لم تكن تنتظر هذه الدعوة فتجاهل هذه الرسالة.',
    other: 'You are invited to Best Gas Collections. Tap the green button to accept.',
    otherDir: 'ltr', org: 'الناقل الأفضل للغاز'
  },
  en: {
    dir: 'ltr', align: 'left',
    subject: 'You\'re invited to Best Gas Collections',
    pre: '{who} added you as {role}. Tap Accept invitation and choose your password.',
    hi: 'Hello {name},',
    lead: '{who} added you to Best Gas Collections as {role}.',
    email: 'Email', role: 'Role', until: 'Invitation valid until',
    button: 'Accept invitation',
    steps: ['Tap Accept invitation.', 'Choose a password of 8 or more characters.', 'Sign in with your email and new password.'],
    fallback: 'If the button does not work, copy this link into your browser:',
    foot: 'This link is yours alone and works once, until {date}. If you were not expecting it, ignore this email.',
    other: 'دعوة للانضمام إلى نظام تحصيل النقدية. اضغط الزر الأخضر لقبولها.',
    otherDir: 'rtl', org: 'Best Gas Carrier Co.'
  },
  ur: {
    dir: 'rtl', align: 'right',
    subject: 'بیسٹ گیس کیش کلیکشن میں شمولیت کی دعوت',
    pre: '{who} نے آپ کو بطور {role} شامل کیا ہے۔ «دعوت قبول کریں» پر ٹیپ کریں۔',
    hi: 'السلام علیکم {name}،',
    lead: '{who} نے آپ کو بیسٹ گیس کیش کلیکشن سسٹم میں بطور {role} شامل کیا ہے۔',
    email: 'ای میل', role: 'کردار', until: 'دعوت کی آخری تاریخ',
    button: 'دعوت قبول کریں',
    steps: ['«دعوت قبول کریں» پر ٹیپ کریں۔', 'کم از کم 8 حروف کا پاس ورڈ منتخب کریں۔', 'اپنی ای میل اور نئے پاس ورڈ سے لاگ اِن کریں۔'],
    fallback: 'اگر بٹن کام نہ کرے تو یہ لنک کاپی کر کے براؤزر میں کھولیں:',
    foot: 'یہ لنک صرف آپ کے لیے ہے اور {date} تک ایک بار کام کرتا ہے۔ اگر آپ کو اس کی توقع نہیں تھی تو اس ای میل کو نظر انداز کریں۔',
    other: 'You are invited to Best Gas Collections. Tap the green button to accept.',
    otherDir: 'ltr', org: 'بیسٹ گیس'
  }
};
function inviteCopy_(lang) { return INVITE_COPY_[lang] || INVITE_COPY_.ar; }
function roleNameIn_(role, lang) {
  var r = ROLE_NAMES_[role] || [role, role, role];
  return lang === 'en' ? r[1] : lang === 'ur' ? (r[2] || r[1]) : r[0];
}
// The name to greet someone by: the first word, kept together with the word
// after it when that first word is عبد, أبو, أم, بن and the like.
function firstName_(name) {
  var p = String(name || '').trim().split(/\s+/);
  if (p.length > 1 && /^(\u0639\u0628\u062F|\u0623\u0628\u0648|\u0627\u0628\u0648|\u0623\u0645|\u0627\u0645|\u0628\u0646|\u0627\u0628\u0646|\u0628\u0646\u062A|\u0622\u0644)$/.test(p[0])) return p[0] + ' ' + p[1];
  return p[0] || '';
}
function fill_(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
}

function sendInvitation_(u, token, inviter, appUrl) {
  var link = appUrl + '?invite=' + encodeURIComponent(token);
  var lang = userLang_(u);
  var c = inviteCopy_(lang);
  var who = inviter && inviter.name ? inviter.name : 'Best Gas';
  var expTxt = String(u.inviteExpiresAt || '').slice(0, 10);
  var vars = { who: who, role: roleNameIn_(u.role, lang), name: firstName_(u.name), date: expTxt };
  var text = [
    fill_(c.hi, vars), '',
    fill_(c.lead, vars), '',
    c.steps.map(function (st, i) { return (i + 1) + '. ' + st; }).join('\n'), '',
    link, '',
    c.email + ': ' + u.email,
    c.until + ': ' + expTxt, '',
    fill_(c.foot, vars), '',
    c.other
  ].join('\n');
  try {
    sendMail_(u.email, c.subject, text, inviteEmailHtml_(u, link, c, vars, appUrl));
    return true;
  } catch (e) {
    logAudit_('invite_email_failed', u.id, String(e));
    return false;
  }
}

// Table layout with inline styles, as every mail client needs, but fluid:
// the card is 100% wide up to 560px, so a phone never scrolls sideways;
// Outlook for Windows, which ignores max-width, gets a fixed 560px table
// through a conditional comment. Arabic text carries no letter-spacing (it
// would break the letters apart). The logo is a hosted PNG next to the app;
// the organisation's name under it still carries the brand when images are
// blocked.
function inviteEmailHtml_(u, link, c, vars, appUrl) {
  var G = '#4D6D51', DEEP = '#23372A', CREAM = '#F2EEE4', INK = '#1B231D', BODY = '#3F4A42', MUTED = '#5E6A60', LINE = '#E3DED1';
  var e = htmlEsc_, L = e(link);
  var rtl = c.dir === 'rtl';
  var FONT = rtl ? "Tahoma,'Segoe UI',Arial,sans-serif" : "'Segoe UI',Helvetica,Arial,sans-serif";
  var dirAttr = ' dir="' + c.dir + '"';
  function button(label) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">' +
      '<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="' + L + '" style="height:54px;v-text-anchor:middle;width:320px;" arcsize="26%" stroke="f" fillcolor="' + G + '">' +
      '<w:anchorlock/><center style="color:#ffffff;font-family:Tahoma,Arial,sans-serif;font-size:17px;font-weight:bold;">' + e(label) + '</center></v:roundrect><![endif]-->' +
      '<!--[if !mso]><!-- --><a href="' + L + '" target="_blank" style="display:block;max-width:360px;margin:0 auto;background:' + G + ';color:#ffffff;font-family:' + FONT + ';font-size:17px;font-weight:bold;line-height:54px;text-align:center;text-decoration:none;border-radius:14px;">' + e(label) + '</a><!--<![endif]-->' +
    '</td></tr></table>';
  }
  function fact(label, value, ltrValue) {
    return '<tr><td' + dirAttr + ' style="padding:9px 16px;font-family:' + FONT + ';font-size:13px;color:' + MUTED + ';text-align:' + c.align + ';">' + e(label) + '</td>' +
      '<td' + dirAttr + ' style="padding:9px 16px;font-family:' + FONT + ';font-size:14px;font-weight:bold;color:' + INK + ';text-align:' + (rtl ? 'left' : 'right') + ';">' +
      (ltrValue ? '<span dir="ltr">' + e(value) + '</span>' : e(value)) + '</td></tr>';
  }
  function step(n, textStr) {
    return '<tr><td width="34" valign="top" style="padding:0 0 12px;"><div style="width:26px;height:26px;border-radius:13px;background:' + CREAM + ';color:' + G + ';font-family:Arial,sans-serif;font-size:13px;font-weight:bold;line-height:26px;text-align:center;">' + n + '</div></td>' +
      '<td' + dirAttr + ' valign="top" style="padding:3px 0 12px;font-family:' + FONT + ';font-size:14.5px;line-height:1.6;color:' + BODY + ';text-align:' + c.align + ';">' + e(textStr) + '</td></tr>';
  }
  return '<!DOCTYPE html><html lang="' + (c === INVITE_COPY_.en ? 'en' : c === INVITE_COPY_.ur ? 'ur' : 'ar') + '"' + dirAttr + ' xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>' +
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->' +
    '<title>' + e(c.subject) + '</title></head>' +
    '<body style="margin:0;padding:0;background:' + CREAM + ';">' +
    '<div style="display:none;max-height:0;overflow:hidden;">' + e(fill_(c.pre, vars)) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + CREAM + ';"><tr><td align="center" style="padding:24px 12px 32px;">' +
    '<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#ffffff;border-radius:22px;overflow:hidden;">' +
      // the brand, small and settled
      '<tr><td align="center" bgcolor="' + DEEP + '" style="background:' + DEEP + ';padding:26px 20px 22px;">' +
        '<img src="' + e(appUrl) + 'assets/mail-logo.png" width="64" height="64" alt="' + e(c.org) + '" style="display:block;margin:0 auto 12px;border:0;border-radius:16px;">' +
        '<div style="font-family:Tahoma,Arial,sans-serif;color:#ffffff;font-size:17px;font-weight:bold;">' + e(c.org) + '</div>' +
      '</td></tr>' +
      // the greeting and the one sentence
      '<tr><td' + dirAttr + ' style="padding:30px 26px 0;font-family:' + FONT + ';text-align:' + c.align + ';">' +
        '<div style="font-size:24px;font-weight:bold;line-height:1.35;color:' + INK + ';">' + e(fill_(c.hi, vars)) + '</div>' +
        '<div style="font-size:16px;line-height:1.85;color:' + BODY + ';margin-top:10px;">' + e(fill_(c.lead, vars)) + '</div>' +
      '</td></tr>' +
      // what they are joining
      '<tr><td style="padding:20px 26px 0;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + CREAM + ';border-radius:14px;">' +
          '<tr><td colspan="2" style="height:6px;line-height:6px;font-size:6px;">&nbsp;</td></tr>' +
          fact(c.role, vars.role) + fact(c.email, u.email, true) + fact(c.until, vars.date, true) +
          '<tr><td colspan="2" style="height:6px;line-height:6px;font-size:6px;">&nbsp;</td></tr>' +
        '</table>' +
      '</td></tr>' +
      // the one action
      '<tr><td style="padding:24px 26px 0;">' + button(c.button) + '</td></tr>' +
      // what happens next
      '<tr><td style="padding:24px 26px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"' + dirAttr + '>' +
        c.steps.map(function (st, i) { return step(i + 1, st); }).join('') +
      '</table></td></tr>' +
      // the link, written out
      '<tr><td' + dirAttr + ' style="padding:4px 26px 26px;font-family:' + FONT + ';font-size:12.5px;line-height:1.7;color:' + MUTED + ';text-align:' + c.align + ';">' + e(c.fallback) +
        '<div dir="ltr" style="margin-top:4px;font-family:Arial,sans-serif;font-size:12px;word-break:break-all;text-align:left;"><a href="' + L + '" style="color:' + G + ';">' + L + '</a></div>' +
      '</td></tr>' +
      '<tr><td' + dirAttr + ' style="padding:16px 26px 20px;border-top:1px solid ' + LINE + ';font-family:' + FONT + ';font-size:12px;line-height:1.8;color:' + MUTED + ';text-align:' + c.align + ';">' + e(fill_(c.foot, vars)) + '</td></tr>' +
    '</table>' +
    '<!--[if mso]></td></tr></table><![endif]-->' +
    '<div dir="' + c.otherDir + '" style="max-width:560px;margin:14px auto 0;font-family:Tahoma,Arial,sans-serif;font-size:12px;line-height:1.7;color:' + MUTED + ';text-align:center;">' + e(c.other) + '</div>' +
    '</td></tr></table></body></html>';
}

// Every link in the chain a person is named on.
function userAssignments_(userId) {
  var out = [];
  readSheet(SHEETS.CLUSTERS).forEach(function (c) { if (c.clusterManagerUserId === userId || c.collectorUserId === userId) out.push(c.id); });
  readSheet(SHEETS.LOCATIONS).forEach(function (l) { if (l.collectorUserId === userId) out.push(l.id); });
  readSheet(SHEETS.STORES).forEach(function (s) { if (s.storeManagerUserId === userId) out.push(s.id); });
  readSheet(SHEETS.CARS).forEach(function (c) { if (c.driverUserId === userId) out.push(c.id); });
  readSheet(SHEETS.POS).forEach(function (p) { if (p.assignedUserId === userId) out.push(p.id); });
  return out;
}

function actionAdminUpdateUser_(req, user) {
  requireAdmin_(user);
  var target = getById_(SHEETS.USERS, req.id);
  if (!target) return { ok: false, error: 'not_found' };
  var d = req.data || {};
  if (d.name != null) {
    if (!String(d.name).trim()) return { ok: false, error: 'name_required' };
    target.name = d.name;
  }
  if (d.iqamaId !== undefined) {
    var iqn = normIqama_(d.iqamaId);
    // without email the iqama number is how this person signs in
    if (!iqn && !String(d.email != null ? d.email : target.email || '').trim()) return { ok: false, error: 'login_required' };
    var iqOwner = iqn ? userByIqama_(iqn) : null;
    if (iqOwner && iqOwner.id !== target.id) return { ok: false, error: 'iqama_exists' };
    d.iqamaId = iqn || null;
  }
  if (d.email != null) {
    var email = String(d.email).trim();
    // an account signing in by iqama may have no email
    if (!email && !(d.iqamaId !== undefined ? d.iqamaId : target.iqamaId)) return { ok: false, error: 'login_required' };
    var existing = email ? userByEmail_(email) : null;
    if (existing && existing.id !== target.id) return { ok: false, error: 'email_exists' };
    if (String(target.email || '').trim().toLowerCase() !== email.toLowerCase()) bumpEpoch_(target);
    target.email = email;
  }
  var roleChange = d.role != null && d.role !== target.role;
  var disabling = d.active != null && !d.active && target.active !== false;
  if (roleChange || disabling) {
    // an admin cannot lock themselves out, and the company always keeps one
    if (target.id === user.id) return { ok: false, error: 'cannot_change_self' };
    if (target.role === 'admin') {
      var otherAdmins = readSheet(SHEETS.USERS).filter(function (u) { return u.role === 'admin' && u.active !== false && u.id !== target.id; });
      if (!otherAdmins.length) return { ok: false, error: 'last_admin' };
    }
    // someone holding cash or with a handover open keeps their role and
    // access until it is passed on, or it would be stuck with nobody able to move it
    if (personBusy_(target.id)) return { ok: false, error: 'person_holds_cash' };
  }
  if (roleChange && userAssignments_(target.id).length) return { ok: false, error: 'user_has_assignments' };
  if (d.role != null) {
    if (!validRole_(d.role)) return { ok: false, error: 'role_required' };
    target.role = d.role;
  }
  if (d.language != null) { target.language = d.language; target.languageChosen = true; }
  if (d.active != null) target.active = !!d.active;
  if (d.locationId !== undefined) target.locationId = d.locationId;
  if (d.clusterId !== undefined) target.clusterId = d.clusterId;
  if (d.iqamaId !== undefined) target.iqamaId = d.iqamaId;
  writeRow(SHEETS.USERS, target);
  logAudit_('admin_update_user', user.id, target.id);
  fillTranslations_(translatableOf_({ name: target.name }));
  return { ok: true, user: publicUser_(target) };
}

// An account with no email: no invitation can reach it, so it starts with a
// temporary password the admin hands over, changed at the first sign-in.
// easy to read out and type on a phone: no 0/o, 1/l/i
function readablePassword_() {
  var abc = 'abcdefghjkmnpqrstuvwxyz23456789', out = '';
  // from UUID randomness, not Math.random (security review 2026-10-04)
  var hex = (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  for (var i = 0; i < 10; i++) out += abc.charAt(parseInt(hex.substr(i * 4, 4), 16) % abc.length);
  return out;
}
function createIqamaUser_(d, iq, user) {
  var temp = readablePassword_(), salt = randomSalt_();
  var newUser = {
    id: Utilities.getUuid(), name: String(d.name).trim(), email: '', role: d.role, active: true,
    language: d.language || 'en', languageChosen: !!d.language, locationId: d.locationId || null, clusterId: d.clusterId || null,
    iqamaId: iq, salt: salt, pass: hashPw_(temp, salt), mustChangePw: true,
    inviteStatus: 'accepted', createdAt: new Date().toISOString()
  };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { freshenExec_(); newUser.code = nextCode_('user'); writeRow(SHEETS.USERS, newUser); }
  finally { try { lock.releaseLock(); } catch (e) {} }
  logAudit_('admin_create_user_iqama', user.id, newUser.id);
  return { ok: true, user: publicUser_(newUser), tempPassword: temp };
}

// Drivers from a sheet: [{name, iqamaId, role, locationId, language}]. Each
// row goes through the same checks as the form; every new account comes back
// with its temporary password, and a refused row says why.
function actionAdminImportUsers_(req, user) {
  requireAdmin_(user);
  var rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length || rows.length > 300) return { ok: false, error: rows.length ? 'too_many_rows' : 'invalid_input' };
  var created = 0, results = [];
  rows.forEach(function (r, i) {
    var res;
    try { res = actionAdminCreateUser_({ data: r || {} }, user); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (res.ok) created++;
    results.push({ row: i, ok: !!res.ok, error: res.error || null, id: res.user ? res.user.id : null,
      code: res.user ? res.user.code : null, tempPassword: res.tempPassword || null });
  });
  fillTranslations_([].concat.apply([], rows.map(function (r) { return translatableOf_({ name: r && r.name }); })));
  logAudit_('admin_import_users', user.id, created + '/' + rows.length);
  return { ok: true, created: created, total: rows.length, results: results };
}

var RESET_TTL_MS_ = 3 * 86400000;
function actionAdminResetPassword_(req, user) {
  requireAdmin_(user);
  var target = getById_(SHEETS.USERS, req.id);
  if (!target) return { ok: false, error: 'not_found' };
  if (!String(target.email || '').trim()) {
    // nothing to email: the admin reads the new password off the screen
    var t2 = readablePassword_(), s2 = randomSalt_();
    // like "forgot password" (security review 2026-10-04): the current one keeps
    // working, the temporary one lasts three days and is changed at first use
    target.resetSalt = s2; target.resetPass = hashPw_(t2, s2); target.resetExpires = Date.now() + RESET_TTL_MS_;
    bumpEpoch_(target);
    writeRow(SHEETS.USERS, target);
    logAudit_('admin_reset_password', user.id, target.id);
    return { ok: true, tempPassword: t2 };
  }
  // Someone who never accepted their invitation gets a fresh invitation,
  // not a temporary password that would skip the accept step.
  if (target.inviteStatus === 'invited') return actionAdminResendInvite_(req, user);
  var temp = randomPassword_();
  var salt = randomSalt_();
  // the emailed temporary sign-in expires and does not replace the current one
  target.resetSalt = salt;
  target.resetPass = hashPw_(temp, salt);
  target.resetExpires = Date.now() + RESET_TTL_MS_;
  bumpEpoch_(target);   // the person's sessions end
  writeRow(SHEETS.USERS, target);
  sendInvite_(target, temp);
  logAudit_('admin_reset_password', user.id, target.id);
  return { ok: true };
}

function sendInvite_(u, tempPassword) {
  var cfg = config_();
  var subject = (cfg.senderName || 'Best Gas Collections') + ' — بيانات الدخول / Login details';
  var body = [
    'مرحباً ' + u.name + ' / Hello ' + u.name,
    '',
    'البريد / Email: ' + u.email,
    'كلمة المرور المؤقتة / Temporary password: ' + tempPassword,
    '',
    'سيُطلب منك تغييرها عند أول دخول.',
    'You will be asked to change it on first login.'
  ].join('\n');
  try {
    sendMail_(u.email, subject, body);
  } catch (e) {
    // email quota/misconfiguration must not block account creation
    logAudit_('invite_email_failed', u.id, String(e));
  }
}

// ---------- Generic hierarchy CRUD (location / store / car / pos / cluster) ----------

// Structural conflict-of-interest guards: the same person may never hold
// two roles that would let them approve their own handoff (see also the
// runtime checks in Collection.gs at handoff-creation and confirm time).
// The picker offers only the right role, but the picker is the client's
// word for it; this is the server's.
function userHasRole_(userId, role) {
  var u = getById_(SHEETS.USERS, userId);
  if (!u || u.active === false) return false;
  // An admin may stand in for any position while the org is being set up or
  // while somebody is away; the conflict-of-interest checks still apply to
  // them exactly as they do to anyone else.
  return u.role === role || u.role === 'admin';
}

// A delivery fee and a driver commission per unit of each product, for a
// credit customer or a sales channel: products that exist, never negative.
function perUnitRatesError_(d) {
  var perUnit = ['deliveryFees', 'commissions'];
  for (var mi = 0; mi < perUnit.length; mi++) {
    var map = d[perUnit[mi]];
    if (map == null) continue;
    if (typeof map !== 'object' || Array.isArray(map)) return 'invalid_input';
    var pk = safeOwnKeys_(map);
    if (pk.length > 300) return 'invalid_input';
    for (var pi = 0; pi < pk.length; pi++) {
      var pv = map[pk[pi]];
      if (pv === '' || pv == null) { delete map[pk[pi]]; continue; }
      if (!getById_(SHEETS.PRODUCTS, pk[pi])) return 'invalid_product';
      if (!isFinite(Number(pv)) || Number(pv) < 0) return 'invalid_amount';
      map[pk[pi]] = Math.round(Number(pv) * 100) / 100;
    }
  }
  return null;
}

function validateEntity_(kind, d) {
  if (kind === 'customer') {
    if (!String(d.name || '').trim()) return 'name_required';
    if (customerDuplicateOf_(d.name, d.id)) return 'duplicate_customer';
    // the customer's delivery fee per unit, product by product; it is added
    // to their credit lines on its own (special prices were dropped 2026-09-29)
    // and the driver's commission per unit (2026-09-29)
    return perUnitRatesError_(d);
  }
  if (kind === 'channel') {
    if (!String(d.name || '').trim()) return 'name_required';
    return perUnitRatesError_(d);
  }
  if (kind === 'city') {
    if (!String(d.name || '').trim()) return 'name_required';
    if (cityDuplicateOf_(d.name, d.id)) return 'duplicate_city';
    return null;
  }
  if (kind === 'location') {
    if (!d.city) return 'city_required';
    if (!d.name) return 'name_required';
    // a map position is both numbers, in range, or neither
    var hasLat = d.lat != null && d.lat !== '', hasLng = d.lng != null && d.lng !== '';
    if (hasLat || hasLng) {
      var la = Number(d.lat), ln = Number(d.lng);
      if (!hasLat || !hasLng || !isFinite(la) || !isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) return 'invalid_coordinates';
    }
    // Every branch hands its cash to one collector: its own, or (a branch
    // saved before collectors moved to branches) its area's.
    var locCluster = d.clusterId ? getById_(SHEETS.CLUSTERS, d.clusterId) : null;
    if (d.clusterId && !locCluster) return 'invalid_cluster';
    if (!d.collectorUserId && !(locCluster && locCluster.collectorUserId)) return 'collector_required';
    if (d.collectorUserId) {
      if (!userHasRole_(d.collectorUserId, 'collector')) return 'wrong_role';
      if (locCluster && locCluster.clusterManagerUserId === d.collectorUserId) return 'conflict_of_interest';
      // one person, one area: a collector's branches all sit in one area,
      // A collector may serve branches in any number of areas (changed
      // 2026-09-29: one collector can cover every area). Nobody collects
      // while managing an area, though.
      var manages = readSheet(SHEETS.CLUSTERS).some(function (c) { return c.clusterManagerUserId === d.collectorUserId; });
      if (manages) return 'user_in_other_area';
    }
  } else if (kind === 'store') {
    if (!d.locationId) return 'branch_required';
    if (!d.name) return 'name_required';
    // A branch with no manager has nobody to hand its cash to.
    if (!d.storeManagerUserId) return 'manager_required';
    var loc = getById_(SHEETS.LOCATIONS, d.locationId);
    if (!loc) return 'invalid_location';
    if (d.storeManagerUserId && loc.clusterId) {
      var storeCluster = getById_(SHEETS.CLUSTERS, loc.clusterId);
      if (storeCluster && (d.storeManagerUserId === storeCluster.clusterManagerUserId || d.storeManagerUserId === branchCollector_(d.locationId))) {
        return 'conflict_of_interest';
      }
    }
    if (!userHasRole_(d.storeManagerUserId, 'store_manager')) return 'wrong_role';
  } else if (kind === 'car') {
    if (!d.locationId) return 'branch_required';
    if (!d.label) return 'label_required';
    if (!d.driverUserId) return 'driver_required';
    if (!userHasRole_(d.driverUserId, 'driver')) return 'wrong_role';
    if (!getById_(SHEETS.LOCATIONS, d.locationId)) return 'invalid_location';
  } else if (kind === 'pos') {
    if (!d.ownerType || !d.ownerId) return 'owner_required';
    if (!d.label) return 'label_required';
    // Somebody carries every machine, and their name is who the cash on it
    // is traced to.
    // a user account, or (for the many cashiers without one) a name and iqama
    if (!d.assignedUserId && !String(d.holderName || '').trim()) return 'holder_required';
    // the person carrying the machine: a driver, a branch worker or the branch manager
    if (d.assignedUserId && !userHasRole_(d.assignedUserId, 'driver') && !userHasRole_(d.assignedUserId, 'branch_worker') && !userHasRole_(d.assignedUserId, 'store_manager')) return 'wrong_role';
    if (d.ownerType !== 'store' && d.ownerType !== 'car') return 'invalid_owner_type';
    var ownerSheet = d.ownerType === 'store' ? SHEETS.STORES : SHEETS.CARS;
    if (!getById_(ownerSheet, d.ownerId)) return 'invalid_owner';
  } else if (kind === 'cluster') {
    if (!d.name) return 'name_required';
    // An area needs its manager. Collectors belong to its branches now; a
    // collector still set on the area (saved before that change) keeps
    // serving the branches that have none of their own.
    if (!d.clusterManagerUserId) return 'manager_required';
    if (d.collectorUserId && d.clusterManagerUserId === d.collectorUserId) {
      return 'conflict_of_interest';
    }
    if (!userHasRole_(d.clusterManagerUserId, 'cluster_manager')) return 'wrong_role';
    if (d.collectorUserId && !userHasRole_(d.collectorUserId, 'collector')) return 'wrong_role';
    // An area manager runs one area and collects for none. A collector may
    // serve any number of areas (changed 2026-09-29).
    var taken = readSheet(SHEETS.CLUSTERS).some(function (c) {
      return c.id !== d.id && (c.clusterManagerUserId === d.clusterManagerUserId || c.clusterManagerUserId === d.collectorUserId ||
        (c.collectorUserId && c.collectorUserId === d.clusterManagerUserId));
    }) || readSheet(SHEETS.LOCATIONS).some(function (l) {
      return l.collectorUserId && l.collectorUserId === d.clusterManagerUserId;
    });
    if (taken) return 'user_in_other_area';
  } else if (kind === 'zone') {
    if (!d.city) return 'city_required';
    if (!d.name) return 'name_required';
  } else if (kind === 'product') {
    if (!d.name) return 'name_required';
    // A fixed price is only meaningful if there is a price: unitPrice is
    // optional, but locking one that was never set would leave the entry
    // form with a read-only empty box nobody can fill.
    if (d.unitPrice != null && d.unitPrice !== '' && !(Number(d.unitPrice) >= 0)) return 'invalid_price';
    if (d.priceLocked && !(Number(d.unitPrice) > 0)) return 'price_needed';
    // what one unit of an inventory item costs the company, for stock value
    if (d.unitCost != null && d.unitCost !== '' && !(isFinite(Number(d.unitCost)) && Number(d.unitCost) >= 0)) return 'invalid_cost';
    // an item is kept in stock (goods) or is a service; nothing else
    if (d.type != null && d.type !== '' && d.type !== 'goods' && d.type !== 'services') return 'invalid_type';
    // Cylinders (2026-09-30): a cylinder item keeps full and empty counts; a
    // product may draw its stock from one (the iron empty-cylinder sale draws
    // from the iron exchange), one level only, with its effect on the counts.
    // before the setup a product takes exactly what it always took: no unit effect, no inventory item
    var liveSI = stockItemsLive_();
    if (d.stockEffect != null && d.stockEffect !== '' && (liveSI || (d.id && getById_(SHEETS.PRODUCTS, d.id) && getById_(SHEETS.PRODUCTS, d.id).stockEffect === d.stockEffect) ? ['exchange', 'sell_empty', 'sell_full', 'unit'] : ['exchange', 'sell_empty', 'sell_full']).indexOf(d.stockEffect) < 0) return 'invalid_stock_link';
    // (a confirm that stopped half-way may have linked it already: what is stored is kept)
    var stored = !liveSI && d.id ? getById_(SHEETS.PRODUCTS, d.id) : null;
    function keeps(k) { return stored && String(stored[k] || '') === String(d[k] || ''); }
    if (!liveSI && ((d.stockItemId && !keeps('stockItemId')) || (d.returnItemId && !keeps('returnItemId')))) return 'invalid_stock_link';
    // Inventory items (LPG Task 1b): a sales item names the item it moves and
    // how; a cylinder item is exchanged or sold empty or full, a unit item
    // sold in units, a service moves nothing. An exchange may take back
    // another cylinder item's empty (empty iron in, full fiber out).
    var si = d.stockItemId ? getById_(SHEETS.STOCK_ITEMS, d.stockItemId) : null;
    if (d.stockItemId) {
      if (!si || d.type === 'services') return 'invalid_stock_link';
      if (si.kind === 'cylinder' ? ['exchange', 'sell_empty', 'sell_full'].indexOf(d.stockEffect) < 0 : d.stockEffect !== 'unit') return 'invalid_stock_link';
    }
    if (d.returnItemId) {
      var rb = getById_(SHEETS.STOCK_ITEMS, d.returnItemId);
      if (!rb || rb.kind !== 'cylinder' || !si || si.kind !== 'cylinder' || d.stockEffect !== 'exchange') return 'invalid_return_link';
    }
    // the old way a product held stock (before the inventory items are set up)
    if (liveSI) return null;
    if (d.stockOf) {
      if (d.cylinder || d.stockOf === d.id) return 'invalid_stock_link';
      var anchor = getById_(SHEETS.PRODUCTS, d.stockOf);
      if (!anchor || anchor.stockOf || anchor.type === 'services') return 'invalid_stock_link';
      if (d.id && readSheet(SHEETS.PRODUCTS).some(function (p) { return p.stockOf === d.id && p.id !== d.id; })) return 'invalid_stock_link';
    }
    // LPG (2026-10-05): an exchange may take back another cylinder type than the one it
    // sends out (empty iron in, full fiber out); a box holds a whole number of cylinders
    if (d.returnOf) {
      var back = getById_(SHEETS.PRODUCTS, d.returnOf);
      if (!back || back.active === false || !back.cylinder || !d.stockOf || (d.stockEffect || 'exchange') !== 'exchange') return 'invalid_return_link';
    }
    if (d.boxSize != null && d.boxSize !== '') {
      var bx = Number(d.boxSize);
      if (!d.cylinder || !(isFinite(bx) && bx === Math.floor(bx) && bx >= 1 && bx <= 1000)) return 'invalid_box_size';
    }
  } else if (kind === 'stock_item') {
    // what a branch holds and counts: a cylinder (full and empty, a box size,
    // the gas and the cylinder priced apart) or a unit item
    if (!String(d.name || '').trim()) return 'name_required';
    if (d.kind !== 'cylinder' && d.kind !== 'unit') return 'invalid_stock_kind';
    var cf = ['gasCost', 'cylinderCost', 'unitCost'];
    for (var ci = 0; ci < cf.length; ci++) {
      var cv = d[cf[ci]];
      if (cv != null && cv !== '' && !(isFinite(Number(cv)) && Number(cv) >= 0 && Number(cv) <= COST_MAX_AMOUNT_)) return 'invalid_cost';
    }
    if (d.boxSize != null && d.boxSize !== '') {
      var sbx = Number(d.boxSize);
      if (d.kind !== 'cylinder' || !(isFinite(sbx) && sbx === Math.floor(sbx) && sbx >= 1 && sbx <= 1000)) return 'invalid_box_size';
    }
  } else if (kind === 'income_item' || kind === 'expense_item') {
    if (!d.name) return 'name_required';
  } else if (kind === 'cost_type') {
    // the catalogue of costs (Costing.gs): what it is called, the family it
    // reports under, and whether it moves with activity
    if (!String(d.name || '').trim()) return 'name_required';
    if (COST_GROUPS_.indexOf(d.group) < 0) return 'group_required';
    if (d.nature != null && d.nature !== '' && d.nature !== 'fixed' && d.nature !== 'variable') return 'invalid_input';
  } else {
    return 'invalid_kind';
  }
  return null;
}

// Changing who stands on a link, or where a store/car/POS/branch belongs,
// is refused while cash or an approval is still in motion there: the open
// handoff would point at the wrong person, or the cash would be stranded.
// Cash or approvals in motion for one person within one area: entries they
// wrote at its branches not yet handed over, the area's handovers from or to
// them still open or held, and its bulk batches they sent awaiting the deputy.
function areaPersonBusy_(clusterId, userId) {
  if (!userId) return false;
  var locIds = readSheet(SHEETS.LOCATIONS).filter(function (l) { return l.clusterId === clusterId; }).map(function (l) { return l.id; });
  if (readSheet(SHEETS.ENTRIES).some(function (e) {
    return e.enteredBy === userId && !e.consumedBy && !e.voided && locIds.indexOf(e.locationId) >= 0;
  })) return true;
  if (readSheet(SHEETS.HANDOFFS).some(function (h) {
    if (h.clusterId !== clusterId || (h.fromUserId !== userId && h.toUserId !== userId)) return false;
    if (h.status === 'pending' || h.status === 'pending_deputy' || h.status === 'disputed') return true;
    return h.status === 'confirmed' && h.toUserId === userId && !h.consumedBy;
  })) return true;
  return readSheet(SHEETS.AREA_BULK_BATCHES).some(function (b) {
    return b.clusterId === clusterId && b.uploadedBy === userId && b.status === 'pending_deputy';
  });
}

// A branch's handovers to its collector still open, or received and not yet banked.
function branchCollectorBusy_(locationId, userId) {
  if (!userId) return false;
  return readSheet(SHEETS.HANDOFFS).some(function (h) {
    if (h.kind !== 'cluster_to_collector' || h.locationId !== locationId || h.toUserId !== userId) return false;
    return h.status === 'pending' || h.status === 'pending_deputy' || h.status === 'disputed' || (h.status === 'confirmed' && !h.consumedBy);
  });
}

function inFlightError_(kind, before, after) {
  function changed(k) { return String(before[k] || '') !== String(after[k] || ''); }
  var people = { store: ['storeManagerUserId'], car: ['driverUserId'], pos: ['assignedUserId'], cluster: ['clusterManagerUserId', 'collectorUserId'] }[kind] || [];
  for (var i = 0; i < people.length; i++) {
    if (!changed(people[i])) continue;
    // An area's people are judged on that area alone: someone still on a
    // second area (rows saved before one-person-one-area) may hold cash
    // there without that blocking a change here.
    var busy = kind === 'cluster' ? areaPersonBusy_(before.id, before[people[i]]) : personBusy_(before[people[i]]);
    if (busy) return 'person_holds_cash';
  }
  if (kind === 'location' && changed('clusterId') && placeBusy_('location', before.id)) return 'cash_in_flight';
  // a branch's collector is not replaced while its cash is on the way to them
  if (kind === 'location' && changed('collectorUserId') && branchCollectorBusy_(before.id, before.collectorUserId || branchCollector_(before.id))) return 'person_holds_cash';
  if ((kind === 'store' || kind === 'car') && changed('locationId') && placeBusy_(kind, before.id)) return 'cash_in_flight';
  if (kind === 'pos' && (changed('ownerId') || changed('ownerType')) && placeBusy_('pos', before.id)) return 'cash_in_flight';
  return null;
}

function actionAdminSaveEntity_(req, user) {
  requireManager_(user);
  // the duplicate check and the new number must see the same file: hold the
  // lock from the check to the write (writeRow releases it)
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var res;
  try { freshenExec_(); res = saveEntity_({ kind: req.kind, id: req.id, data: req.data, noTranslate: true }, user); } finally { try { lock.releaseLock(); } catch (e) {} }
  // the translation call is slow; nothing else should wait on it
  if (res && res.ok) fillTranslations_(translatableOf_(res.entity));
  return res;
}

// Master data from an Excel sheet: each row goes through saveEntity_, the
// same checks and numbering as the form, under the lock one row at a time.
// A row with an id updates that record. The client resolves names and
// numbers to ids and shows every row's problem before sending.
function actionAdminImportEntities_(req, user) {
  requireManager_(user);
  if (!hasOwn_(ENTITY_SHEET, req.kind)) return { ok: false, error: 'invalid_kind' };
  var rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length) return { ok: false, error: 'invalid_input' };
  if (rows.length > 300) return { ok: false, error: 'too_many_rows' };
  var results = [], created = 0, updated = 0, saved = [];
  rows.forEach(function (r, i) {
    r = r || {};
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var res;
    try { freshenExec_(); res = saveEntity_({ kind: req.kind, id: r.id || null, data: r.data || {}, noTranslate: true }, user); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    finally { try { lock.releaseLock(); } catch (e2) {} }
    if (res.ok) { if (r.id) updated++; else created++; saved.push(res.entity); }
    results.push({ row: i, ok: !!res.ok, error: res.error || null, id: res.entity ? res.entity.id : null, code: res.entity ? (res.entity.code || null) : (res.code || null) });
  });
  // the whole file's new names go to Google Translate together, not row by row
  fillTranslations_([].concat.apply([], saved.map(translatableOf_)));
  logAudit_('admin_import_' + req.kind, user.id, (created + updated) + '/' + rows.length);
  return { ok: true, created: created, updated: updated, total: rows.length, results: results };
}

// An inventory item's fields made plain: numbers as numbers, and only the
// fields its kind has (a unit item has no gas, cylinder or box; a cylinder no unit cost).
function stockItemClean_(src) {
  var d = {};
  safeOwnKeys_(src || {}).forEach(function (k) { d[k] = src[k]; });
  d.name = String(d.name == null ? '' : d.name).replace(/\s+/g, ' ').trim();
  ['boxSize', 'gasCost', 'cylinderCost', 'unitCost'].forEach(function (k) {
    if (d[k] == null || d[k] === '') { d[k] = ''; return; }
    var n = Number(d[k]);
    if (isFinite(n)) d[k] = n;
  });
  if (d.kind === 'unit') { d.boxSize = ''; d.gasCost = ''; d.cylinderCost = ''; }
  else if (d.kind === 'cylinder') d.unitCost = '';
  return d;
}
// a sales item with sales in units, or stock counted on it before the inventory items
function productHasStockHistory_(id) {
  return readSheet(SHEETS.ENTRIES).some(function (e) { return !e.voided && e.productId === id && Number(e.qty || 0) > 0; }) ||
    readSheet(SHEETS.INV_MOVES).some(function (m) { return !m.voided && m.productId === id && !m.stockItemId; });
}
// an inventory item with movements (old ones on its sales items too) or sales items on it
function stockItemInUse_(id) {
  var linked = Object.create(null), any = false;
  readSheet(SHEETS.PRODUCTS).forEach(function (p) { if (p.stockItemId === id || p.returnItemId === id) { linked[p.id] = true; any = true; } });
  return any || readSheet(SHEETS.INV_MOVES).some(function (m) { return !m.voided && (m.stockItemId === id || (!m.stockItemId && linked[m.productId])); });
}

function saveEntity_(req, user) {
  var kind = req.kind;
  var sheetName = hasOwn_(ENTITY_SHEET, kind) ? ENTITY_SHEET[kind] : null;
  if (!sheetName) return { ok: false, error: 'invalid_kind' };
  var d = req.data || {};
  // a record's number is the system's, never the form's
  // (nor its id or stamps: a form id would overwrite another record, 2026-10-04 review)
  var dc = {}; safeOwnKeys_(d).forEach(function (k2) { if (['code', 'id', 'createdAt', 'updatedAt'].indexOf(k2) < 0) dc[k2] = d[k2]; }); d = dc;
  if (kind === 'location' && d.lat != null && d.lat !== '' && d.lng != null && d.lng !== '') { d.lat = Number(d.lat); d.lng = Number(d.lng); }

  var obj = req.id ? getById_(sheetName, req.id) : null;
  if (req.id && !obj) return { ok: false, error: 'not_found' };
  if (!obj) obj = { id: Utilities.getUuid(), active: true };

  // Validate the merged result, not the raw patch — a partial update (e.g.
  // just toggling `active`) must not fail validation for omitting fields
  // it never intended to touch. writeRow only persists on success, so a
  // failed validation here never partially applies. safeOwnKeys_ (not a
  // bare hasOwnProperty loop) keeps a client-supplied "__proto__" key from
  // reassigning obj's/merged's actual prototype — see Code.gs.
  var merged = {};
  safeOwnKeys_(obj).forEach(function (k0) { merged[k0] = obj[k0]; });
  safeOwnKeys_(d).forEach(function (k1) { merged[k1] = d[k1]; });
  // a returned cylinder type means nothing once the product stops drawing from a stock item (or stops
  // being an exchange without the form naming one), and a box size nothing once it is no cylinder
  if (kind === 'product' && merged.returnOf && (!merged.stockOf || (!d.returnOf && (merged.stockEffect || 'exchange') !== 'exchange'))) { merged.returnOf = ''; d.returnOf = ''; }
  if (kind === 'product' && !merged.cylinder && merged.boxSize != null && merged.boxSize !== '') { merged.boxSize = ''; d.boxSize = ''; }
  function setBoth(k, v) { merged[k] = v; d[k] = v; }
  var stockBefore = kind === 'stock_item' && req.id ? JSON.parse(JSON.stringify(obj)) : null;
  if (kind === 'product' && stockItemsLive_()) {
    // the old stock fields leave the sales item once inventory items exist: kept on
    // the rows saved before, never taken from a form
    ['cylinder', 'stockName', 'emptyCost', 'stockOf', 'returnOf', 'boxSize'].forEach(function (k) { if (hasOwn_(d, k)) { delete d[k]; merged[k] = obj[k]; } });
    if (merged.type === 'services') {
      // a service moves no stock (one sent with a link is refused below)
      if (!(hasOwn_(d, 'stockItemId') && d.stockItemId)) { setBoth('stockItemId', ''); setBoth('stockEffect', ''); setBoth('returnItemId', ''); }
    } else if (!merged.stockItemId) {
      // no inventory item: nothing hangs on it
      if (merged.stockEffect) setBoth('stockEffect', '');
      if (merged.returnItemId) setBoth('returnItemId', '');
    } else {
      var lnk = getById_(SHEETS.STOCK_ITEMS, merged.stockItemId);
      if (lnk && (merged.stockEffect == null || merged.stockEffect === '')) setBoth('stockEffect', lnk.kind === 'cylinder' ? 'exchange' : 'unit');
      // an item taken back means nothing once the sales item stops being an exchange
      if (merged.returnItemId && !hasOwn_(d, 'returnItemId') && merged.stockEffect !== 'exchange') setBoth('returnItemId', '');
    }
  }
  if (kind === 'stock_item') {
    // the system's own fields are never the form's
    ['since', 'fromSetup', 'setupKey'].forEach(function (k) { if (hasOwn_(d, k)) { delete d[k]; merged[k] = obj[k]; } });
    var cleaned = stockItemClean_(merged);
    ['kind', 'boxSize', 'gasCost', 'cylinderCost', 'unitCost'].forEach(function (k) { if (cleaned[k] !== obj[k] || hasOwn_(d, k)) setBoth(k, cleaned[k]); });
    if (!obj.since) setBoth('since', todayRiyadh_());
  }
  var err = validateEntity_(kind, merged);
  if (err === 'duplicate_customer') return { ok: false, error: err, code: customerDuplicateOf_(merged.name, merged.id).code };
  if (err) return { ok: false, error: err };
  if (req.id) {
    // after the setup a sales item with sales or old counts keeps its stock link: changing it
    // would move every past figure. A wrong link is fixed with a new sales item (and this
    // one deactivated) or a dated count (fix round 1, 2026-10-05).
    if (kind === 'product' && stockItemsLive_() && ['stockItemId', 'stockEffect', 'returnItemId'].some(function (k) { return String(merged[k] || '') !== String(obj[k] || ''); }) && productHasStockHistory_(obj.id)) return { ok: false, error: 'stock_link_locked' };
    // an item with stock movements stays an inventory item, or its history would vanish
    if (kind === 'product' && merged.type === 'services' && obj.type !== 'services' && invHasMoves_(obj.id)) return { ok: false, error: 'has_stock' };
    // full and empty counts would lose their meaning
    if (kind === 'product' && !!merged.cylinder !== !!obj.cylinder && invHasMoves_(obj.id)) return { ok: false, error: 'has_stock' };
    // an inventory item with movements or sales items keeps its kind (full and empty would lose their meaning)
    if (kind === 'stock_item' && merged.kind !== obj.kind && stockItemInUse_(obj.id)) return { ok: false, error: 'has_stock' };
    var flightErr = inFlightError_(kind, obj, merged);
    if (flightErr) return { ok: false, error: flightErr };
  }

  // a product's unit cost before this save (null for a new product), so the
  // sales already made keep the cost they were sold at (noteProductCost_)
  var costBefore = kind === 'product' && req.id ? Number(obj.unitCost || 0) : null;
  // prices, fees and commissions before the save, for their history
  var rateBefore = hasOwn_(RATE_FIELDS_, kind) ? (req.id ? JSON.parse(JSON.stringify(obj)) : {}) : null;
  safeOwnKeys_(d).forEach(function (k) { obj[k] = d[k]; });
  if (obj.active === undefined) obj.active = true;
  if ((kind === 'customer' || kind === 'city') && obj.name) obj.name = String(obj.name).replace(/\s+/g, ' ').trim();
  if (hasOwn_(CODE_PREFIX_, kind) && !obj.code) obj.code = nextCode_(kind);

  var saved = writeRow(sheetName, obj);
  if (kind === 'product') noteProductCost_(saved, costBefore, user.id);
  if (kind === 'stock_item') noteStockItemCost_(saved, stockBefore, user.id);
  if (rateBefore) rateChanges_(kind, rateBefore, saved, user.id, { via: req.importing ? 'import' : 'save' });
  logAudit_('admin_save_' + kind, user.id, saved.id);
  if (!req.noTranslate) fillTranslations_(translatableOf_(saved));
  return { ok: true, entity: saved };
}

// ---------- Price and rate history (2026-10-04) ----------
// Every change to a price, a cost, a delivery fee or a driver's commission is
// kept, old and new, with who and when (the user: "any update should not
// impact the old data and should have history"). A saved day carries the
// amounts it was worked out with, so a change never rewrites it; this sheet
// is the record of what stood when. Maps (fees and commissions per item)
// are compared item by item.
var RATE_FIELDS_ = { product: ['unitPrice', 'priceLocked', 'unitCost'], customer: ['deliveryFees', 'commissions'], channel: ['deliveryFees', 'commissions'], stock_item: ['gasCost', 'cylinderCost', 'unitCost'] };
function rateVal_(v) { if (v === undefined || v === null || v === '') return null; var n = Number(v); return isFinite(n) ? Math.round(n * 10000) / 10000 : String(v); }
function rateChanges_(kind, before, after, userId, extra) {
  if (!hasOwn_(RATE_FIELDS_, kind) || !after) return [];
  before = before || {}; extra = extra || {};
  var found = [];
  RATE_FIELDS_[kind].forEach(function (f) {
    var a = before[f], b = after[f];
    if (f === 'priceLocked') { if (!!a !== !!b) found.push({ field: f, productId: null, from: !!a, to: !!b }); return; }
    if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
      var am = a && typeof a === 'object' ? a : {}, bm = b && typeof b === 'object' ? b : {}, keys = Object.create(null);
      safeOwnKeys_(am).forEach(function (k) { keys[k] = 1; });
      safeOwnKeys_(bm).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).forEach(function (pid) {
        var x = rateVal_(hasOwn_(am, pid) ? am[pid] : null), y = rateVal_(hasOwn_(bm, pid) ? bm[pid] : null);
        if (x == null) x = 0; if (y == null) y = 0;
        if (String(x) !== String(y)) found.push({ field: f, productId: pid, from: x, to: y });
      });
      return;
    }
    var x1 = rateVal_(a), y1 = rateVal_(b);
    if (x1 == null) x1 = 0; if (y1 == null) y1 = 0;
    if (String(x1) !== String(y1)) found.push({ field: f, productId: null, from: x1, to: y1 });
  });
  var at = new Date().toISOString();
  var rows = found.map(function (c) {
    return { id: Utilities.getUuid(), kind: kind, recordId: after.id, recordName: String(after.name || after.label || ''), field: c.field, productId: c.productId,
      from: c.from, to: c.to, fromDate: extra.fromDate || todayRiyadh_(), reason: extra.reason || '', via: extra.via || 'save', by: userId || 'system', at: at };
  });
  if (extra.collect) Array.prototype.push.apply(extra.collect, rows);
  else rateChangesWrite_(rows, userId);
  return rows;
}
function rateChangesWrite_(rows, userId) {
  if (!rows.length) return;
  try { costAppendMany_(SHEETS.RATE_CHANGES, rows); }
  catch (e) {
    logAudit_('rate_history_unwritten', userId || 'system', rows.map(function (r) { return r.kind + ':' + r.recordId + ' ' + r.field + (r.productId ? '[' + r.productId + ']' : '') + ' ' + r.from + '>' + r.to; }).join('; ').slice(0, 4000));
  }
}
// A record's history, newest first. Company-wide roles read it; a cost only
// for those who read costs.
function actionGetRateHistory_(req, user) {
  if (!isCompanyWide_(user.role)) return { ok: false, error: 'forbidden' };
  if (!hasOwn_(RATE_FIELDS_, req.kind)) return { ok: false, error: 'invalid_kind' };
  var seeCost = costCanRead_(user);
  var rows = readSheet(SHEETS.RATE_CHANGES).filter(function (r) { return r.kind === req.kind && r.recordId === req.id && (seeCost || ['unitCost', 'gasCost', 'cylinderCost'].indexOf(r.field) < 0); })
    .sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
  return { ok: true, changes: rows };
}

// ---------- Translations ----------
// Names are typed in Arabic. The client shows them in English or Urdu from
// the translations sheet, which Google Translate fills when a name is saved.
// A name that already carries Latin letters ("النسيم Al-Naseem") is left to
// the client, which shows its Latin part. A failed translation never fails
// the save; adminFillTranslations catches the gaps up later.
var TR_FIELDS_ = ['name', 'label', 'city'];
function needsTranslation_(s) {
  s = String(s == null ? '' : s).trim();
  // an Arabic word, not just a plate's single letters ("أ ص ن 1062")
  return !!s && /[؀-ۿ]{2,}/.test(s) && !/[A-Za-z]/.test(s);
}
function translatableOf_(obj) {
  return TR_FIELDS_.map(function (k) { return obj && obj[k]; }).filter(needsTranslation_).map(function (s) { return String(s).trim(); });
}
function translationIndex_() {
  var m = {};
  readSheet(SHEETS.TRANSLATIONS).forEach(function (r) { if (r.src) m[r.src] = r; });
  return m;
}
// one request per chunk of lines, so an import of a hundred names is a few
// calls, not two hundred; a chunk whose line count comes back different is
// done one line at a time instead
function machineTranslate_(list, lang) {
  var out = [], i = 0;
  while (i < list.length) {
    var chunk = [], size = 0;
    while (i < list.length && chunk.length < 80 && size + list[i].length < 4500) { chunk.push(list[i]); size += list[i].length + 1; i++; }
    if (!chunk.length) { chunk.push(list[i]); i++; }
    var lines = String(LanguageApp.translate(chunk.join('\n'), 'ar', lang)).split('\n');
    if (lines.length !== chunk.length) lines = chunk.map(function (s) { return String(LanguageApp.translate(s, 'ar', lang)); });
    lines.forEach(function (l) { out.push(String(l).trim()); });
  }
  return out;
}
function fillTranslations_(srcs) {
  var idx = translationIndex_(), seen = {}, todo = [];
  (srcs || []).forEach(function (s) {
    if (!needsTranslation_(s)) return;
    s = String(s).trim();
    if (seen[s] || hasOwn_(idx, s)) return;
    seen[s] = true; todo.push(s);
  });
  if (!todo.length) return 0;
  var en, ur;
  try { en = machineTranslate_(todo, 'en'); ur = machineTranslate_(todo, 'ur'); }
  catch (e) { return 0; }
  todo.forEach(function (s, i) { writeRow(SHEETS.TRANSLATIONS, { src: s, en: en[i] || '', ur: ur[i] || '', auto: true }); });
  return todo.length;
}
// every name in master data, for filling the gaps in one go
function allTranslatable_() {
  var out = [];
  safeOwnKeys_(ENTITY_SHEET).forEach(function (k) { readSheet(ENTITY_SHEET[k]).forEach(function (r) { out = out.concat(translatableOf_(r)); }); });
  readSheet(SHEETS.USERS).forEach(function (u) { out = out.concat(translatableOf_({ name: u.name })); });
  return out;
}
function actionAdminFillTranslations_(req, user) {
  requireManager_(user);
  var added = fillTranslations_(allTranslatable_());
  logAudit_('admin_fill_translations', user.id, String(added));
  return { ok: true, added: added };
}
// {src, en, ur} or {rows:[...]}: a blank en/ur keeps what is there
function actionAdminSaveTranslation_(req, user) {
  requireManager_(user);
  var rows = Array.isArray(req.rows) ? req.rows : [{ src: req.src, en: req.en, ur: req.ur }];
  if (!rows.length || rows.length > 1000) return { ok: false, error: 'invalid_input' };
  for (var i = 0; i < rows.length; i++) {
    if (!rows[i] || !String(rows[i].src || '').trim()) return { ok: false, error: 'invalid_input' };
  }
  var idx = translationIndex_(), n = 0;
  rows.forEach(function (r) {
    var src = String(r.src).trim();
    var row = hasOwn_(idx, src) ? idx[src] : { src: src, en: '', ur: '' };
    var en = String(r.en == null ? '' : r.en).trim(), ur = String(r.ur == null ? '' : r.ur).trim();
    if (!en && !ur && row.id) return;
    if (en) row.en = en;
    if (ur) row.ur = ur;
    row.auto = false;
    idx[src] = writeRow(SHEETS.TRANSLATIONS, row);
    n++;
  });
  logAudit_('admin_save_translation', user.id, rows.length === 1 ? String(rows[0].src).slice(0, 80) : String(n));
  return { ok: true, saved: n };
}

function actionAdminDeleteEntity_(req, user) {
  requireManager_(user);
  var kind = req.kind;
  var sheetName = hasOwn_(ENTITY_SHEET, kind) ? ENTITY_SHEET[kind] : null;
  if (!sheetName) return { ok: false, error: 'invalid_kind' };
  var target = getById_(sheetName, req.id);
  if (!target) return { ok: false, error: 'not_found' };
  if (kind === 'city') {
    var ck = normalizeName_(target.name);
    var used = readSheet(SHEETS.LOCATIONS).concat(readSheet(SHEETS.ZONES), readSheet(SHEETS.CUSTOMERS)).some(function (r) { return r.city && normalizeName_(r.city) === ck; });
    if (used) return { ok: false, error: 'has_children' };
  }

  var children = hasOwn_(ENTITY_CHILDREN, kind) ? ENTITY_CHILDREN[kind] : [];
  for (var i = 0; i < children.length; i++) {
    var rule = children[i];
    var rows = readSheet(rule.sheet);
    for (var j = 0; j < rows.length; j++) {
      if (rows[j][rule.field] !== req.id) continue;
      if (rule.ownerType && rows[j].ownerType !== rule.ownerType) continue;
      if (rule.centreType && rows[j].centreType !== rule.centreType) continue;
      if (rule.live && rows[j].voided) continue;
      return { ok: false, error: 'has_children' };
    }
  }

  deleteRow_(sheetName, req.id);
  logAudit_('admin_delete_' + kind, user.id, req.id);
  return { ok: true };
}

// ---------- Config ----------

function actionAdminSetConfig_(req, user) {
  requireManager_(user);
  var cfg = config_();
  var d = req.data || {};
  var before = JSON.stringify(cfg);
  // a rate, not a percentage: 0.15 is 15%
  if (d.vatRate != null && (!(Number(d.vatRate) >= 0) || Number(d.vatRate) >= 1)) return { ok: false, error: 'invalid_vat' };
  ['staleThresholdHours', 'heldThresholdHours', 'secondApprovalThreshold'].forEach(function (k) {
    if (d[k] != null && !(Number(d[k]) >= 0)) d.__bad = true;
  });
  if (d.__bad) return { ok: false, error: 'invalid_setting' };
  // Going live is one way: once on, nothing in the app turns it off, so
  // "start a fresh round" can never be run against real data.
  if (d.liveLocked === false && cfg.liveLocked === true) return { ok: false, error: 'live_locked' };
  if (d.liveLocked === true) { cfg.liveLocked = true; cfg.liveLockedAt = new Date().toISOString(); cfg.liveLockedBy = user.id; }
  // a day saved before the change keeps being worked out at the rate of its
  // own date: the old rate is kept with the last day it stood (vatRateOn_).
  // A second change the same day keeps the first record.
  if (d.vatRate != null) {
    var vatWas = typeof cfg.vatRate === 'number' ? cfg.vatRate : 0.15;
    if (Number(d.vatRate) !== vatWas) {
      var vatUntil = Utilities.formatDate(new Date(Date.now() - 86400000), 'Asia/Riyadh', 'yyyy-MM-dd');
      var vh = Array.isArray(cfg.vatHistory) ? cfg.vatHistory.slice() : [];
      if (!vh.length || String(vh[vh.length - 1].until) < vatUntil) vh.push({ rate: vatWas, until: vatUntil });
      cfg.vatHistory = vh;
    }
    cfg.vatRate = Number(d.vatRate);
  }
  if (d.senderName != null) cfg.senderName = String(d.senderName);
  if (d.staleThresholdHours != null) cfg.staleThresholdHours = Number(d.staleThresholdHours);
  if (d.heldThresholdHours != null) cfg.heldThresholdHours = Number(d.heldThresholdHours);
  if (d.secondApprovalThreshold != null) cfg.secondApprovalThreshold = Number(d.secondApprovalThreshold);
  if (d.areaManagerBulkUploadEnabled != null) cfg.areaManagerBulkUploadEnabled = !!d.areaManagerBulkUploadEnabled;
  if (d.posSalesEnabled != null) cfg.posSalesEnabled = !!d.posSalesEnabled;
  // whether the prices typed at the branches hold VAT (profit is read without it)
  if (d.salesIncludeVat != null) cfg.salesIncludeVat = !!d.salesIncludeVat;
  writeRow(SHEETS.CONFIG, cfg);
  // what changed, from what to what — a settings change moves money too
  var was = JSON.parse(before), diff = [];
  ['vatRate', 'staleThresholdHours', 'heldThresholdHours', 'secondApprovalThreshold', 'areaManagerBulkUploadEnabled', 'posSalesEnabled', 'salesIncludeVat', 'liveLocked', 'senderName'].forEach(function (k) {
    if (String(was[k]) !== String(cfg[k])) diff.push(k + ': ' + was[k] + ' → ' + cfg[k]);
  });
  logAudit_('admin_set_config', user.id, diff.join('; ') || 'no change');
  return { ok: true, config: cfg };
}

// ---------- First-run bootstrap ----------
// Run this ONCE from the Apps Script editor (Run > setupFirstAdmin) after
// deploying — there is no admin yet, so the web app's adminCreateUser
// action has nothing to authenticate against. Edit the two constants below
// before running. See SETUP.md.

function setupFirstAdmin() {
  var ADMIN_NAME = 'Admin';
  var ADMIN_EMAIL = 'CHANGE_ME@bestgas.sa';

  if (ADMIN_EMAIL.indexOf('CHANGE_ME') >= 0) {
    throw new Error('Edit ADMIN_EMAIL in setupFirstAdmin() before running it.');
  }
  if (userByEmail_(ADMIN_EMAIL)) {
    throw new Error('That email already has an account.');
  }

  var temp = randomPassword_();
  var salt = randomSalt_();
  var admin = {
    id: Utilities.getUuid(),
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    role: 'admin',
    active: true,
    language: 'ar',
    salt: salt,
    pass: hashPw_(temp, salt),
    mustChangePw: true
  };
  writeRow(SHEETS.USERS, admin);
  sendInvite_(admin, temp);
  Logger.log('First admin created for ' + ADMIN_EMAIL + '; the temporary sign-in was emailed, not logged.');
}

// ---------- Starting a fresh test round ----------
// The tabs that hold movement, as opposed to the org itself. Renaming these
// is what "start fresh" means here: nothing is deleted, and the previous
// round stays in the workbook under a dated name.
var TRANSACTIONAL_SHEETS_ = [
  SHEETS.ENTRIES, SHEETS.HANDOFFS, SHEETS.AREA_BULK_BATCHES,
  SHEETS.BANK_LINES, SHEETS.RISK_ITEMS,
  // the stock movements balance against the sales: one without the other would
  // leave every branch's stock with purchases and no sales (2026-10-05)
  SHEETS.INV_MOVES
];
// The audit trail is not in the list (security review 2026-10-04): a fresh round
// must never hide who did what.

function actionAdminArchiveTransactions_(req, user) {
  requireManager_(user);
  // A word the caller has to type, so this can never be one stray tap.
  if (String(req.confirm || '') !== 'ARCHIVE') return { ok: false, error: 'confirm_required' };
  if (config_().liveLocked === true) return { ok: false, error: 'live_locked' };
  // cash on its way would vanish with the round
  if (readSheet(SHEETS.HANDOFFS).some(function (h) { return ['pending', 'pending_deputy', 'disputed'].indexOf(h.status) >= 0; })) return { ok: false, error: 'cash_in_flight' };

  var ss = spreadsheet_();
  var stamp = Utilities.formatDate(new Date(), 'Asia/Riyadh', 'yyyy-MM-dd_HHmmss');
  var archived = [];
  for (var i = 0; i < TRANSACTIONAL_SHEETS_.length; i++) {
    var name = TRANSACTIONAL_SHEETS_[i];
    var sh = ss.getSheetByName(name);
    if (!sh) continue;
    var rows = Math.max(0, sh.getLastRow() - 1);
    if (!rows) continue;                       // nothing in it, leave it alone
    // Google Sheets refuses a duplicate tab name, and a second round started
    // straight after the first (the audit tab always holds the first round's
    // own line) would otherwise reuse this one and fail half-way through.
    var target = name + '_archive_' + stamp, n = 2;
    while (ss.getSheetByName(target)) target = name + '_archive_' + stamp + '_' + (n++);
    sh.setName(target);
    archived.push({ sheet: name, rows: rows, archivedAs: target });
    delete exec_().sheets[name];
    bumpVersion_(name);                        // every cached copy is now stale
  }
  // sheet_() recreates each one empty on the next read, including the audit
  // tab this line writes into.
  logAudit_('admin_archive_transactions', user.id, archived.map(function (a) { return a.sheet + ':' + a.rows; }).join(', ') || 'nothing to archive');
  return { ok: true, archived: archived, stamp: stamp };
}

// ---------- Reference data (used by every role to render forms/pickers) ----------

// Collectors used to belong to areas; they belong to branches now. This
// writes each area's collector onto its branches that have none of their
// own, then clears it from the area — every branch keeps exactly the
// collector it already had, and no hidden area-level link is left behind
// to trip the one-area rule when that collector is moved later.
// Returns how many branches it wrote.
function migrateBranchCollectors_() {
  var legacy = readSheet(SHEETS.CLUSTERS).filter(function (c) { return c.collectorUserId; });
  if (!legacy.length) return 0;
  var moved = 0;
  readSheet(SHEETS.LOCATIONS).forEach(function (l) {
    if (l.collectorUserId) return;
    var c = legacy.filter(function (x) { return x.id === l.clusterId; })[0];
    if (!c) return;
    l.collectorUserId = c.collectorUserId;
    writeRow(SHEETS.LOCATIONS, l);
    logAudit_('migrate_branch_collector', 'system', l.id + ' <- ' + c.collectorUserId + ' (area ' + c.id + ')');
    moved++;
  });
  legacy.forEach(function (c) {
    var was = c.collectorUserId;
    c.collectorUserId = '';
    writeRow(SHEETS.CLUSTERS, c);
    logAudit_('migrate_area_collector_cleared', 'system', c.id + ' (was ' + was + ')');
  });
  return moved;
}

// Runs the move above on the first request after the update, then never again.
function migrateBranchCollectorsOnce_() {
  runOnce_('MIGRATED_BRANCH_COLLECTORS', migrateBranchCollectors_);
}

// ---------- Credit customers and the city list ----------
// One spelling for comparing names: the same customer typed with a different
// alef, ta marbuta, hamza seat, diacritics, tatweel, spacing or letter case
// must be caught as the same customer, or the list fills with near-twins and
// credit owed by one customer is split across several records.
function normalizeName_(s) {
  return String(s == null ? '' : s)
    .replace(/[\u064B-\u065F\u0670\u0640\u200B-\u200F\u202A-\u202E\u061C\uFEFF]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/[\u0649\u06CC]/g, '\u064A')
    .replace(/\u06A9/g, '\u0643')
    .replace(/[\u0629\u06C1\u06C3\u06D5]/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A')
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Main Saudi cities, so a new system starts with a list to pick from.
var DEFAULT_CITIES_ = [
  'الرياض', 'جدة', 'مكة المكرمة', 'المدينة المنورة', 'الدمام', 'الخبر', 'الظهران',
  'الأحساء', 'الهفوف', 'القطيف', 'الجبيل', 'الخفجي', 'رأس تنورة', 'بقيق', 'النعيرية',
  'حفر الباطن', 'الطائف', 'تبوك', 'بريدة', 'عنيزة', 'الرس', 'حائل', 'أبها',
  'خميس مشيط', 'محايل عسير', 'بيشة', 'النماص', 'جازان', 'صبيا', 'أبو عريش', 'نجران',
  'الباحة', 'الخرج', 'الدوادمي', 'المجمعة', 'الزلفي', 'شقراء', 'وادي الدواسر', 'ينبع',
  'رابغ', 'القنفذة', 'الليث', 'سكاكا', 'عرعر', 'القريات', 'رفحاء', 'طريف', 'الوجه', 'ضباء'
];

// The customer already on file under this name, other than `selfId`.
function customerDuplicateOf_(name, selfId) {
  var key = normalizeName_(name);
  if (!key) return null;
  return readSheet(SHEETS.CUSTOMERS).filter(function (c) {
    return c.id !== selfId && normalizeName_(c.name) === key;
  })[0] || null;
}

function cityDuplicateOf_(name, selfId) {
  var key = normalizeName_(name);
  if (!key) return null;
  return readSheet(SHEETS.CITIES).filter(function (c) {
    return c.id !== selfId && normalizeName_(c.name) === key;
  })[0] || null;
}

// Every record the system keeps gets a number of its own, with a prefix that
// says what it is: BR-0001 a branch, AR-0001 an area, and so on. The counter
// for each kind lives in a script property (SEQ_<kind>), so a deleted
// record's number is never handed out again. Call it while holding the
// script lock.
var CODE_PREFIX_ = {
  location: 'BR', cluster: 'AR', city: 'CT', zone: 'ZN', store: 'ST', car: 'CR', pos: 'POS',
  product: 'PR', income_item: 'INC', expense_item: 'EXP', customer: 'CUS', user: 'EMP', channel: 'CH', cost_type: 'CST', stock_item: 'STK'
};
function codeSheet_(kind) { return kind === 'user' ? SHEETS.USERS : ENTITY_SHEET[kind]; }
function isCodedSheet_(name) {
  return Object.keys(CODE_PREFIX_).some(function (k) { return codeSheet_(k) === name; });
}
function nextCode_(kind) {
  var prefix = CODE_PREFIX_[kind];
  var key = 'SEQ_' + kind;
  var max = Number(PropertiesService.getScriptProperties().getProperty(key) || 0);
  var re = new RegExp('^' + prefix + '-(\\d+)$');
  readSheet(codeSheet_(kind)).forEach(function (r) {
    var m = re.exec(String(r.code || ''));
    if (m && Number(m[1]) > max) max = Number(m[1]);
  });
  max += 1;
  setScriptProp_(key, String(max));
  var n = String(max);
  while (n.length < 4) n = '0' + n;
  return prefix + '-' + n;
}

// Numbers every record saved before numbering existed, in the order the
// rows were written. Never renumbers. Returns how many it numbered.
function backfillCodes_() {
  var done = 0;
  var lock = LockService.getScriptLock();
  Object.keys(CODE_PREFIX_).forEach(function (kind) {
    readSheet(codeSheet_(kind)).forEach(function (r) {
      if (r.code) return;
      lock.waitLock(30000);
      try {
        freshenExec_();
        var cur = getById_(codeSheet_(kind), r.id);
        if (!cur || cur.code) return;
        cur.code = nextCode_(kind);
        writeRow(codeSheet_(kind), cur);
        done++;
      } finally {
        try { lock.releaseLock(); } catch (e) {}
      }
    });
  });
  return done;
}

function backfillCodesOnce_() {
  runOnce_('CODES_BACKFILLED', backfillCodes_);
  // a second pass catches any number a request erased by writing back a copy
  // it had read before the first pass (fixed in writeRow since)
  runOnce_('CODES_BACKFILLED_2', backfillCodes_);
}

// Runs fn once across every execution: the job is claimed under the lock on a
// fresh read of the script properties, run outside it (its writes take the
// lock row by row), then marked done. A claim older than ten minutes belongs
// to a run that died (Apps Script stops at six) and is taken over.
function runOnce_(flag, fn) {
  if (scriptProps_()[flag]) return false;
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    freshenExec_();
    if (props.getProperty(flag)) return false;
    var claim = props.getProperty(flag + '_CLAIM');
    if (claim && Date.now() - new Date(claim).getTime() < 10 * 60000) return false;
    setScriptProp_(flag + '_CLAIM', new Date().toISOString());
  } finally {
    lock.releaseLock();
  }
  fn();
  setScriptProp_(flag, new Date().toISOString());
  return true;
}

// The data jobs that run once after an update. Each keeps its own flag, so
// calling this on every request costs one read of the script properties.
function runOneTimeMigrations_() {
  migrateBranchCollectorsOnce_();
  seedCitiesOnce_();
  seedCustomersOnce_();
  backfillCodesOnce_();
  seedCostTypesOnce_();
  // the app became Best Gas Collections; the sender name saved at setup still
  // said the old default (a name someone chose is kept)
  runOnce_('SENDER_RENAMED', function () {
    var c = config_();
    if (!c.senderName || c.senderName === 'Best Gas Cash Collection') { c.senderName = 'Best Gas Collections'; writeRow(SHEETS.CONFIG, c); }
  });
}

// A customer by internal number (any letter case) or by name (normalised).
function findCustomer_(text) {
  var t = String(text == null ? '' : text).trim();
  if (!t) return null;
  var up = t.toUpperCase(), key = normalizeName_(t);
  var rows = readSheet(SHEETS.CUSTOMERS);
  for (var i = 0; i < rows.length; i++) if (String(rows[i].code || '').toUpperCase() === up) return rows[i];
  for (var j = 0; j < rows.length; j++) if (normalizeName_(rows[j].name) === key) return rows[j];
  return null;
}

// Adds each new name once. A name already on file, or repeated earlier in the
// same list, is skipped and reported with the number it already has.
// A row may also carry the driver's commission and the delivery fee per unit
// (2026-10-03, from the company's customer sheet "applies to every product"):
// each is set for every product that is not a service. A blank leaves that
// one as it was; a negative or non-numeric amount refuses the row. With
// opts.update an existing customer is overwritten with the row's amounts
// (reported in updated) instead of being skipped as a duplicate.
function customerRate_(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { none: true };
  var n = Number(String(v).replace(/,/g, '').trim());
  if (!isFinite(n) || n < 0 || n > 100000) return { bad: true };
  return { value: Math.round(n * 100) / 100 };
}
function applyCustomerRates_(c, rates, goods) {
  [['commissions', rates.commission], ['deliveryFees', rates.delivery]].forEach(function (p) {
    if (p[1].none) return;
    var map = Object.create(null);
    var was = c[p[0]] && typeof c[p[0]] === 'object' ? c[p[0]] : {};
    safeOwnKeys_(was).forEach(function (k) { map[k] = was[k]; });
    goods.forEach(function (g) { map[g.id] = p[1].value; });
    var plain = {}; Object.keys(map).forEach(function (k) { plain[k] = map[k]; });
    c[p[0]] = plain;
  });
}
function importCustomers_(rows, opts) {
  opts = opts || {};
  var created = [], skipped = [], updated = [], changes = [];
  var goods = null;
  var lock = LockService.getScriptLock();
  try {
  for (var i = 0; i < rows.length; i++) {
    var r = typeof rows[i] === 'string' ? { name: rows[i] } : (rows[i] || {});
    var name = String(r.name || '').replace(/\s+/g, ' ').trim();
    if (!name) { skipped.push({ row: i, name: '', code: null, reason: 'name_required' }); continue; }
    var rates = { commission: customerRate_(r.commission), delivery: customerRate_(r.delivery) };
    if (rates.commission.bad || rates.delivery.bad) { skipped.push({ row: i, name: name, code: null, reason: 'invalid_amount' }); continue; }
    var hasRates = !rates.commission.none || !rates.delivery.none;
    if (hasRates && !goods) goods = readSheet(SHEETS.PRODUCTS).filter(function (p) { return p.type !== 'services'; });
    // one lock per row: the duplicate check, the number and the write together
    lock.waitLock(30000);
    try {
      freshenExec_();
      var dup = customerDuplicateOf_(name, null);
      if (dup) {
        if (opts.update && hasRates) {
          var dupBefore = JSON.parse(JSON.stringify(dup));
          applyCustomerRates_(dup, rates, goods);
          var upd = writeRow(SHEETS.CUSTOMERS, dup);
          updated.push(upd);
          rateChanges_('customer', dupBefore, upd, opts.userId, { via: 'customer_sheet', collect: changes });
        }
        else skipped.push({ row: i, name: name, code: dup.code, reason: 'duplicate' });
        continue;
      }
      var c = { id: Utilities.getUuid(), code: nextCode_('customer'), name: name, active: true };
      if (r.city) c.city = String(r.city).trim();
      if (r.phone) c.phone = String(r.phone).trim();
      if (hasRates) applyCustomerRates_(c, rates, goods);
      var made = writeRow(SHEETS.CUSTOMERS, c);
      created.push(made);
      if (hasRates) rateChanges_('customer', {}, made, opts.userId, { via: 'customer_sheet', collect: changes });
    } finally {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
  } finally {
    // the history in one sheet call, not one per customer, under the lock, and
    // also for the rows saved before a failure part-way
    if (changes.length) {
      lock.waitLock(30000);
      try { freshenExec_(); rateChangesWrite_(changes, opts.userId); } finally { try { lock.releaseLock(); } catch (e) {} }
    }
  }
  return { created: created, skipped: skipped, updated: updated };
}

function actionAdminImportCustomers_(req, user) {
  requireManager_(user);
  var rows = Array.isArray(req.rows) ? req.rows : [];
  if (!rows.length) return { ok: false, error: 'invalid_input' };
  // each row takes the lock and re-reads the list: 500 finish well inside one run
  if (rows.length > 500) return { ok: false, error: 'too_many_rows' };
  var res = importCustomers_(rows, { update: req.update === true, userId: user.id });
  // the names show in English and Urdu too: the new ones and the ones the sheet updated
  fillTranslations_([].concat.apply([], res.created.concat(res.updated).map(translatableOf_)));
  logAudit_('admin_import_customers', user.id, res.created.length + ' created, ' + res.updated.length + ' updated, ' + res.skipped.length + ' skipped');
  return { ok: true, created: res.created, updated: res.updated, skipped: res.skipped };
}

// The company's customer list ships in CustomerSeed.js, a file that exists in
// the Apps Script project only — never in this repo, which is public. When
// that file defines CUSTOMER_SEED_, the first request imports it once.
function seedCustomersOnce_() {
  if (typeof CUSTOMER_SEED_ === 'undefined' || !CUSTOMER_SEED_ || !CUSTOMER_SEED_.length) return;
  runOnce_('SEEDED_CUSTOMERS', function () {
    var res = importCustomers_(CUSTOMER_SEED_);
    logAudit_('seed_customers', 'system', res.created.length + ' created, ' + res.skipped.length + ' skipped');
  });
}

// The city list: the default cities plus every city a branch or a zone
// already names, each once. Returns how many it added.
function seedCities_() {
  var have = {};
  readSheet(SHEETS.CITIES).forEach(function (c) { have[normalizeName_(c.name)] = true; });
  var names = DEFAULT_CITIES_.slice();
  readSheet(SHEETS.LOCATIONS).concat(readSheet(SHEETS.ZONES)).forEach(function (r) {
    if (r.city) names.push(String(r.city).trim());
  });
  var added = 0;
  var lock = LockService.getScriptLock();
  names.forEach(function (n) {
    var k = normalizeName_(n);
    if (!k || have[k]) return;
    have[k] = true;
    lock.waitLock(30000);
    try {
      freshenExec_();
      if (cityDuplicateOf_(n, null)) return;
      writeRow(SHEETS.CITIES, { id: Utilities.getUuid(), code: nextCode_('city'), name: n, active: true });
      added++;
    } finally {
      try { lock.releaseLock(); } catch (e) {}
    }
  });
  return added;
}

function seedCitiesOnce_() {
  runOnce_('SEEDED_CITIES', seedCities_);
}

function actionMeta_(req, user) {
  var locations = readSheet(SHEETS.LOCATIONS);
  var stores = readSheet(SHEETS.STORES);
  var cars = readSheet(SHEETS.CARS);
  var pos = readSheet(SHEETS.POS);
  var clusters = readSheet(SHEETS.CLUSTERS);
  var zones = readSheet(SHEETS.ZONES);
  var products = readSheet(SHEETS.PRODUCTS);
  var incomeItems = readSheet(SHEETS.INCOME_ITEMS);
  var expenseItems = readSheet(SHEETS.EXPENSE_ITEMS);
  var customers = readSheet(SHEETS.CUSTOMERS);
  var channels = readSheet(SHEETS.CHANNELS);
  var cities = readSheet(SHEETS.CITIES);
  // the inventory items the branches count (LPG Task 1b)
  var stockItems = readSheet(SHEETS.STOCK_ITEMS);
  var users = readSheet(SHEETS.USERS).map(publicUser_);

  // what a unit costs the company is not a driver's, a counter worker's or a collector's to read
  if (['driver', 'branch_worker', 'collector'].indexOf(user.role) >= 0) {
    products = products.map(function (p) { var o = {}; safeOwnKeys_(p).forEach(function (k) { if (k !== 'unitCost' && k !== 'emptyCost') o[k] = p[k]; }); return o; });
    stockItems = stockItems.map(function (s) { var o = {}; safeOwnKeys_(s).forEach(function (k) { if (k !== 'unitCost' && k !== 'gasCost' && k !== 'cylinderCost') o[k] = s[k]; }); return o; });
  }
  if (isCompanyWide_(user.role) && user.role !== 'admin' && user.role !== 'finance') {
    // the deputy, the accountant and operations see people, not their sign-in
    // names or iqama numbers (security review 2026-10-04)
    pos = pos.map(function (p) { var o = {}; safeOwnKeys_(p).forEach(function (k) { if (k !== 'holderIqama') o[k] = p[k]; }); return o; });
    users = users.map(function (u) { var o = {}; safeOwnKeys_(u).forEach(function (k) { if (k !== 'email' && k !== 'iqamaId') o[k] = u[k]; }); return o; });
  }
  if (!isCompanyWide_(user.role)) {
    // holders' iqama numbers are private, and they are sign-in names
    pos = pos.map(function (p) { var o = {}; safeOwnKeys_(p).forEach(function (k) { if (k !== 'holderIqama') o[k] = p[k]; }); return o; });
    customers = customers.map(function (c) { return { id: c.id, code: c.code, name: c.name, city: c.city, active: c.active, deliveryFees: c.deliveryFees || null, commissions: c.commissions || null }; });
    // non-admins get every row (ids needed for pickers/labels) but only the
    // safe columns per the reference app's rule: restrict fields, not rows.
    users = users.map(function (u) {
      return { id: u.id, code: u.code || null, name: u.name, role: u.role, locationId: u.locationId, clusterId: u.clusterId };
    });
  }

  // the cost catalogue rides along for the people who read costs
  var costTypes = costCanRead_(user) ? readSheet(SHEETS.COST_TYPES) : undefined;
  return {
    ok: true, costTypes: costTypes,
    locations: locations, stores: stores, cars: cars, pos: pos,
    clusters: clusters, zones: zones, products: products, stockItems: stockItems, users: users,
    incomeItems: incomeItems, expenseItems: expenseItems, customers: customers, cities: cities, channels: channels,
    translations: readSheet(SHEETS.TRANSLATIONS).map(function (r) { return { src: r.src, en: r.en || '', ur: r.ur || '', auto: r.auto !== false }; }),
    config: { vatRate: vatRate_(), vatHistory: vatHistory_(), staleThresholdHours: staleThresholdHours_(), heldThresholdHours: heldThresholdHours_(), secondApprovalThreshold: secondApprovalThreshold_(), areaManagerBulkUploadEnabled: areaManagerBulkUploadEnabled_(), posSalesEnabled: posSalesEnabled_(), salesIncludeVat: salesIncludeVat_(), liveLocked: config_().liveLocked === true, liveLockedAt: config_().liveLockedAt || null, stockItemsLive: stockItemsLive_() }
  };
}
