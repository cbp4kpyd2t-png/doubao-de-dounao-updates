const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');

const DEFAULT_UPDATE_SOURCE = 'https://raw.githubusercontent.com/cbp4kpyd2t-png/doubao-de-dounao-updates/main/update-manifest.json';

function versionParts(value) { return String(value || '0').replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0).slice(0, 3); }
function compareVersions(left, right) { const a = versionParts(left); const b = versionParts(right); for (let i = 0; i < 3; i += 1) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1; } return 0; }
function sha256File(file) { return new Promise((resolve, reject) => { const hash = crypto.createHash('sha256'); const stream = fs.createReadStream(file); stream.on('error', reject); stream.on('data', (chunk) => hash.update(chunk)); stream.on('end', () => resolve(hash.digest('hex'))); }); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isTransientFileLock(error) { return ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code); }
async function removeWithRetries(target, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { await fsp.rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 }); return true; }
    catch (error) {
      if (!isTransientFileLock(error) || attempt === attempts) throw error;
      await wait(attempt * 300);
    }
  }
  return false;
}
function createUpdateWorkDir(userDataDir, version) {
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(userDataDir, 'updates', `${String(version)}-${suffix}`);
}
function readyUpdateIsUsable(readyUpdate, executablePath) {
  return Boolean(readyUpdate?.contentDir && fs.existsSync(path.join(readyUpdate.contentDir, path.basename(executablePath))));
}
async function cleanupStaleUpdateDirs(updatesRoot, keepDir) {
  let entries = [];
  try { entries = await fsp.readdir(updatesRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(updatesRoot, entry.name);
    if (path.resolve(candidate) === path.resolve(keepDir)) continue;
    try { await removeWithRetries(candidate, 2); } catch { /* A scanner or old process may still hold it; a future check retries. */ }
  }
}
function isHttps(value) { return /^https:\/\//i.test(String(value || '')); }
function localPath(value) { return /^file:\/\//i.test(String(value || '')) ? fileURLToPath(value) : path.resolve(String(value || '')); }
function resolvePackageSource(manifestSource, packageValue) {
  if (isHttps(packageValue) || /^file:\/\//i.test(packageValue) || path.isAbsolute(packageValue)) return packageValue;
  if (isHttps(manifestSource)) return new URL(packageValue, manifestSource).href;
  return path.resolve(path.dirname(localPath(manifestSource)), packageValue);
}
async function downloadHttps(url, target, redirects = 0) {
  if (redirects > 5) throw new Error('更新下载重定向次数过多');
  await fsp.mkdir(path.dirname(target), { recursive: true });
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'EcommerceMainImageGenerator-Updater' } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) { response.resume(); const next = new URL(response.headers.location, url); if (next.protocol !== 'https:') { reject(new Error('更新下载拒绝从HTTPS降级到不安全连接')); return; } downloadHttps(next.href, target, redirects + 1).then(resolve, reject); return; }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`更新下载失败：HTTP ${response.statusCode}`)); return; }
      const output = fs.createWriteStream(target); response.pipe(output); output.on('finish', () => output.close(resolve)); output.on('error', reject);
    });
    request.setTimeout(60000, () => request.destroy(new Error('更新下载超时'))); request.on('error', reject);
  });
}
async function readTextSource(source) { if (isHttps(source)) return new Promise((resolve, reject) => { https.get(source, (response) => { if (response.statusCode !== 200) { response.resume(); reject(new Error(`更新清单读取失败：HTTP ${response.statusCode}`)); return; } let text = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve(text)); }).on('error', reject); }); return fsp.readFile(localPath(source), 'utf8'); }
function runPowerShell(args, timeoutMs = 180000) { return new Promise((resolve, reject) => { const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true }); let stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('更新解压超时')); }, timeoutMs); child.stderr.on('data', (chunk) => { stderr += chunk; }); child.on('error', reject); child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr.trim() || `更新解压失败：${code}`)); }); }); }

