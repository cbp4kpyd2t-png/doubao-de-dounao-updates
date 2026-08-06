const test = require('node:test');
const assert = require('node:assert/strict');
const { transitionWorkflow, completeWorkflow, failWorkflow, isWorkflowOverdue } = require('../src/workflow-state');

test('状态机持久记录步骤、截止时间、重试和完成结果', () => {
  const state = { runId: 'r1', workflow: { history: [] } };
  const step = transitionWorkflow(state, '上传参考图', { productId: 'p1', round: 2, attempt: 1 }, { timeoutMs: 1000, maxAttempts: 2 });
  assert.equal(step.status, 'active'); assert.equal(step.maxAttempts, 2); assert.equal(state.workflow.current.id, step.id);
  assert.equal(isWorkflowOverdue(state, Date.parse(step.deadlineAt) + 1), true);
  completeWorkflow(state, { uploaded: 3 }); assert.equal(state.workflow.current, null); assert.equal(state.workflow.lastCompleted.outcome.uploaded, 3);
});

test('中途切换步骤会保留被替代步骤且失败带恢复动作', () => {
  const state = { runId: 'r1' };
  transitionWorkflow(state, '保存图片'); transitionWorkflow(state, '质量检测');
  assert.equal(state.workflow.history[0].status, 'superseded');
  failWorkflow(state, new Error('损坏'), '跳过候选');
  assert.equal(state.workflow.current, null); assert.equal(state.workflow.history.at(-1).recoveryAction, '跳过候选'); assert.equal(state.workflow.recoveryCount, 1);
});

test('最终复扫是显式持久化步骤', () => {
  const state = { runId: 'r2' };
  const step = transitionWorkflow(state, '最终复扫', { productId: 'p1', round: 3 });
  assert.equal(step.recovery, '保留缩略图断点并开启下一对话');
  assert.equal(step.timeoutMs, 360000);
});
