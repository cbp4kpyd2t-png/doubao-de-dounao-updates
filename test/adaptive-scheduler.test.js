const test = require('node:test');
const assert = require('node:assert/strict');
const { AdaptiveScheduler } = require('../src/adaptive-scheduler');

test('连续成功会采用偏短间隔并根据实测耗时缩短生成等待', () => {
  const scheduler = new AdaptiveScheduler({ enabled: true });
  for (let i = 0; i < 5; i += 1) scheduler.record({ outcome: 'success', generationMs: 70000, images: 5 });
  assert.ok(scheduler.nextDelaySeconds(20, 60, () => 0.5) <= 28);
  assert.ok(scheduler.generationTimeoutSeconds(200) < 200);
  assert.ok(scheduler.generationTimeoutSeconds(200) >= 60);
});

test('失败和限流会增加调度压力且状态可持久化恢复', () => {
  const scheduler = new AdaptiveScheduler({ enabled: true });
  scheduler.record({ outcome: 'failure' }); scheduler.record({ outcome: 'rate-limit', rateLimited: true });
  const delay = scheduler.nextDelaySeconds(20, 60, () => 0.5);
  assert.ok(delay >= 45); assert.equal(scheduler.rateLimitCooldownMinutes(1), 10);
  const restored = new AdaptiveScheduler(scheduler.snapshot()); assert.equal(restored.snapshot().rateLimitCount, 1); assert.equal(restored.recentFailureRate(), 1);
});

test('关闭自适应时仍严格服从用户上下限', () => {
  const scheduler = new AdaptiveScheduler({ enabled: false });
  scheduler.record({ outcome: 'success', generationMs: 20000, images: 5 });
  assert.equal(scheduler.generationTimeoutSeconds(200), 200);
  assert.equal(scheduler.nextDelaySeconds(20, 60, () => 0), 20);
  assert.equal(scheduler.nextDelaySeconds(20, 60, () => 0.999), 60);
});
