const test = require('node:test');
const assert = require('node:assert/strict');
const { TaskRunner } = require('../src/runner');

test('旧版状态迁移后保留产品输出目录并补齐runId', () => {
  const runner = new TaskRunner('user-data', 'downloads');
  const state = runner.migrateState({ version: 1, root: 'R', createdAt: '2026-01-01T00:00:00.000Z', currentProduct: 1, products: { p: { outputDir: 'old-dir' } } }, 'R');
  assert.equal(state.version, 5); assert.equal(state.pendingPoolVersion, 1); assert.match(state.runId, /^legacy-/); assert.equal(state.runOutputDir, null); assert.equal(state.products.p.outputDir, 'old-dir'); assert.deepEqual(state.products.p.thumbnailProgress, {}); assert.deepEqual(state.products.p.pendingPool, []); assert.ok(state.workflow); assert.ok(state.qualityPolicy); assert.equal(state.creativePolicy.enabled, true);
});

test('界面连续三次无变化时返回GPT页面恢复而不暂停', () => {
  const runner = new TaskRunner('user-data', 'downloads');
  runner.running = true; runner.currentPhase = '上传中'; runner.state = { status: 'active' };
  runner.checkpoint = async () => {};
  let alert = null; runner.on('alert', (value) => { alert = value; });
  const snapshot = { found: true, title: 'ChatGPT', hasComposer: true, hasStop: false, downloadCount: 0, generatedCount: 0, attachmentCount: 2, submitEnabled: true };
  assert.equal(runner.observeWatchState(snapshot), false);
  assert.equal(runner.observeWatchState(snapshot), false);
  assert.equal(runner.observeWatchState(snapshot), 'recover-page');
  assert.equal(runner.paused, false); assert.equal(runner.state.status, 'active'); assert.equal(alert, null);
});

test('正在生成时不会被无变化监控误暂停', () => {
  const runner = new TaskRunner('user-data', 'downloads'); runner.running = true; runner.currentPhase = '生成中';
  const snapshot = { found: true, hasStop: true };
  for (let i = 0; i < 5; i += 1) assert.equal(runner.observeWatchState(snapshot), false);
  assert.equal(runner.paused, false); assert.equal(runner.watchSameCount, 0);
});

test('图片未生成且界面连续三次无变化时始终放弃当前对话并重开', () => {
  const runner = new TaskRunner('user-data', 'downloads'); runner.running = true; runner.currentPhase = '生成中'; runner.state = { status: 'active' }; runner.checkpoint = async () => {}; runner.recoveryContext = { images: [], prompt: 'p' };
  const snapshot = { found: true, title: 'ChatGPT', hasComposer: true, hasStop: false, downloadCount: 0, generatedCount: 0, attachmentCount: 0, submitEnabled: false };
  for (let recovery = 1; recovery <= 5; recovery += 1) { assert.equal(runner.observeWatchState(snapshot), false); assert.equal(runner.observeWatchState(snapshot), false); assert.equal(runner.observeWatchState(snapshot), 'recover'); assert.equal(runner.paused, false); }
  assert.equal(runner.watchRecoveryCount, 5); assert.equal(runner.paused, false);
});

test('每轮上传前明确进入新对话阶段', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  const newChatAt = source.indexOf("phase: '新对话中'"); const callAt = source.indexOf("runStep('打开新对话'"); const uploadAt = source.indexOf("runStep('上传参考图'");
  assert.ok(newChatAt >= 0 && newChatAt < callAt && callAt < uploadAt);
});

test('图片路径读取失败时禁止误发缺图请求', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(source, /已保存图片校验失败，损坏文件已删除并禁止误发补图请求/);
  assert.match(source, /内容重复/);
});

