const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

async function main() {
  const [sourceDir, productsRoot] = process.argv.slice(2);
  if (!sourceDir || !productsRoot) throw new Error('用法：node scripts/sync-tagged-vocabularies.js <极简词库目录> <商品总目录>');
  const sourceFiles = (await fsp.readdir(sourceDir, { withFileTypes: true }))
    .filter((item) => item.isFile() && /^L\d+.*\.txt$/iu.test(item.name));
  const productDirs = (await fsp.readdir(productsRoot, { withFileTypes: true }))
    .filter((item) => item.isDirectory() && /^L\d+/iu.test(item.name));
  const productsByCode = new Map(productDirs.map((item) => [item.name.match(/^L\d+/iu)[0].toUpperCase(), item.name]));
  const copied = [];
  const skipped = [];
  const missing = [];

  for (const source of sourceFiles) {
    const code = source.name.match(/^L\d+/iu)[0].toUpperCase();
    if (code === 'L063') {
      skipped.push(`${code}（手工提示词专用）`);
      continue;
    }
    const productName = productsByCode.get(code);
    if (!productName) {
      missing.push(`${code}（找不到商品目录）`);
      continue;
    }
    const configDir = path.join(productsRoot, productName, '豆脑配置');
    const target = path.join(configDir, '极简词库.txt');
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.copyFile(path.join(sourceDir, source.name), target);
    copied.push(`${code} -> ${target}`);
  }

  process.stdout.write(`${JSON.stringify({ copiedCount: copied.length, copied, skipped, missing }, null, 2)}\n`);
  if (missing.length) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
