const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  CONFIG_DIR_NAME,
  FIXED_FIVE_IMAGE_PROMPT,
  COMPACT_FACTS_MAX_LENGTH,
  FINAL_PROMPT_MAX_LENGTH,
  compactFactsPrompt,
  buildCreativePlan,
  buildRoundPrompt,
  prepareProductCreativeFiles,
} = require('../src/creative-engine');

test('商品事实压缩为90字以内并优先保留关键尺寸和禁错信息', () => {
  const summary = compactFactsPrompt({
    productName: '测试双层置物架',
    quantity: 2,
    customRequirements: '实际尺寸37×25×33厘米，黑色金属双层结构，下层可以向前抽拉，支撑脚必须贴合台面',
    requiredElements: ['必须保留下层抽拉篮和四个支撑脚', '不得悬空或生成落地柜'],
    appearanceFacts: ['黑色金属材质', '双层网格篮结构', '人物比例必须符合实际尺寸'],
  });
  assert.ok(summary.length >= 80);
  assert.ok(summary.length <= COMPACT_FACTS_MAX_LENGTH);
  assert.match(summary, /测试双层置物架/);
  assert.match(summary, /唯一身份锚点/);
  assert.match(summary, /37×25×33厘米/);
  assert.match(summary, /禁改/);
  assert.match(summary, /主体完整突出/);
});

async function fixture(name = 'L043叠衣板主图', text = '这是叠衣板，15个一组。另一处写30个一组。严格以已上传的置物架参考图为准。') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dou-nao-creative-'));
  const txt = path.join(dir, '提示词.txt');
  const image = path.join(dir, '1.png');
  await fsp.writeFile(txt, text, 'utf8');
  await fsp.writeFile(image, Buffer.from('reference-image'));
  return { dir, txt, image, product: { id: name, name, dir, txts: [txt], images: [image], prompt: text, valid: true } };
}

function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

test('safe extraction preserves the original TXT and writes managed files', async () => {
  const item = await fixture();
  const before = sha(item.txt);
  const bundle = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  assert.equal(sha(item.txt), before);
  assert.equal(bundle.facts.quantity, null);
  assert.equal(bundle.facts.pendingConfirmation[0].field, 'quantity');
  assert.deepEqual(bundle.facts.pendingConfirmation[0].candidates, [15, 30]);
  assert.ok(bundle.facts.ignoredTemplateErrors.some((value) => value.includes('置物架')));
  for (const name of ['商品事实.json', '提取报告.txt', '来源指纹.json', '创意计划.json']) {
    assert.equal(fs.existsSync(path.join(item.dir, CONFIG_DIR_NAME, name)), true);
  }
});

test('creative plan contains 50 unique composite angles and exactly five tasks per round', async () => {
  const item = await fixture('橱柜厨房岛台置物架主图', '黑色双层置物架，用于厨房岛台收纳。');
  const { facts } = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const plan = buildCreativePlan(facts, { cycle: 1 });
  assert.equal(plan.tasks.length, 50);
  assert.equal(new Set(plan.tasks.map((task) => JSON.stringify(task.angle))).size, 50);
  assert.equal(plan.peopleTaskCount, 50);
  for (let round = 1; round <= 10; round += 1) assert.equal(plan.tasks.filter((task) => task.round === round).length, 5);
  assert.ok(plan.tasks.every((task) => task.mainImageRule.includes('Temu')));
});

