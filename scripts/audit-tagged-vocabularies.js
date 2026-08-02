const { scanProducts } = require('../src/core');
const { prepareProductCreativeFiles, buildRoundPrompt, FINAL_PROMPT_MAX_LENGTH } = require('../src/creative-engine');

async function main() {
  const [productsRoot] = process.argv.slice(2);
  if (!productsRoot) throw new Error('用法：node scripts/audit-tagged-vocabularies.js <商品总目录>');
  const products = await scanProducts(productsRoot);
  const results = [];
  for (const product of products) {
    if (product.manualPromptMode) {
      results.push({ product: product.name, mode: 'manual', status: 'skipped' });
      continue;
    }
    const bundle = await prepareProductCreativeFiles(product, { cycle: 1 });
    if (!bundle.taggedVocabulary) {
      results.push({ product: product.name, mode: 'legacy', status: 'no-tagged-vocabulary' });
      continue;
    }
    let maxPromptLength = 0;
    for (let round = 1; round <= 10; round += 1) {
      let prompt;
      try {
        prompt = buildRoundPrompt(bundle.facts, bundle.plan, round, '', product.imageSelection);
      } catch (error) {
        throw new Error(`${product.name} 第${round}轮：${error.message}`);
      }
      maxPromptLength = Math.max(maxPromptLength, prompt.length);
    }
    results.push({
      product: product.name,
      mode: 'tagged',
      status: 'ok',
      tags: bundle.taggedVocabulary.linkedTags,
      scenes: bundle.taggedVocabulary.scenes.length,
      actions: bundle.taggedVocabulary.actions.length,
      maxPromptLength,
      limit: FINAL_PROMPT_MAX_LENGTH,
    });
  }
  const failed = results.filter((item) => !['ok', 'skipped'].includes(item.status));
  process.stdout.write(`${JSON.stringify({ productCount: products.length, failedCount: failed.length, results }, null, 2)}\n`);
  if (failed.length) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