test('单对话生成超时可配置并直接加入延后回查队列', () => {
  const fs = require('node:fs'); const automation = fs.readFileSync(require.resolve('../src/automation'), 'utf8'); const runner = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(automation, /sendPrompt\(text, generationTimeoutSeconds = 60\)/);
  assert.match(automation, /Date\.now\(\) \+ timeoutSeconds \* 1000/);
  assert.match(automation, /__GENERATION_TIMEOUT__/);
  assert.match(runner, /roundLoop: while/);
  assert.match(runner, /await this\.deferCurrentChat\(this\.recoveryContext/);
  assert.match(runner, /const deferred = await this\.deferCurrentChat/);
  assert.match(runner, /当前对话地址尚未形成，仍将/);
  assert.match(runner, /continue roundLoop/);
});

test('生成结束后等待新图片控件稳定再保存', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(source, /this\.generatedBaseline = before\.generatedCount \|\| 0/);
  assert.match(source, /const hasNewImages = \(state\.generatedCount \|\| 0\) > \(this\.generatedBaseline \|\| 0\)/);
  assert.match(source, /imagesStable >= 2/);
  assert.match(source, /findWaitSeconds: 2, maxWaitSeconds: 4, targetTotal: 5/);
  assert.match(source, /查看器已确认5张图片生成完成，立即进入保存流程/);
  assert.match(source, /const finalViewer = await runNative\('viewer-image-count'/);
  assert.match(source, /status: 'complete'/);
  assert.match(source, /status: 'partial'/);
  assert.doesNotMatch(source, /imagesStable >= 2\) \{ await sleep\(2000\); this\.generationDeadline = null; return; \}/);
});

test('原生另存为执行期间界面监控不会误判卡住', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /this\.nativeSaveInFlight = true/);
  assert.match(source, /finally \{ this\.nativeSaveInFlight = false; this\.resetWatchdogSamples\(\); \}/);
  assert.match(source, /this\.nativeSaveInFlight \|\| this\.watchInFlight/);
});

test('保存失败会关闭保存界面并返回原ChatGPT对话后继续', () => {
  const fs = require('node:fs'); const automation = fs.readFileSync(require.resolve('../src/automation'), 'utf8'); const runner = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(automation, /const chatUrlBeforeSave = await this\.getCurrentChatUrl/);
  assert.match(automation, /runNative\('recover-save-ui', \{ chatUrl: chatUrlBeforeSave \}/);
  assert.match(automation, /filesBeforeSave/); assert.match(automation, /清理\$\{failedFiles\.length\}个未计数文件/);
  assert.match(automation, /__SAVE_FAILED_RECOVERED__/); assert.match(automation, /__SAVE_RECOVERY_FAILED__/);
  assert.match(runner, /error\.message\.startsWith\('__SAVE_FAILED_RECOVERED__'\)/);
  assert.match(runner, /保存失败界面已自动关闭并返回ChatGPT，立即用新对话继续/);
});

test('保存前使用最小空缺编号且不复用旧文件', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(source, /let availableStartNumber = 1/);
  assert.match(source, /while \(usedNumbers\.has\(availableStartNumber\)\) availableStartNumber \+= 1/);
  assert.match(source, /startNumber: availableStartNumber/);
});

