/**
 * Prepared actual-browser form regression, NOT an executed test.
 *
 * Run ONLY inside ego-browser nodejs, with an already owned numeric TaskSpace:
 *   GONGDE_CREATOR_FORM_SPACE_ID="$OWNED_SPACE_ID" \
 *   GONGDE_CREATOR_FORM_LOOPBACK_URL="$READY_LOOPBACK_URL" \
 *   ego-browser nodejs < services/gongde-payments/tests/free-creator-form-regression.local.mjs
 *
 * Input priority: globalThis.GONGDE_CREATOR_FORM_SPACE_ID / LOOPBACK_URL,
 * then the matching GONGDE_CREATOR_FORM_* environment values, then
 * process.argv[2] (space ID) / process.argv[3] (origin) if actually forwarded.
 * The full global names are GONGDE_CREATOR_FORM_SPACE_ID and
 * GONGDE_CREATOR_FORM_LOOPBACK_URL. A global space ID may be a safe integer.
 * Pipe this source through ego-browser nodejs; interactive REPL logging may be
 * suppressed. The script uses stable native CSS selectors and keyboard Enter,
 * never transient DOM attribute mutation or a separate SDK module import.
 *
 * No new TaskSpace, no finish(), DB/server/browser launch, mock, fixture mutation,
 * production URL, filesystem artifact, screenshot or raw recovery-key log.
 * Exactly ONE registration submission; no retries after ambiguous outcomes.
 * All business operations use actual UI forms and the supplied app's real HTTP
 * session/work endpoints. No direct Repository, SQL, seeded business state or fake
 * request/clipboard interception. Recovery values exist only in browser/Node memory.
 *
 * One new Page is kept in the supplied space for Main. Creator cookies are shared:
 * execute serially after Main's creator-critical path; this driver logs out the
 * prior creator and leaves its newly recovered synthetic creator logged in.
 * It does not touch the separate administrator cookie or finish Main's space.
 */
import { randomBytes } from 'node:crypto';

class FormRegressionFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireTrue = (condition, code) => {
  if (!condition) throw new FormRegressionFailure(code);
};

let stage = 'input_guard';
let spaceId = null;
let page = null;
let registrationAttempted = false;
let registrationConfirmed = false;
let recoveryKey = null;
let rotatedRecoveryKey = null;
const passed = [];

async function boundedRead(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FormRegressionFailure(code)), milliseconds);
      })
    ]);
  } finally { clearTimeout(timer); }
}

async function poll(predicate, argument, code, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const evaluation = argument === undefined ? page.evaluate(predicate) : page.evaluate(predicate, argument);
    const result = await boundedRead(evaluation, Math.min(5000, remaining), code);
    if (result) return result;
    const delay = Math.min(150, deadline - Date.now());
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new FormRegressionFailure(code);
}

function record(name) {
  passed.push(name);
  console.log(JSON.stringify({ case: name, pass: true }));
}

async function enterFrom(selector) {
  await page.focus(selector);
  await page.keyboard.press('Enter');
}

async function getJson(path, expectedStatus = 200) {
  const response = await page.fetch(path, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', timeout: 10000
  });
  requireTrue(response.status === expectedStatus, 'FORM_REGRESSION_HTTP_STATUS_MISMATCH');
  let body;
  try { body = JSON.parse(response.body); }
  catch { throw new FormRegressionFailure('FORM_REGRESSION_HTTP_JSON_INVALID'); }
  return body;
}

async function logout() {
  await page.press('#creator-logout', 'Enter');
  await poll(() => {
    const auth = document.getElementById('creator-auth');
    const workspace = document.getElementById('creator-workspace');
    return auth && workspace && !auth.hidden && workspace.hidden;
  }, undefined, 'FORM_REGRESSION_LOGOUT_TIMEOUT');
  await getJson('/api/gongde/creators/session', 401);
}

async function login(username, password, displayName, expectedCreatorId) {
  await page.fill('#creator-login input[name=username]', username);
  await page.fill('#creator-login input[name=password]', password);
  await enterFrom('#creator-login input[name=password]');
  await poll(expected => {
    const workspace = document.getElementById('creator-workspace');
    const form = document.getElementById('creator-login');
    const name = document.getElementById('creator-account-name');
    return workspace && !workspace.hidden && name?.textContent.includes(expected.displayName) &&
      form && !form.querySelector('fieldset').disabled &&
      form.elements.username.value === expected.username && form.elements.password.value === '';
  }, { username, displayName }, 'FORM_REGRESSION_LOGIN_INPUT_CAPTURE_TIMEOUT');
  const session = await getJson('/api/gongde/creators/session');
  requireTrue(session.account?.username === username && session.account?.displayName === displayName &&
    session.account?.creatorId === expectedCreatorId, 'FORM_REGRESSION_LOGIN_ACCOUNT_MISMATCH');
}

