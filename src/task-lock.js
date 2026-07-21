const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

class GlobalTaskLock {
  constructor(userDataDir) { this.file = path.join(userDataDir, 'edge-automation.lock'); this.token = null; }
  acquire() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = crypto.randomUUID();
      const record = { pid: process.pid, token, executable: process.execPath, acquiredAt: new Date().toISOString() };
      try {
        const fd = fs.openSync(this.file, 'wx');
        try { fs.writeFileSync(fd, JSON.stringify(record), 'utf8'); } finally { fs.closeSync(fd); }
        this.token = token; return record;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let owner = null; try { owner = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
        if (owner && processAlive(Number(owner.pid))) throw new Error(`另一任务正在操作Edge（进程 ${owner.pid}），禁止同时启动第二个任务`);
        try { fs.unlinkSync(this.file); } catch {}
      }
    }
    throw new Error('无法取得Edge全局任务锁，请关闭残留软件进程后重试');
  }
  release() {
    if (!this.token) return;
    try { const owner = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (owner.token === this.token && Number(owner.pid) === process.pid) fs.unlinkSync(this.file); } catch {}
    this.token = null;
  }
}

module.exports = { GlobalTaskLock, processAlive };