test('旧对话回查会把新图片收集到统一暂存池', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /const ignoredChats = this\.state\.ignoredChats \|\|= \[\]/);
  assert.match(source, /await this\.browser\.openChatUrl\(entry\.url\)/);
  assert.match(source, /await this\.stageChatImagesToPool\(context, entry/);
  assert.match(source, /await this\.promotePendingPool\(context\)/);
  assert.match(source, /pooled_chat=/);
  assert.match(source, /status: 'pending'/);
  assert.match(source, /recoverToFreshChatPage\(`旧对话无效或页面未加载/);
});

test('输入框未加载与真正退出登录使用不同错误并走自动恢复', () => {
  const fs = require('node:fs'); const automation = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(automation, /if \(state\.hasLogin\) throw new Error\('ChatGPT页面明确显示登录入口/);
  assert.match(automation, /if \(!state\.hasComposer\) throw new Error\('__CHATGPT_PAGE_NOT_READY__/);
  assert.doesNotMatch(automation, /state\.hasLogin \|\| !state\.hasComposer/);
});

test('回收旧对话首次加载后会再刷新一次避免白屏', () => {
  const fs = require('node:fs'); const automation = fs.readFileSync(require.resolve('../src/automation'), 'utf8'); const runner = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(automation, /openChatUrl\(url, \{ refreshAfterOpen = false \} = \{\}\)/);
  assert.match(automation, /if \(refreshAfterOpen \|\| initialError\)/);
  assert.match(automation, /await runNative\('refresh-page', \{\}, 60000\)/);
  assert.match(automation, /await this\.assertSafePage\(\)/);
  assert.equal((runner.match(/openChatUrl\(entry\.url, \{ refreshAfterOpen: true \}\)/g) || []).length, 0);
  assert.match(runner, /await this\.browser\.openChatUrl\(entry\.url\)/);
  assert.doesNotMatch(runner, /if \(returnUrl\) await this\.browser\.openChatUrl\(returnUrl\)/);
});

test('每次打开上传前重新读取当前商品文件夹', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /await scanProductDirectory\(product\.dir, product\.name\)/);
  assert.match(source, /await this\.refreshProductInputs\(context\)/);
  assert.match(source, /文件夹内容已变化/);
});

test('发送按钮重试成功会记录实际尝试次数', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(source, /发送按钮首次点击未生效/);
  assert.match(source, /sent\.attempts/);
});

test('无图片生成超时不刷新当前页面而由下一轮直接开启新对话', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /await this\.browser\.refreshPage\(\);\s*await this\.browser\.newChat\(\)/);
  assert.match(source, /在\$\{adaptiveGenerationSeconds\}秒内未生成完整图片/);
  assert.match(source, /async deferCurrentChat/);
  assert.match(source, /status: 'pending'/);
});

test('一到四张图片只暂存不计轮次并延后回查', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /generationResult\?\.status === 'partial'/);
  assert.match(source, /await this\.stageChatImagesToPool/);
  assert.match(source, /'\.pending_pool'/);
  assert.match(source, /暂不计正式图片数/);
  assert.doesNotMatch(source, /ps\.round = Math\.max\(0, ps\.round - 1\)/);
  assert.match(source, /continue roundLoop/);
});

test('保存不足时不在旧对话补图而是直接进入新对话', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.doesNotMatch(source, /本轮还缺少\$\{5 - roundSaved\}张/);
  assert.doesNotMatch(source, /请继续生成\$\{5 - roundSaved\}张/);
  assert.match(source, /stageChatImagesToPool/);
  assert.match(source, /promotePendingPool/);
  assert.doesNotMatch(source, /sendPrompt\([^)]*补/);
});

test('参考图连续上传失败后刷新页面并在新对话继续而不停止', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(source, /while \(this\.connected\)/);
  assert.match(source, /maxRefreshCycles/);
  assert.match(source, /参考图连续上传失败，正在刷新页面并打开新对话后继续上传/);
  assert.match(source, /await this\.refreshPage\(\);\s*await this\.newChat\(\)/);
  assert.doesNotMatch(source, /参考图自动重传 3 次后仍不完整/);
});

test('UI显示与实际20到60秒随机等待一致', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
  assert.match(html, /下一轮倒计时/);
  assert.match(html, /id="waitEnabled" type="checkbox" checked/);
  assert.match(html, /id="waitMinSeconds"[^>]*value="20"/);
  assert.match(html, /id="waitMaxSeconds"[^>]*value="60"/);
  assert.match(html, /id="waitSummary"/);
  assert.doesNotMatch(html, /3–5 分钟/);
  assert.match(renderer, /Math\.max\(0, Math\.ceil\(n\)\)/);
  assert.match(renderer, /startNew\(root, \{ totalCycles, \.\.\.waits, \.\.\.generation, \.\.\.advanced \}\)/);
  assert.match(renderer, /轮次等待已关闭/);
});

test('轮次等待设置写入任务状态并可在断点继续时恢复', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /waitEnabled: prior\.waitEnabled !== false/);
  assert.match(source, /waitMinSeconds: Number\.isFinite\(prior\.waitMinSeconds\)/);
  assert.match(source, /waitMaxSeconds: Number\.isFinite\(prior\.waitMaxSeconds\)/);
  assert.match(source, /options\.waitMinSeconds \?\? 20/);
  assert.match(source, /options\.waitMaxSeconds \?\? 60/);
  assert.match(source, /this\.state\.waitEnabled/);
  assert.match(source, /轮次等待已关闭，立即打开下一新对话/);
});

test('可恢复故障不暂停而是刷新页面并从新对话重试', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8'); const automation = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.doesNotMatch(source, /requiresManualIntervention\(error\)/);
  assert.match(source, /自动恢复可解决故障/);
  assert.match(source, /正在刷新页面并打开新对话继续，不暂停任务/);
  assert.match(source, /await this\.recoverToFreshChatPage\(error\.message\); continue roundLoop/);
  assert.match(source, /for \(let attempt = 1; attempt <= 3/);
  assert.match(source, /任务不会暂停；等待10秒后继续尝试/);
  assert.match(automation, /async recoverToFreshChatPage\(\)/);
  assert.match(automation, /runNative\('recover-save-ui', \{ chatUrl: null \}/);
  assert.match(source, /stageChatImagesToPool/);
  assert.doesNotMatch(source, /本轮补生成3次后仍不足5张`\); await this\.checkpoint\(\); await this\.waitIfPaused/);
});

