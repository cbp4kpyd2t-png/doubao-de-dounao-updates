const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const { clipboard } = require('electron');
const { validateImage, extensionFor } = require('./core');

const packagedHelper = path.join(__dirname, 'native-edge.ps1');
const HELPER = packagedHelper.includes('app.asar') ? packagedHelper.replace('app.asar', 'app.asar.unpacked') : packagedHelper;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let boundEdgeWindowHandle = null;

function updateBoundEdgeWindow(result) { if (Number.isFinite(Number(result?.windowHandle)) && Number(result.windowHandle) > 0) boundEdgeWindowHandle = Number(result.windowHandle); }
function clearBoundEdgeWindow() { boundEdgeWindowHandle = null; }

function runNative(action, payload = {}, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const scopedPayload = boundEdgeWindowHandle && payload.edgeWindowHandle === undefined ? { ...payload, edgeWindowHandle: boundEdgeWindowHandle } : payload;
    const encoded = Buffer.from(JSON.stringify(scopedPayload), 'utf8').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Action', action, '-PayloadBase64', encoded], { windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`操作超时：${action}`)); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((stderr || stdout || `原生操作失败：${action}`).trim()));
      try { const result = JSON.parse(stdout.trim() || '{}'); updateBoundEdgeWindow(result); resolve(result); } catch { reject(new Error(`无法解析原生操作结果：${stdout}`)); }
    });
  });
}

