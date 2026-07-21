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
