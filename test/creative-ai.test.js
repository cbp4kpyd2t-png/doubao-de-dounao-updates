const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const {
  BANK_KEYS,
  BEGIN_MARKER,
  END_MARKER,
  parseMarkedJson,
  localAuditBank,
  buildObserverPrompt,
  buildDirectorPrompt,
  buildCriticPrompt,
  applyCriticDecision,
  ensureAiCreativeBank,
} = require('../src/creative-ai');

function marked(value) {
  return `${BEGIN_MARKER}\n${JSON.stringify(value)}\n${END_MARKER}`;
}

function facts() {
  return {
    productId: 'L001',
    productName: '测试置物架',
    identityAnchor: '全部参考图',
    quantity: 1,
    appearanceFacts: ['黑色双层金属结构'],
    requiredElements: ['保持双层'],
    forbiddenChanges: ['不得改变结构'],
    confirmedSellingPoints: ['分类收纳'],
    customRequirements: '实际尺寸37×25×33厘米',
  };
}

function completeBank() {
  const bank = {};
  BANK_KEYS.forEach((key, keyIndex) => {
    bank[key] = Array.from({ length: 20 }, (_, index) => {
      const base = 0x3400 + keyIndex * 100 + index * 4;
      return String.fromCodePoint(base, base + 1, base + 2, base + 3);
    });
  });
  return bank;
}

test('marked JSON parser ignores surrounding text and reads the latest marked object', () => {
  const result = parseMarkedJson(`old ${marked({ old: true })}\nnew ${marked({ ok: true })}`);
  assert.deepEqual(result, { ok: true });
  assert.throws(() => parseMarkedJson('{"ok":true}'), /边界标记/);
});

test('local critic removes semantic near-duplicates instead of counting wording changes', () => {
  const result = localAuditBank({
    scenes: ['豪华厨房中女性伸手拿取置物架物品', '豪华厨房里女性伸手拿取置物架物品', '户外露台移动置物架准备聚餐'],
  }, 0.55);
  assert.equal(result.approvedBank.scenes.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].reason, /语义过近/);
});

test('critic-approved lists replace rejected candidates and accept explicit replacements', () => {
  const result = applyCriticDecision(
    { scenes: ['常见厨房拿取', '户外移动场景'], actions: ['伸手拿取'] },
    {
      approvedBank: { scenes: ['户外移动场景'], actions: ['伸手拿取'] },
      replacements: [{ category: 'scenes', value: '雨后温室备餐场景' }],
    },
  );
  assert.deepEqual(result.scenes, ['户外移动场景', '雨后温室备餐场景']);
  assert.equal(result.scenes.includes('常见厨房拿取'), false);
});

test('three prompts use independent roles and strict structured boundaries', () => {
  const observer = buildObserverPrompt(facts());
  const director = buildDirectorPrompt(facts(), { actions: ['拿取'] });
  const critic = buildCriticPrompt(facts(), completeBank());
  assert.match(observer, /生活观察员和商品策略师/);
  assert.match(director, /广告创意总监、空间设计师和摄影指导/);
  assert.match(critic, /挑剔的电商视觉审稿人/);
  for (const prompt of [observer, director, critic]) {
    assert.match(prompt, new RegExp(BEGIN_MARKER));
    assert.match(prompt, new RegExp(END_MARKER));
    assert.match(prompt, /只输出一个JSON对象/);
    assert.doesNotMatch(prompt, /"appearanceFacts"/);
    assert.match(prompt, /"summary"/);
  }
});

test('AI analysis runs three chats once, writes cache, then reuses the approved bank', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dou-nao-ai-'));
  const product = { id: 'L001', name: '测试置物架', dir, images: [path.join(dir, '1.png')] };
  await fsp.writeFile(product.images[0], Buffer.from('image'));
  const observer = {
    audiences: ['家庭用户'],
    painPoints: ['台面杂乱'],
    usageMoments: ['备餐前'],
    sellingPoints: ['分类收纳'],
    actions: ['双手移动到备餐区'],
    spatialRelations: ['商品在人物前方同一景深'],
  };
  const director = completeBank();
  const critic = { approvedBank: director, rejected: [], replacements: [] };
  const answers = [marked(observer), marked(director), marked(critic)];
  const calls = [];
  const browser = {
    connected: true,
    async requestStructuredText(prompt, options) {
      calls.push({ prompt, options });
      return answers[calls.length - 1];
    },
  };
  const first = await ensureAiCreativeBank({
    browser,
    product,
    facts: facts(),
    configDir: dir,
    fingerprint: 'fingerprint-1',
    diversityStrength: 'balanced',
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].options.images, product.images);
  assert.equal(calls[1].options.images, undefined);
  assert.equal(first.reused, false);
  assert.equal(first.approvedBank.scenes.length, 20);
  assert.equal(await fsp.stat(path.join(dir, 'AI产品分析.json')).then(() => true), true);
  assert.equal(await fsp.stat(path.join(dir, '差异化词库.json')).then(() => true), true);

  const second = await ensureAiCreativeBank({
    browser,
    product,
    facts: facts(),
    configDir: dir,
    fingerprint: 'fingerprint-1',
    diversityStrength: 'balanced',
  });
  assert.equal(second.reused, true);
  assert.equal(calls.length, 3);
});
