const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const TAGGED_VOCABULARY_FILE = '极简词库.txt';
const TAGGED_VOCABULARY_TEMPLATE_FILE = '极简词库模板.txt';

const KEY_ALIASES = new Map([
  ['锁', 'locks'],
  ['人物锁', 'personLocks'],
  ['固定词', 'fixedWords'],
  ['必带词', 'fixedWords'],
  ['动机', 'motivations'],
  ['受众', 'audiences'],
  ['场景', 'scenes'],
  ['动作', 'actions'],
  ['关系', 'relations'],
  ['空间关系', 'relations'],
  ['机位', 'cameras'],
  ['摄影机位', 'cameras'],
  ['销售', 'sales'],
  ['销售作用', 'sales'],
  ['禁配', 'blocks'],
  ['禁错', 'blocks'],
  ['禁错规则', 'blocks'],
]);

const REQUIRED_POOLS = [
  ['锁', 'locks'],
  ['人物锁', 'personLocks'],
  ['场景', 'scenes'],
  ['动作', 'actions'],
  ['关系', 'relations'],
  ['机位', 'cameras'],
  ['销售', 'sales'],
  ['禁配', 'blocks'],
];

const TEMPLATE = `# 将本文件复制为“极简词库.txt”后生效。可重复写同一字段，软件会自动合并。
# 用“｜”分词；场景、动作、关系、机位用相同[tag]联动，不能完全独立乱配。
锁=商品颜色｜商品结构｜商品数量
人物锁=清晰正脸｜人物大比例｜不遮挡商品｜五张必须使用不同人物、不同人种、不同人脸、不同服装
固定词=每轮必须原样带入的完整短语
动机=核心购买动机
受众=真实购买者
场景12=[用]真实使用场景｜[装]真实安装场景
动作12=[用]真实使用动作｜[装]真实安装动作
关系=[用]人与商品空间关系｜[装]安装时空间关系
机位=[用]正脸中近景｜[装]侧前方近景
销售=用途直观｜结构清楚
禁配=不可出现的错误｜不可虚构的结构
`;

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function splitValues(value) {
  return unique(String(value || '').split(/[｜|]/u));
}

function normalizeKey(value) {
  return String(value || '').trim().replace(/\d+$/u, '');
}

function taggedItem(value, lineNumber) {
  const match = String(value || '').trim().match(/^\[([^\]]+)\](.+)$/u);
  if (!match) return { tag: '通', text: String(value || '').trim(), lineNumber };
  return { tag: match[1].trim(), text: match[2].trim(), lineNumber };
}

function parseTaggedVocabulary(source, sourceFile = TAGGED_VOCABULARY_FILE) {
  const pools = { locks: [], personLocks: [], fixedWords: [], motivations: [], audiences: [], scenes: [], actions: [], relations: [], cameras: [], sales: [], blocks: [] };
  let title = '';
  const errors = [];
  const lines = String(source || '').replace(/^\uFEFF/u, '').split(/\r?\n/u);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const separator = line.indexOf('=');
    if (separator < 1) {
      if (!title) title = line;
      else errors.push(`第${index + 1}行缺少“=”：${line}`);
      return;
    }
    const rawKey = normalizeKey(line.slice(0, separator));
    const key = KEY_ALIASES.get(rawKey);
    if (!key) {
      errors.push(`第${index + 1}行字段“${rawKey}”不受支持`);
      return;
    }
    const values = splitValues(line.slice(separator + 1));
    if (!values.length) {
      errors.push(`第${index + 1}行“${rawKey}”没有词条`);
      return;
    }
    if (['scenes', 'actions', 'relations', 'cameras'].includes(key)) pools[key].push(...values.map((value) => taggedItem(value, index + 1)));
    else pools[key].push(...values);
  });

  for (const [label, key] of REQUIRED_POOLS) if (!pools[key].length) errors.push(`缺少必填字段“${label}”`);
  for (const key of ['scenes', 'actions']) {
    for (const item of pools[key]) if (!item.text) errors.push(`第${item.lineNumber}行存在空的带标签词条`);
  }

  const sceneTags = new Set(pools.scenes.filter((item) => item.tag !== '通').map((item) => item.tag));
  const actionTags = new Set(pools.actions.filter((item) => item.tag !== '通').map((item) => item.tag));
  const linkedTags = [...sceneTags].filter((tag) => actionTags.has(tag));
  if (!linkedTags.length && pools.scenes.length && pools.actions.length) errors.push('场景和动作没有共同[tag]，无法安全联动组合');
  for (const tag of sceneTags) if (!actionTags.has(tag)) errors.push(`标签[${tag}]有场景但没有动作`);
  for (const tag of actionTags) if (!sceneTags.has(tag)) errors.push(`标签[${tag}]有动作但没有场景`);

  if (errors.length) throw new Error(`极简词库格式错误（${path.basename(sourceFile)}）：${errors.join('；')}`);
  for (const key of ['locks', 'personLocks', 'fixedWords', 'motivations', 'audiences', 'sales', 'blocks']) pools[key] = unique(pools[key]);
  const directConflicts = pools.fixedWords.filter((word) => pools.blocks.includes(word));
  if (directConflicts.length) throw new Error(`极简词库固定词与禁配冲突（${path.basename(sourceFile)}）：${directConflicts.join('、')}`);
  for (const key of ['scenes', 'actions', 'relations', 'cameras']) {
    const seen = new Set();
    pools[key] = pools[key].filter((item) => {
      const signature = `${item.tag}\u0000${item.text}`;
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
  }
  return {
    schemaVersion: 1,
    sourceFile,
    sourceFingerprint: crypto.createHash('sha256').update(String(source || '')).digest('hex'),
    title,
    linkedTags,
    ...pools,
  };
}

async function loadTaggedVocabulary(configDir) {
  const file = path.join(configDir, TAGGED_VOCABULARY_FILE);
  try {
    const source = await fsp.readFile(file, 'utf8');
    return parseTaggedVocabulary(source, file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureTaggedVocabularyTemplate(configDir) {
  const file = path.join(configDir, TAGGED_VOCABULARY_TEMPLATE_FILE);
  try {
    await fsp.access(file);
  } catch {
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(file, TEMPLATE, 'utf8');
  }
  return file;
}

function untag(items) {
  return unique((items || []).map((item) => item.text));
}

function toCreativeBank(vocabulary) {
  if (!vocabulary) return null;
  return {
    scenes: untag(vocabulary.scenes),
    actions: untag(vocabulary.actions),
    spatialRelations: untag(vocabulary.relations),
    cameraDirections: untag(vocabulary.cameras),
    salesRoles: vocabulary.sales,
    audiences: vocabulary.audiences,
    fixedWords: vocabulary.fixedWords,
    taggedVocabulary: vocabulary,
  };
}

module.exports = {
  TAGGED_VOCABULARY_FILE,
  TAGGED_VOCABULARY_TEMPLATE_FILE,
  TEMPLATE,
  parseTaggedVocabulary,
  loadTaggedVocabulary,
  ensureTaggedVocabularyTemplate,
  toCreativeBank,
};