test('未处理异常触发最终保护重启Edge并从断点继续但用户停止不触发', () => {
  const fs = require('node:fs'); const runner = fs.readFileSync(require.resolve('../src/runner'), 'utf8'); const automation = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(runner, /finalProtectionEligible = true/);
  assert.match(runner, /error\.message === '__STOPPED__' \|\| this\.stopped/);
  assert.match(runner, /await this\.browser\.restartEdgeAndOpenChatGPT\(\)/);
  assert.match(runner, /return this\.start\(root, 'continue'/);
  assert.match(runner, /state\.status = 'recovering'/);
  assert.match(automation, /async restartEdgeAndOpenChatGPT\(\)/);
  assert.match(automation, /runNative\('restart-edge-chatgpt'/);
  assert.match(automation, /检测到安全检查，需要正常人工处理/);
});

test('商品缺少参考图或TXT时记录原因并自动进入下一个商品', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /缺少有效参考图或TXT提示词，已自动跳过并进入下一个商品/);
  assert.match(source, /this\.state\.currentProduct = p \+ 1; await this\.checkpoint\(\); continue/);
  assert.match(source, /ps\.status = 'skipped'/);
  assert.match(source, /this\.skipCurrentProduct = true/);
  assert.match(source, /__SKIP_PRODUCT__/);
  assert.match(source, /break roundLoop/);
  assert.doesNotMatch(source, /this\.pause\(`产品“\$\{product\.name\}”缺少有效参考图或TXT提示词/);
});

test('按用户设定的新对话数量在安全时间点回查旧对话', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /newChatsSinceIgnoredCheck = \(this\.state\.newChatsSinceIgnoredCheck \|\| 0\) \+ 1/);
  assert.match(source, /const checkEvery = this\.state\.ignoredCheckEveryChats \|\| 10/);
  assert.match(source, /newChatsSinceIgnoredCheck \|\| 0\) < checkEvery/);
  assert.match(source, /await this\.checkIgnoredChats\(context\)/);
  assert.match(source, /当前对话已经结束，开始在安全时间点回查旧对话/);
  assert.doesNotMatch(source, /entry\.checkAttempts >= 3/);
  assert.match(source, /sort\(\(a, b\) => String\(a\.lastCheckedAt \|\| a\.ignoredAt/);
  assert.match(source, /slice\(0, 1\)/);
  assert.match(source, /nextCheckAt/);
  const dueAt = source.indexOf("runStep('检查旧对话'");
  const newChatAt = source.indexOf("runStep('打开新对话'", dueAt);
  assert.ok(dueAt >= 0 && newChatAt > dueAt);
});

test('旧对话只有确认五个缩略图都已保存后才结束回查', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /viewerInfo\.five && \(entry\.processedIndexes \|\| \[\]\)\.length >= 5/);
  assert.match(source, /entry\.status = 'collected'/);
});

test('回查到期后会检查旧对话并清零计数', async () => {
  const runner = new TaskRunner('user-data', 'downloads');
  runner.state = { ignoredCheckEveryChats: 5, newChatsSinceIgnoredCheck: 5, ignoredChats: [{ status: 'pending', productId: 'p1', cycle: 1 }] };
  runner.checkpoint = async () => {};
  let checked = 0; runner.checkIgnoredChats = async () => { checked += 1; return 0; };
  runner.log = () => {};
  await runner.checkIgnoredChatsIfDue({ productId: 'p1', cycle: 1 });
  assert.equal(checked, 1);
  assert.equal(runner.state.newChatsSinceIgnoredCheck, 0);
});

test('多个旧对话在商品统一暂存池凑够五张后合并为正式一轮', async () => {
  const fs = require('node:fs'); const fsp = fs.promises; const os = require('node:os'); const path = require('node:path'); const sharp = require('sharp');
  const { validateImage } = require('../src/core'); const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ecom-pool-')); const outputDir = path.join(root, '商品'); const poolDir = path.join(outputDir, '.pending_pool'); await fsp.mkdir(poolDir, { recursive: true });
  const pendingPool = []; const hashes = new Set(); const colors = ['red', 'blue', 'green', 'yellow', 'black'];
  for (let i = 0; i < 5; i += 1) { const file = path.join(poolDir, `候选_${i + 1}.png`); await sharp({ create: { width: 4, height: 4, channels: 3, background: colors[i] } }).png().toFile(file); const info = await validateImage(file, hashes); hashes.add(info.hash); pendingPool.push({ file, ...info, sourceChatId: i < 2 ? 'chat-1' : 'chat-2', sourceUrl: `https://chatgpt.com/c/${i < 2 ? 1 : 2}`, thumbnailIndex: i, inputFingerprint: 'same-input', savedAt: new Date(Date.now() + i).toISOString(), status: 'pending' }); }
  const runner = new TaskRunner('user-data', 'downloads'); runner.state = { runId: 'run-1' }; runner.checkpoint = async () => {};
  const context = { ps: { outputDir, completed: 0, round: 0, hashes: [], pendingPool }, hashes: new Set(), productName: '商品', productId: '商品', productPrompt: '提示', outputs: root, cycle: 1 };
  const promoted = await runner.promotePendingPool(context);
  assert.equal(promoted.length, 5); assert.equal(context.ps.completed, 5); assert.equal(context.ps.round, 1); assert.equal(context.ps.pendingPool.length, 0);
  assert.deepEqual(new Set(promoted.map((item) => item.sourceChatId)), new Set(['chat-1', 'chat-2']));
  const finalFiles = (await fsp.readdir(outputDir, { withFileTypes: true })).filter((item) => item.isFile() && /^商品_\d{3}\./.test(item.name)); assert.equal(finalFiles.length, 5);
});

test('不同参考图和TXT版本的暂存图片不会混成同一轮', async () => {
  const fs = require('node:fs'); const fsp = fs.promises; const os = require('node:os'); const path = require('node:path'); const sharp = require('sharp'); const { validateImage } = require('../src/core');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ecom-pool-version-')); const outputDir = path.join(root, '商品'); const poolDir = path.join(outputDir, '.pending_pool'); await fsp.mkdir(poolDir, { recursive: true }); const pendingPool = []; const hashes = new Set();
  for (let i = 0; i < 5; i += 1) { const file = path.join(poolDir, `候选_${i}.png`); await sharp({ create: { width: 4, height: 4, channels: 3, background: ['red', 'blue', 'green', 'yellow', 'black'][i] } }).png().toFile(file); const info = await validateImage(file, hashes); hashes.add(info.hash); pendingPool.push({ file, ...info, sourceChatId: `chat-${i}`, inputFingerprint: i < 2 ? 'version-a' : 'version-b', savedAt: new Date(Date.now() + i).toISOString(), status: 'pending' }); }
  const runner = new TaskRunner('user-data', 'downloads'); runner.state = { runId: 'run-1' }; runner.checkpoint = async () => {}; const context = { ps: { outputDir, completed: 0, round: 0, hashes: [], pendingPool }, hashes: new Set(), productName: '商品', productId: '商品', productPrompt: '提示', outputs: root, cycle: 1 };
  assert.equal((await runner.promotePendingPool(context)).length, 0); assert.equal(context.ps.pendingPool.length, 5); assert.equal(context.ps.completed, 0);
});

test('UI可配置单对话生成等待和回查间隔并支持断点恢复', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
  const runner = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(html, /id="generationTimeoutSeconds"[^>]*value="200"/);
  assert.match(renderer, /ignoredCheckEveryChats[^\n]*1, 20, 10/);
  assert.match(renderer, /if \(!saved\) \{ \$\('ignoredCheckEveryChats'\)\.value = 10/);
  assert.match(renderer, /function generationOptions\(\)/);
  assert.match(renderer, /\.\.\.generation/);
  assert.match(runner, /generationTimeoutSeconds: Number\.isFinite\(prior\.generationTimeoutSeconds\)/);
  assert.match(runner, /previousIgnoredCheckEveryChats = Number\.isFinite\(prior\.ignoredCheckEveryChats\)/);
  assert.match(runner, /ignoredCheckPolicyVersion: 2/);
  assert.match(renderer, /continueSaved\(root, \{ \.\.\.waits, \.\.\.generation, \.\.\.advanced \}\)/);
  assert.match(runner, /if \(options\.generationTimeoutSeconds !== undefined\)/);
  assert.match(runner, /本次任务设置：单对话生成等待/);
});

test('生成完成后只在确认五图列表稳定时进入正式保存', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /已确认5张图片全部生成完成/);
  assert.match(source, /查看器稳定检测结果/);
  assert.match(source, /generationResult\?\.viewer \|\| await this\.runStep\('确认图片'/);
  assert.match(source, /this\.detectedImages = viewerInfo\.total \|\| 0/);
});

test('UI显示本轮实际识别图片数量', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
  assert.match(html, /id="detectedImages"/);
  assert.match(renderer, /本轮识别/);
  assert.match(renderer, /s\.detectedImages/);
});

