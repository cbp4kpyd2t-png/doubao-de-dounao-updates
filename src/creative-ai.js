const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { compactFactsPrompt } = require('./creative-engine');

const AI_ANALYSIS_FILE = 'AI产品分析.json';
const AI_BANK_FILE = '差异化词库.json';
const AI_SCHEMA_VERSION = 1;
const BEGIN_MARKER = 'DOUNAO_JSON_BEGIN';
const END_MARKER = 'DOUNAO_JSON_END';

const BANK_KEYS = Object.freeze([
  'audiences',
  'painPoints',
  'usageMoments',
  'sellingPoints',
  'scenes',
  'actions',
  'spatialRelations',
  'props',
  'lighting',
  'personTypes',
  'apparel',
  'salesRoles',
  'cameraDirections',
  'productOrientations',
  'elevations',
  'distances',
  'placements',
  'architecturalStyles',
  'colorPalettes',
  'seasons',
  'weather',
  'animals',
]);

const MIN_COUNTS = Object.freeze({
  scenes: 12,
  actions: 12,
  spatialRelations: 8,
  lighting: 10,
  cameraDirections: 10,
  salesRoles: 8,
});

function uniqueStrings(values, max = 40) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!clean) continue;
    const key = clean.toLocaleLowerCase('zh-CN');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
    if (output.length >= max) break;
  }
  return output;
}

function charBigrams(value) {
  const normalized = String(value || '').toLocaleLowerCase('zh-CN').replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】[\]_-]+/g, '');
  const grams = new Set();
  if (normalized.length < 2) {
    if (normalized) grams.add(normalized);
    return grams;
  }
  for (let index = 0; index < normalized.length - 1; index += 1) grams.add(normalized.slice(index, index + 2));
  return grams;
}

