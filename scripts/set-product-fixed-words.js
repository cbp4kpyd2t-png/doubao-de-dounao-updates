const fsp = require('node:fs').promises;
const path = require('node:path');

const PERSON_DIVERSITY_LOCK = '五张必须使用不同人物、不同人种、不同人脸、不同服装';

const FIXED_WORDS = {
  L042: ['钉孔入土', 'L形卷带'],
  L043: ['一板一衣', '前端翻页'],
  L047: ['前后双拱', '侧面四横杆'],
  L048: ['塑料常春藤', '绿色网格卷'],
  L051: ['平底侧褶', '扭绳双提手'],
  L058: ['黑桶双区', '脚踏脱水'],
  L068: ['双门窄高柜', '下门竖盘'],
  L071: ['双柱升降', '四刹车轮'],
  L072: ['四层十二孔', '软膜鞋位'],
  L074: ['三层盘槽', '双钩侧件'],
  L075: ['双层杯环', '右前排水嘴'],
  L076: ['四边围垫', '2:1长方'],
  L077: ['洞屋顶抓板', '双绳双球'],
  L078: ['六格托盘', '双片U提手'],
  L081: ['一板一抽篮', '正面抽拉'],
  L082: ['左右伸缩', '槽孔底板'],
  L083: ['下盘抽拉', '错层双篮'],
  L085: ['三宽平刃', '红阶梯刀架'],
  L086: ['木顶双抽篮', '四柱短脚'],
  L087: ['上深下斜篮', '双承托轨'],
  L088: ['三篮S错位', '一长两圆'],
  L089: ['32cm层间', '14cm窄深'],
  L090: ['下翻单门', '低矮单腔'],
  L091: ['三件同规格', '凹口抽屉'],
  L092: ['三块2mm薄板', '三尺寸孔位'],
  L094: ['船形陶瓷盘', '竹木弧托'],
  L096: ['细长炭槽', '外张折叠腿'],
};

async function main() {
  const [sourceDir] = process.argv.slice(2);
  if (!sourceDir) throw new Error('用法：node scripts/set-product-fixed-words.js <极简词库目录>');
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  const directFiles = entries
    .filter((entry) => entry.isFile() && /^L\d+.*\.txt$/iu.test(entry.name))
    .map((entry) => ({ name: entry.name, file: path.join(sourceDir, entry.name) }));
  const productFiles = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^L\d+/iu.test(item.name))) {
    const file = path.join(sourceDir, entry.name, '豆脑配置', '极简词库.txt');
    try { await fsp.access(file); productFiles.push({ name: entry.name, file }); } catch {}
  }
  const files = [...directFiles, ...productFiles];
  const updated = [];
  for (const item of files) {
    const code = item.name.match(/^L\d+/iu)[0].toUpperCase();
    if (code === 'L063') continue;
    const words = FIXED_WORDS[code];
    if (!words) throw new Error(`${code}没有配置商品独立固定词`);
    const file = item.file;
    const original = await fsp.readFile(file, 'utf8');
    const fixedLine = `固定词=${words.join('｜')}`;
    let next;
    if (/^固定词=.*$/mu.test(original)) next = original.replace(/^固定词=.*$/mu, fixedLine);
    else next = original.replace(/^(人物锁=.*)$/mu, `$1\n${fixedLine}`);
    next = next.replace(/^人物锁=(.*)$/mu, (_line, value) => {
      const locks = value.split('｜').map((item) => item.trim()).filter(Boolean);
      if (!locks.includes(PERSON_DIVERSITY_LOCK)) locks.push(PERSON_DIVERSITY_LOCK);
      return `人物锁=${locks.join('｜')}`;
    });
    if (next === original && !original.includes(fixedLine)) throw new Error(`${item.name}找不到“人物锁=”插入位置`);
    await fsp.writeFile(file, next, 'utf8');
    updated.push(`${code}:${words.join('、')}；${PERSON_DIVERSITY_LOCK}`);
  }
  process.stdout.write(`${JSON.stringify({ updatedCount: updated.length, updated }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
