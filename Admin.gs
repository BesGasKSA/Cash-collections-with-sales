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
  product: SHEETS.PRODUCTS
};

// child sheet + the field on the child that points at the parent, used to
// block deletes that would orphan children.
var ENTITY_CHILDREN = {
  location: [{ sheet: SHEETS.STORES, field: 'locationId' }, { sheet: SHEETS.CARS, field: 'locationId' }],
  store: [{ sheet: SHEETS.POS, field: 'ownerId', ownerType: 'store' }],
  car: [{ sheet: SHEETS.POS, field: 'ownerId', ownerType: 'car' }],
  cluster: [{ sheet: SHEETS.LOCATIONS, field: 'clusterId' }],
  zone: [{ sheet: SHEETS.LOCATIONS, field: 'zoneId' }],
  pos: [],
  // a product with existing sales history stays selectable in entry forms
  // (deactivate instead) but blocking delete protects the report from
  // orphaned productIds it can no longer label.
  product: [{ sheet: SHEETS.ENTRIES, field: 'productId' }]
};

function requireAdmin_(user) {
  if (user.role !== 'admin') throw new Error('forbidden');
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
  return ['admin', 'finance', 'accountant', 'operations_manager', 'deputy_operations_manager', 'cluster_manager', 'store_manager', 'collector', 'driver'].indexOf(r) >= 0;
}