function similarity(left, right) {
  const a = charBigrams(left);
  const b = charBigrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const item of a) if (b.has(item)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function localAuditBank(input, threshold = 0.72) {
  const approvedBank = {};
  const rejected = [];
  for (const key of BANK_KEYS) {
    approvedBank[key] = [];
    for (const value of uniqueStrings(input?.[key])) {
      const duplicate = approvedBank[key].find((existing) => similarity(existing, value) >= threshold);
      if (duplicate) {
        rejected.push({ category: key, value, reason: `与“${duplicate}”语义过近`, duplicateOf: duplicate });
      } else {
        approvedBank[key].push(value);
      }
    }
  }
  return { approvedBank, rejected };
}

function parseMarkedJson(text) {
  const source = String(text || '');
  const start = source.lastIndexOf(BEGIN_MARKER);
  const end = start >= 0 ? source.indexOf(END_MARKER, start + BEGIN_MARKER.length) : -1;
  if (start < 0 || end < 0) throw new Error('AI回答缺少豆脑JSON边界标记');
  const body = source
    .slice(start + BEGIN_MARKER.length, end)
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI回答不是JSON对象');
  return parsed;
}

function factsForAi(facts) {
  return { summary: compactFactsPrompt(facts) };
}

function outputRule(schemaDescription) {
  return [
    '只输出一个JSON对象，不要输出解释、Markdown标题或分析过程。',
    `输出必须以独立一行 ${BEGIN_MARKER} 开始，以独立一行 ${END_MARKER} 结束。`,
    schemaDescription,
    '所有内容使用简体中文；不要虚构商品尺寸、结构、材质、数量或功能。',
  ].join('\n');
}

function buildObserverPrompt(facts) {
  return [
    '你是生活观察员和商品策略师，不是图片提示词改写员。',
    '请先观察已上传的全部商品参考图，再结合下面已经安全提取的商品事实，寻找真实且彼此不同的购买动机与使用方式。',
    '不要讨论摄影风格、豪华装修、光线或画质。不要使用“高级感、温馨、简约、精致”等空泛词。',
    '同一类别中的答案必须在实际含义上不同，不能只更换人物性别、房间名称或同义词。',
    JSON.stringify(factsForAi(facts), null, 2),
    outputRule('JSON字段必须为：audiences、painPoints、usageMoments、sellingPoints、actions、spatialRelations。每个字段输出10至18个短语。'),
  ].join('\n\n');
}

function buildDirectorPrompt(facts, observer) {
  return [
    '你是由广告创意总监、空间设计师和摄影指导组成的创意组。',
    '请根据商品事实和生活观察结果建立“原子化视觉词库”，不要直接写5张完整提示词。',
    '目标是让后续50张电商主图在场景、行为、空间关系和摄影语言上明显不同，同时每张都能独立作为商品主图。',
    '允许夸张、豪华、丰富道具、人物和动物，但商品必须完整醒目、比例真实，是第一视觉主体。',
    '禁止把差异仅建立在更换服装、颜色、宠物或房间名称上。场景必须符合商品用途。',
    `商品事实：${JSON.stringify(factsForAi(facts), null, 2)}`,
    `生活观察：${JSON.stringify(observer, null, 2)}`,
    outputRule(`JSON字段必须为：${BANK_KEYS.join('、')}。scenes、actions各至少18项；cameraDirections、lighting、salesRoles各至少12项；其他字段各8至16项。`),
  ].join('\n\n');
}

function buildCriticPrompt(facts, candidateBank) {
  return [
    '你现在不是创意策划者，而是严格、挑剔的电商视觉审稿人。',
    '商品事实不可修改。审查候选词库中的同义改写、常见AI套路、不真实比例、不符合用途、商品可能被弱化，以及只能当氛围图不能当主图的项目。',
    '“豪华厨房中的女性伸手拿取”和“欧式厨房中的女士取出物品”属于同一个创意，必须淘汰一个。',
    '不能只指出问题：每淘汰一个重要项目，必须给出构思路径明显不同的替代项。',
    '替代项至少改变使用情境、人物行为、空间关系、摄影语言、销售作用中的两项，不能只换服装、颜色、动物或道具。',
    `商品事实：${JSON.stringify(factsForAi(facts), null, 2)}`,
    `候选词库：${JSON.stringify(candidateBank, null, 2)}`,
    outputRule(`JSON字段必须为：approvedBank、rejected、replacements。approvedBank必须包含${BANK_KEYS.join('、')}这些数组字段；rejected数组每项包含category、value、reason、duplicateOf；replacements数组每项包含category、value、differenceReason。`),
  ].join('\n\n');
}

function mergeBanks(...banks) {
  const merged = {};
  for (const key of BANK_KEYS) merged[key] = uniqueStrings(banks.flatMap((bank) => bank?.[key] || []));
  return merged;
}

function applyCriticDecision(candidateBank, critic) {
  const replacements = {};
  for (const item of Array.isArray(critic?.replacements) ? critic.replacements : []) {
    if (!BANK_KEYS.includes(item?.category) || !item?.value) continue;
    replacements[item.category] ||= [];
    replacements[item.category].push(item.value);
  }
  const approved = {};
  for (const key of BANK_KEYS) {
    const reviewed = uniqueStrings(critic?.approvedBank?.[key]);
    approved[key] = uniqueStrings([...(reviewed.length ? reviewed : candidateBank?.[key] || []), ...(replacements[key] || [])]);
  }
  return approved;
}

function validateBank(bank) {
  const normalized = mergeBanks(bank);
  const shortages = Object.entries(MIN_COUNTS)
    .filter(([key, minimum]) => normalized[key].length < minimum)
    .map(([key, minimum]) => ({ key, actual: normalized[key].length, minimum }));
  return { bank: normalized, shortages };
}

async function atomicWriteJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureAiCreativeBank({ browser, product, facts, configDir, fingerprint, force = false, diversityStrength = 'balanced', log = () => {} }) {
  const analysisFile = path.join(configDir, AI_ANALYSIS_FILE);
  const bankFile = path.join(configDir, AI_BANK_FILE);
  const existing = await readJson(bankFile);
  if (!force && existing?.schemaVersion === AI_SCHEMA_VERSION && existing.sourceFingerprint === fingerprint && existing.diversityStrength === diversityStrength && existing.approvedBank && ['approved', 'usable-with-local-fallback'].includes(existing.status)) {
    const checked = validateBank(existing.approvedBank);
    return { ...existing, approvedBank: checked.bank, reused: true };
  }
  if (!browser?.connected || typeof browser.requestStructuredText !== 'function') throw new Error('当前Edge尚未连接，无法运行AI差异化分析');

  const previousAnalysis = !force ? await readJson(analysisFile) : null;
  const canResume = previousAnalysis?.schemaVersion === AI_SCHEMA_VERSION
    && previousAnalysis.sourceFingerprint === fingerprint
    && previousAnalysis.diversityStrength === diversityStrength;
  let observer = canResume ? previousAnalysis.observer || null : null;
  let director = canResume ? previousAnalysis.director || null : null;
  let critic = null;
  const threshold = diversityStrength === 'bold' ? 0.62 : diversityStrength === 'conservative' ? 0.82 : 0.72;

  async function saveStage(stage, sourceBank, error = null) {
    const localReview = localAuditBank(sourceBank, threshold);
    const checked = validateBank(localReview.approvedBank);
    const analysis = {
      schemaVersion: AI_SCHEMA_VERSION,
      sourceFingerprint: fingerprint,
      diversityStrength,
      generatedAt: new Date().toISOString(),
      completedStage: stage,
      observer,
      director,
      critic: critic ? {
        rejected: Array.isArray(critic.rejected) ? critic.rejected.slice(0, 100) : [],
        replacements: Array.isArray(critic.replacements) ? critic.replacements.slice(0, 100) : [],
      } : null,
      lastError: error ? String(error.message || error) : null,
    };
    const finalStage = stage === 'critic';
    const result = {
      schemaVersion: AI_SCHEMA_VERSION,
      sourceFingerprint: fingerprint,
      generatedAt: new Date().toISOString(),
      status: finalStage ? (checked.shortages.length ? 'usable-with-local-fallback' : 'approved') : `partial-${stage}`,
      completedStage: stage,
      diversityStrength,
      approvedBank: checked.bank,
      aiRejected: analysis.critic?.rejected || [],
      localRejected: localReview.rejected,
      shortages: checked.shortages,
      lastError: analysis.lastError,
    };
    await atomicWriteJson(analysisFile, analysis);
    await atomicWriteJson(bankFile, result);
    return result;
  }

  let stageResult = existing?.approvedBank ? { ...existing, reused: true } : null;
  if (!observer) {
    log(`AI差异化分析：${product.name}，第1/3步生活观察`);
    const observerRaw = await browser.requestStructuredText(buildObserverPrompt(facts), { images: product.images, timeoutSeconds: 180 });
    observer = parseMarkedJson(observerRaw);
    stageResult = await saveStage('observer', observer);
    log(`AI生活观察已立即保存：${product.name}`);
  } else log(`AI差异化分析从已保存的生活观察继续：${product.name}`);

  if (!director) {
    try {
      log(`AI差异化分析：${product.name}，第2/3步视觉词库`);
      const directorRaw = await browser.requestStructuredText(buildDirectorPrompt(facts, observer), { timeoutSeconds: 180 });
      director = parseMarkedJson(directorRaw);
      stageResult = await saveStage('director', mergeBanks(observer, director));
      log(`AI候选差异化词库已立即保存：${product.name}`);
    } catch (error) {
      stageResult = await saveStage('observer', observer, error);
      log(`AI视觉词库暂未完成，已保留生活观察并继续图片任务：${error.message}`);
      return { ...stageResult, reused: false, partial: true };
    }
  } else log(`AI差异化分析从已保存的候选词库继续：${product.name}`);
  const candidateBank = mergeBanks(observer, director);

  try {
    log(`AI差异化分析：${product.name}，第3/3步挑剔审稿`);
    const criticRaw = await browser.requestStructuredText(buildCriticPrompt(facts, candidateBank), { timeoutSeconds: 180 });
    critic = parseMarkedJson(criticRaw);
  } catch (error) {
    stageResult = await saveStage('director', candidateBank, error);
    log(`AI挑剔审稿暂未完成，已使用并保留候选词库：${error.message}`);
    return { ...stageResult, reused: false, partial: true };
  }
  const result = await saveStage('critic', applyCriticDecision(candidateBank, critic));
  return { ...result, reused: false };
}

module.exports = {
  AI_ANALYSIS_FILE,
  AI_BANK_FILE,
  AI_SCHEMA_VERSION,
  BANK_KEYS,
  BEGIN_MARKER,
  END_MARKER,
  similarity,
  localAuditBank,
  parseMarkedJson,
  buildObserverPrompt,
  buildDirectorPrompt,
  buildCriticPrompt,
  mergeBanks,
  applyCriticDecision,
  validateBank,
  ensureAiCreativeBank,
};
