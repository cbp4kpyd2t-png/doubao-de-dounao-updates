const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { scanProductDirectory } = require('../src/core');
const { prepareProductCreativeFiles, buildRoundPrompt } = require('../src/creative-engine');
const { ChatGPTAutomation } = require('../src/automation');

async function main() {
  const productDir = process.env.PRODUCT_DIR;
  const outputDir = process.env.SMOKE_OUT;
  const fileStem = process.env.FILE_STEM || 'live-smoke';
  if (!productDir || !outputDir) throw new Error('PRODUCT_DIR and SMOKE_OUT are required');
  const product = await scanProductDirectory(productDir, path.basename(productDir));
  if (!product.valid) throw new Error('The selected smoke-test product is invalid');
  console.log('INPUT', JSON.stringify({ images: product.images.length, txts: product.txts.length, name: product.name }));
  const bundle = await prepareProductCreativeFiles(product, { cycle: 1 });
  const prompt = buildRoundPrompt(bundle.facts, bundle.plan, 1, '');
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.writeFile(path.join(outputDir, 'sent-prompt.txt'), prompt, 'utf8');
  const browser = new ChatGPTAutomation({ downloadDir: outputDir, log: (message) => console.log(new Date().toISOString(), message) });
  try {
    await browser.launch();
    console.log('CONNECTED');
    await browser.newChat();
    console.log('NEW_CHAT');
    await browser.uploadReferences(product.images, () => false, { maxRefreshCycles: 2 });
    console.log('UPLOAD_OK', product.images.length);
    await browser.sendPrompt(prompt, 200);
    console.log('PROMPT_SENT');
    const result = await browser.waitForGeneration(() => false);
    console.log('GENERATION', JSON.stringify(result));
    const viewer = await browser.getViewerImageCount({ targetTotal: 5, maxWaitSeconds: 60 });
    console.log('VIEWER', JSON.stringify(viewer));
    if (!viewer.found || viewer.total < 5) throw new Error(`Incomplete five-image result: ${viewer.total || 0}`);
    const saved = await browser.downloadNewImages(outputDir, fileStem, 1, 5, new Set(), []);
    console.log('SAVED', JSON.stringify(saved.map((item) => ({ file: item.file, width: item.width, height: item.height, hash: item.hash }))));
    if (saved.length !== 5) throw new Error(`Saved only ${saved.length} images`);
    console.log('SMOKE_OK');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error('SMOKE_FAILED', error.stack || error);
  process.exitCode = 1;
});
