const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packagedHelper = path.join(__dirname, 'process-guard.ps1');
const HELPER = packagedHelper.includes('app.asar') ? packagedHelper.replace('app.asar', 'app.asar.unpacked') : packagedHelper;

function cleanupHiddenLegacyInstances(executableName = path.basename(process.execPath), currentPid = process.pid) {
  const encodedName = Buffer.from(executableName, 'utf8').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-CurrentPid', String(currentPid), '-ExecutableNameBase64', encodedName], { windowsHide: true, encoding: 'utf8', timeout: 20000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '隐藏实例清理失败').trim());
  return JSON.parse((result.stdout || '{}').trim());
}

module.exports = { cleanupHiddenLegacyInstances };