async function checkWork(workId, creatorId, slug, expected) {
  const work = await getJson('/api/gongde/creators/works/' + encodeURIComponent(workId));
  requireTrue(work.workId === workId && work.creatorId === creatorId && work.slug === slug,
    'FORM_REGRESSION_WORK_IDENTITY_MISMATCH');
  requireTrue(work.metadata?.titleZh === expected.titleZh &&
    work.metadata?.description === expected.description &&
    JSON.stringify(work.metadata?.tags) === JSON.stringify(expected.tags),
  'FORM_REGRESSION_WORK_METADATA_MISMATCH');
  const preserved = await boundedRead(page.evaluate(value => {
    const form = document.getElementById('creator-work-form');
    const tags = form.elements.tags.value.split(/[,\uFF0C\u3001]/u).map(item => item.trim()).filter(Boolean);
    return form.elements.slug.value === value.slug && form.elements.slug.disabled &&
      form.elements.titleZh.value === value.titleZh &&
      form.elements.description.value === value.description &&
      JSON.stringify(tags) === JSON.stringify(value.tags) &&
      document.getElementById('creator-work-id').value === value.workId;
  }, { ...expected, slug, workId }), 5000, 'FORM_REGRESSION_WORK_DOM_READ_TIMEOUT');
  requireTrue(preserved, 'FORM_REGRESSION_WORK_FORM_NOT_PRESERVED');
}

