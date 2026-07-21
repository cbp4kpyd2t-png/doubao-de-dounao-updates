const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { GlobalTaskLock } = require('../src/task-lock');

test('全局任务锁禁止同一电脑同时运行两个Edge任务并可正常释放', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ecom-task-lock-'));
  const first = new GlobalTaskLock(dir); const second = new GlobalTaskLock(dir);
  first.acquire();
  assert.throws(() => second.acquire(), /另一任务正在操作Edge/);
  first.release();
  assert.doesNotThrow(() => second.acquire());
  second.release();
});

test('全局任务锁会清理已经退出进程留下的旧锁', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ecom-stale-lock-'));
  await fsp.writeFile(path.join(dir, 'edge-automation.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' }), 'utf8');
  const lock = new GlobalTaskLock(dir);
  assert.doesNotThrow(() => lock.acquire());
  lock.release();
});

test('隐藏实例清理脚本保留可见实例进程树并只关闭无窗口残留组', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'process-guard.ps1'), 'utf8');
  assert.match(script, /MainWindowHandle -ne 0/);
  assert.match(script, /\$visibleIds/);
  assert.match(script, /if\(\$protected\)\{continue\}/);
  assert.match(script, /Stop-Process -Id \$process\.Id -Force/);
});

test('原生Edge调用会自动附带已绑定窗口句柄', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'automation.js'), 'utf8');
  assert.match(source, /boundEdgeWindowHandle/);
  assert.match(source, /edgeWindowHandle: boundEdgeWindowHandle/);
  assert.match(source, /updateBoundEdgeWindow\(result\)/);
  assert.match(source, /clearBoundEdgeWindow\(\)/);
});
