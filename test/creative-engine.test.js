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
  buildCreativePlan,
  buildRoundPrompt,
  prepareProductCreativeFiles,
} = require('../src/creative-engine');

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
  assert.equal(plan.peopleTaskCount, 45);
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
  assert.match(prompt, /空间关系/);
});

test('round prompt uses cleaned facts, five distinct tasks, and mandatory five-image wording', async () => {
  const item = await fixture('橱柜厨房岛台置物架主图', '黑色双层置物架，用于厨房岛台收纳。');
  const { facts, plan } = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const prompt = buildRoundPrompt(facts, plan, 3, '整体采用暖金色调');
  assert.match(prompt, /图片1/);
  assert.match(prompt, /图片5/);
  assert.match(prompt, /第3轮/);
  assert.match(prompt, /整体采用暖金色调/);
  assert.match(prompt, /必须真正生成5张图片/);
  assert.match(prompt, /不是一张包含5个方案的图片/);
  assert.ok(prompt.includes(FIXED_FIVE_IMAGE_PROMPT));
  assert.equal((prompt.match(/角度编号A/g) || []).length, 5);
});

test('round prompt locks five outputs to five positions from one contact sheet', async () => {
  const item = await fixture('L063健身板主图', '粉色健身板。');
  const { facts, plan } = await prepareProductCreativeFiles(item.product, { cycle: 1 });
  const prompt = buildRoundPrompt(facts, plan, 1, '', {
    selectedRootContactSheet: '粉色_六角度合成参考图.png',
    selectedColorLabel: '粉色',
    lockedAnglePositions: ['左上', '上中', '右上', '左下', '下中'],
  });
  assert.match(prompt, /本轮单角度锁定规则/);
  assert.match(prompt, /图片1：只锁定合成图“左上”/);
  assert.match(prompt, /图片5：只锁定合成图“下中”/);
  assert.match(prompt, /禁止平均、融合、镜像或拼接其他角度/);
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
