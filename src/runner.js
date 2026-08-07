const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { isBackgroundTest, outputFolderName } = require('./edition');
const { ChatGPTAutomation } = isBackgroundTest ? require('./background-automation') : require('./automation');
const { scanProductDirectory, scanProducts, allocateOutputDir, allocateRunLayout, validateImage, extensionFor, appendIndex, atomicWriteJson, randomDelayMs, safeName } = require('./core');
const { AdaptiveScheduler } = require('./adaptive-scheduler');
const { transitionWorkflow, completeWorkflow, failWorkflow, isWorkflowOverdue, policyFor } = require('./workflow-state');
const { analyzeProductImage } = require('./quality');
const { prepareProductCreativeFiles, buildRoundPrompt, CREATIVE_ENGINE_VERSION } = require('./creative-engine');
const { ensureAiCreativeBank } = require('./creative-ai');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LEGACY_IMAGE_REQUEST_SUFFIX = '请严格以已上传的产品参考图为产品身份锚点，一次生成5张彼此独立的方形电商主图。保持产品形状、颜色、材质、结构和比例一致；不要添加可读文字、Logo、水印、促销徽章或无关配件。';

async function buildInputFingerprint(images, prompt) {
  const hash = crypto.createHash('sha256');
  hash.update(String(prompt || ''), 'utf8');
  for (const file of [...(images || [])].sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))) {
    hash.update('\0'); hash.update(path.basename(file), 'utf8'); hash.update('\0');
    hash.update(await fsp.readFile(file));
  }
  return hash.digest('hex');
}