test('保存候选图片时删除重复文件并压紧连续编号', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  assert.match(source, /跳过查看器中的重复候选图片/);
  assert.match(source, /await fsp\.unlink\(item\.file\)/);
  assert.match(source, /while \(usedNumbers\.has\(finalNumber\)\) finalNumber \+= 1/);
  assert.match(source, /String\(finalNumber\)\.padStart\(3, '0'\)/);
  assert.match(source, /已跳过与当前大图对应的第/);
});

test('旧版缩略图断点升级后清空以避免错位重复保存', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /thumbnailProgressVersion: 2/);
  assert.match(source, /previousThumbnailProgressVersion < 2/);
  assert.match(source, /ps\.thumbnailProgress = \{\}/);
});

test('UI可设置整批循环次数并传递给新任务', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
  const preload = fs.readFileSync(require.resolve('../src/preload'), 'utf8');
  assert.match(html, /id="totalCycles" type="number" min="1" max="99"/);
  assert.match(html, /id="cycleStatus"/);
  assert.match(renderer, /startNew\(root, \{ totalCycles, \.\.\.waits, \.\.\.generation, \.\.\.advanced \}\)/);
  assert.match(renderer, /当前批次/);
  assert.match(preload, /startNew: \(root, options\)/);
});

test('UI会记忆时间开关和循环轮次设置', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'renderer.js'), 'utf8');
  assert.match(renderer, /UI_SETTINGS_KEY = 'ecommerce-main-image-generator\.ui-settings\.v1'/);
  assert.match(renderer, /localStorage\.setItem\(UI_SETTINGS_KEY/);
  assert.match(renderer, /localStorage\.getItem\(UI_SETTINGS_KEY\)/);
  assert.match(renderer, /loadUiPreferences\(\)/);
  for (const id of ['totalCycles', 'waitEnabled', 'waitMinSeconds', 'waitMaxSeconds', 'generationTimeoutSeconds', 'ignoredCheckEveryChats']) assert.match(renderer, new RegExp(`'${id}'`));
  assert.match(renderer, /addEventListener\('change'/);
  assert.match(renderer, /refreshSavedState[\s\S]*saveUiPreferences\(\)/);
});

