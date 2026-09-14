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

function actionAdminCreateUser_(req, user) {
  requireAdmin_(user);
  var d = req.data || {};
  if (!d.name || !d.email || !validRole_(d.role)) return { ok: false, error: 'invalid_input' };
  if (userByEmail_(d.email)) return { ok: false, error: 'email_exists' };

  var temp = randomPassword_();
  var salt = randomSalt_();
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
    salt: salt,
    pass: hashPw_(temp, salt),
    mustChangePw: true
  };
  writeRow(SHEETS.USERS, newUser);
  sendInvite_(newUser, temp);
  logAudit_('admin_create_user', user.id, newUser.id);
  return { ok: true, user: publicUser_(newUser) };
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
    MailApp.sendEmail(u.email, subject, body);
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
