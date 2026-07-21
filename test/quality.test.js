const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs').promises;
const sharp = require('sharp');
const { analyzeProductImage, histogramSimilarity } = require('../src/quality');

test('质量检测接受合格方图并给出白底和主体一致性指标', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-'));
  const ref = path.join(dir, 'ref.png'); const candidate = path.join(dir, 'candidate.png');
  await sharp({ create: { width: 800, height: 800, channels: 3, background: '#ffffff' } }).composite([{ input: Buffer.from('<svg width="400" height="400"><rect width="400" height="400" fill="#222"/></svg>'), left: 200, top: 200 }]).png().toFile(ref);
  await fs.copyFile(ref, candidate);
  const result = await analyzeProductImage(candidate, [ref], { minDimension: 512 });
  assert.equal(result.approved, true); assert.ok(result.whiteScore > 0.68); assert.ok(result.consistencyScore > 0.9);
});

test('过小或非方图硬拒绝，非白底默认只警告以保障产量', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-bad-')); const file = path.join(dir, 'bad.png');
  await sharp({ create: { width: 300, height: 500, channels: 3, background: '#111111' } }).png().toFile(file);
  const normal = await analyzeProductImage(file, [], { minDimension: 512, requireWhite: false });
  assert.equal(normal.approved, false); assert.ok(normal.hardIssues.some((item) => item.includes('尺寸过小'))); assert.ok(normal.issues.some((item) => item.includes('白底')));
  const strict = await analyzeProductImage(file, [], { minDimension: 256, squareTolerance: 1, requireWhite: true }); assert.equal(strict.approved, false); assert.ok(strict.hardIssues.some((item) => item.includes('白底')));
});

test('直方图相似度范围稳定', () => { assert.equal(histogramSimilarity([0.5, 0.5], [0.5, 0.5]), 1); assert.ok(histogramSimilarity([1, 0], [0, 1]) >= 0); });
