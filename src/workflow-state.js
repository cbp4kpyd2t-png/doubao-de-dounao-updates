const STEP_POLICIES = Object.freeze({
  '扫描产品': { timeoutMs: 30000, maxAttempts: 2, recovery: '重新扫描目录' },
  '检查旧对话': { timeoutMs: 120000, maxAttempts: 1, recovery: '延后回查并开启新对话' },
  '打开新对话': { timeoutMs: 90000, maxAttempts: 1, recovery: '进入安全熔断并等待人工确认' },
  '上传参考图': { timeoutMs: 240000, maxAttempts: 1, recovery: '清空附件后仅重传一次，失败则安全暂停' },
  '发送提示词': { timeoutMs: 120000, maxAttempts: 1, recovery: '验证附件，失败则安全暂停' },
  '等待生成': { timeoutMs: 900000, maxAttempts: 1, recovery: '记录旧对话并开启新对话' },
  '确认图片': { timeoutMs: 120000, maxAttempts: 2, recovery: '延后回查当前对话' },
  '最终复扫': { timeoutMs: 360000, maxAttempts: 1, recovery: '保留缩略图断点并开启下一对话' },
  '保存图片': { timeoutMs: 360000, maxAttempts: 2, recovery: '关闭保存界面并返回对话' },
  '质量检测': { timeoutMs: 120000, maxAttempts: 1, recovery: '拒绝无效候选并继续' },
  '轮次等待': { timeoutMs: 900000, maxAttempts: 1, recovery: '结束等待并继续' },
  '限流冷却': { timeoutMs: 7200000, maxAttempts: 1, recovery: '冷却后恢复页面' },
  '页面恢复': { timeoutMs: 180000, maxAttempts: 1, recovery: '仅恢复一次，失败则安全暂停' },
});

function policyFor(name, overrides = {}) { return { timeoutMs: 120000, maxAttempts: 1, recovery: '恢复页面并从断点继续', ...(STEP_POLICIES[name] || {}), ...overrides }; }

function transitionWorkflow(state, name, context = {}, overrides = {}) {
  const policy = policyFor(name, overrides);
  const now = Date.now();
  const previous = state.workflow?.current;
  state.workflow ||= {};
  state.workflow.version ||= 1;
  state.workflow.sequence ||= 0;
  state.workflow.history ||= [];
  state.workflow.current ||= null;
  state.workflow.recoveryCount ||= 0;
  if (previous && previous.status === 'active') {
    previous.status = 'superseded'; previous.finishedAt = new Date(now).toISOString();
    state.workflow.history.push(previous);
  }
  const current = {
    id: `${state.runId || 'run'}-${++state.workflow.sequence}`,
    name,
    status: 'active',
    attempt: Math.max(1, Number(context.attempt) || 1),
    maxAttempts: policy.maxAttempts,
    enteredAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + policy.timeoutMs).toISOString(),
    timeoutMs: policy.timeoutMs,
    recovery: policy.recovery,
    productId: context.productId || null,
    cycle: context.cycle || null,
    round: context.round || null,
    details: context.details || null,
  };
  state.workflow.current = current;
  state.workflow.history = state.workflow.history.slice(-80);
  return current;
}

function completeWorkflow(state, outcome = {}) {
  const current = state.workflow?.current; if (!current) return null;
  state.workflow.history ||= [];
  current.status = 'completed'; current.finishedAt = new Date().toISOString(); current.outcome = outcome;
  state.workflow.lastCompleted = { ...current };
  state.workflow.history.push({ ...current }); state.workflow.history = state.workflow.history.slice(-80); state.workflow.current = null;
  return current;
}

function failWorkflow(state, error, recoveryAction = null) {
  const current = state.workflow?.current; if (!current) return null;
  state.workflow.history ||= [];
  current.status = 'failed'; current.finishedAt = new Date().toISOString(); current.error = String(error?.message || error || '未知错误'); current.recoveryAction = recoveryAction || current.recovery;
  state.workflow.history.push({ ...current }); state.workflow.history = state.workflow.history.slice(-80); state.workflow.current = null; state.workflow.recoveryCount = (state.workflow.recoveryCount || 0) + 1;
  return current;
}

function isWorkflowOverdue(state, now = Date.now()) { const deadline = Date.parse(state.workflow?.current?.deadlineAt || ''); return Number.isFinite(deadline) && deadline <= now; }

module.exports = { STEP_POLICIES, policyFor, transitionWorkflow, completeWorkflow, failWorkflow, isWorkflowOverdue };
