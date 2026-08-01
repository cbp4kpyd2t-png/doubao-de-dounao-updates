const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const sharp = require('sharp');
const { scanProductDirectory, scanProducts, allocateOutputDir, allocateRunLayout, validateImage, appendIndex, randomDelayMs, safeName } = require('../src/core');

async function tempDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'ecom-test-')); }
test('扫描产品时排序并合并全部 TXT', async () => {
  const root = await tempDir(); const p = path.join(root, '产品1'); await fsp.mkdir(p);
  await fsp.writeFile(path.join(p, 'b.txt'), '第二段'); await fsp.writeFile(path.join(p, 'a.txt'), '第一段');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toFile(path.join(p, '参考.png'));
  const products = await scanProducts(root); assert.equal(products[0].prompt, '第一段\n\n第二段'); assert.equal(products[0].valid, true);
});

test('每次上传前可重新扫描商品文件夹中的最新参考图和TXT', async () => {
  const root = await tempDir(); const dir = path.join(root, '产品'); await fsp.mkdir(dir);
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toFile(path.join(dir, '1.png')); await fsp.writeFile(path.join(dir, '提示.txt'), '旧提示');
  let product = await scanProductDirectory(dir, '产品'); assert.equal(product.images.length, 1); assert.equal(product.prompt, '旧提示');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toFile(path.join(dir, '2.png')); await fsp.writeFile(path.join(dir, '提示.txt'), '新提示');
  product = await scanProductDirectory(dir, '产品'); assert.equal(product.images.length, 2); assert.equal(product.prompt, '新提示');
});
test('最终角度母图按组轮换且单轮不超过10张，并忽略候选和压力测试目录', async () => {
  const root = await tempDir(); const dir = path.join(root, '产品'); await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, '提示.txt'), '提示');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toFile(path.join(dir, '原图.png'));
  const finalAngles = path.join(dir, 'L063最终角度母图_18张');
  const lavender = path.join(finalAngles, '浅紫色');
  const pink = path.join(finalAngles, '粉色');
  const candidate = path.join(dir, '角度母图候选');
  const stress = path.join(dir, '压力测试_图片加文案');
  await fsp.mkdir(lavender, { recursive: true }); await fsp.mkdir(pink); await fsp.mkdir(candidate); await fsp.mkdir(stress);
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toFile(path.join(pink, '粉色_A.png'));
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'green' } }).png().toFile(path.join(lavender, '浅紫色_A.png'));
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'black' } }).png().toFile(path.join(candidate, '不合格.png'));
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toFile(path.join(stress, '测试.png'));
  const first = await scanProductDirectory(dir, '产品', { round: 1, maxImages: 10 });
  const second = await scanProductDirectory(dir, '产品', { round: 2, maxImages: 10 });
  assert.equal(first.images.length, 2); assert.equal(second.images.length, 2);
  assert.notEqual(first.imageSelection.selectedAngleGroup, second.imageSelection.selectedAngleGroup);
  assert.ok(first.images.some((file) => file.endsWith('原图.png')));
  assert.ok(second.images.some((file) => file.endsWith('原图.png')));
  assert.ok(![...first.images, ...second.images].some((file) => file.endsWith('不合格.png') || file.endsWith('测试.png')));
});
test('同一角度组存在合成参考图时只上传合成图而不上传六张单图', async () => {
  const root = await tempDir(); const dir = path.join(root, '产品'); const angles = path.join(dir, '最终角度母图');
  await fsp.mkdir(angles, { recursive: true }); await fsp.writeFile(path.join(dir, '提示.txt'), '提示');
  await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toFile(path.join(dir, '原图.png'));
  for (const suffix of ['A', 'B', 'C', 'D', 'E', 'F']) {
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toFile(path.join(angles, `粉色_${suffix}.png`));
  }
  await sharp({ create: { width: 3, height: 2, channels: 3, background: 'green' } }).png().toFile(path.join(angles, '粉色_六角度合成参考图.png'));
  const product = await scanProductDirectory(dir, '产品', { round: 1, maxImages: 10 });
  assert.equal(product.images.length, 2);
  assert.ok(product.images.some((file) => file.endsWith('粉色_六角度合成参考图.png')));
  assert.ok(!product.images.some((file) => file.endsWith('粉色_A.png')));
});
test('根目录多个颜色六角度合成图每轮只上传一个并轮换颜色', async () => {
  const root = await tempDir(); const dir = path.join(root, 'L063健身板主图'); await fsp.mkdir(dir);
  await fsp.writeFile(path.join(dir, '商品事实.txt'), '健身板结构事实');
  for (const [name, color] of [['粉色', 'pink'], ['黑色', 'black'], ['浅紫色', 'lavender']]) {
    await sharp({ create: { width: 300, height: 200, channels: 3, background: color } }).png().toFile(path.join(dir, `${name}_六角度合成参考图.png`));
  }
  const first = await scanProductDirectory(dir, 'L063健身板主图', { round: 1 });
  const second = await scanProductDirectory(dir, 'L063健身板主图', { round: 2 });
  assert.equal(first.images.length, 1);
  assert.equal(second.images.length, 1);
  assert.notEqual(first.images[0], second.images[0]);
  assert.equal(first.imageSelection.lockedAnglePositions.length, 5);
  assert.equal(first.allReferenceImages.length, 3);
});
test('输出目录重名时追加数字', async () => {
  const root = await tempDir(); const a = await allocateOutputDir(root, '商品'); const b = await allocateOutputDir(root, '商品');
  assert.equal(path.basename(a), '商品_1'); assert.equal(path.basename(b), '商品_2');
});
test('输出目录使用最小可用正整数后缀', async () => {
  const root = await tempDir(); await fsp.mkdir(path.join(root, '商品_1')); await fsp.mkdir(path.join(root, '商品_2')); await fsp.mkdir(path.join(root, '商品_4'));
  const allocated = await allocateOutputDir(root, '商品'); assert.equal(path.basename(allocated), '商品_3');
});
test('每次任务创建陛下请查收总目录并按商品分子目录', async () => {
  const root = await tempDir();
  const first = await allocateRunLayout(root, ['商品A', '商品B']);
  const second = await allocateRunLayout(root, ['商品A']);
  assert.equal(path.basename(first.runDir), '陛下请查收_1');
  assert.equal(path.basename(second.runDir), '陛下请查收_2');
  assert.equal(first.productDirs['商品A'], path.join(first.runDir, '商品A'));
  assert.ok((await fsp.stat(first.productDirs['商品B'])).isDirectory());
});
test('图片校验拒绝重复内容', async () => {
  const root = await tempDir(); const file = path.join(root, 'a.png'); await sharp({ create: { width: 3, height: 4, channels: 3, background: 'blue' } }).png().toFile(file);
  const info = await validateImage(file); assert.equal(info.width, 3); await assert.rejects(validateImage(file, new Set([info.hash])), /重复/);
});
test('随机等待严格位于20到60秒', () => { assert.equal(randomDelayMs(() => 0), 20000); assert.equal(randomDelayMs(() => 0.999999), 60000); });
test('随机等待支持用户自定义范围和零等待', () => { assert.equal(randomDelayMs(() => 0, 5, 15), 5000); assert.equal(randomDelayMs(() => 0.999999, 5, 15), 15000); assert.equal(randomDelayMs(() => 0, 0, 0), 0); });
test('CSV包含run_id并正确转义', async () => { const root = await tempDir(); await appendIndex(root, { run_id: 'run-1', job_id: 'a,b', prompt: 'x"y' }); const csv = await fsp.readFile(path.join(root, 'index.csv'), 'utf8'); assert.match(csv, /^run_id,/); assert.match(csv, /run-1,"a,b"/); assert.equal(safeName('a:b?'), 'a_b_'); });
test('旧版CSV会保留为legacy文件', async () => { const root = await tempDir(); await fsp.writeFile(path.join(root, 'index.csv'), 'job_id,product_id\r\nold,p1\r\n'); await appendIndex(root, { run_id: 'new' }); const files = await fsp.readdir(root); assert.ok(files.some((f) => f.startsWith('index-legacy-'))); assert.match(await fsp.readFile(path.join(root, 'index.csv'), 'utf8'), /^run_id,/); });