class TaskRunner extends EventEmitter {
  constructor(userDataDir, downloadsDir) { super(); this.userDataDir = userDataDir; this.downloadsDir = downloadsDir; this.running = false; this.paused = false; this.stopped = false; this.nativeSaveInFlight = false; this.skipCurrentProduct = false; this.currentPhase = '待处理'; this.detectedImages = 0; this.watchLastSignature = null; this.watchSameCount = 0; this.watchInFlight = false; this.watchRecoveryCount = 0; this.recoveryContext = null; this.recoveryActive = false; this.rateLimitCooling = false; this.rateLimitRestartRequested = false; this.rateLimitRecoveryActive = false; this.workflowRecoveryRequested = false; this.scheduler = null; this.prefetchedRoundPrompt = null; }
  snapshot(extra = {}) { const scheduler = this.scheduler?.snapshot(); const safety = this.state?.safety || {}; return { running: this.running, paused: this.paused, stopped: this.stopped, safetyHold: safety.status === 'hold', safetyReason: safety.reason || null, safetyHoldUntil: safety.holdUntil || null, detectedImages: this.detectedImages, workflowStep: this.state?.workflow?.current?.name || null, adaptiveDelaySeconds: scheduler?.lastDelaySeconds || 0, adaptiveGenerationSeconds: this.state?.activeGenerationTimeoutSeconds || this.state?.generationTimeoutSeconds || 0, recentFailureRate: this.scheduler?.recentFailureRate() || 0, qualityRejected: this.state?.qualityStats?.rejected || 0, qualityWarnings: this.state?.qualityStats?.warnings || 0, ...extra }; }
  emitStatus(extra = {}) { if (extra.phase && extra.phase !== this.currentPhase) { this.currentPhase = extra.phase; this.resetWatchdogSamples(); } this.emit('status', this.snapshot({ currentCycle: this.state?.currentCycle || 0, totalCycles: this.state?.totalCycles || 1, ...extra })); }
  log(message) { const line = `[${new Date().toLocaleString('zh-CN')}] ${message}`; this.emit('log', line); if (this.logFile) fs.appendFileSync(this.logFile, `${line}\r\n`, 'utf8'); }
  pause(reason = '用户暂停', showAlert = reason !== '用户暂停') { this.paused = true; if (this.state) this.state.status = 'paused'; this.checkpoint().catch(() => {}); this.log(reason); this.emitStatus({ phase: '已暂停', message: reason }); if (showAlert) this.emit('alert', { title: '任务需要处理', message: reason }); }
  resume() { if (!this.running) return; const safety = this.ensureSafetyState(); if (safety.status === 'hold') { this.log(`用户已确认处理安全暂停：${safety.reason || '页面异常'}`); safety.status = 'ready'; safety.reason = null; safety.heldAt = null; safety.holdUntil = null; safety.manualResumeRequired = false; safety.recoveryFailures = 0; safety.failureWindowStartedAt = null; safety.saveRecoveryFailures = 0; safety.saveFailureWindowStartedAt = null; safety.uploadRecoveryFailures = 0; safety.uploadFailureWindowStartedAt = null; } this.paused = false; this.workflowRecoveryRequested = false; this.resetWatchdogSamples(); if (this.state) this.state.status = 'active'; this.checkpoint().catch(() => {}); this.log('任务继续'); this.emitStatus({ phase: '继续中' }); }
  stop() { this.stopped = true; this.paused = false; if (this.state) this.state.status = 'stopped'; this.checkpoint().catch(() => {}); this.log('任务将在当前安全步骤后停止'); }
  async shutdown() { this.stopWatchdog(); this.stop(); await this.checkpoint().catch(() => {}); await this.browser?.close(); this.browser = null; }
  async checkpoint() { if (this.stateFile && this.state) await atomicWriteJson(this.stateFile, this.state); }
  async waitIfPaused() { while (this.paused && !this.stopped) await sleep(500); if (this.stopped) throw new Error('__STOPPED__'); }
  ensureSafetyState() {
    if (!this.state) return { status: 'ready', recoveryFailures: 0 };
    this.state.safety ||= { version: 3, status: 'ready', recoveryFailures: 0, failureWindowStartedAt: null, saveRecoveryFailures: 0, saveFailureWindowStartedAt: null, uploadRecoveryFailures: 0, uploadFailureWindowStartedAt: null, reason: null, heldAt: null, holdUntil: null, manualResumeRequired: false };
    this.state.safety.version = Math.max(3, Number(this.state.safety.version) || 1);
    return this.state.safety;
  }
  isSecurityOrLoginError(error) { return /__LOGIN_REQUIRED__|__SECURITY|验证码|安全检查|安全验证|登录入口|退出登录|账号.*(?:停用|封禁|禁用)|account.*(?:deactivat|suspend|block)|verify you are human/i.test(String(error?.message || error || '')); }
  recordSafetyFailure(reason) {
    const safety = this.ensureSafetyState(); const now = Date.now(); const started = Date.parse(safety.failureWindowStartedAt || '');
    if (!Number.isFinite(started) || now - started > 10 * 60000) { safety.failureWindowStartedAt = new Date(now).toISOString(); safety.recoveryFailures = 0; }
    safety.recoveryFailures = Math.max(0, Number(safety.recoveryFailures) || 0) + 1; safety.lastFailureAt = new Date(now).toISOString(); safety.lastFailure = String(reason || '页面异常');
    return safety.recoveryFailures;
  }
  recordTransientSaveFailure(reason) {
    const safety = this.ensureSafetyState(); const now = Date.now(); const started = Date.parse(safety.saveFailureWindowStartedAt || '');
    if (!Number.isFinite(started) || now - started > 10 * 60000) { safety.saveFailureWindowStartedAt = new Date(now).toISOString(); safety.saveRecoveryFailures = 0; }
    safety.saveRecoveryFailures = Math.max(0, Number(safety.saveRecoveryFailures) || 0) + 1; safety.lastSaveFailureAt = new Date(now).toISOString(); safety.lastSaveFailure = String(reason || '保存界面异常');
    return safety.saveRecoveryFailures;
  }
  recordTransientUploadFailure(reason) {
    const safety = this.ensureSafetyState(); const now = Date.now(); const started = Date.parse(safety.uploadFailureWindowStartedAt || '');
    if (!Number.isFinite(started) || now - started > 10 * 60000) { safety.uploadFailureWindowStartedAt = new Date(now).toISOString(); safety.uploadRecoveryFailures = 0; }
    safety.uploadRecoveryFailures = Math.max(0, Number(safety.uploadRecoveryFailures) || 0) + 1; safety.lastUploadFailureAt = new Date(now).toISOString(); safety.lastUploadFailure = String(reason || '上传界面异常');
    return safety.uploadRecoveryFailures;
  }
  resetSafetyFailures() {
    const safety = this.ensureSafetyState(); safety.recoveryFailures = 0; safety.failureWindowStartedAt = null; safety.lastFailure = null;
    safety.saveRecoveryFailures = 0; safety.saveFailureWindowStartedAt = null; safety.lastSaveFailure = null;
    safety.uploadRecoveryFailures = 0; safety.uploadFailureWindowStartedAt = null; safety.lastUploadFailure = null;
  }
  async waitForRecoveryJitter(label, minSeconds, maxSeconds, random = Math.random) {
    const delayMs = randomDelayMs(random, minSeconds, maxSeconds); const seconds = Math.max(0, Math.ceil(delayMs / 1000)); const until = Date.now() + delayMs;
    this.log(`${label}：随机等待${seconds}秒后自动继续`); this.emitStatus({ phase: label, remainingSeconds: seconds });
    while (Date.now() < until) { await this.waitIfPaused(); const remainingMs = until - Date.now(); this.emitStatus({ phase: label, remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000)) }); await sleep(Math.min(500, remainingMs)); }
    return seconds;
  }
  async enterSafetyHold(reason, { recommendedMinutes = 30 } = {}) {
    const safety = this.ensureSafetyState(); const message = String(reason || '检测到需要人工处理的页面异常');
    if (safety.status === 'hold' && this.paused) return;
    safety.status = 'hold'; safety.reason = message; safety.heldAt = new Date().toISOString(); safety.holdUntil = new Date(Date.now() + Math.max(1, recommendedMinutes) * 60000).toISOString(); safety.manualResumeRequired = true;
    this.paused = true; if (this.state) this.state.status = 'safety_hold'; await this.checkpoint().catch(() => {});
    this.log(`安全熔断已启动：已停止所有ChatGPT页面操作并保存断点。${message}。建议至少等待${recommendedMinutes}分钟，确认账号和页面正常后再点击“继续当前任务”`);
    this.emitStatus({ phase: '安全暂停', message }); this.emit('alert', { title: '安全暂停', message: `${message}\n\n软件已停止所有页面操作并保存断点。请人工确认账号和页面正常后，再点击“继续当前任务”。` });
  }
  ensureScheduler() { this.scheduler ||= new AdaptiveScheduler(this.state?.scheduler || {}); if (this.state) this.state.scheduler = this.scheduler.snapshot(); return this.scheduler; }
  schedulerCheckpoint() { if (this.state && this.scheduler) this.state.scheduler = this.scheduler.snapshot(); return this.checkpoint(); }
  stepContext(details = null) { const context = this.recoveryContext || {}; return { productId: context.productId, cycle: context.cycle || this.state?.currentCycle, round: context.round, details }; }
  async runStep(name, operation, overrides = {}) {
    const policy = policyFor(name, overrides); let lastError;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      const started = transitionWorkflow(this.state, name, { ...this.stepContext(overrides.details), attempt }, policy); this.workflowRecoveryRequested = false; await this.checkpoint();
      try {
        const result = await operation({ attempt, deadlineAt: Date.parse(this.state.workflow.current.deadlineAt), policy });
        if (this.state.workflow?.current?.id !== started.id) transitionWorkflow(this.state, name, { ...this.stepContext('嵌套步骤完成后确认'), attempt }, policy);
        completeWorkflow(this.state, { attempt }); await this.checkpoint(); return result;
      } catch (error) {
        lastError = error; failWorkflow(this.state, error, policy.recovery); await this.checkpoint();
        if (error.message === '__STOPPED__' || this.stopped || attempt >= policy.maxAttempts) throw error;
        this.log(`${name}第${attempt}/${policy.maxAttempts}次未完成：${error.message}；${policy.recovery}`);
        if (typeof overrides.onRetry === 'function') await overrides.onRetry(error, attempt);
        await sleep(Math.min(5000, 800 * attempt));
      }
    }
    throw lastError;
  }
  async recoverToFreshChatPage(reason) {
    try {
      this.log(`正在执行唯一一次ChatGPT页面恢复：关闭残留窗口、返回首页并刷新；原因：${reason}`);
      await this.browser.recoverToFreshChatPage();
      this.log('ChatGPT页面已恢复，下一循环将开启全新对话继续任务');
      return true;
    } catch (error) {
      if (this.isRateLimited(error)) { await this.cooldownForRateLimit(error.message); return this.recoverAfterRateLimitCooldown('页面恢复过程中触发限流'); }
      this.log(`唯一一次ChatGPT页面恢复未成功：${error.message}`);
    }
    if (this.stopped) throw new Error('__STOPPED__');
    return false;
  }
  isRateLimited(error) { return String(error?.message || error || '').startsWith('__RATE_LIMITED__'); }
  async cooldownForRateLimit(reason = 'ChatGPT请求过于频繁') {
    if (this.rateLimitCooling) { while (this.rateLimitCooling && !this.stopped) await sleep(1000); return; }
    this.rateLimitCooling = true;
    try {
      const level = Math.min(4, Math.max(1, Number(this.state?.rateLimitLevel || 0) + 1));
      this.ensureScheduler().record({ outcome: 'rate-limit', rateLimited: true });
      const minutes = this.scheduler.rateLimitCooldownMinutes(level); const until = Date.now() + minutes * 60000;
      if (this.state) { this.state.rateLimitLevel = level; this.state.rateLimitUntil = new Date(until).toISOString(); this.state.rateLimitRecoveryPending = true; this.state.status = 'cooldown'; }
      transitionWorkflow(this.state, '限流冷却', { ...this.stepContext(reason) }, { timeoutMs: minutes * 60000 + 60000 }); await this.schedulerCheckpoint().catch(() => {});
      this.log(`检测到ChatGPT请求过于频繁，进入${minutes}分钟限流冷却；期间不刷新、不重启Edge、不打开新对话或旧对话。原因：${reason}`);
      while (Date.now() < until && !this.stopped) {
        const remainingSeconds = Math.ceil((until - Date.now()) / 1000);
        this.emitStatus({ phase: '限流冷却中', remainingSeconds, message: `请求过于频繁，${Math.ceil(remainingSeconds / 60)}分钟后重试` });
        await sleep(Math.min(1000, Math.max(1, until - Date.now())));
      }
      if (this.state && !this.stopped) { this.state.rateLimitUntil = null; this.state.status = 'active'; completeWorkflow(this.state, { minutes }); await this.checkpoint().catch(() => {}); }
    } finally { this.rateLimitCooling = false; this.resetWatchdogSamples(); }
  }
  async resumeSavedRateLimitCooldownIfNeeded() {
    const until = Date.parse(this.state?.rateLimitUntil || ''); if (!Number.isFinite(until)) return !!this.state?.rateLimitRecoveryPending;
    if (until <= Date.now()) {
      this.state.rateLimitUntil = null; this.state.status = 'active'; await this.checkpoint().catch(() => {});
      this.log('上次限流冷却时间已经结束，将立即恢复ChatGPT页面并继续任务');
      return true;
    }
    this.rateLimitCooling = true;
    try {
      this.log('检测到上次任务尚处于限流冷却，继续等待原定时间，不访问ChatGPT页面');
      while (Date.now() < until && !this.stopped) {
        const remainingSeconds = Math.ceil((until - Date.now()) / 1000);
        this.emitStatus({ phase: '限流冷却中', remainingSeconds, message: `请求过于频繁，${Math.ceil(remainingSeconds / 60)}分钟后重试` });
        await sleep(Math.min(1000, Math.max(1, until - Date.now())));
      }
      if (!this.stopped) { this.state.rateLimitUntil = null; this.state.status = 'active'; await this.checkpoint().catch(() => {}); }
    } finally { this.rateLimitCooling = false; }
    return !this.stopped;
  }
  async recoverAfterRateLimitCooldown(reason = '限流冷却结束') {
    if (this.rateLimitRecoveryActive) { while (this.rateLimitRecoveryActive && !this.stopped) await sleep(500); return !this.stopped; }
    this.rateLimitRecoveryActive = true;
    try {
      try {
        if (this.state) this.state.status = 'recovering';
        this.emitStatus({ phase: '冷却后恢复中', message: '正在进行唯一一次页面恢复检查' });
        this.log(`限流冷却已结束，正在进行唯一一次ChatGPT页面恢复：${reason}`);
        await this.browser.recoverToFreshChatPage();
        if (this.state) { this.state.status = 'active'; this.state.rateLimitUntil = null; this.state.rateLimitRecoveryPending = false; }
        await this.checkpoint().catch(() => {});
        this.log('ChatGPT页面已在限流冷却后恢复，任务将从当前断点开启新对话继续');
        return true;
      } catch (error) {
        throw new Error(`__RATE_LIMIT_RECOVERY_FAILED__:冷却后页面仍不可安全使用：${error.message}`);
      }
      if (this.stopped) throw new Error('__STOPPED__');
    } finally { this.rateLimitRecoveryActive = false; this.resetWatchdogSamples(); }
  }
  async refreshProductInputs(context) {
    const latest = await scanProductDirectory(context.productDir, context.productName, { round: context.round, maxImages: 10 });
    if (!latest.valid) throw new Error(`商品“${context.productName}”上传前重新检查失败：当前文件夹缺少有效参考图或TXT提示词`);
    const previous = JSON.stringify({ images: context.images || [], prompt: context.sourcePromptText || '' });
    const current = JSON.stringify({ images: latest.images, prompt: latest.prompt });
    if (previous !== current) this.log(`商品“${context.productName}”文件夹内容已变化，本次将上传最新的${latest.images.length}张参考图并使用最新TXT提示词`);
    context.images = latest.images;
    context.sourcePromptText = latest.prompt;
    const prepared = await this.prepareRoundPrompt(latest, context.round, context.cycle);
    context.productPrompt = prepared.sourcePrompt;
    context.prompt = prepared.prompt;
    context.creativeFingerprint = prepared.creativeFingerprint;
    context.creativeMode = prepared.creativeMode;
    return context;
  }
  async prepareRoundPrompt(product, round, cycle, options = {}) {
    const creativePolicy = this.state?.creativePolicy || { enabled: true, globalRequirements: '' };
    if (product.manualPromptMode) {
      if (!String(product.manualPrompt || '').trim()) throw new Error(`商品“${product.name}”缺少手工提示词；请创建“手工提示词.txt”或填写“创意要求.txt”`);
      this.log(`手工提示词专用模式：${product.name}；仅发送“${path.basename(product.manualPromptFile || '手工提示词.txt')}”原文，不读取商品事实、不生成或使用豆脑配置`);
      return { sourcePrompt: product.manualPrompt, prompt: product.manualPrompt, creativeFingerprint: null, creativeMode: false, manualPromptMode: true };
    }
    if (creativePolicy.enabled === false) {
      return { sourcePrompt: product.prompt, prompt: `${product.prompt}\n\n${LEGACY_IMAGE_REQUEST_SUFFIX}`, creativeFingerprint: null, creativeMode: false };
    }
    let bundle = await prepareProductCreativeFiles(product, { cycle });
    let aiVocabularyUsed = false;
    const taggedVocabularyUsed = !!bundle.taggedVocabulary;
    if (taggedVocabularyUsed) this.log(`已加载极简联动词库：${product.name}；以后只需编辑“豆脑配置/极简词库.txt”即可增加词条`);
    if (!taggedVocabularyUsed && creativePolicy.aiEnabled !== false && options.skipAi !== true) {
      try {
        const ai = await ensureAiCreativeBank({
          browser: this.browser,
          product,
          facts: bundle.facts,
          configDir: bundle.configDir,
          fingerprint: bundle.fingerprint,
          force: creativePolicy.forceReanalyze === true && !this.state.products?.[product.id]?.aiReanalyzedAt,
          diversityStrength: creativePolicy.diversityStrength || 'balanced',
          log: (message) => this.log(message),
        });
        bundle = await prepareProductCreativeFiles(product, {
          cycle,
          creativeBank: ai.approvedBank,
          diversityStrength: creativePolicy.diversityStrength || 'balanced',
        });
        aiVocabularyUsed = true;
        const productState = this.state.products?.[product.id];
        if (productState) {
          productState.aiVocabularyFingerprint = bundle.fingerprint;
          if (!ai.reused) productState.aiReanalyzedAt = new Date().toISOString();
        }
        const aiStatus = ai.partial
          ? `已保存到${ai.completedStage === 'observer' ? '生活观察阶段' : '候选词库阶段'}，下次从断点继续`
          : (ai.reused ? '已从缓存读取' : '已通过挑剔审稿');
        this.log(`AI差异化词库${aiStatus}：${product.name}`);
      } catch (error) {
        this.log(`AI差异化分析未完成，自动使用本地词库继续，不暂停任务：${error.message}`);
      }
    }
    const prompt = buildRoundPrompt(bundle.facts, bundle.plan, round, creativePolicy.globalRequirements || '', product.imageSelection);
    const vocabularyLabel = taggedVocabularyUsed ? '极简联动词库' : (aiVocabularyUsed ? 'AI审稿词库' : '本地安全词库');
    if (options.silent !== true) this.log(`差异化创意已就绪：${product.name} 第${round}轮，商品事实${bundle.sourceChanged ? '已重新提取' : '沿用已验证版本'}，${vocabularyLabel}，创意引擎v${CREATIVE_ENGINE_VERSION}`);
    return { sourcePrompt: prompt, prompt, creativeFingerprint: bundle.plan.vocabularyFingerprint || bundle.fingerprint, creativeMode: true };
  }
  prefetchKey(product, round, cycle, sourceFingerprint) { return `${product.id}|${cycle}|${round}|${sourceFingerprint}`; }
  startRoundPromptPrefetch(product, round, cycle, sourceFingerprint) {
    if (!product?.valid || !sourceFingerprint || this.stopped) return;
    const key = this.prefetchKey(product, round, cycle, sourceFingerprint);
    if (this.prefetchedRoundPrompt?.key === key) return;
    const promise = this.prepareRoundPrompt(product, round, cycle, { skipAi: true, silent: true })
      .then((prepared) => ({ prepared, error: null }))
      .catch((error) => ({ prepared: null, error }));
    this.prefetchedRoundPrompt = { key, promise };
  }
  async consumeRoundPromptPrefetch(product, round, cycle, sourceFingerprint) {
    const key = this.prefetchKey(product, round, cycle, sourceFingerprint);
    if (this.prefetchedRoundPrompt?.key !== key) return null;
    const cached = this.prefetchedRoundPrompt; this.prefetchedRoundPrompt = null;
    const result = await cached.promise;
    if (result.error) { this.log(`下一轮提示词预生成未采用，将在正式步骤重新生成：${result.error.message}`); return null; }
    this.log(`已直接使用生成期间预备的第${round}轮提示词，跳过本轮现场等待`);
    return result.prepared;
  }
  async checkIgnoredChats(context) {
    const ignoredChats = this.state.ignoredChats ||= []; let collectedImages = 0;
    const now = Date.now();
    const entries = ignoredChats.filter((item) => item.status === 'pending' && item.productId === context.productId && (!item.cycle || item.cycle === context.cycle) && (!item.nextCheckAt || Date.parse(item.nextCheckAt) <= now)).sort((a, b) => String(a.lastCheckedAt || a.ignoredAt || '').localeCompare(String(b.lastCheckedAt || b.ignoredAt || ''))).slice(0, 1);
    if (!entries.length) { this.log('本次没有已到回查时间的旧对话；不会为了回查而刷新页面'); return 0; }
    for (const entry of entries) {
      if (context.ps.completed >= 50) break;
      try {
        await this.browser.openChatUrl(entry.url);
        const oldState = await this.browser.inspectWatchState();
        entry.lastCheckedAt = new Date().toISOString();
        if (oldState.hasRateLimit) throw new Error('__RATE_LIMITED__:旧对话回查时出现请求过于频繁');
        if (oldState.hasStop) { entry.lastError = '图片仍在生成'; entry.nextCheckAt = new Date(Date.now() + 2 * 60000).toISOString(); this.log(`旧对话仍在生成，至少2分钟后再查：${entry.url}`); await this.checkpoint(); continue; }
        const viewerInfo = await this.browser.getViewerImageCount({ targetTotal: isBackgroundTest ? 1 : 5, maxWaitSeconds: 15 });
        entry.detectedTotal = viewerInfo.total || 0;
        if (!viewerInfo.found || entry.detectedTotal <= 0) { entry.lastError = '未检测到图片'; entry.nextCheckAt = new Date(Date.now() + 5 * 60000).toISOString(); this.log(`旧对话尚无可收集图片，至少5分钟后再查：${entry.url}`); await this.checkpoint(); continue; }
        const added = await this.stageChatImagesToPool(context, entry, entry.detectedTotal); collectedImages += added.length;
        if ((isBackgroundTest && (entry.processedIndexes || []).length >= entry.detectedTotal) || (viewerInfo.five && (entry.processedIndexes || []).length >= 5)) { entry.status = 'collected'; entry.collectedAt = new Date().toISOString(); }
        else entry.nextCheckAt = new Date(Date.now() + 5 * 60000).toISOString();
        const promoted = await this.promotePendingPool(context);
        this.log(`旧对话本次新增收集${added.length}张，统一暂存池转正${promoted.length}张：${entry.url}`);
      } catch (error) {
        entry.lastCheckedAt = new Date().toISOString(); entry.lastError = error.message;
        if (this.isRateLimited(error)) { await this.checkpoint(); await this.cooldownForRateLimit(error.message); await this.recoverAfterRateLimitCooldown('旧对话回查触发限流'); break; }
        entry.nextCheckAt = new Date(Date.now() + 10 * 60000).toISOString();
        this.log(`检查旧对话失败，至少10分钟后再查：${error.message}`);
        await this.recoverToFreshChatPage(`旧对话无效或页面未加载：${error.message}`);
      }
      await this.checkpoint();
    }
    return collectedImages;
  }

  async recordNewConversation() {
    this.state.newChatsSinceIgnoredCheck = (this.state.newChatsSinceIgnoredCheck || 0) + 1;
    await this.checkpoint();
  }

  async checkIgnoredChatsIfDue(context) {
    if (isBackgroundTest) { this.state.newChatsSinceIgnoredCheck = 0; return 0; }
    const checkEvery = this.state.ignoredCheckEveryChats || 10;
    if ((this.state.newChatsSinceIgnoredCheck || 0) < checkEvery) return 0;
    const hasPending = (this.state.ignoredChats || []).some((item) => item.status === 'pending' && item.productId === context.productId && (!item.cycle || item.cycle === context.cycle));
    if (!hasPending) {
      this.state.newChatsSinceIgnoredCheck = 0; await this.checkpoint();
      this.log(`已完成${checkEvery}个新对话，当前商品没有需要回查的旧对话`); return 0;
    }
    this.state.newChatsSinceIgnoredCheck = 0; await this.checkpoint();
    this.log(`已完成${checkEvery}个新对话；当前对话已经结束，开始在安全时间点回查旧对话`);
    const collected = await this.checkIgnoredChats(context);
    this.log(`旧对话周期检查完成，本次向统一暂存池新增${collected}张图片`);
    return collected;
  }

  async deferCurrentChat(context, reason, metadata = {}) {
    const url = this.browser.currentChatUrl || await this.browser.waitForStableCurrentChatUrl(8000).catch(() => null);
    if (!url) { this.log(`当前超时对话地址尚未形成，无法加入回查队列：${reason}`); return null; }
    const ignoredChats = this.state.ignoredChats ||= [];
    let entry = ignoredChats.find((item) => item.url === url);
    if (!entry) {
      entry = { id: crypto.randomUUID(), url, productId: context.productId, round: context.round, cycle: context.cycle, inputFingerprint: context.inputFingerprint, status: 'pending', processedIndexes: [], ignoredAt: new Date().toISOString(), reason, ...metadata };
      ignoredChats.push(entry);
    } else Object.assign(entry, metadata, { reason, inputFingerprint: entry.inputFingerprint || context.inputFingerprint, status: entry.status === 'collected' ? 'collected' : 'pending' });
    await this.checkpoint(); this.log(`已将超时对话加入稍后回查队列：${url}`); return entry;
  }

  async finalRescanCurrentChatBeforeNextChat(context, entry = null, options = {}) {
    if (!context || !this.browser) return { entry, detectedTotal: 0, added: [], promoted: [] };
    transitionWorkflow(this.state, '最终复扫', { ...this.stepContext('逐个核对5个缩略图') }); await this.checkpoint();
    const ignoredChats = this.state.ignoredChats ||= [];
    let currentEntry = entry;
    if (!currentEntry) {
      const url = await this.browser.waitForStableCurrentChatUrl(15000).catch(() => null);
      if (!url) {
        this.log('切换新对话前最终复扫：当前对话地址尚未稳定，无法建立缩略图断点；稍后仍会按旧对话回查规则处理');
        completeWorkflow(this.state, { detectedTotal: 0, processed: 0, reason: 'chat-url-not-ready' }); await this.checkpoint();
        return { entry: null, detectedTotal: 0, added: [], promoted: [] };
      }
      currentEntry = ignoredChats.find((item) => item.url === url);
      if (!currentEntry) {
        currentEntry = { id: crypto.randomUUID(), url, productId: context.productId, round: context.round, cycle: context.cycle, inputFingerprint: context.inputFingerprint, status: 'pending', processedIndexes: [], ignoredAt: new Date().toISOString(), reason: '切换新对话前最终复扫' };
        ignoredChats.push(currentEntry);
      }
    }
    currentEntry.processedIndexes = [...new Set(currentEntry.processedIndexes || [])].sort((a, b) => a - b);
    const maxPasses = Math.max(1, Math.min(5, Number(options.maxPasses) || (isBackgroundTest ? 3 : 2)));
    const allAdded = []; let detectedTotal = Math.max(0, Number(options.initialTotal) || 0); let noProgressPasses = 0;
    this.log(`准备开启新对话前执行最终复扫；当前已处理缩略图${currentEntry.processedIndexes.length}/5`);
    for (let pass = 1; pass <= maxPasses && currentEntry.processedIndexes.length < 5; pass += 1) {
      await this.waitIfPaused();
      let viewerInfo;
      try {
        viewerInfo = await this.browser.getViewerImageCount({ targetTotal: isBackgroundTest ? 1 : 5, findWaitSeconds: pass === 1 ? 4 : 2, maxWaitSeconds: pass === 1 ? 6 : 4 });
      } catch (error) {
        currentEntry.lastError = `最终复扫第${pass}次检测失败：${error.message}`;
        this.log(currentEntry.lastError);
        if (pass < maxPasses) await sleep(1200);
        continue;
      }
      if (!viewerInfo?.found || (viewerInfo.total || 0) <= 0) {
        currentEntry.lastError = `最终复扫第${pass}次未检测到可保存图片`;
        this.log(currentEntry.lastError);
        if (pass < maxPasses) await sleep(1200);
        continue;
      }
      detectedTotal = Math.max(detectedTotal, Math.min(5, viewerInfo.total || 1));
      currentEntry.detectedTotal = Math.max(Number(currentEntry.detectedTotal) || 0, detectedTotal);
      this.detectedImages = detectedTotal;
      this.emitStatus({ product: context.productName, round: context.round, completed: context.ps.completed, phase: '切换前最终复扫' });
      const processedBefore = currentEntry.processedIndexes.length;
      if (detectedTotal > processedBefore) {
        this.nativeSaveInFlight = true;
        try {
          const added = await this.stageChatImagesToPool(context, currentEntry, detectedTotal);
          allAdded.push(...added);
        } catch (error) {
          currentEntry.lastError = `最终复扫第${pass}次补存失败：${error.message}`;
          this.log(currentEntry.lastError);
        } finally {
          this.nativeSaveInFlight = false;
          this.resetWatchdogSamples();
        }
      }
      const processedAfter = currentEntry.processedIndexes.length;
      this.log(`切换前最终复扫第${pass}/${maxPasses}次：检测${detectedTotal}/5张，已处理${processedAfter}/5张，本次新增${Math.max(0, processedAfter - processedBefore)}张`);
      if ((isBackgroundTest && detectedTotal > 0 && processedAfter >= detectedTotal) || (detectedTotal >= 5 && processedAfter >= 5)) {
        currentEntry.status = 'collected'; currentEntry.collectedAt = new Date().toISOString(); currentEntry.lastError = null;
        break;
      }
      currentEntry.status = 'pending';
      currentEntry.nextCheckAt = new Date(Date.now() + 5 * 60000).toISOString();
      noProgressPasses = processedAfter > processedBefore ? 0 : noProgressPasses + 1;
      if (noProgressPasses >= 1) {
        const pageReportsFiveButNotAllSaved = detectedTotal >= 5 && processedAfter < 5;
        if (!pageReportsFiveButNotAllSaved || pass >= maxPasses) {
          this.log('切换前最终复扫没有新增已处理缩略图，已跑完必要复扫，保留当前对话断点并交给稍后回查');
          break;
        }
        this.log(`页面已报告5张但只保存${processedAfter}/5张；即使本次无新增仍继续第${pass + 1}/${maxPasses}次复扫，等待延迟图片出现`);
      }
      if (pass < maxPasses) await sleep(1200);
    }
    if (!isBackgroundTest && currentEntry.processedIndexes.length < 5) {
      currentEntry.status = 'pending';
      currentEntry.nextCheckAt ||= new Date(Date.now() + 5 * 60000).toISOString();
    }
    const promoted = await this.promotePendingPool(context);
    completeWorkflow(this.state, { detectedTotal, processed: currentEntry.processedIndexes.length, added: allAdded.length, promoted: promoted.length }); await this.checkpoint();
    this.log(`切换新对话前最终复扫完成：检测${detectedTotal}/5张，累计已处理${currentEntry.processedIndexes.length}/5张，新增暂存${allAdded.length}张，转入正式目录${promoted.length}张`);
    return { entry: currentEntry, detectedTotal, added: allAdded, promoted };
  }

  async syncPendingPoolState(context) {
    const poolDir = path.join(context.ps.outputDir, '.pending_pool');
    await fsp.mkdir(poolDir, { recursive: true });
    await atomicWriteJson(path.join(poolDir, 'pool-state.json'), { version: 1, productId: context.productId, updatedAt: new Date().toISOString(), items: context.ps.pendingPool || [] });
  }

  async migrateLegacyEntryToPool(context, entry) {
    const legacyFiles = entry.stagedFiles || []; if (!legacyFiles.length) return;
    const poolDir = path.join(context.ps.outputDir, '.pending_pool'); await fsp.mkdir(poolDir, { recursive: true });
    const known = new Set([...(context.ps.hashes || []), ...(context.ps.pendingPool || []).map((item) => item.hash).filter(Boolean)]);
    for (let i = 0; i < legacyFiles.length; i += 1) {
      const source = legacyFiles[i];
      try {
        const info = await validateImage(source, known); known.add(info.hash);
        const target = path.join(poolDir, `${safeName(context.productName)}_legacy_${entry.id}_${i + 1}${extensionFor(info.format)}`);
        if (path.resolve(source) !== path.resolve(target)) await fsp.rename(source, target);
        context.ps.pendingPool.push({ file: target, hash: info.hash, format: info.format, width: info.width, height: info.height, sourceChatId: entry.id, sourceUrl: entry.url, thumbnailIndex: entry.stagedIndexes?.[i] ?? i, inputFingerprint: entry.inputFingerprint || context.inputFingerprint, savedAt: new Date().toISOString(), status: 'pending' });
      } catch { await fsp.unlink(source).catch(() => {}); }
    }
    entry.processedIndexes = [...new Set([...(entry.processedIndexes || []), ...(entry.stagedIndexes || [])])];
    entry.stagedFiles = []; entry.stagedIndexes = [];
  }

  async stageChatImagesToPool(context, entry, total) {
    if (!entry || total <= 0) return [];
    context.ps.pendingPool ||= [];
    await this.migrateLegacyEntryToPool(context, entry);
    const poolDir = path.join(context.ps.outputDir, '.pending_pool'); await fsp.mkdir(poolDir, { recursive: true });
    context.ps.rejectedHashes ||= [];
    const poolHashes = new Set([...(context.ps.hashes || []), ...context.ps.pendingPool.map((item) => item.hash).filter(Boolean), ...context.ps.rejectedHashes]);
    const processed = [...new Set(entry.processedIndexes || [])];
    const needed = Math.max(0, Math.min(5, total) - processed.length);
    if (needed <= 0) return [];
    const shortId = String(entry.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
    const downloaded = await this.browser.downloadNewImages(poolDir, `${safeName(context.productName)}_pool_${shortId}`, 1, needed, poolHashes, processed);
    const added = []; this.state.qualityStats ||= { checked: 0, approved: 0, warnings: 0, rejected: 0 };
    transitionWorkflow(this.state, '质量检测', { ...this.stepContext(`候选${downloaded.length}张`) }); await this.checkpoint();
    const qualityResults = await Promise.all(downloaded.map(async (image) => {
      if (this.state.qualityPolicy?.enabled === false) return { approved: true, status: 'approved', issues: [], reviewNotes: `${image.width}x${image.height}` };
      try { return await analyzeProductImage(image.file, context.images || [], this.state.qualityPolicy); }
      catch (error) { return { approved: false, status: 'revise', issues: [], hardIssues: [error.message], reviewNotes: `质量检测失败：${error.message}` }; }
    }));
    const warningNotes = [];
    for (let imageIndex = 0; imageIndex < downloaded.length; imageIndex += 1) {
      const image = downloaded[imageIndex]; const quality = qualityResults[imageIndex];
      this.state.qualityStats.checked += 1;
      if (!quality.approved) {
        if (image.hash && !context.ps.rejectedHashes.includes(image.hash)) context.ps.rejectedHashes.push(image.hash);
        this.state.qualityStats.rejected += 1; await fsp.unlink(image.file).catch(() => {});
        await appendIndex(context.outputs, { run_id: this.state.runId, job_id: `c${context.cycle || 1}-${context.productId}-quality-${entry.id}-${image.thumbnailIndex}`, product_id: context.productId, variant: '', output_file: '', status: 'revise', review_notes: quality.reviewNotes, prompt: context.productPrompt.slice(0, 500) });
        this.log(`质量检测拒绝1张候选图，不计入数量：${quality.reviewNotes}`); continue;
      }
      if (Number.isInteger(image.thumbnailIndex) && !processed.includes(image.thumbnailIndex)) processed.push(image.thumbnailIndex);
      this.state.qualityStats.approved += 1;
      if (quality.issues?.length) { this.state.qualityStats.warnings += 1; warningNotes.push(quality.reviewNotes); }
      context.ps.pendingPool.push({ file: image.file, hash: image.hash, format: image.format, width: image.width, height: image.height, sourceChatId: entry.id, sourceUrl: entry.url, thumbnailIndex: image.thumbnailIndex, inputFingerprint: entry.inputFingerprint || context.inputFingerprint, savedAt: new Date().toISOString(), status: 'pending' });
      context.ps.pendingPool[context.ps.pendingPool.length - 1].quality = quality;
      added.push({ ...image, quality });
    }
    if (warningNotes.length) this.log(`质量检测提示汇总（${warningNotes.length}张为保证产量仍保留）：${warningNotes.join('；')}`);
    completeWorkflow(this.state, { checked: downloaded.length, accepted: added.length });
    entry.processedIndexes = processed.sort((a, b) => a - b);
    entry.detectedTotal = total;
    await this.syncPendingPoolState(context); await this.checkpoint();
    this.log(`当前对话检测到${total}张，质量检查后保留${added.length}张，立即计入50张目标`);
    return added;
  }

  async promotePendingPool(context) {
    context.ps.pendingPool ||= []; const promoted = [];
    const stem = safeName(context.productName); const usedNumbers = new Set();
    for (const dirent of await fsp.readdir(context.ps.outputDir, { withFileTypes: true })) {
      if (!dirent.isFile() || !dirent.name.startsWith(`${stem}_`)) continue;
      const number = dirent.name.slice(stem.length + 1).split('.')[0]; if (/^\d{3}$/.test(number)) usedNumbers.add(Number(number));
    }
    while (context.ps.completed < 50) {
      const neededForRound = 1;
      const candidates = context.ps.pendingPool
        .filter((candidate) => candidate.status === 'pending')
        .sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
      if (!candidates || !candidates.length) break;
      const selected = candidates.slice(0, neededForRound); const targets = selected.map((item) => {
        let number = 1; while (usedNumbers.has(number)) number += 1; usedNumbers.add(number);
        return { ...item, final: path.join(context.ps.outputDir, `${stem}_${String(number).padStart(3, '0')}${extensionFor(item.format)}`) };
      });
      const moved = [];
      try { for (const item of targets) { await fsp.rename(item.file, item.final); moved.push(item); } }
      catch (error) { for (const item of moved.reverse()) await fsp.rename(item.final, item.file).catch(() => {}); throw error; }
      for (const image of targets) {
        context.hashes.add(image.hash); context.ps.completed += 1; context.ps.hashes = [...context.hashes];
        await appendIndex(context.outputs, { run_id: this.state.runId, job_id: `c${context.cycle || 1}-${context.productId}-pool-${image.sourceChatId}`, product_id: context.productId, variant: context.ps.completed, output_file: path.relative(context.outputs, image.final), status: image.quality?.issues?.length ? 'approved' : 'generated', review_notes: `${image.width}x${image.height}; sha256=${image.hash}; pooled_chat=${image.sourceUrl}; input=${image.inputFingerprint}; cycle=${context.cycle || 1}; quality=${image.quality?.reviewNotes || 'legacy/not-checked'}`, prompt: context.productPrompt.slice(0, 500) });
        promoted.push({ ...image, file: image.final });
      }
      if (this.state) {
        this.state.rateLimitLevel = 0;
        this.state.rateLimitUntil = null;
        this.state.rateLimitRecoveryPending = false;
      }
      const selectedFiles = new Set(selected.map((item) => item.file));
      context.ps.pendingPool = context.ps.pendingPool.filter((item) => !selectedFiles.has(item.file));
      context.ps.round = Math.min(10, Math.floor(context.ps.completed / 5));
      this.log(`图片已立即转入正式目录：当前${context.ps.completed}/50张`);
      await this.syncPendingPoolState(context); await this.checkpoint();
    }
    return promoted;
  }

  resetWatchdogSamples() { this.watchLastSignature = null; this.watchSameCount = 0; }
  observeWatchState(state) {
    if (state?.hasRateLimit) { this.resetWatchdogSamples(); return 'rate-limit'; }
    if (state?.hasSecurity || state?.hasLogin) { this.resetWatchdogSamples(); return 'security'; }
    if (this.state && isWorkflowOverdue(this.state)) { this.resetWatchdogSamples(); return 'step-timeout'; }
    if (!state?.found || state.hasStop) { this.resetWatchdogSamples(); return false; }
    const signature = JSON.stringify({ phase: this.currentPhase, title: state.title, hasComposer: state.hasComposer, hasSecurity: state.hasSecurity, downloadCount: state.downloadCount, generatedCount: state.generatedCount, attachmentCount: state.attachmentCount, submitEnabled: state.submitEnabled });
    if (signature === this.watchLastSignature) this.watchSameCount += 1;
    else { this.watchLastSignature = signature; this.watchSameCount = 1; }
    this.log(`界面无变化检测：${this.watchSameCount}/3（${this.currentPhase}）`);
    if (this.watchSameCount < 3) return false;
    if (this.recoveryContext) { this.watchRecoveryCount += 1; this.resetWatchdogSamples(); return 'recover'; }
    this.log(`ChatGPT界面连续3次无变化，当前没有可恢复的生成上下文；将请求当前步骤安全退出。当前阶段：${this.currentPhase}`);
    this.resetWatchdogSamples(); return 'recover-page';
  }
  async recoverCurrentOperation() {
    const context = this.recoveryContext; if (!context || this.recoveryActive) return;
    this.recoveryActive = true;
    try {
      const currentUrl = await this.browser.waitForStableCurrentChatUrl(10000).catch(() => null);
      const ignoredChats = this.state.ignoredChats ||= [];
      if (currentUrl && context.promptSubmitted === true && !ignoredChats.some((item) => item.url === currentUrl)) ignoredChats.push({ id: crypto.randomUUID(), url: currentUrl, productId: context.productId, round: context.round, cycle: context.cycle, inputFingerprint: context.inputFingerprint, status: 'pending', processedIndexes: [], ignoredAt: new Date().toISOString(), reason: '界面连续无变化' });
      await this.checkpoint();
      this.log(`生成界面连续3次无变化，已记录当前对话等待安全时间点回收；本次不检查旧对话，直接刷新并打开新对话（第${this.watchRecoveryCount}次）`);
      await this.browser.refreshPage();
      await this.browser.newChat();
      await this.refreshProductInputs(context);
      context.inputFingerprint = await buildInputFingerprint(context.images, context.prompt);
      await this.browser.uploadReferences(context.images, () => this.stopped);
      await this.browser.sendPrompt(context.prompt, this.state.generationTimeoutSeconds);
      context.promptSubmitted = true;
      context.ps.chatAttempts = (context.ps.chatAttempts || 0) + 1;
      await this.recordNewConversation();
      this.emitStatus({ product: context.productName, round: context.round, phase: '生成中' });
      this.log('已清空旧草稿，并在新对话中重新完成上传和发送');
    } catch (error) { if (/缺少有效参考图或TXT提示词/.test(error.message)) { this.skipCurrentProduct = true; context.ps.status = 'skipped'; context.ps.skipReason = error.message; this.log(`${error.message}，当前商品将在恢复流程结束后自动跳过`); } else this.log(`自动恢复失败：${error.message}`); }
    finally { this.recoveryActive = false; this.resetWatchdogSamples(); }
  }
  startWatchdog() {
    this.stopWatchdog(); this.resetWatchdogSamples();
    this.watchTimer = setInterval(async () => {
      if (!this.running || this.paused || this.stopped || this.rateLimitCooling || this.workflowRecoveryRequested || this.currentPhase === '等待中' || this.currentPhase === '上传中' || this.nativeSaveInFlight || this.watchInFlight || !this.browser?.connected) return;
      this.watchInFlight = true;
      try {
        const decision = this.observeWatchState(await this.browser.inspectWatchState());
        if (decision === 'recover' || decision === 'step-timeout') {
          this.workflowRecoveryRequested = true;
          const step = this.state?.workflow?.current;
          this.log(`${decision === 'step-timeout' ? '步骤超过明确时限' : '界面连续无变化'}，已请求当前操作安全退出；步骤：${step?.name || this.currentPhase}；恢复动作：${step?.recovery || '刷新并打开新对话'}`);
        } else if (decision === 'recover-page') { this.workflowRecoveryRequested = true; this.log(`界面监控请求页面恢复，等待当前安全步骤退出：${this.currentPhase}`); }
        else if (decision === 'security') { await this.enterSafetyHold('检测到登录页、验证码或安全验证，禁止继续自动操作'); }
        else if (decision === 'rate-limit') { await this.cooldownForRateLimit('界面监控检测到请求过于频繁'); this.rateLimitRestartRequested = true; this.workflowRecoveryRequested = true; this.log('限流冷却已经结束，已通知当前轮次退出原等待阶段并从新对话继续'); }
      } catch (error) { this.log(`界面监控暂时无法读取：${error.message}`); }
      finally { this.watchInFlight = false; }
    }, 30000);
  }
  stopWatchdog() { if (this.watchTimer) clearInterval(this.watchTimer); this.watchTimer = null; this.watchInFlight = false; }

  async loginCheck(root) {
    const outputs = path.join(root, outputFolderName); await fsp.mkdir(outputs, { recursive: true });
    const browser = new ChatGPTAutomation({ userDataDir: this.userDataDir, downloadDir: this.downloadsDir, log: (m) => this.emit('log', m) });
    await browser.launch(); return { browser, loggedIn: await browser.isLoggedIn() };
  }

  migrateState(prior, root) {
    const previousThumbnailProgressVersion = prior.thumbnailProgressVersion || 1;
    const previousIgnoredCheckEveryChats = Number.isFinite(prior.ignoredCheckEveryChats) ? prior.ignoredCheckEveryChats : 10;
    const ignoredCheckEveryChats = !prior.ignoredCheckPolicyVersion && previousIgnoredCheckEveryChats === 5 ? 10 : previousIgnoredCheckEveryChats;
    const state = { ...prior, version: 6, pendingPoolVersion: 1, thumbnailProgressVersion: 3, ignoredCheckPolicyVersion: 2, root, runId: prior.runId || `legacy-${Date.parse(prior.createdAt) || Date.now()}`, runOutputDir: prior.runOutputDir || null, runOutputDirs: prior.runOutputDirs || (prior.runOutputDir ? [prior.runOutputDir] : []), status: prior.status || 'stopped', currentCycle: prior.currentCycle || 1, totalCycles: prior.totalCycles || 1, waitEnabled: prior.waitEnabled !== false, waitMinSeconds: Number.isFinite(prior.waitMinSeconds) ? prior.waitMinSeconds : 20, waitMaxSeconds: Number.isFinite(prior.waitMaxSeconds) ? prior.waitMaxSeconds : 60, generationTimeoutSeconds: Number.isFinite(prior.generationTimeoutSeconds) ? prior.generationTimeoutSeconds : 60, ignoredCheckEveryChats, rateLimitLevel: Number.isFinite(prior.rateLimitLevel) ? prior.rateLimitLevel : 0, rateLimitUntil: prior.rateLimitUntil || null, rateLimitRecoveryPending: prior.rateLimitRecoveryPending === true, currentProduct: prior.currentProduct || 0, products: prior.products || {}, ignoredChats: prior.ignoredChats || [], newChatsSinceIgnoredCheck: prior.newChatsSinceIgnoredCheck || 0, adaptiveScheduling: prior.adaptiveScheduling !== false, scheduler: prior.scheduler || {}, workflow: prior.workflow || { version: 1, sequence: 0, history: [], current: null, lastCompleted: null, recoveryCount: 0 }, safety: prior.safety || { version: 1, status: 'ready', recoveryFailures: 0, failureWindowStartedAt: null, reason: null, heldAt: null, holdUntil: null, manualResumeRequired: false }, qualityPolicy: { enabled: prior.qualityPolicy?.enabled !== false, minDimension: prior.qualityPolicy?.minDimension || 512, squareTolerance: prior.qualityPolicy?.squareTolerance || 0.08, requireWhite: prior.qualityPolicy?.requireWhite === true, strictConsistency: prior.qualityPolicy?.strictConsistency === true }, qualityStats: prior.qualityStats || { checked: 0, approved: 0, warnings: 0, rejected: 0 } };
    state.creativePolicy = {
      enabled: prior.creativePolicy?.enabled !== false,
      aiEnabled: prior.creativePolicy?.aiEnabled !== false,
      diversityStrength: ['conservative', 'balanced', 'bold'].includes(prior.creativePolicy?.diversityStrength) ? prior.creativePolicy.diversityStrength : 'balanced',
      forceReanalyze: prior.creativePolicy?.forceReanalyze === true,
      globalRequirements: String(prior.creativePolicy?.globalRequirements || '').slice(0, 4000),
    };
    state.scheduler.enabled = state.adaptiveScheduling;
    if (state.workflow.current?.status === 'active') { state.workflow.current.status = 'interrupted'; state.workflow.current.finishedAt = new Date().toISOString(); state.workflow.history ||= []; state.workflow.history.push(state.workflow.current); state.workflow.current = null; }
    for (const ps of Object.values(state.products)) { ps.hashes ||= []; ps.rejectedHashes ||= []; ps.thumbnailProgress ||= {}; ps.pendingPool ||= []; ps.chatAttempts ||= 0; if (previousThumbnailProgressVersion < 3) ps.thumbnailProgress = {}; ps.completed ||= 0; ps.round = Math.min(10, Math.floor(ps.completed / 5)); }
    for (const entry of state.ignoredChats) { entry.stagedFiles ||= []; entry.stagedIndexes ||= []; entry.processedIndexes ||= []; if (previousThumbnailProgressVersion < 3) entry.processedIndexes = []; if (entry.status === 'failed' || entry.status === 'collecting') { entry.status = 'pending'; entry.nextCheckAt ||= new Date().toISOString(); } }
    return state;
  }

  async inspectSavedState(root) {
    const file = path.join(root, outputFolderName, 'task-state.json');
    try {
      const prior = this.migrateState(JSON.parse(await fsp.readFile(file, 'utf8')), root);
      return { available: prior.root === root && prior.status !== 'completed', runId: prior.runId, status: prior.status, currentProduct: prior.currentProduct, currentCycle: prior.currentCycle, totalCycles: prior.totalCycles, waitEnabled: prior.waitEnabled, waitMinSeconds: prior.waitMinSeconds, waitMaxSeconds: prior.waitMaxSeconds, generationTimeoutSeconds: prior.generationTimeoutSeconds, ignoredCheckEveryChats: prior.ignoredCheckEveryChats, adaptiveScheduling: prior.adaptiveScheduling, qualityPolicy: prior.qualityPolicy, creativePolicy: prior.creativePolicy, createdAt: prior.createdAt };
    } catch { return { available: false }; }
  }

  async start(root, mode = 'new', options = {}) {
    if (this.running) throw new Error('已有任务正在运行');
    this.running = true; this.paused = false; this.stopped = false; this.emitStatus({ phase: '准备中' });
    let finalProtectionEligible = false; let restartAfterManualResume = false; let fatalReason = null;
    const outputs = path.join(root, outputFolderName); await fsp.mkdir(outputs, { recursive: true });
    this.logFile = path.join(outputs, 'run.log'); this.stateFile = path.join(outputs, 'task-state.json');
    try {
      const products = await scanProducts(root);
      if (!products.length) throw new Error('所选目录中没有产品子文件夹');
      const validProducts = products.filter((item) => item.valid);
      let prior = null; try { prior = JSON.parse(await fsp.readFile(this.stateFile, 'utf8')); } catch {}
      if (mode === 'continue') {
        if (!prior || prior.root !== root) throw new Error('没有可继续的历史任务');
        this.state = this.migrateState(prior, root); this.state.status = 'active'; const resumedSafety = this.ensureSafetyState(); resumedSafety.status = 'ready'; resumedSafety.reason = null; resumedSafety.manualResumeRequired = false; resumedSafety.recoveryFailures = 0; resumedSafety.failureWindowStartedAt = null;
        if (options.waitEnabled !== undefined) this.state.waitEnabled = options.waitEnabled !== false;
        if (options.waitMinSeconds !== undefined) this.state.waitMinSeconds = Math.max(0, Math.min(600, Math.trunc(Number(options.waitMinSeconds) || 0)));
        if (options.waitMaxSeconds !== undefined) this.state.waitMaxSeconds = Math.max(this.state.waitMinSeconds, Math.min(600, Math.trunc(Number(options.waitMaxSeconds) || 0)));
        if (!this.state.waitEnabled) { this.state.waitMinSeconds = 0; this.state.waitMaxSeconds = 0; }
        if (options.generationTimeoutSeconds !== undefined) this.state.generationTimeoutSeconds = Math.max(10, Math.min(600, Math.trunc(Number(options.generationTimeoutSeconds) || 60)));
        if (options.ignoredCheckEveryChats !== undefined) this.state.ignoredCheckEveryChats = Math.max(1, Math.min(20, Math.trunc(Number(options.ignoredCheckEveryChats) || 10)));
        if (options.adaptiveScheduling !== undefined) this.state.adaptiveScheduling = options.adaptiveScheduling !== false;
        if (options.qualityPolicy) this.state.qualityPolicy = { ...this.state.qualityPolicy, ...options.qualityPolicy };
        if (options.creativePolicy) this.state.creativePolicy = {
          enabled: options.creativePolicy.enabled !== false,
          aiEnabled: options.creativePolicy.aiEnabled !== false,
          diversityStrength: ['conservative', 'balanced', 'bold'].includes(options.creativePolicy.diversityStrength) ? options.creativePolicy.diversityStrength : 'balanced',
          forceReanalyze: options.creativePolicy.forceReanalyze === true,
          globalRequirements: String(options.creativePolicy.globalRequirements || '').slice(0, 4000),
        };
      } else {
        const layout = await allocateRunLayout(outputs, validProducts.map((item) => item.name));
        const totalCycles = Math.max(1, Math.min(99, Math.trunc(Number(options.totalCycles) || 1)));
        const waitEnabled = options.waitEnabled !== false;
        const waitMinSeconds = Math.max(0, Math.min(600, Math.trunc(Number(options.waitMinSeconds ?? 20) || 0)));
        const waitMaxSeconds = Math.max(waitMinSeconds, Math.min(600, Math.trunc(Number(options.waitMaxSeconds ?? 60) || 0)));
        const generationTimeoutSeconds = Math.max(10, Math.min(600, Math.trunc(Number(options.generationTimeoutSeconds ?? 60) || 60)));
        const ignoredCheckEveryChats = Math.max(1, Math.min(20, Math.trunc(Number(options.ignoredCheckEveryChats ?? 10) || 10)));
        const adaptiveScheduling = options.adaptiveScheduling !== false;
        const qualityPolicy = { enabled: options.qualityPolicy?.enabled !== false, minDimension: Math.max(256, Math.min(2048, Math.trunc(Number(options.qualityPolicy?.minDimension) || 512))), squareTolerance: 0.08, requireWhite: options.qualityPolicy?.requireWhite === true, strictConsistency: options.qualityPolicy?.strictConsistency === true };
        this.state = { version: 6, pendingPoolVersion: 1, thumbnailProgressVersion: 3, ignoredCheckPolicyVersion: 2, runId: crypto.randomUUID(), root, runOutputDir: layout.runDir, runOutputDirs: [layout.runDir], createdAt: new Date().toISOString(), status: 'active', currentCycle: 1, totalCycles, waitEnabled, waitMinSeconds: waitEnabled ? waitMinSeconds : 0, waitMaxSeconds: waitEnabled ? waitMaxSeconds : 0, generationTimeoutSeconds, ignoredCheckEveryChats, adaptiveScheduling, scheduler: { enabled: adaptiveScheduling }, workflow: { version: 1, sequence: 0, history: [], current: null, lastCompleted: null, recoveryCount: 0 }, safety: { version: 1, status: 'ready', recoveryFailures: 0, failureWindowStartedAt: null, reason: null, heldAt: null, holdUntil: null, manualResumeRequired: false }, qualityPolicy, qualityStats: { checked: 0, approved: 0, warnings: 0, rejected: 0 }, rateLimitLevel: 0, rateLimitUntil: null, rateLimitRecoveryPending: false, currentProduct: 0, products: {}, ignoredChats: [], newChatsSinceIgnoredCheck: 0 };
        this.state.creativePolicy = {
          enabled: options.creativePolicy?.enabled !== false,
          aiEnabled: options.creativePolicy?.aiEnabled !== false,
          diversityStrength: ['conservative', 'balanced', 'bold'].includes(options.creativePolicy?.diversityStrength) ? options.creativePolicy.diversityStrength : 'balanced',
          forceReanalyze: options.creativePolicy?.forceReanalyze === true,
          globalRequirements: String(options.creativePolicy?.globalRequirements || '').slice(0, 4000),
        };
        for (const product of validProducts) this.state.products[product.id] = { outputDir: layout.productDirs[product.name], completed: 0, round: 0, chatAttempts: 0, hashes: [], rejectedHashes: [], thumbnailProgress: {}, pendingPool: [] };
      }
      this.scheduler = new AdaptiveScheduler({ ...this.state.scheduler, enabled: this.state.adaptiveScheduling }); this.state.scheduler = this.scheduler.snapshot();
      this.log(`本次任务设置：单对话生成等待上限${this.state.generationTimeoutSeconds}秒；每${this.state.ignoredCheckEveryChats}个新对话回查；轮次等待${this.state.waitEnabled ? `${this.state.waitMinSeconds}–${this.state.waitMaxSeconds}秒` : '关闭'}；自适应调度${this.state.adaptiveScheduling ? '开启' : '关闭'}；质量检测${this.state.qualityPolicy.enabled ? '开启' : '关闭'}`);
      await this.checkpoint();
      const browser = this.browser?.connected ? this.browser : new ChatGPTAutomation({ userDataDir: this.userDataDir, downloadDir: this.downloadsDir, log: (m) => this.log(m) });
      this.browser = browser; if (!browser.connected) await browser.launch(); this.startWatchdog();
      if (!(await browser.isLoggedIn())) {
        const initialPageState = await browser.inspectWatchState().catch(() => null);
        if (initialPageState?.hasRateLimit) { await this.cooldownForRateLimit('__RATE_LIMITED__:启动时检测到ChatGPT提示请求过于频繁'); await this.recoverAfterRateLimitCooldown('程序启动时的限流冷却结束'); }
        else { await this.enterSafetyHold('ChatGPT尚未登录或登录状态不可确认，请在已打开的Edge中完成人工检查'); await this.waitIfPaused(); }
      }
      finalProtectionEligible = true;
      if (await this.resumeSavedRateLimitCooldownIfNeeded()) await this.recoverAfterRateLimitCooldown('从已保存的限流冷却状态恢复');
      cycleLoop: while (this.state.currentCycle <= this.state.totalCycles) {
      this.log(`开始整批循环 ${this.state.currentCycle}/${this.state.totalCycles}，输出目录：${this.state.runOutputDir}`); this.emitStatus({ phase: '批次准备中' });
      for (let p = this.state.currentProduct || 0; p < products.length; p += 1) {
        const product = products[p]; this.state.currentProduct = p;
        if (!product.valid) {
          const reason = `产品“${product.name}”缺少有效参考图或TXT提示词，已自动跳过并进入下一个商品`;
          this.log(reason); this.state.skippedProducts ||= []; this.state.skippedProducts.push({ productId: product.id, reason, skippedAt: new Date().toISOString() }); this.state.currentProduct = p + 1; await this.checkpoint(); continue;
        }
        const ps = this.state.products[product.id] ||= { outputDir: null, completed: 0, round: 0, chatAttempts: 0, hashes: [], rejectedHashes: [], thumbnailProgress: {}, pendingPool: [] };
        ps.thumbnailProgress ||= {}; ps.pendingPool ||= []; ps.rejectedHashes ||= []; ps.chatAttempts ||= 0;
        if (ps.outputDir) await fsp.mkdir(ps.outputDir, { recursive: true });
        else if (this.state.runOutputDir) { ps.outputDir = path.join(this.state.runOutputDir, safeName(product.name)); await fsp.mkdir(ps.outputDir, { recursive: true }); }
        else ps.outputDir = await allocateOutputDir(outputs, product.name, null);
        const hashes = new Set(ps.hashes || []);
        roundLoop: while (ps.completed < 50 && ps.round < 10) {
          const roundAtStart = ps.round; let roundCommitted = false; this.skipCurrentProduct = false;
          try {
          await this.waitIfPaused();
          if (this.rateLimitRestartRequested) { await this.recoverAfterRateLimitCooldown('界面监控触发的限流冷却结束'); this.rateLimitRestartRequested = false; }
          const nextRound = (ps.chatAttempts % 10) + 1; this.detectedImages = 0;
          const latestProduct = await scanProductDirectory(product.dir, product.name, { round: nextRound, maxImages: 10 });
          if (!latestProduct.valid) { const reason = `商品“${product.name}”上传前重新检查发现缺少有效参考图或TXT提示词，已自动跳过并进入下一个商品`; this.log(reason); ps.status = 'skipped'; ps.skipReason = reason; this.state.skippedProducts ||= []; this.state.skippedProducts.push({ productId: product.id, reason, skippedAt: new Date().toISOString() }); this.recoveryContext = null; await this.checkpoint(); break roundLoop; }
          if (JSON.stringify(latestProduct.images) !== JSON.stringify(product.images) || latestProduct.prompt !== product.prompt) this.log(`商品“${product.name}”文件夹内容已变化，本轮将使用最新的${latestProduct.images.length}张参考图和TXT提示词`);
          if (latestProduct.imageSelection?.selectedAngleGroup) this.log(`本轮参考图限量为${latestProduct.images.length}/10张：根目录${Math.min(latestProduct.imageSelection.rootAvailable, 10)}张 + 角度组“${latestProduct.imageSelection.selectedAngleGroup}”${latestProduct.imageSelection.selectedAngleCount}张`);
          const sourceFingerprint = await buildInputFingerprint(latestProduct.images, latestProduct.prompt);
          const preparedPrompt = await this.runStep('生成差异化创意', async () => (await this.consumeRoundPromptPrefetch(latestProduct, nextRound, this.state.currentCycle, sourceFingerprint)) || this.prepareRoundPrompt(latestProduct, nextRound, this.state.currentCycle), { maxAttempts: 2 });
          const prompt = preparedPrompt.prompt;
          const inputFingerprint = await buildInputFingerprint(latestProduct.images, prompt);
          ps.creativeFingerprint = preparedPrompt.creativeFingerprint;
          ps.creativeEngineVersion = preparedPrompt.creativeMode ? CREATIVE_ENGINE_VERSION : null;
          this.watchRecoveryCount = 0; this.recoveryContext = { productId: product.id, productName: product.name, productDir: product.dir, sourcePromptText: latestProduct.prompt, productPrompt: preparedPrompt.sourcePrompt, images: latestProduct.images, prompt, inputFingerprint, creativeFingerprint: preparedPrompt.creativeFingerprint, creativeMode: preparedPrompt.creativeMode, round: nextRound, cycle: this.state.currentCycle, ps, hashes, outputs, promptSubmitted: false };
          await this.runStep('检查旧对话', () => this.checkIgnoredChatsIfDue(this.recoveryContext), { maxAttempts: 1 });
          if (ps.completed >= 50) { this.recoveryContext = null; break roundLoop; }
          this.emitStatus({ product: product.name, productIndex: p + 1, productTotal: products.length, round: nextRound, completed: ps.completed, phase: '新对话中' });
          await this.runStep('打开新对话', () => browser.newChat(), { maxAttempts: 1 });
          this.emitStatus({ product: product.name, productIndex: p + 1, productTotal: products.length, round: nextRound, completed: ps.completed, phase: '上传中' });
          await this.runStep('上传参考图', ({ deadlineAt }) => browser.uploadReferences(latestProduct.images, () => this.stopped ? '__STOPPED__' : (this.workflowRecoveryRequested || Date.now() >= deadlineAt ? '__WORKFLOW_RECOVERY__' : false), { deadlineAt, maxRefreshCycles: 0 }), { maxAttempts: 1 });
          const adaptiveGenerationSeconds = this.ensureScheduler().generationTimeoutSeconds(this.state.generationTimeoutSeconds); this.state.activeGenerationTimeoutSeconds = adaptiveGenerationSeconds;
          if (adaptiveGenerationSeconds !== this.state.generationTimeoutSeconds) this.log(`自适应调度根据近期生成速度把本对话等待时间调整为${adaptiveGenerationSeconds}秒（用户上限${this.state.generationTimeoutSeconds}秒）`);
          this.recoveryContext.generationStartedAt = Date.now();
          await this.runStep('发送提示词', () => browser.sendPrompt(prompt, adaptiveGenerationSeconds), { maxAttempts: 1 }); this.recoveryContext.promptSubmitted = true; ps.chatAttempts += 1;
          this.startRoundPromptPrefetch(latestProduct, (ps.chatAttempts % 10) + 1, this.state.currentCycle, sourceFingerprint);
          await this.recordNewConversation(); await this.checkpoint(); this.emitStatus({ product: product.name, round: nextRound, completed: ps.completed, phase: '生成中' });
          let generationResult;
          try { generationResult = await this.runStep('等待生成', () => browser.waitForGeneration(() => { if (this.skipCurrentProduct) throw new Error('__SKIP_PRODUCT__'); if (this.rateLimitRestartRequested) throw new Error('__RATE_LIMIT_RESTART__'); if (this.workflowRecoveryRequested) throw new Error('__WORKFLOW_RECOVERY__'); return this.paused || this.recoveryActive || this.rateLimitCooling; }), { timeoutMs: (adaptiveGenerationSeconds + 45) * 1000, maxAttempts: 1 }); }
          catch (error) {
            if (error.message === '__SKIP_PRODUCT__') { this.recoveryContext = null; await this.checkpoint(); break roundLoop; }
            if (error.message === '__CONTENT_POLICY_REFUSAL__') {
              this.state.policyRefusalCount = (Number(this.state.policyRefusalCount) || 0) + 1;
              ps.policyRefusalCount = (Number(ps.policyRefusalCount) || 0) + 1;
              this.log(`检测到商品“${product.name}”当前对话被内容政策拒绝：立即放弃等待，不保存、不补图、不回查该对话，直接开启下一新对话`);
              this.recoveryContext = null; this.watchRecoveryCount = 0; this.workflowRecoveryRequested = false; this.resetWatchdogSamples(); await this.checkpoint(); continue roundLoop;
            }
            if (error.message !== '__GENERATION_TIMEOUT__' && error.message !== '__WORKFLOW_RECOVERY__') throw error;
            this.scheduler.record({ outcome: 'timeout', generationMs: Date.now() - this.recoveryContext.generationStartedAt, images: 0 }); await this.schedulerCheckpoint();
            const deferred = isBackgroundTest ? { id: crypto.randomUUID(), url: browser.currentChatUrl || '', productId: product.id, round: nextRound, cycle: this.state.currentCycle, inputFingerprint, status: 'collecting', processedIndexes: [], ignoredAt: new Date().toISOString(), reason: `在${adaptiveGenerationSeconds}秒内未检测到图片` } : await this.deferCurrentChat(this.recoveryContext, `在${adaptiveGenerationSeconds}秒内未检测到完整图片`);
            await this.finalRescanCurrentChatBeforeNextChat(this.recoveryContext, deferred, { initialTotal: deferred?.detectedTotal || 0 });
            this.log(`商品“${product.name}”在${adaptiveGenerationSeconds}秒内未生成完整图片，${deferred ? '已记录并最终复扫该对话后' : '当前对话地址尚未形成，仍将'}打开下一新对话`); this.recoveryContext = null; this.watchRecoveryCount = 0; this.workflowRecoveryRequested = false; await this.checkpoint(); continue roundLoop;
          }
          if (generationResult?.status === 'partial') {
            const total = generationResult.viewer?.total || 0;
            this.scheduler.record({ outcome: 'partial', generationMs: Date.now() - this.recoveryContext.generationStartedAt, images: total }); await this.schedulerCheckpoint();
            const deferred = isBackgroundTest ? { id: crypto.randomUUID(), url: browser.currentChatUrl || '', productId: product.id, round: nextRound, cycle: this.state.currentCycle, inputFingerprint, status: 'collecting', processedIndexes: [], detectedTotal: total, ignoredAt: new Date().toISOString(), reason: `当前对话生成${total}张` } : await this.deferCurrentChat(this.recoveryContext, `等待结束时仅生成${total}/5张`, { detectedTotal: total });
            if (deferred) await this.finalRescanCurrentChatBeforeNextChat(this.recoveryContext, deferred, { initialTotal: total });
            this.recoveryContext = null; this.watchRecoveryCount = 0; await this.checkpoint(); continue roundLoop;
          }
          this.log(`商品“${product.name}”已确认5张图片全部生成完成，正在进行保存前稳定检查`);
          const viewerInfo = generationResult?.viewer || await this.runStep('确认图片', () => browser.getViewerImageCount({ targetTotal: 5, maxWaitSeconds: 30 }), { maxAttempts: 2 });
          this.detectedImages = viewerInfo.total || 0; this.emitStatus({ product: product.name, round: ps.round, completed: ps.completed, phase: '图片确认中' });
          this.log(`商品“${product.name}”查看器稳定检测结果：${viewerInfo.total || 0}/5张`);
          await this.waitIfPaused(); this.watchRecoveryCount = 0;
          this.emitStatus({ product: product.name, round: ps.round, completed: ps.completed, phase: '下载中' });
          const currentUrl = browser.currentChatUrl || await browser.waitForStableCurrentChatUrl(12000).catch(() => null);
          if (!currentUrl) throw new Error('__CHAT_URL_NOT_READY__:提示词发送后没有形成可验证的ChatGPT对话地址');
          let currentEntry = (this.state.ignoredChats || []).find((item) => currentUrl && item.url === currentUrl);
          if (!currentEntry) {
            currentEntry = { id: crypto.randomUUID(), url: currentUrl, productId: product.id, round: nextRound, cycle: this.state.currentCycle, inputFingerprint, status: 'collecting', processedIndexes: [], ignoredAt: new Date().toISOString(), reason: '当前对话已完整生成' };
            if (!isBackgroundTest) (this.state.ignoredChats ||= []).push(currentEntry);
          }
          let added; let promoted;
          const rejectedBefore = this.state.qualityStats?.rejected || 0;
          this.nativeSaveInFlight = true;
          try {
            try {
              added = await this.runStep('保存图片', () => this.stageChatImagesToPool(this.recoveryContext, currentEntry, Math.min(5, viewerInfo.total || 5)), { maxAttempts: 1 });
            } catch (error) {
              currentEntry.status = 'pending'; currentEntry.nextCheckAt = new Date(Date.now() + 5 * 60000).toISOString(); await this.checkpoint(); throw error;
            }
            if ((isBackgroundTest && (currentEntry.processedIndexes || []).length >= Math.min(5, viewerInfo.total || 1)) || (currentEntry.processedIndexes || []).length >= 5) { currentEntry.status = 'collected'; currentEntry.collectedAt = new Date().toISOString(); }
            else currentEntry.status = 'pending';
            promoted = await this.promotePendingPool(this.recoveryContext);
          }
          finally { this.nativeSaveInFlight = false; this.resetWatchdogSamples(); }
          if ((currentEntry.processedIndexes || []).length < 5) {
            const finalSweep = await this.finalRescanCurrentChatBeforeNextChat(this.recoveryContext, currentEntry, { initialTotal: viewerInfo.total || 0 });
            added.push(...finalSweep.added); promoted.push(...finalSweep.promoted);
          } else this.log('五个图片槽位已全部保存并校验通过，跳过多余最终复扫并立即准备下一对话');
          this.scheduler.record({ outcome: (currentEntry.processedIndexes || []).length >= 5 ? 'success' : 'partial', generationMs: Date.now() - this.recoveryContext.generationStartedAt, images: added.length, qualityRejected: (this.state.qualityStats?.rejected || 0) - rejectedBefore }); await this.schedulerCheckpoint();
          roundCommitted = ps.round > roundAtStart; this.recoveryContext = null; this.resetSafetyFailures();
          this.log(`当前完整对话向统一暂存池新增${added.length}张，本次转入正式目录${promoted.length}张；暂存池剩余${ps.pendingPool.length}张`);
          await this.checkpoint();
          if (ps.completed < 50 && this.state.waitEnabled) {
            const adaptiveDelaySeconds = this.ensureScheduler().nextDelaySeconds(this.state.waitMinSeconds, this.state.waitMaxSeconds); this.state.scheduler = this.scheduler.snapshot(); const delay = adaptiveDelaySeconds * 1000; const until = Date.now() + delay;
            this.log(`自适应调度：下一对话等待${adaptiveDelaySeconds}秒；近期失败率${Math.round(this.scheduler.recentFailureRate() * 100)}%`); transitionWorkflow(this.state, '轮次等待', { ...this.stepContext(`等待${adaptiveDelaySeconds}秒`) }, { timeoutMs: delay + 60000 }); await this.checkpoint();
            while (Date.now() < until) { await this.waitIfPaused(); const remainingMs = until - Date.now(); this.emitStatus({ product: product.name, round: ps.round, completed: ps.completed, phase: '等待中', remainingSeconds: Math.ceil(remainingMs / 1000) }); await sleep(Math.min(1000, remainingMs)); }
            completeWorkflow(this.state, { seconds: adaptiveDelaySeconds }); await this.checkpoint();
          } else if (ps.completed < 50) this.log('轮次等待已关闭，立即打开下一新对话');
          } catch (error) {
            this.nativeSaveInFlight = false;
            const savePageRecovered = error.message.startsWith('__SAVE_FAILED_RECOVERED__');
            const uploadRetryExhausted = /^__(UPLOAD_RETRY_EXHAUSTED|UPLOAD_ENTRY_NOT_READY)__/.test(error.message);
            if (error.message === '__STOPPED__') throw error;
            if (error.message === '__RATE_LIMIT_RESTART__') {
              const limitedUrl = await browser.getCurrentChatUrl().catch(() => null);
              if (limitedUrl && this.recoveryContext?.promptSubmitted === true) {
                const ignoredChats = this.state.ignoredChats ||= [];
                if (!ignoredChats.some((item) => item.url === limitedUrl)) ignoredChats.push({ id: crypto.randomUUID(), url: limitedUrl, productId: product.id, round: roundAtStart + 1, cycle: this.state.currentCycle, inputFingerprint: this.recoveryContext.inputFingerprint, status: 'pending', processedIndexes: [], ignoredAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 10 * 60000).toISOString(), reason: '限流冷却后放弃原对话并重启轮次' });
              }
              await this.checkpoint(); await this.recoverAfterRateLimitCooldown('界面监控限流后重启当前轮次');
              this.rateLimitRestartRequested = false; this.recoveryContext = null; this.log('限流后的原等待阶段已退出，将立即开启新对话继续任务'); continue roundLoop;
            }
            if (this.isRateLimited(error)) {
              const limitedUrl = await browser.getCurrentChatUrl().catch(() => null);
              if (limitedUrl && this.recoveryContext?.promptSubmitted === true) {
                const ignoredChats = this.state.ignoredChats ||= [];
                if (!ignoredChats.some((item) => item.url === limitedUrl)) ignoredChats.push({ id: crypto.randomUUID(), url: limitedUrl, productId: product.id, round: roundAtStart + 1, cycle: this.state.currentCycle, inputFingerprint: this.recoveryContext.inputFingerprint, status: 'pending', processedIndexes: [], ignoredAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 10 * 60000).toISOString(), reason: error.message });
              }
              this.recoveryContext = null; await this.checkpoint(); await this.cooldownForRateLimit(error.message); await this.recoverAfterRateLimitCooldown('当前轮次触发限流'); this.rateLimitRestartRequested = false; continue roundLoop;
            }
            if (!roundCommitted) ps.round = roundAtStart;
            this.ensureScheduler().record({ outcome: 'failure', generationMs: this.recoveryContext?.generationStartedAt ? Date.now() - this.recoveryContext.generationStartedAt : 0, images: 0 }); await this.schedulerCheckpoint().catch(() => {});
            const failedUrl = await browser.getCurrentChatUrl().catch(() => null);
            if (failedUrl && this.recoveryContext?.promptSubmitted === true) {
              const ignoredChats = this.state.ignoredChats ||= [];
              if (!ignoredChats.some((item) => item.url === failedUrl)) ignoredChats.push({ id: crypto.randomUUID(), url: failedUrl, productId: product.id, round: roundAtStart + 1, cycle: this.state.currentCycle, inputFingerprint: this.recoveryContext.inputFingerprint, status: 'pending', processedIndexes: [], ignoredAt: new Date().toISOString(), reason: error.message });
            }
            this.recoveryContext = null; this.watchRecoveryCount = 0; this.resetWatchdogSamples();
            this.log(`当前轮次异常：${error.message}；已保存断点并进入有界恢复判断`);
            await this.checkpoint();
            if (this.isSecurityOrLoginError(error)) { await this.enterSafetyHold(`检测到登录或安全验证异常：${error.message}`); await this.waitIfPaused(); continue roundLoop; }
            if (uploadRetryExhausted) {
              const uploadFailures = this.recordTransientUploadFailure(error.message); await this.checkpoint();
              await this.waitForRecoveryJitter(`上传入口自动恢复（第${uploadFailures}次）`, uploadFailures <= 1 ? 4 : (uploadFailures === 2 ? 8 : 15), uploadFailures <= 1 ? 8 : (uploadFailures === 2 ? 15 : 30));
              this.log('参考图上传入口暂时不可用；已保留任务断点，将重新打开新对话再定位上传按钮，不进入人工安全暂停');
              continue roundLoop;
            }
            if (savePageRecovered) {
              const saveFailures = this.recordTransientSaveFailure(error.message); await this.checkpoint();
              const shortRecovery = saveFailures <= 1;
              await this.waitForRecoveryJitter(`保存快速恢复（第${saveFailures}次）`, shortRecovery ? 2 : (saveFailures === 2 ? 6 : 15), shortRecovery ? 5 : (saveFailures === 2 ? 12 : 35));
              this.log('保存失败界面已关闭并返回ChatGPT；当前对话已保留回查断点，将直接开启新对话，不刷新页面、不要求人工确认');
              continue roundLoop;
            }
            const safetyFailures = this.recordSafetyFailure(error.message); await this.checkpoint();
            if (safetyFailures >= 3) { await this.enterSafetyHold(`10分钟内连续${safetyFailures}次页面恢复异常：${error.message}`); await this.waitIfPaused(); continue roundLoop; }
            await this.waitForRecoveryJitter(`页面冷却恢复（第${safetyFailures}次）`, 15, 35);
            const recovered = await this.recoverToFreshChatPage(error.message);
            if (!recovered) {
              const recoveryFailures = this.recordSafetyFailure(`页面恢复失败：${error.message}`); await this.checkpoint();
              if (recoveryFailures >= 3) { await this.enterSafetyHold(`10分钟内连续${recoveryFailures}次页面恢复异常：${error.message}`); await this.waitIfPaused(); }
              else { await this.waitForRecoveryJitter(`页面恢复未成功（第${recoveryFailures}次）`, 20, 40); this.log('本次页面恢复未成功，已保留断点；尚未达到人工暂停阈值，将在新一轮重新检查页面'); }
            }
            continue roundLoop;
          }
        }
        if (ps.completed >= 50) this.log(`产品“${product.name}”已完成50张`);
        this.state.currentProduct = p + 1; await this.checkpoint();
      }
      this.log(`整批循环 ${this.state.currentCycle}/${this.state.totalCycles} 已完成`); this.state.currentCycle += 1;
      if (this.state.currentCycle > this.state.totalCycles) break cycleLoop;
      const nextLayout = await allocateRunLayout(outputs, validProducts.map((item) => item.name));
      this.state.runOutputDir = nextLayout.runDir; this.state.runOutputDirs ||= []; this.state.runOutputDirs.push(nextLayout.runDir); this.state.currentProduct = 0; this.state.products = {}; this.state.skippedProducts = [];
      for (const product of validProducts) this.state.products[product.id] = { outputDir: nextLayout.productDirs[product.name], completed: 0, round: 0, chatAttempts: 0, hashes: [], rejectedHashes: [], thumbnailProgress: {}, pendingPool: [] };
      await this.checkpoint();
      }
      this.state.status = 'completed'; await this.checkpoint(); this.emitStatus({ phase: '已完成', message: '所有产品处理完成' });
    } catch (error) {
      if (error.message === '__STOPPED__' || this.stopped) this.emitStatus({ phase: '已停止' });
      else if (finalProtectionEligible && this.isRateLimited(error)) {
        fatalReason = error.message;
        if (this.state) this.state.status = 'cooldown';
        await this.checkpoint().catch(() => {});
        try { await this.cooldownForRateLimit(error.message); await this.recoverAfterRateLimitCooldown('任务外层捕获到限流'); restartAfterManualResume = true; }
        catch (recoveryError) { await this.enterSafetyHold(`限流冷却后仍无法安全恢复：${recoveryError.message}`); await this.waitIfPaused(); restartAfterManualResume = !this.stopped; }
      } else if (finalProtectionEligible) {
        fatalReason = error.message;
        await this.enterSafetyHold(`任务遇到未处理异常，已禁止自动关闭或重启Edge：${fatalReason}`);
        await this.waitIfPaused(); restartAfterManualResume = !this.stopped;
      } else {
        this.pause(`任务启动异常：${error.message}`);
        if (this.state) this.state.status = 'failed'; await this.checkpoint().catch(() => {});
      }
    } finally { this.stopWatchdog(); await this.browser?.close(); this.browser = null; this.running = false; this.emitStatus(); }
    if (restartAfterManualResume && !this.stopped) {
      this.log('人工确认已完成，软件将从保存的断点继续；不会自动关闭或重启Edge');
      return this.start(root, 'continue', options);
    }
  }
}

module.exports = { TaskRunner };
