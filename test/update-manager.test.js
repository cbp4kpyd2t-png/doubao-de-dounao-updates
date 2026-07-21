const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { UpdateManager, compareVersions, resolvePackageSource, DEFAULT_UPDATE_SOURCE } = require('../src/update-manager');

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
test('品牌名称统一改为豆包的豆脑且保留内部数据标识', () => {
  const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')); const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'); const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.equal(pkg.build.productName, '豆包的豆脑'); assert.equal(pkg.build.nsis.shortcutName, '豆包的豆脑'); assert.match(pkg.build.win.artifactName, /^豆包的豆脑-/); assert.equal(pkg.name, 'ecommerce-main-image-generator'); assert.match(html, /<h1>豆包的豆脑<\/h1>/); assert.match(main, /title: '豆包的豆脑'/);
});
test('公开更新仓库地址与发布包地址配置一致', () => {
  const fs = require('node:fs'); const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.update.manifestUrl, DEFAULT_UPDATE_SOURCE);
  assert.match(pkg.update.releaseBaseUrl, /^https:\/\/github\.com\/cbp4kpyd2t-png\/doubao-de-dounao-updates\/releases\/download$/);
});
