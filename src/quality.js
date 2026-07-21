const fs = require('node:fs');
const fsp = fs.promises;
const sharp = require('sharp');

const signatureCache = new Map();
const clamp01 = (value) => Math.max(0, Math.min(1, value));

async function imageSignature(file) {
  const stat = await fsp.stat(file); const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (signatureCache.has(key)) return signatureCache.get(key);
  const { data, info } = await sharp(file, { failOn: 'error' }).flatten({ background: '#ffffff' }).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const bins = new Array(12).fill(0); const pixels = info.width * info.height;
  for (let i = 0; i < data.length; i += 3) { bins[Math.min(3, data[i] >> 6)] += 1; bins[4 + Math.min(3, data[i + 1] >> 6)] += 1; bins[8 + Math.min(3, data[i + 2] >> 6)] += 1; }
  const signature = bins.map((value) => value / pixels / 3); signatureCache.set(key, signature); return signature;
}

function histogramSimilarity(left, right) { let distance = 0; for (let i = 0; i < left.length; i += 1) distance += Math.abs(left[i] - right[i]); return clamp01(1 - distance / 2); }

async function whiteBackgroundScore(file) {
  const { data, info } = await sharp(file, { failOn: 'error' }).flatten({ background: '#ffffff' }).resize(96, 96, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let border = 0; let white = 0; const margin = 8;
  for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
    if (x >= margin && x < info.width - margin && y >= margin && y < info.height - margin) continue;
    const i = (y * info.width + x) * 3; border += 1;
    if (data[i] >= 235 && data[i + 1] >= 235 && data[i + 2] >= 235 && Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) <= 14) white += 1;
  }
  return border ? white / border : 0;
}

async function analyzeProductImage(file, referenceFiles = [], policy = {}) {
  const settings = { minDimension: 512, squareTolerance: 0.08, whiteThreshold: 0.68, consistencyThreshold: 0.16, requireWhite: false, strictConsistency: false, ...policy };
  const metadata = await sharp(file, { failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('无法读取图片尺寸');
  const issues = []; const hardIssues = [];
  const minDimension = Math.min(metadata.width, metadata.height); const squareDelta = Math.abs(metadata.width - metadata.height) / Math.max(metadata.width, metadata.height);
  if (minDimension < settings.minDimension) hardIssues.push(`尺寸过小：${metadata.width}x${metadata.height}`);
  if (squareDelta > settings.squareTolerance) hardIssues.push(`不是合格方图：${metadata.width}x${metadata.height}`);
  const whiteScore = await whiteBackgroundScore(file);
  if (whiteScore < settings.whiteThreshold) (settings.requireWhite ? hardIssues : issues).push(`白底边缘占比偏低：${Math.round(whiteScore * 100)}%`);
  let consistencyScore = null;
  if (referenceFiles.length) {
    const candidate = await imageSignature(file); const refs = await Promise.all(referenceFiles.map((reference) => imageSignature(reference).catch(() => null)));
    consistencyScore = Math.max(0, ...refs.filter(Boolean).map((reference) => histogramSimilarity(candidate, reference)));
    if (consistencyScore < settings.consistencyThreshold) (settings.strictConsistency ? hardIssues : issues).push(`主体颜色结构相似度偏低：${Math.round(consistencyScore * 100)}%`);
  }
  const approved = hardIssues.length === 0;
  const status = approved ? (issues.length ? 'approved_with_warnings' : 'approved') : 'revise';
  const reviewNotes = [`${metadata.width}x${metadata.height}`, `white=${whiteScore.toFixed(3)}`, consistencyScore === null ? 'consistency=n/a' : `consistency=${consistencyScore.toFixed(3)}`, ...hardIssues, ...issues].join('; ');
  return { approved, status, hardReject: !approved, width: metadata.width, height: metadata.height, whiteScore, consistencyScore, issues, hardIssues, reviewNotes };
}

module.exports = { analyzeProductImage, whiteBackgroundScore, imageSignature, histogramSimilarity };