test('整批循环为每批创建新输出总目录并支持断点恢复', () => {
  const fs = require('node:fs'); const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /totalCycles = Math\.max\(1, Math\.min\(99/);
  assert.match(source, /cycleLoop: while \(this\.state\.currentCycle <= this\.state\.totalCycles\)/);
  assert.match(source, /const nextLayout = await allocateRunLayout/);
  assert.match(source, /this\.state\.runOutputDirs\.push\(nextLayout\.runDir\)/);
  assert.match(source, /this\.state\.products = \{\}/);
  assert.match(source, /currentCycle: prior\.currentCycle \|\| 1/);
  assert.match(source, /totalCycles: prior\.totalCycles \|\| 1/);
});

test('请求过于频繁时进入持久化退避且不触发Edge最终重启', () => {
  const fs = require('node:fs');
  const runnerSource = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  const automationSource = fs.readFileSync(require.resolve('../src/automation'), 'utf8');
  const schedulerSource = fs.readFileSync(require.resolve('../src/adaptive-scheduler'), 'utf8');
  assert.match(schedulerSource, /\[10, 20, 40, 60\]/);
  assert.match(runnerSource, /rateLimitUntil/);
  assert.match(runnerSource, /rateLimitLevel/);
  assert.match(runnerSource, /else if \(finalProtectionEligible && this\.isRateLimited\(error\)\)/);
  assert.match(runnerSource, /期间不刷新、不重启Edge、不打开新对话或旧对话/);
  assert.match(automationSource, /__RATE_LIMITED__/);
});

test('旧对话回查一次只处理一个到期记录并为未完成记录设置下次检查时间', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /Date\.parse\(item\.nextCheckAt\) <= now/);
  assert.match(source, /slice\(0, 1\)/);
  assert.match(source, /await this\.browser\.openChatUrl\(entry\.url\)/);
  assert.doesNotMatch(source, /openChatUrl\(entry\.url, \{ refreshAfterOpen: true \}\)/);
  assert.match(source, /entry\.nextCheckAt = new Date\(Date\.now\(\) \+ 5 \* 60000\)/);
});

