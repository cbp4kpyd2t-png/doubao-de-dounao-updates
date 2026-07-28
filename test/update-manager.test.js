const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { UpdateManager, compareVersions, resolvePackageSource, createUpdateWorkDir, readyUpdateIsUsable, normalizeProxyUrl, DEFAULT_UPDATE_SOURCE } = require('../src/update-manager');

test('更新器只接受更高语义版本', () => { assert.equal(compareVersions('1.1.0', '1.0.9'), 1); assert.equal(compareVersions('1.0.0', '1.0.0'), 0); assert.equal(compareVersions('0.9.9', '1.0.0'), -1); });
test('本地和HTTPS清单均可安全解析相对更新包', () => {
  assert.equal(resolvePackageSource('https://example.com/releases/update-manifest.json', 'app.zip'), 'https://example.com/releases/app.zip');
  const manifest = path.join('D:\\', 'share', 'update-manifest.json');
  assert.equal(resolvePackageSource(manifest, 'app.zip'), path.join('D:\\', 'share', 'app.zip'));
});
test('界面顶部明显显示从主进程读取的实际版本号', () => {
  const fs = require('node:fs'); const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'); const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
  const headerEnd = html.indexOf('</header>'); const versionAt = html.indexOf('id="appVersion"');
  assert.ok(versionAt > 0 && versionAt < headerEnd); assert.match(renderer, /当前版本 v\$\{await window\.appApi\.getVersion\(\)\}/); assert.match(html, /version\.css/);
});
test('空白或旧默认更新源自动迁移到公开HTTPS更新地址', async () => {
  const fs = require('node:fs'); const fsp = fs.promises; const os = require('node:os'); const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-unconfigured-')); const installDir = path.join(dir, 'app'); await fsp.mkdir(dir, { recursive: true });
  const manager = new UpdateManager({ userDataDir: dir, currentVersion: '1.1.1', installDir, executablePath: path.join(installDir, 'app.exe'), packaged: false });
  await fsp.writeFile(manager.settingsFile, JSON.stringify({ autoCheck: true, source: path.join(installDir, 'updates', 'update-manifest.json') }), 'utf8');
  assert.equal((await manager.getSettings()).source, DEFAULT_UPDATE_SOURCE);
  await fsp.writeFile(manager.settingsFile, JSON.stringify({ autoCheck: true, source: '' }), 'utf8');
  assert.equal((await manager.getSettings()).source, DEFAULT_UPDATE_SOURCE);
});
test('界面提供更新源文件选择入口', () => {
  const fs = require('node:fs'); const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'); const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8'); const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.match(html, /id="chooseUpdateSource"/); assert.match(renderer, /chooseUpdateSource\(\)/); assert.match(preload, /update:chooseSource/);
});
test('更新界面显示真实下载百分比、文件大小和处理阶段', () => {
  const fs = require('node:fs'); const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'); const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8'); const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'style.css'), 'utf8');
  assert.match(html, /id="updateProgressWrap"/); assert.match(html, /<progress id="updateProgress" max="100"/);
  assert.match(renderer, /function renderUpdateStatus/); assert.match(renderer, /status\.receivedBytes/); assert.match(renderer, /status\.totalBytes/); assert.match(renderer, /status\.progress/);
  assert.match(renderer, /正在解压安装文件/); assert.match(css, /\.updateProgress progress/);
});
test('并行自动检查与手动检查复用同一个下载任务', async () => {
  const manager = new UpdateManager({ userDataDir: 'C:\\temp\\update-lock', currentVersion: '1.0.0', installDir: 'C:\\app', executablePath: 'C:\\app\\app.exe', packaged: false });
  let calls = 0; manager.performCheck = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { state: 'current' }; };
  const [first, second] = await Promise.all([manager.check(), manager.check()]);
  assert.equal(calls, 1); assert.equal(first.state, 'current'); assert.equal(second.state, 'current'); assert.equal(manager.checkPromise, null);
});
test('下载器提供进度、90秒停滞检测和有限重试', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-manager.js'), 'utf8');
  assert.match(source, /options\.onProgress\?\.\(\{ received, total, percent/);
  assert.match(source, /response\.setTimeout\(90 \* 1000/);
  assert.match(source, /attempts: 3/);
  assert.match(source, /state: 'verifying'/); assert.match(source, /state: 'extracting'/);
});
test('更新下载自动兼容Windows系统代理和分协议代理格式', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:10808'), 'http://127.0.0.1:10808');
  assert.equal(normalizeProxyUrl('http=127.0.0.1:8080;https=127.0.0.1:10808'), 'http://127.0.0.1:10808');
  assert.equal(normalizeProxyUrl('http://proxy.example:8080'), 'http://proxy.example:8080');
  const fs = require('node:fs'); const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-manager.js'), 'utf8');
  assert.match(source, /Internet Settings/); assert.match(source, /ProxyEnable/); assert.match(source, /ProxyServer/);
  assert.match(source, /new HttpsProxyAgent\(proxyUrl\)/); assert.match(source, /https\.get\(url, updateRequestOptions\(\)/);
});
test('品牌名称统一改为豆包的豆脑且保留内部数据标识', () => {
  const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')); const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'); const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.equal(pkg.build.productName, '豆包的豆脑'); assert.equal(pkg.build.nsis.shortcutName, '豆包的豆脑'); assert.match(pkg.build.win.artifactName, /^豆包的豆脑-/); assert.equal(pkg.name, 'ecommerce-main-image-generator'); assert.match(html, /<h1>豆包的豆脑<\/h1>/); assert.match(main, /title: '豆包的豆脑'/);
});
test('公开更新仓库地址与发布包地址配置一致', () => {
  const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.update.manifestUrl, DEFAULT_UPDATE_SOURCE);
  assert.match(pkg.update.releaseBaseUrl, /^https:\/\/github\.com\/cbp4kpyd2t-png\/doubao-de-dounao-updates\/releases\/download$/);
});
test('每次检查使用唯一暂存目录，旧目录被占用时不会阻塞新下载', () => {
  const first = createUpdateWorkDir('C:\\temp\\app', '1.3.1');
  const second = createUpdateWorkDir('C:\\temp\\app', '1.3.1');
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.join('C:\\temp\\app', 'updates'));
  assert.match(path.basename(first), /^1\.3\.1-\d+-[a-f0-9]{8}$/);
});
test('同一版本已校验完成时重复检查直接复用，不删除暂存文件', async () => {
  const fs = require('node:fs'); const fsp = fs.promises; const os = require('node:os');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-ready-cache-'));
  const installDir = path.join(dir, 'installed'); const stagedDir = path.join(dir, 'updates', '1.3.1-verified', 'staged'); const executablePath = path.join(installDir, 'app.exe');
  await fsp.mkdir(stagedDir, { recursive: true }); await fsp.writeFile(path.join(stagedDir, 'app.exe'), 'ok');
  const manifestFile = path.join(dir, 'update-manifest.json');
  await fsp.writeFile(manifestFile, JSON.stringify({ version: '1.3.1', package: 'missing.zip', sha256: 'a'.repeat(64) }), 'utf8');
  const manager = new UpdateManager({ userDataDir: dir, currentVersion: '1.3.0', installDir, executablePath, packaged: true });
  manager.readyUpdate = { version: '1.3.1', contentDir: stagedDir, notes: 'ready' };
  assert.equal(readyUpdateIsUsable(manager.readyUpdate, executablePath), true);
  const result = await manager.check(manifestFile);
  assert.equal(result.state, 'ready'); assert.equal(result.version, '1.3.1'); assert.equal(fs.existsSync(path.join(stagedDir, 'app.exe')), true);
});
test('安装优先使用新包内助手并等待全部旧版子进程退出', () => {
  const fs = require('node:fs');
  const managerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-manager.js'), 'utf8');
  const helperSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'update-helper.ps1'), 'utf8');
  assert.match(managerSource, /const stagedHelper = path\.join\(this\.readyUpdate\.contentDir/);
  assert.match(managerSource, /fs\.existsSync\(stagedHelper\) \? stagedHelper : currentHelper/);
  assert.match(helperSource, /Get-CimInstance Win32_Process/);
  assert.match(helperSource, /StartsWith\(\$installPrefix/);
  assert.match(helperSource, /Copy-DirectoryContents/);
  assert.match(helperSource, /install\.log/);
});
