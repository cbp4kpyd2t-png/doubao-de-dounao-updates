const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { TaskRunner } = require('./runner');
const { cleanupHiddenLegacyInstances } = require('./process-guard');
const { GlobalTaskLock } = require('./task-lock');
const { UpdateManager } = require('./update-manager');

const ADMIN_ACCOUNT_HASH = Buffer.from('883b26d58a3f49a0f48c78639d93d321b71ebd0fe8cf5b44c6f75f232fac2de3', 'hex');
const ADMIN_PASSWORD_HASH = Buffer.from('6737486ddfe28e347e30504384523a88616c618ece8c87d431f99263480b311c', 'hex');
const ADMIN_CREDENTIAL_VERSION = 1;
const AUTH_MARKER_SECRET = Buffer.from('df6705423a887ce665eca0999cf134f115614b18a63d1cfc4a361df659f6c1f1', 'hex');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let win; let runner; let globalTaskLock; let updateManager; let activeTaskPromise = null; let shutdownPromise = null; let adminAuthenticated = false; let failedLogins = 0; let lockedUntil = 0;
function credentialHash(value, salt) { return crypto.scryptSync(String(value ?? ''), salt, 32); }
function credentialMatches(value, salt, expected) { const actual = credentialHash(value, salt); return actual.length === expected.length && crypto.timingSafeEqual(actual, expected); }
function installationId() { return crypto.createHash('sha256').update(path.dirname(process.execPath).toLowerCase()).digest('hex'); }
function authorizationToken(id) { return crypto.createHmac('sha256', AUTH_MARKER_SECRET).update(`${id}:${ADMIN_CREDENTIAL_VERSION}`).digest('hex'); }
function authorizationFile() { return path.join(app.getPath('userData'), 'admin-authorization.json'); }
function isInstallationAuthorized() { try { const saved = JSON.parse(fs.readFileSync(authorizationFile(), 'utf8')); const id = installationId(); return saved.installationId === id && saved.credentialVersion === ADMIN_CREDENTIAL_VERSION && saved.token === authorizationToken(id); } catch { return false; } }
function rememberInstallationAuthorization() { const id = installationId(); fs.mkdirSync(path.dirname(authorizationFile()), { recursive: true }); fs.writeFileSync(authorizationFile(), JSON.stringify({ installationId: id, credentialVersion: ADMIN_CREDENTIAL_VERSION, token: authorizationToken(id), authorizedAt: new Date().toISOString() }), 'utf8'); }
function requireAdmin() { if (!adminAuthenticated) throw new Error('请先完成管理员账号登录'); }
function createWindow() {
  adminAuthenticated = isInstallationAuthorized(); failedLogins = 0; lockedUntil = 0;
  win = new BrowserWindow({ width: 1040, height: 760, minWidth: 820, minHeight: 620, title: '豆包的豆脑', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  runner = new TaskRunner(app.getPath('userData'), app.getPath('downloads'));
  globalTaskLock = new GlobalTaskLock(app.getPath('userData'));
  updateManager = new UpdateManager({ userDataDir: app.getPath('userData'), currentVersion: app.getVersion(), installDir: path.dirname(process.execPath), executablePath: process.execPath, packaged: app.isPackaged, onStatus: (data) => win?.webContents.send('update:status', data) });
  runner.on('status', (data) => win?.webContents.send('task:status', data));
  runner.on('log', (line) => win?.webContents.send('task:log', line));
  runner.on('alert', ({ title, message }) => dialog.showMessageBox(win, { type: 'warning', title, message, buttons: ['知道了'], defaultId: 0 }));
  win.webContents.once('did-finish-load', () => setTimeout(async () => { try { const settings = await updateManager.getSettings(); const sourceExists = /^https:\/\//i.test(settings.source || '') || fs.existsSync(settings.source || ''); if (settings.autoCheck && sourceExists && !activeTaskPromise) await updateManager.check(); } catch (error) { win?.webContents.send('update:status', { state: 'error', message: `自动检查更新失败：${error.message}` }); } }, 5000));
}

function focusMainWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
async function runLockedTask(root, mode, options) {
  if (activeTaskPromise) throw new Error('当前已有任务正在运行，禁止同时启动第二个任务');
  globalTaskLock.acquire();
  activeTaskPromise = runner.start(root, mode, options);
  try { await activeTaskPromise; }
  finally { activeTaskPromise = null; globalTaskLock.release(); }
}
function shutdownApplication() {
  if (!shutdownPromise) shutdownPromise = (async () => { runner?.stopWatchdog(); await runner?.shutdown(); globalTaskLock?.release(); })();
  return shutdownPromise;
}

if (!hasSingleInstanceLock) app.quit();
else {
  app.on('second-instance', () => focusMainWindow());
  app.whenReady().then(async () => {
    let cleanup = { killed: [], visible: [] };
    try { cleanup = cleanupHiddenLegacyInstances(); }
    catch (error) { dialog.showErrorBox('启动检查失败', `无法清理隐藏残留实例：${error.message}`); app.quit(); return; }
    if ((cleanup.visible || []).length) {
      dialog.showErrorBox('软件已经在运行', '检测到另一个可见的“豆包的豆脑”窗口。请继续使用该窗口，或先关闭它再启动新版。');
      app.quit(); return;
    }
    createWindow();
    if ((cleanup.killed || []).length) runner.log(`启动时已关闭${cleanup.killed.length}个隐藏残留进程，避免多个实例同时操作Edge`);
  });
}
app.on('window-all-closed', () => { shutdownApplication().finally(() => { if (process.platform !== 'darwin') app.quit(); }); });
app.on('before-quit', () => { runner?.stopWatchdog(); globalTaskLock?.release(); });
process.on('exit', () => globalTaskLock?.release());
ipcMain.handle('auth:login', (_e, account, password) => {
  const remainingMs = lockedUntil - Date.now();
  if (remainingMs > 0) return { ok: false, message: `登录失败次数过多，请${Math.ceil(remainingMs / 1000)}秒后再试` };
  const accountOk = credentialMatches(account, 'ecommerce-main-image-admin-account-v1', ADMIN_ACCOUNT_HASH);
  const passwordOk = credentialMatches(password, 'ecommerce-main-image-admin-password-v1', ADMIN_PASSWORD_HASH);
  if (!accountOk || !passwordOk) {
    failedLogins += 1; if (failedLogins >= 5) { lockedUntil = Date.now() + 30000; failedLogins = 0; }
    return { ok: false, message: lockedUntil > Date.now() ? '账号或密码错误，已锁定30秒' : `账号或密码错误，还可尝试${5 - failedLogins}次` };
  }
  adminAuthenticated = true; failedLogins = 0; lockedUntil = 0; rememberInstallationAuthorization(); return { ok: true };
});
ipcMain.handle('auth:status', () => ({ authenticated: adminAuthenticated, credentialVersion: ADMIN_CREDENTIAL_VERSION }));
ipcMain.handle('folder:choose', async () => { requireAdmin(); const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择产品总目录' }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('task:startNew', async (_e, root, options) => { requireAdmin(); runLockedTask(root, 'new', options).catch((error) => runner.log(`启动失败：${error.message}`)); return true; });
ipcMain.handle('task:continueSaved', async (_e, root, options) => { requireAdmin(); runLockedTask(root, 'continue', options).catch((error) => runner.log(`继续失败：${error.message}`)); return true; });
ipcMain.handle('task:inspectSaved', async (_e, root) => { requireAdmin(); return runner.inspectSavedState(root); });
ipcMain.handle('task:pause', () => { requireAdmin(); return runner.pause('用户暂停', false); });
ipcMain.handle('task:resume', () => { requireAdmin(); return runner.resume(); });
ipcMain.handle('task:stop', () => { requireAdmin(); return runner.stop(); });
ipcMain.handle('task:login', async (_e, root) => {
  requireAdmin();
  if (runner.browser?.connected) return { loggedIn: await runner.browser.isLoggedIn() };
  const { browser, loggedIn } = await runner.loginCheck(root); runner.browser = browser; return { loggedIn };
});
ipcMain.handle('folder:openOutput', async (_e, root) => { requireAdmin(); return shell.openPath(path.join(root, 'outputs')); });
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:getSettings', async () => { requireAdmin(); return updateManager.getSettings(); });
ipcMain.handle('update:chooseSource', async () => { requireAdmin(); const result = await dialog.showOpenDialog(win, { title: '选择更新清单 update-manifest.json', properties: ['openFile'], filters: [{ name: '更新清单', extensions: ['json'] }] }); return result.canceled ? null : result.filePaths[0]; });
ipcMain.handle('update:saveSettings', async (_e, settings) => { requireAdmin(); return updateManager.saveSettings(settings); });
ipcMain.handle('update:check', async (_e, source) => { requireAdmin(); if (activeTaskPromise) throw new Error('任务运行中暂不检查更新，避免影响生成效率'); return updateManager.check(source); });
ipcMain.handle('update:install', async () => { requireAdmin(); if (activeTaskPromise) throw new Error('请先停止当前任务再安装更新'); await updateManager.install(); setTimeout(() => shutdownApplication().finally(() => app.quit()), 250); return true; });