// New users are *invited*, not handed a temporary password: the email carries
// a single-use link, the person picks their own password on the accept page,
// and their status moves invited -> accepted (link used) -> active (first
// real sign-in). See userStatus_ in Code.gs for how the admin list reads it.
function actionAdminCreateUser_(req, user) {
  requireAdmin_(user);
  var d = req.data || {};
  if (!d.name || !d.email || !validRole_(d.role)) return { ok: false, error: 'invalid_input' };
  if (userByEmail_(d.email)) return { ok: false, error: 'email_exists' };

  var newUser = {
    id: Utilities.getUuid(),
    name: d.name,
    email: String(d.email).trim(),
    role: d.role,
    active: true,
    language: d.language || 'ar',
    locationId: d.locationId || null,
    clusterId: d.clusterId || null,
    iqamaId: d.iqamaId || null,
    salt: null,
    pass: null,
    mustChangePw: false,
    createdAt: new Date().toISOString()
  };
  var token = issueInvite_(newUser, user);
  writeRow(SHEETS.USERS, newUser);
  var sent = sendInvitation_(newUser, token, user, inviteAppUrl_(req));
  logAudit_('admin_invite_user', user.id, newUser.id);
  return { ok: true, user: publicUser_(newUser), inviteSent: sent };
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
// using (live site, or a local preview), falling back to the live site.
function inviteAppUrl_(req) {
  var u = String((req && req.appUrl) || '').split('#')[0].split('?')[0];
  if (/^https:\/\/[^\s"'<>]+$/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>]*$/.test(u)) {
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
  var sent = sendInvitation_(target, token, user, inviteAppUrl_(req));
  logAudit_('admin_resend_invite', user.id, target.id);
  return { ok: true, user: publicUser_(target), inviteSent: sent };
}

// Public (no session): what the accept page needs to greet the person.
function actionInviteInfo_(req) {
  var u = userByInviteToken_(req.inviteToken);
  if (!u) return { ok: true, status: 'invalid' };
  var st = inviteTokenState_(u);
  var out = { ok: true, status: st, language: u.language || 'ar' };
  if (st === 'valid') { out.name = u.name; out.email = u.email; out.role = u.role; out.expiresAt = u.inviteExpiresAt; }
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
  admin: ['مدير النظام', 'System Administrator'],
  finance: ['المالية', 'Finance'],
  accountant: ['محاسب', 'Accountant'],
  operations_manager: ['مدير العمليات', 'Operations Manager'],
  deputy_operations_manager: ['نائب مدير العمليات', 'Deputy Operations Manager'],
  cluster_manager: ['مدير منطقة', 'Area Manager'],
  store_manager: ['مدير فرع', 'Branch Manager'],
  collector: ['المحصّل', 'Collector'],
  driver: ['السائق', 'Driver']
};

function htmlEsc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Returns true when the email went out. A failure never blocks the account:
// the admin sees 'not sent' and can press Resend.
function sendInvitation_(u, token, inviter, appUrl) {
  var link = appUrl + '?invite=' + encodeURIComponent(token);
  var role = ROLE_NAMES_[u.role] || [u.role, u.role];
  var who = inviter && inviter.name ? inviter.name : 'Best Gas';
  var expTxt = String(u.inviteExpiresAt || '').slice(0, 10);
  var subject = 'دعوة للانضمام إلى نظام تحصيل النقدية | You\'re invited to Best Gas Cash Collection';
  var text = [
    'مرحباً ' + u.name + '،',
    who + ' يدعوك للانضمام إلى نظام تحصيل النقدية والموافقات — الناقل الأفضل للغاز، بصلاحية: ' + role[0] + '.',
    'لقبول الدعوة واختيار كلمة المرور افتح الرابط التالي:',
    '',
    'Hello ' + u.name + ',',
    who + ' has invited you to join the Best Gas Cash Collection & Approval System as ' + role[1] + '.',
    'Accept the invitation and choose your password here:',
    '',
    'Invitation link: ' + link,
    '',
    'الرابط صالح حتى / Link valid until: ' + expTxt,
    'البريد / Email: ' + u.email
  ].join('\n');
  try {
    sendMail_(u.email, subject, text, inviteEmailHtml_(u, link, who, role, expTxt, appUrl));
    return true;
  } catch (e) {
    logAudit_('invite_email_failed', u.id, String(e));
    return false;
  }
}

// Table layout + inline styles only: that's what Outlook, Gmail and phone
// mail apps all render the same way. The logo is a hosted PNG next to the
// app (data: images are stripped by Gmail); the text wordmark under it
// still carries the brand when a mail client blocks images.
function inviteEmailHtml_(u, link, who, role, expTxt, appUrl) {
  var G = '#4D6D51', GD = '#3B5540', CREAM = '#F2EEE4', INK = '#1F2A22', MUTED = '#6B7468';
  var e = htmlEsc_, L = e(link);
  function button(label) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto 8px;"><tr><td align="center" bgcolor="' + G + '" style="border-radius:12px;background:' + G + ';">' +
      '<a href="' + L + '" target="_blank" style="display:inline-block;padding:15px 40px;font-family:Tahoma,Arial,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:12px;">' + label + '</a></td></tr></table>';
  }
  function row(k, v) {
    return '<tr><td style="padding:8px 0;color:' + MUTED + ';font-size:13px;">' + k + '</td><td align="right" style="padding:8px 0;color:' + INK + ';font-size:13px;font-weight:bold;">' + v + '</td></tr>';
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
    '<body style="margin:0;padding:0;background:' + CREAM + ';">' +
    '<div style="display:none;max-height:0;overflow:hidden;">' + e(who) + ' invited you to Best Gas Cash Collection</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + CREAM + ';"><tr><td align="center" style="padding:32px 14px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;">' +
    // header
    '<tr><td align="center" bgcolor="' + G + '" style="background:' + G + ';background-image:linear-gradient(135deg,' + G + ',' + GD + ');padding:34px 24px 28px;">' +
      '<img src="' + e(appUrl) + 'assets/mail-logo.png" width="76" height="76" alt="Best Gas" style="display:block;margin:0 auto 14px;border:0;border-radius:18px;">' +
      '<div style="font-family:Tahoma,Arial,sans-serif;color:#ffffff;font-size:20px;font-weight:bold;">الناقل الأفضل للغاز</div>' +
      '<div style="font-family:Arial,sans-serif;color:' + CREAM + ';font-size:11px;letter-spacing:3px;margin-top:6px;">BEST GAS CARRIER CO.</div>' +
      '<div style="display:inline-block;margin-top:18px;padding:6px 16px;border-radius:999px;background:#5f7e63;font-family:Tahoma,Arial,sans-serif;color:#ffffff;font-size:12px;">دعوة للانضمام &nbsp;&bull;&nbsp; Invitation</div>' +
    '</td></tr>' +
    // Arabic
    '<tr><td dir="rtl" align="right" style="padding:34px 36px 6px;font-family:Tahoma,Arial,sans-serif;text-align:right;color:' + INK + ';">' +
      '<div style="font-size:22px;font-weight:bold;margin-bottom:12px;">مرحباً ' + e(u.name) + '،</div>' +
      '<div style="font-size:15px;line-height:1.9;color:#3d463f;">يسعدنا انضمامك إلينا. قام <b>' + e(who) + '</b> بدعوتك للانضمام إلى <b>نظام تحصيل النقدية والموافقات</b> بصلاحية <b style="color:' + G + ';">' + e(role[0]) + '</b>.<br>اضغط الزر أدناه لقبول الدعوة واختيار كلمة المرور الخاصة بك.</div>' +
      button('قبول الدعوة') +
    '</td></tr>' +
    // details
    '<tr><td style="padding:10px 36px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F5EF;border-radius:12px;font-family:Tahoma,Arial,sans-serif;">' +
      '<tr><td style="padding:6px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' +
        row('Email / البريد', '<span dir="ltr">' + e(u.email) + '</span>') +
        row('Role / الصلاحية', e(role[1]) + ' · ' + e(role[0])) +
        row('Valid until / صالحة حتى', '<span dir="ltr">' + e(expTxt) + '</span>') +
      '</table></td></tr></table>' +
    '</td></tr>' +
    // English
    '<tr><td dir="ltr" align="left" style="padding:26px 36px 6px;font-family:Arial,sans-serif;text-align:left;color:' + INK + ';">' +
      '<div style="border-top:1px solid #EEEAE0;padding-top:24px;font-size:20px;font-weight:bold;margin-bottom:10px;">Hello ' + e(u.name) + ',</div>' +
      '<div style="font-size:15px;line-height:1.7;color:#3d463f;"><b>' + e(who) + '</b> has invited you to join the <b>Best Gas Cash Collection &amp; Approval System</b> as <b style="color:' + G + ';">' + e(role[1]) + '</b>. Accept the invitation to choose your password and sign in.</div>' +
      button('Accept invitation') +
    '</td></tr>' +
    // fallback link
    '<tr><td style="padding:14px 36px 30px;font-family:Arial,sans-serif;">' +
      '<div style="font-size:12px;color:' + MUTED + ';line-height:1.7;text-align:center;">إذا لم يعمل الزر، انسخ الرابط التالي في المتصفح<br>If the button doesn\'t work, paste this link into your browser:</div>' +
      '<div dir="ltr" style="margin-top:8px;font-size:12px;text-align:center;word-break:break-all;"><a href="' + L + '" style="color:' + G + ';">' + L + '</a></div>' +
    '</td></tr>' +
    // footer
    '<tr><td align="center" bgcolor="#F7F5EF" style="background:#F7F5EF;padding:18px 28px;font-family:Tahoma,Arial,sans-serif;font-size:11.5px;color:' + MUTED + ';line-height:1.8;">' +
      'الرابط شخصي ويُستخدم مرة واحدة فقط. إذا لم تكن تتوقع هذه الدعوة يمكنك تجاهل هذه الرسالة.<br>' +
      'This link is personal and works once. If you weren\'t expecting this invitation, you can ignore this email.<br>' +
      '<span style="color:' + G + ';font-weight:bold;">Best Gas Carrier Co.</span>' +
    '</td></tr>' +
    '</table></td></tr></table></body></html>';
}

function actionAdminUpdateUser_(req, user) {
  requireAdmin_(user);
  var target = getById_(SHEETS.USERS, req.id);
  if (!target) return { ok: false, error: 'not_found' };
  var d = req.data || {};
  if (d.name != null) {
    if (!String(d.name).trim()) return { ok: false, error: 'invalid_input' };
    target.name = d.name;
  }
  if (d.email != null) {
    var email = String(d.email).trim();
    if (!email) return { ok: false, error: 'invalid_input' };
    var existing = userByEmail_(email);
    if (existing && existing.id !== target.id) return { ok: false, error: 'email_exists' };
    target.email = email;
  }
  if (d.role != null) {
    if (!validRole_(d.role)) return { ok: false, error: 'invalid_input' };
    target.role = d.role;
  }
  if (d.language != null) target.language = d.language;
  if (d.active != null) target.active = !!d.active;
  if (d.locationId !== undefined) target.locationId = d.locationId;
  if (d.clusterId !== undefined) target.clusterId = d.clusterId;
  if (d.iqamaId !== undefined) target.iqamaId = d.iqamaId;
  writeRow(SHEETS.USERS, target);
  logAudit_('admin_update_user', user.id, target.id);
  return { ok: true, user: publicUser_(target) };
}

function actionAdminResetPassword_(req, user) {
  requireAdmin_(user);
  var target = getById_(SHEETS.USERS, req.id);
  if (!target) return { ok: false, error: 'not_found' };
  // Someone who never accepted their invitation gets a fresh invitation,
  // not a temporary password that would skip the accept step.
  if (target.inviteStatus === 'invited') return actionAdminResendInvite_(req, user);
  var temp = randomPassword_();
  var salt = randomSalt_();
  target.salt = salt;
  target.pass = hashPw_(temp, salt);
  target.mustChangePw = true;
  writeRow(SHEETS.USERS, target);
  sendInvite_(target, temp);
  logAudit_('admin_reset_password', user.id, target.id);
  return { ok: true };
}

function sendInvite_(u, tempPassword) {
  var cfg = config_();
  var subject = (cfg.senderName || 'Best Gas Cash Collection') + ' — بيانات الدخول / Login details';
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
function validateEntity_(kind, d) {
  if (kind === 'location') {
    if (!d.city || !d.name) return 'invalid_input';
  } else if (kind === 'store') {
    if (!d.locationId || !d.name) return 'invalid_input';
    var loc = getById_(SHEETS.LOCATIONS, d.locationId);
    if (!loc) return 'invalid_location';
    if (d.storeManagerUserId && loc.clusterId) {
      var storeCluster = getById_(SHEETS.CLUSTERS, loc.clusterId);
      if (storeCluster && (d.storeManagerUserId === storeCluster.clusterManagerUserId || d.storeManagerUserId === storeCluster.collectorUserId)) {
        return 'conflict_of_interest';
      }
    }
  } else if (kind === 'car') {
    if (!d.locationId || !d.label) return 'invalid_input';
    if (!getById_(SHEETS.LOCATIONS, d.locationId)) return 'invalid_location';
  } else if (kind === 'pos') {
    if (!d.ownerType || !d.ownerId || !d.label) return 'invalid_input';
    if (d.ownerType !== 'store' && d.ownerType !== 'car') return 'invalid_owner_type';
    var ownerSheet = d.ownerType === 'store' ? SHEETS.STORES : SHEETS.CARS;
    if (!getById_(ownerSheet, d.ownerId)) return 'invalid_owner';
  } else if (kind === 'cluster') {
    if (!d.name) return 'invalid_input';
    if (d.clusterManagerUserId && d.collectorUserId && d.clusterManagerUserId === d.collectorUserId) {
      return 'conflict_of_interest';
    }
  } else if (kind === 'zone') {
    if (!d.city || !d.name) return 'invalid_input';
  } else if (kind === 'product') {
    if (!d.name) return 'invalid_input';
  } else {
    return 'invalid_kind';
  }
  return null;
}

function actionAdminSaveEntity_(req, user) {
  requireAdmin_(user);
  var kind = req.kind;
  var sheetName = hasOwn_(ENTITY_SHEET, kind) ? ENTITY_SHEET[kind] : null;
  if (!sheetName) return { ok: false, error: 'invalid_kind' };
  var d = req.data || {};

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
  var err = validateEntity_(kind, merged);
  if (err) return { ok: false, error: err };

  safeOwnKeys_(d).forEach(function (k) { obj[k] = d[k]; });
  if (obj.active === undefined) obj.active = true;

  var saved = writeRow(sheetName, obj);
  logAudit_('admin_save_' + kind, user.id, saved.id);
  return { ok: true, entity: saved };
}

function actionAdminDeleteEntity_(req, user) {
  requireAdmin_(user);
  var kind = req.kind;
  var sheetName = hasOwn_(ENTITY_SHEET, kind) ? ENTITY_SHEET[kind] : null;
  if (!sheetName) return { ok: false, error: 'invalid_kind' };
  if (!getById_(sheetName, req.id)) return { ok: false, error: 'not_found' };

  var children = hasOwn_(ENTITY_CHILDREN, kind) ? ENTITY_CHILDREN[kind] : [];
  for (var i = 0; i < children.length; i++) {
    var rule = children[i];
    var rows = readSheet(rule.sheet);
    for (var j = 0; j < rows.length; j++) {
      if (rows[j][rule.field] !== req.id) continue;
      if (rule.ownerType && rows[j].ownerType !== rule.ownerType) continue;
      return { ok: false, error: 'has_children' };
    }
  }

  deleteRow_(sheetName, req.id);
  logAudit_('admin_delete_' + kind, user.id, req.id);
  return { ok: true };
}

// ---------- Config ----------

function actionAdminSetConfig_(req, user) {
  requireAdmin_(user);
  var cfg = config_();
  var d = req.data || {};
  if (d.vatRate != null) cfg.vatRate = Number(d.vatRate);
  if (d.senderName != null) cfg.senderName = String(d.senderName);
  if (d.staleThresholdHours != null) cfg.staleThresholdHours = Number(d.staleThresholdHours);
  if (d.heldThresholdHours != null) cfg.heldThresholdHours = Number(d.heldThresholdHours);
  if (d.secondApprovalThreshold != null) cfg.secondApprovalThreshold = Number(d.secondApprovalThreshold);
  if (d.areaManagerBulkUploadEnabled != null) cfg.areaManagerBulkUploadEnabled = !!d.areaManagerBulkUploadEnabled;
  writeRow(SHEETS.CONFIG, cfg);
  logAudit_('admin_set_config', user.id, null);
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
  Logger.log('First admin created: ' + ADMIN_EMAIL + ' — temp password also emailed: ' + temp);
}

// ---------- Reference data (used by every role to render forms/pickers) ----------

function actionMeta_(req, user) {
  var locations = readSheet(SHEETS.LOCATIONS);
  var stores = readSheet(SHEETS.STORES);
  var cars = readSheet(SHEETS.CARS);
  var pos = readSheet(SHEETS.POS);
  var clusters = readSheet(SHEETS.CLUSTERS);
  var zones = readSheet(SHEETS.ZONES);
  var products = readSheet(SHEETS.PRODUCTS);
  var users = readSheet(SHEETS.USERS).map(publicUser_);

  if (!isCompanyWide_(user.role)) {
    // non-admins get every row (ids needed for pickers/labels) but only the
    // safe columns per the reference app's rule: restrict fields, not rows.
    users = users.map(function (u) {
      return { id: u.id, name: u.name, role: u.role, locationId: u.locationId, clusterId: u.clusterId };
    });
  }

  return {
    ok: true,
    locations: locations, stores: stores, cars: cars, pos: pos,
    clusters: clusters, zones: zones, products: products, users: users,
    config: { vatRate: vatRate_(), staleThresholdHours: staleThresholdHours_(), heldThresholdHours: heldThresholdHours_(), secondApprovalThreshold: secondApprovalThreshold_(), areaManagerBulkUploadEnabled: areaManagerBulkUploadEnabled_() }
  };
}
