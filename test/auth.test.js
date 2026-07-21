const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');

test('管理员凭据只在主进程使用慢摘要校验且不保存明文', () => {
  assert.match(main, /crypto\.scryptSync/); assert.match(main, /crypto\.timingSafeEqual/);
  assert.doesNotMatch(main, /14700082581/); assert.doesNotMatch(main, /['"]12580['"]/);
  assert.doesNotMatch(renderer, /14700082581|12580/); assert.doesNotMatch(html, /14700082581|12580/);
});

test('每个安装目录首次登录后保存带签名的本机授权标记', () => {
  assert.match(main, /path\.dirname\(process\.execPath\)/); assert.match(main, /createHmac\('sha256'/);
  assert.match(main, /admin-authorization\.json/); assert.match(main, /isInstallationAuthorized\(\)/);
  assert.match(main, /rememberInstallationAuthorization\(\)/); assert.match(main, /adminAuthenticated = isInstallationAuthorized\(\)/);
});

test('密码版本号变化会让旧授权自动失效', () => {
  assert.match(main, /const ADMIN_CREDENTIAL_VERSION = 1/);
  assert.match(main, /saved\.credentialVersion === ADMIN_CREDENTIAL_VERSION/);
  assert.match(main, /credentialVersion: ADMIN_CREDENTIAL_VERSION/);
  assert.match(main, /`\$\{id\}:\$\{ADMIN_CREDENTIAL_VERSION\}`/);
});

test('未授权时所有任务和文件接口由主进程拦截', () => {
  assert.match(main, /function requireAdmin\(\)/);
  for (const channel of ['folder:choose', 'task:startNew', 'task:continueSaved', 'task:inspectSaved', 'task:pause', 'task:resume', 'task:stop', 'task:login', 'folder:openOutput']) {
    const start = main.indexOf(`ipcMain.handle('${channel}'`); assert.ok(start >= 0, `缺少 ${channel}`); assert.match(main.slice(start, start + 260), /requireAdmin\(\)/, `${channel} 未受登录保护`);
  }
});

test('界面启动时显示密码登录门禁并可恢复已有授权', () => {
  assert.match(html, /id="authOverlay"/); assert.match(html, /id="adminAccount"/); assert.match(html, /id="adminPassword" type="password"/);
  assert.match(preload, /adminLogin:/); assert.match(preload, /authStatus:/);
  assert.match(renderer, /window\.appApi\.authStatus\(\)/); assert.match(renderer, /window\.appApi\.adminLogin\(account, password\)/);
  assert.match(renderer, /unlockApplication\(\)/); assert.match(renderer, /adminPassword'\)\.value = ''/);
});

test('软件使用单实例锁并把第二次启动切回现有窗口', () => {
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /app\.on\('second-instance'/);
  assert.match(main, /if \(win\.isMinimized\(\)\) win\.restore\(\)/);
  assert.match(main, /cleanupHiddenLegacyInstances\(\)/);
});

test('所有任务必须取得跨进程Edge全局锁', () => {
  assert.match(main, /new GlobalTaskLock\(app\.getPath\('userData'\)\)/);
  assert.match(main, /globalTaskLock\.acquire\(\)/);
  assert.match(main, /globalTaskLock\.release\(\)/);
  assert.match(main, /runLockedTask\(root, 'new'/);
  assert.match(main, /runLockedTask\(root, 'continue'/);
});

test('关闭窗口时停止监控并释放任务锁', () => {
  assert.match(main, /runner\?\.stopWatchdog\(\)/);
  assert.match(main, /await runner\?\.shutdown\(\)/);
  assert.match(main, /process\.on\('exit'.*globalTaskLock\?\.release\(\)/);
});