class ChatGPTAutomation {
  constructor({ downloadDir, log }) { this.downloadDir = downloadDir; this.log = log; this.connected = false; }
  async launch() {
    let result = await runNative('inspect');
    if (!result.found) throw new Error('未找到已打开且标题包含 ChatGPT 的 Microsoft Edge 窗口。请先用当前 Edge 打开 https://chatgpt.com/');
    if (!result.hasComposer) { await runNative('enable-accessibility', {}, 60000); result = await runNative('inspect'); }
    this.connected = true; this.windowTitle = result.title; this.log(`已连接当前 Edge：${result.title}`);
  }
  async close() { this.connected = false; clearBoundEdgeWindow(); }
  async isLoggedIn() { const result = await runNative('inspect'); return result.found && result.hasComposer && !result.hasLogin; }
  async assertSafePage() {
    const state = await runNative('inspect');
    if (!state.found) throw new Error('当前 Edge 中未找到 ChatGPT 页面');
    if (state.hasRateLimit) throw new Error('__RATE_LIMITED__:ChatGPT提示请求过于频繁');
    if (state.hasSecurity) throw new Error('检测到验证码或安全检查，请手动处理后继续');
    if (state.hasLogin) throw new Error('ChatGPT页面明确显示登录入口，账号可能已退出登录，需要正常人工处理');
    if (!state.hasComposer) throw new Error('__CHATGPT_PAGE_NOT_READY__:ChatGPT输入框尚未加载，按页面故障自动恢复');
  }
  async inspectWatchState() {
    const state = await runNative('inspect');
    return { found: state.found, title: state.title, hasComposer: state.hasComposer, hasSecurity: state.hasSecurity, hasRateLimit: !!state.hasRateLimit, hasStop: state.hasStop, downloadCount: state.downloadCount || 0, generatedCount: state.generatedCount || 0, attachmentCount: state.attachmentCount || 0, submitEnabled: !!state.submitEnabled };
  }
  async getCurrentChatUrl() { const result = await runNative('get-current-chat-url'); return result.isChat ? result.url : null; }
  async waitForStableCurrentChatUrl(timeoutMs = 30000) {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    let previous = null; let stableSamples = 0;
    while (Date.now() < deadline) {
      const current = await this.getCurrentChatUrl().catch(() => null);
      if (current && current === previous) stableSamples += 1;
      else { previous = current; stableSamples = current ? 1 : 0; }
      if (current && stableSamples >= 2) return current;
      await sleep(1000);
    }
    return null;
  }
  async openChatUrl(url, { refreshAfterOpen = false } = {}) {
    let initialError = null;
    try { await runNative('open-chat-url', { url }, 60000); }
    catch (error) { initialError = error; this.log(`记录对话首次加载未进入页面，将立即刷新一次：${error.message}`); }
    if (refreshAfterOpen || initialError) {
      if (!initialError) this.log('记录对话首次加载完成，按回收规则再刷新一次以避免白屏');
      await runNative('refresh-page', {}, 60000);
    }
    await this.assertSafePage();
  }
  async refreshPage() { await runNative('refresh-page', {}, 60000); await this.assertSafePage(); }
  async recoverToFreshChatPage() {
    await runNative('recover-save-ui', { chatUrl: null }, 90000);
    this.connected = true;
    await this.assertSafePage();
  }
  async restartEdgeAndOpenChatGPT() {
    const restarted = await runNative('restart-edge-chatgpt', {}, 90000);
    this.connected = true;
    let state = await runNative('inspect');
    if (!state.hasComposer && !state.hasLogin && !state.hasSecurity) {
      await runNative('enable-accessibility', {}, 60000);
      state = await runNative('inspect');
    }
    if (!state.found) throw new Error('重启后未找到Microsoft Edge窗口');
    if (state.hasRateLimit) throw new Error('__RATE_LIMITED__:Edge重启后ChatGPT仍提示请求过于频繁');
    if (state.hasSecurity) throw new Error('Edge重启后检测到安全检查，需要正常人工处理');
    if (state.hasLogin) throw new Error('Edge重启后页面明确显示登录入口，需要正常人工处理');
    if (!state.hasComposer) throw new Error('__CHATGPT_PAGE_NOT_READY__:Edge重启后ChatGPT输入框尚未加载');
    return { ...restarted, ready: true };
  }
  async getViewerImageCount(options = {}) { return runNative('viewer-image-count', options, 95000); }
  async newChat() {
    await this.assertSafePage(); const fresh = await runNative('new-chat', {}, 60000); await sleep(250); await this.assertSafePage();
    if (!fresh.ok || fresh.attachmentCount !== 0) throw new Error('新对话验证失败：页面仍包含旧附件，已停止本轮上传');
  }
  async uploadReferences(files, shouldAbort = () => false, options = {}) {
    const maxRefreshCycles = Math.max(0, Math.min(5, Number(options.maxRefreshCycles ?? 2)));
    const deadlineAt = Number(options.deadlineAt) || (Date.now() + 240000);
    const checkAbort = () => {
      const reason = shouldAbort();
      if (reason) throw new Error(reason === true ? '__WORKFLOW_RECOVERY__' : String(reason));
      if (Date.now() >= deadlineAt) throw new Error('__WORKFLOW_RECOVERY__:上传步骤超时');
    };
    let refreshCycle = 0;
    while (this.connected) {
      checkAbort();
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        checkAbort();
        try {
          const result = await runNative('upload', { files }, 90000);
          checkAbort();
          if ((result.attachmentCount || 0) < files.length) throw new Error(`应上传 ${files.length} 张，实际识别 ${result.attachmentCount || 0} 张`);
          this.expectedAttachments = files.length; await sleep(250); return;
        } catch (error) {
          lastError = error; this.log(`参考图上传未完整（第 ${attempt}/3 次）：${error.message}`);
          const cleared = await runNative('clear-attachments', {}, 45000).catch(() => ({ ok: false }));
          if (!cleared.ok) { this.log('无法清除不完整附件，将通过刷新页面恢复'); break; }
          if (attempt < 3) { this.log('已删除全部附件，正在重新上传所有参考图'); await sleep(350); }
        }
      }
      refreshCycle += 1;
      if (refreshCycle > maxRefreshCycles) throw new Error(`__UPLOAD_RETRY_EXHAUSTED__:参考图连续上传失败：${lastError?.message || '附件状态异常'}`);
      this.log(`参考图连续上传失败，正在刷新页面并打开新对话后继续上传（刷新第${refreshCycle}次）：${lastError?.message || '附件状态异常'}`);
      checkAbort();
      await this.refreshPage();
      await this.newChat();
      await sleep(500);
    }
    throw new Error('__WORKFLOW_RECOVERY__:浏览器连接已中断');
  }
  async sendPrompt(text, generationTimeoutSeconds = 60) {
    if (this.expectedAttachments > 0) {
      const verified = await runNative('verify-attachments', { expected: this.expectedAttachments }, 90000);
      if (!verified.ok) throw new Error(`发送前附件校验失败：应有 ${this.expectedAttachments} 张，实际 ${verified.attachmentCount || 0} 张`);
    }
    const timeoutSeconds = Math.max(10, Math.min(600, Math.trunc(Number(generationTimeoutSeconds) || 60)));
    const before = await runNative('inspect'); this.downloadBaseline = before.downloadCount || 0; this.generatedBaseline = before.generatedCount || 0; clipboard.writeText(text); const sent = await runNative('send'); if ((sent.attempts || 1) > 1) this.log(`发送按钮首次点击未生效，第${sent.attempts}次重试后已确认提交`); this.expectedAttachments = 0; this.generationDeadline = Date.now() + timeoutSeconds * 1000; this.generationTimeoutSeconds = timeoutSeconds;
  }
  async waitForGeneration(shouldPause = () => false) {
    let sawStop = false; let generationEnded = false; let imagesStable = 0; let lastViewerProbe = 0; this.generationDeadline ||= Date.now() + (this.generationTimeoutSeconds || 60) * 1000;
    while (Date.now() < this.generationDeadline) {
      if (shouldPause()) { this.generationDeadline += 500; await sleep(500); continue; }
      const state = await runNative('inspect');
      if (state.hasRateLimit) throw new Error('__RATE_LIMITED__:ChatGPT提示请求过于频繁');
      if (state.hasSecurity) throw new Error('检测到验证码或安全检查，请手动处理后继续');
      if (state.hasStop) sawStop = true;
      if (sawStop && !state.hasStop) generationEnded = true;
      if (!state.hasStop && state.downloadCount > (this.downloadBaseline || 0)) generationEnded = true;
      const hasNewImages = (state.generatedCount || 0) > (this.generatedBaseline || 0);
      if (!state.hasStop && hasNewImages) imagesStable += 1;
      else imagesStable = 0;
      // 第一张先渲染出来只表示有进展，不能代表本轮五张已经完成。
      if (!state.hasStop && Date.now() - lastViewerProbe >= (generationEnded || imagesStable >= 2 ? 6000 : 12000)) {
        lastViewerProbe = Date.now();
        const viewer = await runNative('viewer-image-count', { findWaitSeconds: 2, maxWaitSeconds: 4, targetTotal: 5 }, 12000).catch(() => ({ found: false }));
        if (viewer.found && viewer.five) { this.log('查看器已确认5张图片生成完成，立即进入保存流程'); this.generationDeadline = null; return { status: 'complete', viewer }; }
      }
      await sleep(3000);
    }
    const finalViewer = await runNative('viewer-image-count', { findWaitSeconds: 3, maxWaitSeconds: 5, targetTotal: 5 }, 18000).catch(() => ({ found: false }));
    this.generationDeadline = null;
    if (finalViewer.found && finalViewer.five) return { status: 'complete', viewer: finalViewer };
    if (finalViewer.found && (finalViewer.total || 0) > 0) {
      this.log(`等待时间结束时仅确认${finalViewer.total || 1}/5张，将暂存并延后回查，不计入本轮`);
      return { status: 'partial', viewer: finalViewer };
    }
    throw new Error('__GENERATION_TIMEOUT__');
  }
  async downloadNewImages(targetDir, fileStem, startNumber, needed, knownHashes, processedIndexes = []) {
    await fsp.mkdir(targetDir, { recursive: true });
    const chatUrlBeforeSave = await this.getCurrentChatUrl().catch(() => null);
    const usedNumbers = new Set();
    for (const entry of await fsp.readdir(targetDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(`${fileStem}_`)) continue;
      const numberText = entry.name.slice(fileStem.length + 1).split('.')[0];
      if (/^\d{3}$/.test(numberText)) usedNumbers.add(Number(numberText));
    }
    let availableStartNumber = 1;
    while (usedNumbers.has(availableStartNumber)) availableStartNumber += 1;
    const filesBeforeSave = new Set((await fsp.readdir(targetDir, { withFileTypes: true })).filter((item) => item.isFile()).map((item) => item.name));
    let result;
    try { result = await runNative('save-viewer-images', { targetDir, fileStem, startNumber: availableStartNumber, needed, processedIndexes }, Math.max(120000, (needed + 1) * 45000)); }
    catch (error) {
      let recoveryError = null;
      try { await runNative('recover-save-ui', { chatUrl: chatUrlBeforeSave }, 90000); await this.assertSafePage(); }
      catch (failed) { recoveryError = failed; }
      const failedFiles = (await fsp.readdir(targetDir, { withFileTypes: true }).catch(() => [])).filter((item) => item.isFile() && !filesBeforeSave.has(item.name) && item.name.startsWith(`${fileStem}_`));
      for (const item of failedFiles) await fsp.unlink(path.join(targetDir, item.name)).catch(() => {});
      if (recoveryError) throw new Error(`__SAVE_RECOVERY_FAILED__:保存失败且未能恢复ChatGPT页面：${recoveryError.message}; 原因：${error.message}`);
      this.log(`图片保存失败后已关闭保存界面、清理${failedFiles.length}个未计数文件，并恢复到原ChatGPT对话`);
      throw new Error(`__SAVE_FAILED_RECOVERED__:${error.message}`);
    }
    if (Number.isInteger(result.selectedThumbnailIndex) && result.selectedThumbnailIndex >= 0) this.log(`已跳过与当前大图对应的第${result.selectedThumbnailIndex + 1}个缩略图${result.selectedThumbnailAssumed ? '（按当前查看器布局识别）' : ''}`);
    const saved = [];
    for (const item of result.saved || []) {
      try {
        const info = await validateImage(item.file, knownHashes);
        const expectedExt = extensionFor(info.format);
        if (saved.length >= needed) { await fsp.unlink(item.file).catch(() => {}); continue; }
        let finalNumber = 1; while (usedNumbers.has(finalNumber)) finalNumber += 1;
        const finalPath = path.join(path.dirname(item.file), `${fileStem}_${String(finalNumber).padStart(3, '0')}${expectedExt}`);
        if (path.resolve(item.file) !== path.resolve(finalPath)) { await fsp.unlink(finalPath).catch(() => {}); await fsp.rename(item.file, finalPath); }
        usedNumbers.add(finalNumber);
        knownHashes.add(info.hash); saved.push({ file: finalPath, thumbnailIndex: item.index, viewerTotal: result.total, ...info });
      } catch (error) {
        if (/内容重复/.test(error.message)) { await fsp.unlink(item.file).catch(() => {}); this.log(`跳过查看器中的重复候选图片：${error.message}`); }
        else { await fsp.unlink(item.file).catch(() => {}); throw new Error(`已保存图片校验失败，损坏文件已删除并禁止误发补图请求：${error.message}`); }
      }
    }
    return saved;
  }
}

module.exports = { ChatGPTAutomation, runNative, updateBoundEdgeWindow, clearBoundEdgeWindow };
