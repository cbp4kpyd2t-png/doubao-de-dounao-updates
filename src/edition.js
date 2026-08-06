const pkg = require('../package.json');

const isBackgroundTest = pkg.dounaoEdition === 'background-test';

module.exports = {
  id: isBackgroundTest ? 'background-test' : 'stable',
  isBackgroundTest,
  title: isBackgroundTest ? '豆包的豆脑-后台测试版' : '豆包的豆脑',
  outputFolderName: isBackgroundTest ? 'outputs-background-test' : 'outputs',
};
