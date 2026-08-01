const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const sharp = require('sharp');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SHEET_SUFFIX = '_六角度合成参考图.png';
const TILE_SIZE = 1024;
const COLS = 3;
const ROWS = 2;
const PADDING = 38;

function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

async function buildSheet(groupName, files, outputDir) {
  const selected = files
    .filter((file) => IMAGE_EXTS.has(path.extname(file).toLowerCase()) && !file.endsWith(SHEET_SUFFIX))
    .sort(naturalCompare)
    .slice(0, COLS * ROWS);
  if (selected.length !== COLS * ROWS) {
    throw new Error(`角度组“${groupName}”需要6张图片，实际找到${selected.length}张`);
  }

  const composites = [];
  for (let index = 0; index < selected.length; index += 1) {
    const input = path.join(outputDir, selected[index]);
    const tile = await sharp(input)
      .resize(TILE_SIZE - PADDING * 2, TILE_SIZE - PADDING * 2, {
        fit: 'contain',
        background: { r: 246, g: 246, b: 246, alpha: 1 }
      })
      .extend({
        top: PADDING, bottom: PADDING, left: PADDING, right: PADDING,
        background: { r: 246, g: 246, b: 246, alpha: 1 }
      })
      .png()
      .toBuffer();
    composites.push({
      input: tile,
      left: (index % COLS) * TILE_SIZE,
      top: Math.floor(index / COLS) * TILE_SIZE
    });
  }

  const output = path.join(outputDir, `${groupName}${SHEET_SUFFIX}`);
  await sharp({
    create: {
      width: TILE_SIZE * COLS,
      height: TILE_SIZE * ROWS,
      channels: 3,
      background: { r: 246, g: 246, b: 246 }
    }
  }).composite(composites).png({ compressionLevel: 9 }).toFile(output);
  return output;
}

async function main() {
  const outputDir = path.resolve(process.argv[2] || '');
  if (!outputDir || !fs.existsSync(outputDir)) throw new Error('请传入最终角度母图目录');
  const files = (await fsp.readdir(outputDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const groups = new Map();
  for (const file of files) {
    if (!IMAGE_EXTS.has(path.extname(file).toLowerCase()) || file.endsWith(SHEET_SUFFIX)) continue;
    const groupName = path.basename(file, path.extname(file)).split('_')[0];
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(file);
  }
  const outputs = [];
  for (const [groupName, groupFiles] of [...groups.entries()].sort(([a], [b]) => naturalCompare(a, b))) {
    outputs.push(await buildSheet(groupName, groupFiles, outputDir));
  }
  process.stdout.write(`${JSON.stringify({ outputDir, outputs }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
