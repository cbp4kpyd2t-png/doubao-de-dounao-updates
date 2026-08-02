const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { parseTaggedVocabulary, loadTaggedVocabulary, TAGGED_VOCABULARY_FILE, TEMPLATE } = require('../src/tagged-vocabulary');

const SAMPLE = `L999 测试商品
锁=黑色｜双层
人物锁=清晰正脸｜大比例
固定词=双层结构｜正面抽拉
动机=快速收纳
受众=家庭用户
场景12=[用]厨房台面｜[装]橱柜内部
场景=[护]清洁区
动作12=[用]拿取餐盘｜[装]推入层架｜[护]擦拭边框
关系=[用]人物在商品侧面｜[装]双手靠近层架｜[护]手指贴近边框
机位=[用]正脸中近景｜[装]侧前方近景｜[护]俯拍近景
销售=拿取方便｜结构清楚
禁配=虚构第三层｜人物背脸
`;

test('极简词库支持带标签联动、重复字段追加和数字字段名', () => {
  const bank = parseTaggedVocabulary(SAMPLE);
  assert.deepEqual(bank.linkedTags, ['用', '装', '护']);
  assert.equal(bank.scenes.length, 3);
  assert.equal(bank.actions.length, 3);
  assert.equal(bank.locks[0], '黑色');
  assert.deepEqual(bank.fixedWords, ['双层结构', '正面抽拉']);
  assert.ok(bank.sourceFingerprint.length === 64);
});

test('新词库模板强制五张更换人物、人种、人脸和服装', () => {
  assert.match(TEMPLATE, /五张必须使用不同人物、不同人种、不同人脸、不同服装/);
});

test('场景和动作标签不对称时给出明确错误', () => {
  assert.throws(() => parseTaggedVocabulary(SAMPLE.replace('[护]擦拭边框', '[果]擦拭边框')), /标签\[护\]有场景但没有动作/);
});

test('配置目录不存在极简词库时保持向后兼容', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tagged-vocabulary-'));
  assert.equal(await loadTaggedVocabulary(dir), null);
  await fsp.writeFile(path.join(dir, TAGGED_VOCABULARY_FILE), SAMPLE, 'utf8');
  assert.equal((await loadTaggedVocabulary(dir)).title, 'L999 测试商品');
});

test('固定词与禁配完全相同时拒绝加载', () => {
  assert.throws(() => parseTaggedVocabulary(SAMPLE.replace('固定词=双层结构｜正面抽拉', '固定词=虚构第三层')), /固定词与禁配冲突/);
});