test('approved AI vocabulary changes scene, action and camera dimensions without changing the fixed five-image rule', async () => {
  const item = await fixture('橱柜厨房岛台置物架主图', '黑色双层置物架，用于厨房岛台收纳。');
  const { facts } = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const creativeBank = {
    scenes: ['雨后玻璃温室备餐区', '游艇甲板早餐服务区'],
    actions: ['双手移动商品到工作台', '从下层取出餐盘'],
    cameraDirections: ['贴近台面的左后侧机位', '人物肩后越肩机位'],
    salesRoles: ['展示移动效率', '展示上下层分类'],
    spatialRelations: ['商品与人物处于同一景深'],
    architecturalStyles: ['欧式庄园玻璃温室'],
  };
  const plan = buildCreativePlan(facts, { cycle: 1, creativeBank });
  assert.equal(plan.aiVocabularyUsed, true);
  assert.ok(plan.tasks.some((task) => task.scene.includes('雨后玻璃温室备餐区')));
  assert.ok(plan.tasks.some((task) => task.action === '双手移动商品到工作台'));
  assert.ok(plan.tasks.some((task) => task.angle.cameraDirection === '人物肩后越肩机位'));
  const prompt = buildRoundPrompt(facts, plan, 1);
  assert.ok(prompt.includes(FIXED_FIVE_IMAGE_PROMPT));
  assert.ok(new Set(plan.tasks.slice(0, 5).map((task) => task.scene)).size >= 2);
  assert.ok(new Set(plan.tasks.slice(0, 5).map((task) => task.action)).size >= 2);
});

test('round prompt uses cleaned facts, five distinct tasks, and mandatory five-image wording', async () => {
  const item = await fixture('橱柜厨房岛台置物架主图', '黑色双层置物架，用于厨房岛台收纳。');
  const { facts, plan } = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const prompt = buildRoundPrompt(facts, plan, 3, '整体采用暖金色调');
  assert.match(prompt, /图片1/);
  assert.match(prompt, /图片5/);
  assert.match(prompt, /第3轮/);
  assert.match(prompt, /整体采用暖金色调/);
  assert.match(prompt, /依次生成5张独立1:1主图/);
  assert.match(prompt, /禁止拼图、网格和多视角合集/);
  assert.ok(prompt.includes(FIXED_FIVE_IMAGE_PROMPT));
  assert.equal((prompt.match(/图片\d：/g) || []).length, 5);
  assert.doesNotMatch(prompt, /季节与天气|可选动物元素|色彩关系|光线与道具|销售作用/);
  assert.ok(prompt.length <= FINAL_PROMPT_MAX_LENGTH);
});

test('round prompt locks five outputs to five positions from one contact sheet', async () => {
  const item = await fixture('L063健身板主图', '粉色健身板。');
  const { facts, plan } = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const prompt = buildRoundPrompt(facts, plan, 1, '', {
    selectedRootContactSheet: '粉色_六角度合成参考图.png',
    selectedColorLabel: '粉色',
    lockedAnglePositions: ['左上', '上中', '右上', '左下', '下中'],
  });
  assert.match(prompt, /角度锁定：仅用“粉色”/);
  assert.match(prompt, /图片1-5依次采用左上、上中、右上、左下、下中/);
  assert.match(prompt, /禁止融合\/镜像\/拼接/);
});

test('unchanged sources are reused; changed sources archive the previous managed version', async () => {
  const item = await fixture('收纳盒主图', '一个便携收纳盒。');
  const first = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const second = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(second.sourceChanged, false);
  await fsp.appendFile(item.txt, '\n补充：带提手。', 'utf8');
  const third = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  assert.equal(third.sourceChanged, true);
  assert.notEqual(third.fingerprint, first.fingerprint);
  const history = path.join(item.dir, CONFIG_DIR_NAME, '历史版本');
  assert.ok((await fsp.readdir(history)).length >= 1);
});

test('cached generic product name is rebuilt from the actual folder name', async () => {
  const item = await fixture('L063健身板主图', '粉色健身板，完全展开约105×40厘米。');
  const first = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const factsFile = path.join(first.configDir, '商品事实.json');
  const stale = JSON.parse(await fsp.readFile(factsFile, 'utf8'));
  stale.productName = '商品';
  await fsp.writeFile(factsFile, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');
  const rebuilt = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  assert.equal(rebuilt.sourceChanged, true);
  assert.equal(rebuilt.facts.productName, '健身板');
  assert.match(buildRoundPrompt(rebuilt.facts, rebuilt.plan, 1), /商品：健身板/);
});
