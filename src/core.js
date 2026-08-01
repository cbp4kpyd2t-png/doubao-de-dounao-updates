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

async function collectFinalAngleImageGroups(productDir, entries) {
  const angleDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.includes('最终角度母图'))
    .sort((a, b) => naturalCompare(a.name, b.name));
  const grouped = new Map();
  for (const angleDir of angleDirs) {
    const angleRoot = path.join(productDir, angleDir.name);
    const pending = [angleRoot];
    while (pending.length > 0) {
      const current = pending.shift();
      const children = (await fsp.readdir(current, { withFileTypes: true }))
        .sort((a, b) => naturalCompare(a.name, b.name));
      for (const child of children) {
        const fullPath = path.join(current, child.name);
        if (child.isDirectory()) pending.push(fullPath);
        else if (child.isFile() && IMAGE_EXTS.has(path.extname(child.name).toLowerCase())) {
          const relative = path.relative(angleRoot, fullPath);
          const parts = relative.split(path.sep);
          const filePrefix = path.basename(child.name, path.extname(child.name)).split('_')[0];
          const groupName = parts.length > 1 ? parts[0] : filePrefix;
          const key = `${angleDir.name}/${groupName}`;
          if (!grouped.has(key)) grouped.set(key, []);
          grouped.get(key).push(fullPath);
        }
      }
    }
  }
  let groups = [...grouped.entries()]
    .sort(([a], [b]) => naturalCompare(a, b))
    .map(([name, images]) => {
      const sorted = images.sort(naturalCompare);
      const contactSheets = sorted.filter((file) => path.basename(file).includes('合成参考图'));
      return { name, images: contactSheets.length > 0 ? contactSheets : sorted };
    });
  if (groups.length > 3 && groups.every((group) => group.images.length === 1)) {
    groups = [{ name: '全部角度母图', images: groups.flatMap((group) => group.images).sort(naturalCompare) }];
  }
  return groups;
}

async function scanProductDirectory(dir, name = path.basename(dir), options = {}) {
  const round = Math.max(1, Math.trunc(Number(options.round) || 1));
  const maxImages = Math.max(1, Math.trunc(Number(options.maxImages) || 10));
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort(naturalCompare);
  const rootImages = files.filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase())).map((f) => path.join(dir, f));
  const rootContactSheets = rootImages.filter((file) => path.basename(file).includes('六角度合成参考图'));
  const ordinaryRootImages = rootImages.filter((file) => !rootContactSheets.includes(file));
  const selectedRootContactSheet = rootContactSheets.length > 0
    ? rootContactSheets[(round - 1) % rootContactSheets.length]
    : null;
  const angleGroups = await collectFinalAngleImageGroups(dir, entries);
  const selectedAngleGroup = angleGroups.length > 0 ? angleGroups[(round - 1) % angleGroups.length] : null;
  // 多个颜色的六角度合成图不能同时上传，否则图像模型容易跨颜色、跨视角
  // 拼接商品结构。每轮仅选择一种颜色；五张任务由提示词锁定该合成图中的
  // 五个独立视角。普通白底参考图仍照常保留。
  const preferredRootImages = selectedRootContactSheet
    ? [...ordinaryRootImages, selectedRootContactSheet]
    : ordinaryRootImages;
  const rootSelection = preferredRootImages.slice(0, maxImages);
  const angleCapacity = Math.max(0, maxImages - rootSelection.length);
  const angleSelection = selectedAngleGroup ? selectedAngleGroup.images.slice(0, angleCapacity) : [];
  const images = [...rootSelection, ...angleSelection];
  const txts = files.filter((f) => path.extname(f).toLowerCase() === '.txt').map((f) => path.join(dir, f));
  const prompt = (await Promise.all(txts.map((f) => fsp.readFile(f, 'utf8')))).map((s) => s.trim()).filter(Boolean).join('\n\n');
  const anglePositions = ['左上', '上中', '右上', '左下', '下中', '右下'];
  const angleStart = (round - 1) % anglePositions.length;
  const lockedAnglePositions = Array.from({ length: 5 }, (_, index) => anglePositions[(angleStart + index) % anglePositions.length]);
  return {
    id: name, name, dir, images, allReferenceImages: [...rootImages, ...angleGroups.flatMap((group) => group.images)].sort(naturalCompare), txts, prompt,
    imageSelection: {
      round, maxImages, rootAvailable: rootImages.length, angleGroups: angleGroups.map((group) => ({ name: group.name, count: group.images.length })),
      selectedAngleGroup: selectedAngleGroup?.name || null, selectedAngleCount: angleSelection.length,
      omittedRootCount: Math.max(0, rootImages.length - rootSelection.length),
      selectedRootContactSheet,
      selectedColorLabel: selectedRootContactSheet ? path.basename(selectedRootContactSheet).replace(/_?六角度合成参考图.*$/u, '') : null,
      lockedAnglePositions: selectedRootContactSheet ? lockedAnglePositions : []
    },
    valid: images.length > 0 && txts.length > 0 && prompt.length > 0
  };
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