test('监控检测到限流提示时立即返回限流状态而不是累计卡住次数', () => {
  const runner = new TaskRunner('user-data', 'downloads');
  runner.watchSameCount = 2;
  assert.equal(runner.observeWatchState({ found: true, hasRateLimit: true }), 'rate-limit');
  assert.equal(runner.watchSameCount, 0);
});

test('新任务默认每10个新对话回查且旧默认值5自动迁移为10', () => {
  const runner = new TaskRunner('user-data', 'downloads');
  const migrated = runner.migrateState({ root: 'R', ignoredCheckEveryChats: 5, products: {}, ignoredChats: [] }, 'R');
  assert.equal(migrated.ignoredCheckEveryChats, 10);
  assert.equal(migrated.ignoredCheckPolicyVersion, 2);
  const custom = runner.migrateState({ root: 'R', ignoredCheckEveryChats: 15, products: {}, ignoredChats: [] }, 'R');
  assert.equal(custom.ignoredCheckEveryChats, 15);
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /options\.ignoredCheckEveryChats \?\? 10/);
});

test('程序重启时即使冷却截止时间已过也会请求恢复任务', async () => {
  const runner = new TaskRunner('user-data', 'downloads');
  runner.state = { status: 'cooldown', rateLimitUntil: new Date(Date.now() - 1000).toISOString(), rateLimitRecoveryPending: true };
  runner.checkpoint = async () => {};
  runner.log = () => {};
  assert.equal(await runner.resumeSavedRateLimitCooldownIfNeeded(), true);
  assert.equal(runner.state.status, 'active');
  assert.equal(runner.state.rateLimitUntil, null);
  assert.equal(runner.state.rateLimitRecoveryPending, true);
});

test('冷却结束后恢复ChatGPT页面并清除待恢复标记', async () => {
  const runner = new TaskRunner('user-data', 'downloads');
  let recovered = 0;
  runner.state = { status: 'cooldown', rateLimitUntil: null, rateLimitRecoveryPending: true };
  runner.browser = { recoverToFreshChatPage: async () => { recovered += 1; } };
  runner.checkpoint = async () => {};
  runner.log = () => {};
  assert.equal(await runner.recoverAfterRateLimitCooldown('test'), true);
  assert.equal(recovered, 1);
  assert.equal(runner.state.status, 'active');
  assert.equal(runner.state.rateLimitRecoveryPending, false);
});

test('冷却后仍限流会再次冷却并最终恢复而不是停住', async () => {
  const runner = new TaskRunner('user-data', 'downloads');
  let recovered = 0; let cooled = 0;
  runner.state = { status: 'cooldown', rateLimitRecoveryPending: true };
  runner.browser = { recoverToFreshChatPage: async () => { recovered += 1; if (recovered === 1) throw new Error('__RATE_LIMITED__:still limited'); } };
  runner.cooldownForRateLimit = async () => { cooled += 1; };
  runner.checkpoint = async () => {};
  runner.log = () => {};
  assert.equal(await runner.recoverAfterRateLimitCooldown('test'), true);
  assert.equal(cooled, 1);
  assert.equal(recovered, 2);
  assert.equal(runner.state.rateLimitRecoveryPending, false);
});

test('界面监控限流会退出原生成等待并重启当前轮次', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/runner'), 'utf8');
  assert.match(source, /this\.rateLimitRestartRequested = true/);
  assert.match(source, /throw new Error\('__RATE_LIMIT_RESTART__'\)/);
  assert.match(source, /error\.message === '__RATE_LIMIT_RESTART__'/);
  assert.match(source, /recoverAfterRateLimitCooldown\('界面监控限流后重启当前轮次'\)/);
});