try {
  const positional = process.argv.slice(2);
  const rawSpace = globalThis.GONGDE_CREATOR_FORM_SPACE_ID ??
    process.env.GONGDE_CREATOR_FORM_SPACE_ID ?? positional[0];
  const suppliedSpace = typeof rawSpace === 'number' && Number.isSafeInteger(rawSpace) ? String(rawSpace) : rawSpace;
  const suppliedOrigin = globalThis.GONGDE_CREATOR_FORM_LOOPBACK_URL ??
    process.env.GONGDE_CREATOR_FORM_LOOPBACK_URL ?? positional[1];
  requireTrue(typeof suppliedSpace === 'string' && /^[1-9][0-9]{0,8}$/u.test(suppliedSpace),
    'FORM_REGRESSION_OWNED_SPACE_ID_REQUIRED');
  const match = typeof suppliedOrigin === 'string' ?
    /^http:\/\/127\.0\.0\.1:([1-9][0-9]{4})\/?$/u.exec(suppliedOrigin) : null;
  requireTrue(match && Number(match[1]) >= 10000 && Number(match[1]) <= 65535,
    'FORM_REGRESSION_LITERAL_LOOPBACK_ORIGIN_REQUIRED');
  const origin = new URL(suppliedOrigin).origin;
  spaceId = Number(suppliedSpace);
  requireTrue(typeof taskSpace === 'function', 'FORM_REGRESSION_EGO_NODEJS_REQUIRED');

  const namespace = randomBytes(5).toString('hex');
  const username = 'form_' + namespace;
  const displayName = 'Form regression ' + namespace;
  const originalPassword = 'Fictional-old-' + namespace + '-A1';
  const newPassword = 'Fictional-new-' + namespace + '-B2';
  const slug = 'form-' + namespace;

  stage = 'reuse_owned_space';
  const task = await taskSpace(spaceId); // Numeric reuse only; never a space name.
  requireTrue(task.spaceId === spaceId && task.ownership !== 'user',
    'FORM_REGRESSION_SPACE_NOT_AGENT_OWNED');
  page = await task.newPage();
  await page.goto(origin + '/creator.html');
  requireTrue(new URL(await page.url()).origin === origin, 'FORM_REGRESSION_NONLOCAL_NAVIGATION');
  await poll(() => {
    const auth = document.getElementById('creator-auth');
    const workspace = document.getElementById('creator-workspace');
    return auth && workspace && (!auth.hidden || !workspace.hidden);
  }, undefined, 'FORM_REGRESSION_APP_READY_TIMEOUT');
  const alreadySignedIn = await boundedRead(page.evaluate(() =>
    !document.getElementById('creator-workspace').hidden),
  5000, 'FORM_REGRESSION_SESSION_DOM_READ_TIMEOUT');
  if (alreadySignedIn) await logout();

  stage = 'register_capture';
  await page.fill('#creator-register input[name=username]', username);
  await page.fill('#creator-register input[name=displayName]', displayName);
  await page.fill('#creator-register input[name=password]', originalPassword);
  await page.press('#creator-register input[name=acceptTerms]', 'Space');
  await page.focus('#creator-register input[name=password]');
  registrationAttempted = true;
  await page.keyboard.press('Enter'); // The only registration submission in this driver.
  await poll(expected => {
    const form = document.getElementById('creator-register');
    const recovery = document.getElementById('creator-recovery');
    const value = document.getElementById('creator-recovery-value');
    const workspace = document.getElementById('creator-workspace');
    return form && !form.querySelector('fieldset').disabled && workspace && !workspace.hidden &&
      recovery && !recovery.hidden && value && /^[a-f0-9]{64}$/u.test(value.value) &&
      value.dataset.username === expected.username &&
      form.elements.username.value === expected.username &&
      form.elements.displayName.value === expected.displayName && form.elements.password.value === '';
  }, { username, displayName }, 'FORM_REGRESSION_REGISTER_CAPTURE_TIMEOUT');
  registrationConfirmed = true;
  const registered = await getJson('/api/gongde/creators/session');
  requireTrue(registered.account?.username === username && registered.account?.displayName === displayName &&
    /^[a-f0-9]{32}$/u.test(registered.account?.creatorId ?? ''),
  'FORM_REGRESSION_REGISTERED_ACCOUNT_MISMATCH');
  const creatorId = registered.account.creatorId;
  recoveryKey = await boundedRead(page.evaluate(() =>
    document.getElementById('creator-recovery-value').value),
  5000, 'FORM_REGRESSION_RECOVERY_CAPTURE_TIMEOUT');
  requireTrue(typeof recoveryKey === 'string' && /^[a-f0-9]{64}$/u.test(recoveryKey),
    'FORM_REGRESSION_RECOVERY_KEY_INVALID');
  await page.press('#creator-recovery-saved', 'Enter');
  await poll(() => document.getElementById('creator-recovery').hidden &&
    document.getElementById('creator-recovery-value').value === '',
  undefined, 'FORM_REGRESSION_RECOVERY_CLEAR_TIMEOUT');
  record('register_preserves_captured_username_display_name_and_password');

  stage = 'original_password_login';
  await logout();
  await login(username, originalPassword, displayName, creatorId);
  record('login_uses_registered_password_and_preserves_username');
  await logout();

  stage = 'recovery_capture';
  const recoveryOpen = await boundedRead(page.evaluate(() =>
    document.getElementById('creator-recover').closest('details').open),
  5000, 'FORM_REGRESSION_RECOVERY_DETAILS_READ_TIMEOUT');
  if (!recoveryOpen) await page.press('#creator-auth details > summary', 'Enter');
  await page.fill('#creator-recover input[name=username]', username);
  await page.fill('#creator-recover input[name=recoveryKey]', recoveryKey);
  await page.fill('#creator-recover input[name=password]', newPassword);
  await enterFrom('#creator-recover input[name=password]');
  await poll(expected => {
    const form = document.getElementById('creator-recover');
    const panel = document.getElementById('creator-recovery');
    const output = document.getElementById('creator-recovery-value');
    return form && !form.querySelector('fieldset').disabled &&
      !document.getElementById('creator-auth').hidden && document.getElementById('creator-workspace').hidden &&
      panel && !panel.hidden && output && /^[a-f0-9]{64}$/u.test(output.value) &&
      output.dataset.username === expected && form.elements.username.value === expected &&
      form.elements.recoveryKey.value === '' && form.elements.password.value === '';
  }, username, 'FORM_REGRESSION_RECOVERY_CAPTURE_TIMEOUT');
  rotatedRecoveryKey = await boundedRead(page.evaluate(() =>
    document.getElementById('creator-recovery-value').value),
  5000, 'FORM_REGRESSION_ROTATED_KEY_READ_TIMEOUT');
  requireTrue(typeof rotatedRecoveryKey === 'string' && /^[a-f0-9]{64}$/u.test(rotatedRecoveryKey) &&
    rotatedRecoveryKey !== recoveryKey, 'FORM_REGRESSION_RECOVERY_NOT_ROTATED');
  await getJson('/api/gongde/creators/session', 401);
  await page.press('#creator-recovery-saved', 'Enter');
  await poll(() => document.getElementById('creator-recovery').hidden &&
    document.getElementById('creator-recovery-value').value === '',
  undefined, 'FORM_REGRESSION_ROTATED_KEY_CLEAR_TIMEOUT');
  recoveryKey = null;
  rotatedRecoveryKey = null;
  record('recovery_preserves_username_and_rotates_password_key_and_session');

  stage = 'old_password_rejected';
  await page.fill('#creator-login input[name=username]', username);
  await page.fill('#creator-login input[name=password]', originalPassword);
  await enterFrom('#creator-login input[name=password]');
  await poll(expected => {
    const form = document.getElementById('creator-login');
    const message = document.getElementById('creator-message');
    return !document.getElementById('creator-auth').hidden &&
      document.getElementById('creator-workspace').hidden &&
      !form.querySelector('fieldset').disabled && message.dataset.tone === 'error' &&
      message.textContent === '\u7528\u6237\u540d\u6216\u5bc6\u7801\u4e0d\u6b63\u786e\u3002' &&
      form.elements.username.value === expected.username && form.elements.password.value === expected.password;
  }, { username, password: originalPassword }, 'FORM_REGRESSION_OLD_PASSWORD_REJECTION_TIMEOUT');
  await getJson('/api/gongde/creators/session', 401);
  record('old_password_rejected_without_losing_retry_inputs');

  stage = 'recovered_password_login';
  await login(username, newPassword, displayName, creatorId);
  record('actual_ui_login_uses_captured_recovered_password');

  stage = 'create_work_capture';
  const initial = {
    titleZh: 'Captured creation ' + namespace,
    description: 'Synthetic form creation metadata must survive disabling the entire fieldset.',
    tags: ['alpha', 'beta']
  };
  await page.fill('#creator-work-form input[name=slug]', slug);
  await page.fill('#creator-work-form input[name=titleZh]', initial.titleZh);
  await page.fill('#creator-work-form textarea[name=description]', initial.description);
  await page.fill('#creator-work-form input[name=tags]', ' alpha, beta ');
  await page.press('#creator-work-form input[name=acceptFreeSharing]', 'Space');
  await enterFrom('#creator-work-form input[name=tags]');
  const workId = 'creator.' + creatorId + '.' + slug;
  await poll(expected => {
    const form = document.getElementById('creator-work-form');
    return !form.querySelector('fieldset').disabled &&
      !document.getElementById('creator-upload-section').hidden &&
      document.getElementById('creator-work-id').value === expected.workId &&
      document.getElementById('creator-editor-title').textContent === expected.titleZh;
  }, { workId, titleZh: initial.titleZh }, 'FORM_REGRESSION_CREATE_WORK_CAPTURE_TIMEOUT');
  await checkWork(workId, creatorId, slug, initial);
  record('create_work_preserves_slug_title_description_and_tags_in_actual_http_state');

  stage = 'update_work_capture';
  const updated = {
    titleZh: 'Captured update ' + namespace,
    description: 'Synthetic metadata update must survive disabled fieldset while the original slug stays unchanged.',
    tags: ['beta', 'gamma']
  };
  await page.fill('#creator-work-form input[name=titleZh]', updated.titleZh);
  await page.fill('#creator-work-form textarea[name=description]', updated.description);
  await page.fill('#creator-work-form input[name=tags]', ' beta, gamma, beta ');
  await page.press('#creator-work-form input[name=acceptFreeSharing]', 'Space');
  await enterFrom('#creator-work-form input[name=tags]');
  await poll(expected => {
    const form = document.getElementById('creator-work-form');
    return !form.querySelector('fieldset').disabled &&
      document.getElementById('creator-work-id').value === expected.workId &&
      document.getElementById('creator-editor-title').textContent === expected.titleZh;
  }, { workId, titleZh: updated.titleZh }, 'FORM_REGRESSION_UPDATE_WORK_CAPTURE_TIMEOUT');
  await checkWork(workId, creatorId, slug, updated);
  record('metadata_patch_preserves_actual_values_and_immutable_work_identity');

  console.log(JSON.stringify({
    kind: 'free-creator-form-regression', pass: true, passedCases: passed.length,
    registrationSubmissions: 1, spaceId, page: page.label, syntheticUsername: username, workId,
    recoveryKeyLogged: false, newSpaceCreated: false, parentSpaceFinished: false,
    backendBoundary: 'supplied actual local app HTTP; no mock or direct SQL'
  }));
} catch (error) {
  console.error(JSON.stringify({
    kind: 'free-creator-form-regression', pass: false, stage,
    error: error instanceof FormRegressionFailure ? error.code : 'FORM_REGRESSION_STEP_FAILED',
    passedCases: passed.length, registrationAttempted, registrationConfirmed, spaceId, page: page?.label ?? null,
    retryBoundary: 'Do not replay an unknown registration outcome; inspect the owned page first.',
    recoveryKeyLogged: false, parentSpaceFinished: false
  }));
  process.exitCode = 1;
} finally {
  recoveryKey = null;
  rotatedRecoveryKey = null;
}
