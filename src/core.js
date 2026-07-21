const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const CSV_HEADER = ['run_id', 'job_id', 'product_id', 'variant', 'output_file', 'status', 'review_notes', 'prompt'];

function naturalCompare(a, b) { return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }); }
function csvCell(value) { const s = String(value ?? ''); return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function safeName(name) { return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || '产品'; }
function randomDelayMs(random = Math.random, minSeconds = 20, maxSeconds = 60) {
  const min = Math.max(0, Math.trunc(Number(minSeconds) || 0));
  const max = Math.max(min, Math.trunc(Number(maxSeconds) || 0));
  return min * 1000 + Math.floor(random() * ((max - min) * 1000 + 1));
}

async function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function scanProductDirectory(dir, name = path.basename(dir)) {
  const files = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort(naturalCompare);
  const images = files.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
  const txts = files.filter((f) => path.extname(f).toLowerCase() === '.txt').map((f) => path.join(dir, f));
  const prompt = (await Promise.all(txts.map((f) => fsp.readFile(f, 'utf8')))).map((s) => s.trim()).filter(Boolean).join('\n\n');
  return { id: name, name, dir, images, txts, prompt, valid: images.length > 0 && txts.length > 0 && prompt.length > 0 };
}

async function scanProducts(root) {
  const entries = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name !== 'outputs').sort((a, b) => naturalCompare(a.name, b.name));
  return Promise.all(entries.map((entry) => scanProductDirectory(path.join(root, entry.name), entry.name)));
}

async function allocateOutputDir(outputsRoot, productName, claimedPath) {
  if (claimedPath) { await fsp.mkdir(claimedPath, { recursive: true }); return claimedPath; }
  const base = safeName(productName);
  for (let n = 1; ; n += 1) {
    const candidate = path.join(outputsRoot, `${base}_${n}`);
    try { await fsp.mkdir(candidate, { recursive: false }); return candidate; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

async function allocateRunLayout(outputsRoot, productNames, claimedRunDir = null) {
  const runDir = await allocateOutputDir(outputsRoot, '陛下请查收', claimedRunDir);
  const productDirs = {};
  for (const productName of productNames) {
    const productDir = path.join(runDir, safeName(productName));
    await fsp.mkdir(productDir, { recursive: true });
    productDirs[productName] = productDir;
  }
  return { runDir, productDirs };
}

async function validateImage(file, existingHashes = new Set()) {
  const stat = await fsp.stat(file);
  if (!stat.isFile() || stat.size === 0) throw new Error('图片文件为空');
  const buffer = await fsp.readFile(file);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (existingHashes.has(hash)) throw new Error('图片内容重复');
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  if (!metadata.width || !metadata.height || !metadata.format) throw new Error('无法解码图片');
  return { hash, width: metadata.width, height: metadata.height, format: metadata.format };
}

function extensionFor(format, fallback = '.png') {
  return ({ jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', avif: '.avif' })[format] || fallback;
}

async function appendIndex(outputsRoot, row) {
  const file = path.join(outputsRoot, 'index.csv');
  try {
    const existing = await fsp.readFile(file, 'utf8');
    if (existing && !existing.startsWith('run_id,')) {
      const legacy = path.join(outputsRoot, `index-legacy-${Date.now()}.csv`);
      await fsp.rename(file, legacy);
      await fsp.writeFile(file, `${CSV_HEADER.join(',')}\r\n`, 'utf8');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fsp.writeFile(file, `${CSV_HEADER.join(',')}\r\n`, 'utf8');
  }
  await fsp.appendFile(file, `${CSV_HEADER.map((k) => csvCell(row[k])).join(',')}\r\n`, 'utf8');
}

module.exports = { IMAGE_EXTS, scanProductDirectory, scanProducts, allocateOutputDir, allocateRunLayout, validateImage, extensionFor, appendIndex, atomicWriteJson, randomDelayMs, safeName };