class UpdateManager {
  constructor({ userDataDir, currentVersion, installDir, executablePath, packaged, onStatus = () => {} }) {
    this.userDataDir = userDataDir; this.currentVersion = currentVersion; this.installDir = installDir; this.executablePath = executablePath; this.packaged = packaged; this.onStatus = onStatus;
    this.settingsFile = path.join(userDataDir, 'update-settings.json'); this.readyUpdate = null;
  }
  defaultSettings() { return { autoCheck: true, autoInstallWhenIdle: false, source: DEFAULT_UPDATE_SOURCE }; }
  async getSettings() {
    try {
      const defaults = this.defaultSettings();
      const settings = { ...defaults, ...JSON.parse(await fsp.readFile(this.settingsFile, 'utf8')) };
      const obsoleteDefault = path.join(this.installDir, 'updates', 'update-manifest.json');
      const source = String(settings.source || '').trim();
      if (!source || (!isHttps(source) && path.resolve(source) === path.resolve(obsoleteDefault) && !fs.existsSync(obsoleteDefault))) settings.source = defaults.source;
      return settings;
    } catch { return this.defaultSettings(); }
  }
  async saveSettings(settings) { const safe = { ...this.defaultSettings(), ...settings }; if (/^http:\/\//i.test(safe.source)) throw new Error('远程更新源必须使用HTTPS'); await fsp.mkdir(this.userDataDir, { recursive: true }); await fsp.writeFile(this.settingsFile, JSON.stringify(safe, null, 2), 'utf8'); return safe; }
  status(value) { this.onStatus(value); return value; }
  async check(sourceOverride) {
    const settings = await this.getSettings(); const source = String(sourceOverride || settings.source || '').trim();
    if (!source) return this.status({ state: 'unconfigured', message: '尚未配置更新源：请点击“选择更新源”，选择共享目录中的 update-manifest.json' });
    if (/^http:\/\//i.test(source)) throw new Error('远程更新源必须使用HTTPS');
    if (!isHttps(source) && !fs.existsSync(localPath(source))) return this.status({ state: 'missing', message: '更新清单不存在或共享目录暂时无法访问，请重新选择 update-manifest.json' });
    this.status({ state: 'checking', message: '正在检查更新…' });
    const manifest = JSON.parse((await readTextSource(source)).replace(/^\uFEFF/, ''));
    if (!manifest.version || !manifest.package || !/^[a-f0-9]{64}$/i.test(manifest.sha256 || '')) throw new Error('更新清单缺少version、package或有效sha256');
    if (compareVersions(manifest.version, this.currentVersion) <= 0) return this.status({ state: 'current', message: `当前已是最新版本 ${this.currentVersion}`, currentVersion: this.currentVersion });
    if (this.readyUpdate?.version === manifest.version && readyUpdateIsUsable(this.readyUpdate, this.executablePath)) {
      return this.status({ state: 'ready', message: `版本 ${manifest.version} 已通过校验，可安全安装`, version: manifest.version, notes: this.readyUpdate.notes || manifest.notes || '' });
    }
    const packageSource = resolvePackageSource(source, manifest.package);
    const updatesRoot = path.join(this.userDataDir, 'updates');
    const updateDir = createUpdateWorkDir(this.userDataDir, manifest.version);
    const zipFile = path.join(updateDir, 'package.zip');
    await fsp.mkdir(updateDir, { recursive: true });
    this.status({ state: 'downloading', message: `正在下载 ${manifest.version}…`, version: manifest.version });
    if (isHttps(packageSource)) await downloadHttps(packageSource, zipFile); else await fsp.copyFile(localPath(packageSource), zipFile);
    const actualHash = await sha256File(zipFile); if (actualHash.toLowerCase() !== manifest.sha256.toLowerCase()) { try { await removeWithRetries(updateDir); } catch {} throw new Error('更新包SHA256校验失败，已拒绝安装'); }
    const stagedDir = path.join(updateDir, 'staged'); await runPowerShell(['-Command', `Expand-Archive -LiteralPath '${zipFile.replace(/'/g, "''")}' -DestinationPath '${stagedDir.replace(/'/g, "''")}' -Force`]);
    const entries = await fsp.readdir(stagedDir, { withFileTypes: true }); let contentDir = stagedDir;
    if (entries.length === 1 && entries[0].isDirectory()) contentDir = path.join(stagedDir, entries[0].name);
    const exeName = path.basename(this.executablePath); if (!fs.existsSync(path.join(contentDir, exeName))) throw new Error(`更新包无效：未找到 ${exeName}`);
    this.readyUpdate = { version: manifest.version, notes: manifest.notes || '', contentDir, sha256: actualHash };
    cleanupStaleUpdateDirs(updatesRoot, updateDir).catch(() => {});
    return this.status({ state: 'ready', message: `版本 ${manifest.version} 已通过校验，可安全安装`, version: manifest.version, notes: manifest.notes || '' });
  }
  async install() {
    if (!this.packaged) throw new Error('开发模式不能执行自更新'); if (!this.readyUpdate) throw new Error('没有已下载并校验的更新');
    const helper = path.join(__dirname, 'update-helper.ps1').replace('app.asar', 'app.asar.unpacked');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-ParentPid', String(process.pid), '-SourceDir', this.readyUpdate.contentDir, '-InstallDir', this.installDir, '-ExecutableName', path.basename(this.executablePath)];
    const child = spawn('powershell.exe', args, { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();
    this.status({ state: 'installing', message: '软件关闭后将完成更新并自动重新打开' }); return true;
  }
}

module.exports = { UpdateManager, compareVersions, resolvePackageSource, sha256File, removeWithRetries, createUpdateWorkDir, readyUpdateIsUsable, DEFAULT_UPDATE_SOURCE };
