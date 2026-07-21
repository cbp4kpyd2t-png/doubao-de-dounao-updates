const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const runner = fs.readFileSync(path.join(__dirname, '..', 'src', 'runner.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('无法处理的问题只弹窗提示，不再操作微信', () => {
  assert.match(runner, /this\.emit\('alert', \{ title: '任务需要处理', message: reason \}\)/);
  assert.match(main, /runner\.on\('alert'/);
  assert.match(main, /buttons: \['知道了'\]/);
  assert.doesNotMatch(main, /checkWechat|sendWechatFileHelper|文件传输助手/);
  assert.doesNotMatch(runner, /assistance-needed|BOOS我卡了救救我/);
});

test('用户手动暂停不重复弹出故障提示', () => {
  assert.match(main, /runner\.pause\('用户暂停', false\)/);
  assert.match(runner, /showAlert = reason !== '用户暂停'/);
});

test('打包配置不再包含微信辅助脚本', () => {
  assert.ok(!pkg.build.asarUnpack.includes('src/wechat-notifier.ps1'));
});
