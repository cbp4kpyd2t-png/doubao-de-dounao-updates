const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const CREATIVE_ENGINE_VERSION = 1;
const CONFIG_DIR_NAME = '豆脑配置';
const CUSTOM_REQUIREMENTS_FILE = '创意要求.txt';

const FIXED_FIVE_IMAGE_PROMPT = `【本轮强制输出规则】

请严格依据已经上传的商品参考图，连续执行5次彼此独立的图像生成任务，并最终输出5张独立的1:1方形图片。

必须真正生成5张图片，不能只生成1张，不能只描述5个方案，也不能等待用户再次催促后才继续生成。

图片1、图片2、图片3、图片4、图片5必须分别作为5个独立图像结果输出。每次图像生成任务只输出1张图片，完成一张后立即继续执行下一次，直到5张全部生成完成。

严禁生成五宫格、拼图、网格图、对比图、分镜图、画中画或一张包含多个方案的图片。

本轮5张图片必须采用5种明显不同且未使用过的商品摆放方向、摄影机位置、俯仰高度、构图距离和人物位置；不能只更换背景、服装、裁切或轻微倾斜画面。

5张图片都必须能够独立作为Temu商品主图：商品完整、清晰、醒目，是画面的第一视觉主体，一眼能够识别。人物、动物、家具和装饰道具可以丰富，但不能遮挡或弱化商品。

严格保持参考商品的形状、颜色、材质、结构、部件数量、尺寸比例和关键细节，不得重新设计、增加、删除或替换商品结构。

不要添加可读文字、Logo、水印、价格、促销徽章、边框或平台界面元素。

再次确认：本轮必须生成5张彼此独立的图片，不是一张包含5个方案的图片。`;

const PERSON_TYPES = ['年轻女性', '年轻男性', '中年女性', '中年男性', '优雅女性', '成熟男性', '时尚女性', '休闲男性', '家庭主理人', '专业使用者'];
const APPAREL = ['浅色高级家居服', '深色简约休闲装', '米白针织服装', '低饱和亚麻服装', '现代都市休闲装', '优雅轻奢服装', '自然户外服装', '整洁工作服', '柔和暖色服装', '高级黑白配服装'];
const LIGHTING = ['通透清晨自然光', '明亮午后阳光', '柔和窗边侧光', '金色傍晚暖光', '高级摄影棚柔光', '别墅天窗光线', '电影感轮廓光', '明暗层次丰富的环境光', '温暖室内灯光与自然光混合', '清澈高反差商业光线'];
const LUXURY_SCENES = ['欧式豪华别墅', '现代轻奢大宅', '通透玻璃景观房', '高级酒店式住宅', '艺术感设计师住宅', '临海豪华公寓', '欧式庄园生活空间', '高挑空现代住宅', '精致复古豪宅', '高级度假住宅'];
const CAMERA_DIRECTIONS = ['正前偏左', '正前偏右', '左前方', '右前方', '左侧方', '右侧方', '左后方', '右后方', '正侧面', '斜向纵深'];
const PRODUCT_ORIENTATIONS = ['向左轻转15度', '向右轻转20度', '向左旋转30度', '向右旋转35度', '向左旋转45度', '向右旋转55度', '向左旋转65度', '向右旋转75度', '向左旋转95度', '向右旋转115度'];
const ELEVATIONS = ['平视机位', '轻微俯拍15度', '俯拍25度', '高位俯拍40度', '低机位轻微仰拍'];
const DISTANCES = ['商品占画面约60%的近距离构图', '商品占画面约52%的标准商业构图', '商品占画面约45%的中景构图', '商品前景突出并保留环境纵深', '广角环境构图但商品仍占据视觉中心'];
const PLACEMENTS = ['商品居中前景', '商品位于左前方视觉中心', '商品位于右前方视觉中心', '商品位于下方黄金分割区域', '商品以对角线纵深方式占据前景'];
const SALES_ROLES = ['高点击主图：第一眼识别商品与高级感', '真实使用主图：人物动作直接说明用途', '卖点主图：完整商品同时突出一个核心价值', '生活代入主图：营造想拥有和使用的氛围', '差异化主图：大胆构图但商品仍是第一主体'];

const PROFILE_RULES = [
  { match: /花园隔离带|隔离带/, scenes: ['欧式庭院花坛', '别墅入口步道', '庄园草坪边缘', '豪华露台花园', '泳池旁景观区'], actions: ['正在安装隔离带', '整理花园边界', '在旁观察隔离效果', '用手调整隔离带位置', '在完成的花园边散步'], props: ['花卉、景观石和园艺工具', '草坪、雕塑和大型花盆'], benefits: ['清晰划分花园区域', '提升庭院景观层次', '安装使用直观'] },
  { match: /叠衣板/, scenes: ['豪华衣帽间', '欧式卧室衣柜区', '精品洗衣房', '高级公寓收纳区', '酒店式更衣空间'], actions: ['使用叠衣板折叠衬衫', '整理成摞衣物', '从衣柜取出衣物准备折叠', '展示折叠后的整齐效果', '用手操作叠衣板'], props: ['不同材质衣物、衣架和收纳篮', '高级衣柜、镜面和软装'], benefits: ['快速整齐叠衣', '统一衣物尺寸', '改善衣柜收纳'] },
  { match: /人造植物|人造草/, scenes: ['游艇甲板栏杆', '海景别墅露台', '屋顶花园栏杆', '欧式庭院围栏', '高级公寓阳台'], actions: ['在植物旁放松休息', '进行瑜伽伸展', '整理栏杆装饰', '从植物旁眺望远景', '用手调整植物固定位置'], props: ['户外沙发、花盆和海景', '宠物、遮阳伞和高级户外家具'], benefits: ['遮挡视线保护空间感', '快速营造自然氛围', '适配多种栏杆场景'] },
  { match: /拖把桶/, scenes: ['高级洗衣房', '豪华浴室外区', '通透现代厨房', '别墅家政间', '酒店式客厅'], actions: ['正在清洁地面', '把拖把放入桶中', '提起拖把桶移动', '完成清洁后整理工具', '用手展示桶的操作方式'], props: ['拖把、清洁用品和绿植', '高级地砖、毛巾架和收纳柜'], benefits: ['清洁流程方便', '移动携带直观', '帮助保持空间整洁'] },
  { match: /健身板|瑜伽板/, scenes: ['海景别墅健身区', '豪华室内健身房', '泳池旁运动区', '高层公寓瑜伽区', '庄园露台'], actions: ['站在健身板上训练', '进行平衡训练', '在旁展示健身板', '准备开始拉伸', '用手调整健身板位置'], props: ['瑜伽垫、毛巾和水杯', '泳池、健身器材和绿植'], benefits: ['支持居家训练', '展示平衡运动方式', '适合多种运动空间'] },
  { match: /碗碟收纳柜|三层沥水架|沥水架/, scenes: ['欧式豪华厨房', '现代别墅厨房岛台', '高级开放式厨房', '酒店式餐厨空间', '通透阳光厨房'], actions: ['把清洗后的碗碟放入商品', '从商品中拿取餐具', '在旁准备餐食', '整理不同类型的餐具', '用手展示层架使用方式'], props: ['碗碟、玻璃杯、餐具和鲜花', '高级厨具、食材和装饰器皿'], benefits: ['分类收纳碗碟', '方便沥水和拿取', '充分利用厨房空间'] },
  { match: /可升降桌/, scenes: ['豪华家庭办公室', '海景公寓书房', '设计师卧室办公区', '别墅落地窗工作区', '高级创意工作室'], actions: ['站立办公', '坐姿使用桌面', '调整桌子高度', '在旁进行视频会议', '用手操作桌面设备'], props: ['笔记本电脑、台灯、书籍和咖啡', '办公椅、艺术品和绿植'], benefits: ['适配坐站办公', '改善多场景使用方式', '办公空间更灵活'] },
  { match: /鞋柜/, scenes: ['欧式豪宅玄关', '高级衣帽间入口', '现代别墅走廊', '精品公寓门厅', '酒店式更衣区'], actions: ['从鞋柜取鞋', '把鞋放入鞋柜', '在旁更换鞋子', '整理不同款式鞋履', '用手打开或展示鞋柜'], props: ['鞋履、换鞋凳、地毯和装饰画', '大型绿植、镜面和高级灯具'], benefits: ['鞋履分类收纳', '玄关更加整齐', '拿取和更换方便'] },
  { match: /猫抓板|猫窝/, scenes: ['豪华客厅宠物角', '阳光别墅窗边', '高级公寓卧室', '设计师住宅休闲区', '欧式家庭书房'], actions: ['猫正在使用猫抓板', '猫在猫窝中休息', '人物在旁与猫互动', '人物把玩具放在商品旁', '用手展示猫窝入口'], props: ['猫玩具、宠物垫和高级家具', '绿植、地毯和落地窗'], benefits: ['兼顾休息与抓挠', '融入家庭空间', '提升宠物使用乐趣'] },
  { match: /食品收纳柜|面包收纳/, scenes: ['欧式豪华厨房', '高级食品储藏室', '别墅厨房岛台', '现代餐厨空间', '精致早餐区'], actions: ['把面包零食放入商品', '从商品中拿取食品', '准备家庭早餐', '整理不同食品', '用手展示开合或取物'], props: ['面包、水果、零食和高级餐具', '咖啡机、鲜花和木质砧板'], benefits: ['食品分类收纳', '台面更整齐', '日常拿取方便'] },
  { match: /塑料可抽拉收纳格|可抽拉收纳/, scenes: ['豪华衣帽间', '高级浴室梳妆区', '现代厨房橱柜区', '设计师书房', '精品公寓收纳区'], actions: ['抽拉收纳格取物', '把用品分类放入', '整理日常小物', '人物在旁选择物品', '用手展示抽拉动作'], props: ['化妆品、衣物、文具或厨房小物', '镜面、灯具和高级收纳家具'], benefits: ['抽拉拿取方便', '小物分类清晰', '充分利用空间'] },
  { match: /橱柜厨房岛台置物架|双层收纳架|双层置物架|水果零食架/, scenes: ['欧式豪华厨房岛台', '现代别墅餐厨空间', '高级客厅茶歇区', '庄园户外聚餐区', '通透阳光早餐区'], actions: ['把物品放入置物架', '从置物架拿取物品', '在旁准备餐食或茶点', '整理不同类别物品', '用手展示上下层取物'], props: ['水果、蔬菜、零食、餐具和鲜花', '高级酒具、厨具和装饰器皿'], benefits: ['双层或多层分类收纳', '方便日常拿取', '释放台面空间'] },
  { match: /收纳盒/, scenes: ['豪华衣帽间梳妆台', '高级卧室床头区', '现代浴室台面', '设计师书桌', '精品公寓玄关'], actions: ['用手拿取收纳盒中的小物', '把饰品放入收纳盒', '人物在旁化妆整理', '展示一手可拿的体积感', '整理桌面小物'], props: ['首饰、化妆品、钥匙和文具', '镜面、鲜花和高级软装'], benefits: ['小物集中收纳', '体积小巧便携', '桌面更加整齐'] },
  { match: /砧板/, scenes: ['欧式豪华厨房岛台', '现代别墅备餐区', '高级开放式厨房', '阳光早餐厨房', '酒店式餐厨空间'], actions: ['正在砧板上切配食材', '把三个砧板排列展示', '从砧板孔位拿起产品', '准备餐前食材', '用手调整不同尺寸砧板'], props: ['新鲜蔬菜、面包、厨刀和餐具', '高级厨具、鲜花和食材'], benefits: ['不同尺寸适配备餐', '方便分类使用', '孔位与排列便于拿取'] },
  { match: /腻子刀/, scenes: ['豪华住宅翻新现场', '高端室内装修空间', '设计师工作室样板墙', '别墅墙面施工区', '明亮专业工坊'], actions: ['使用腻子刀处理墙面', '手持三件套选择尺寸', '在旁检查墙面平整度', '把腻子材料涂到工具上', '完整展示大中小三件套'], props: ['腻子材料、工具箱和防护布', '装修梯、照明灯和高级室内结构'], benefits: ['多尺寸适配不同区域', '墙面处理操作直观', '三件套选择灵活'] },
  { match: /烧烤架|烧烤炉/, scenes: ['海景别墅露台', '欧式庄园庭院', '豪华海边营地', '悬崖景观聚餐区', '高级户外厨房'], actions: ['在烧烤架旁烤制食物', '拿取烧烤串', '准备蔬菜和食材', '朋友在旁聚餐', '用手展示烧烤区域'], props: ['烧烤串、蔬菜、餐具和饮品', '户外桌椅、海景和装饰灯串'], benefits: ['户外烹饪氛围强', '便携使用直观', '适合聚会场景'] },
];

function naturalCompare(a, b) { return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }); }
function normalizeProductName(name) { return String(name || '商品').replace(/^L\d+\s*/i, '').replace(/主图$/u, '').trim() || '商品'; }
function unique(values) { return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))]; }
function choose(values, index, fallback) { return values.length ? values[index % values.length] : fallback; }
function profileFor(name) { return PROFILE_RULES.find((profile) => profile.match.test(name)) || { scenes: LUXURY_SCENES, actions: ['人物正在真实使用商品', '人物在商品旁展示', '用手操作商品', '把商品放入真实环境', '人物完成使用后欣赏效果'], props: ['高级家具、艺术装饰和生活用品', '宠物、绿植和丰富生活道具'], benefits: ['用途表达直观', '融入真实生活场景', '商品完整醒目'] }; }

function chineseNumber(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100 };
  if (value === '十') return 10;
  if (value.includes('十')) { const [left, right] = value.split('十'); return (left ? map[left] || 0 : 1) * 10 + (right ? map[right] || 0 : 0); }
  return map[value] || null;
}

function quantityCandidates(text) {
  const values = [];
  const patterns = [/(\d+|[一二两三四五六七八九十百]+)\s*(?:个|件|只|片|块)?\s*(?:为|是)?\s*一组/g, /(\d+|[一二两三四五六七八九十百]+)\s*件套/g];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) { const value = chineseNumber(match[1]); if (Number.isFinite(value)) values.push(value); }
  return unique(values).map(Number);
}

function extractSentences(text) { return String(text || '').split(/[。！？\r\n]+/u).map((value) => value.trim()).filter(Boolean); }
function isTemplateSentence(sentence) { return /(生成任务|五张图片|图片1|图片2|图片3|图片4|图片5|五宫格|拼图|网格图|对比图|分镜图|画中画|Logo|水印|价格|促销徽章|1:1|方形|Temu|随机更改|摄影机位置|产品身份锚点|背景简洁|再次强调)/i.test(sentence); }

async function sourceFingerprint(product) {
  const hash = crypto.createHash('sha256');
  const files = [...(product.txts || []), ...(product.images || [])].sort(naturalCompare);
  for (const file of files) { hash.update(path.basename(file), 'utf8'); hash.update('\0'); hash.update(await fsp.readFile(file)); hash.update('\0'); }
  return hash.digest('hex');
}

async function extractProductFacts(product, fingerprint) {
  const productName = normalizeProductName(product.name);
  const sources = [];
  let originalText = '';
  let customRequirements = '';
  for (const file of product.txts || []) {
    const content = await fsp.readFile(file, 'utf8');
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    sources.push({ file: path.basename(file), sha256: hash });
    if (path.basename(file).toLowerCase() === CUSTOM_REQUIREMENTS_FILE.toLowerCase()) customRequirements += `${content.trim()}\n`;
    else originalText += `${content.trim()}\n\n`;
  }
  const quantities = quantityCandidates(originalText);
  const pendingConfirmation = [];
  if (quantities.length > 1) pendingConfirmation.push({ field: 'quantity', candidates: quantities, reason: '原始TXT中存在多个互相冲突的套装数量，生成时不主动声明数量并以参考图为准' });
  const ignoredTemplateErrors = [];
  if (originalText.includes('严格以已上传的置物架参考图') && !productName.includes('置物架')) ignoredTemplateErrors.push('检测到复制模板中的“置物架参考图”描述，已忽略并改用当前商品全部参考图作为唯一身份锚点');
  if (productName.includes('叠衣板') && quantities.length > 1) ignoredTemplateErrors.push(`叠衣板数量冲突：${quantities.join('与')}，未自动选择`);
  if (productName.includes('砧板') && originalText.includes('展现置物架')) ignoredTemplateErrors.push('砧板文案中的“展现置物架”属于复制错误，已忽略');
  if (/沥水架/.test(productName) && /(卧室|衣帽间|挑选衣物|化妆)/.test(originalText)) ignoredTemplateErrors.push('沥水架文案含衣帽间、挑衣或化妆场景，已改用厨房餐厨场景');
  if (/猫抓板|猫窝/.test(productName) && /(挑选衣物|化妆)/.test(originalText)) ignoredTemplateErrors.push('猫用品文案含挑衣或化妆模板，已改用宠物互动场景');
  if (/食品收纳柜/.test(productName) && /(挑选衣物|化妆)/.test(originalText)) ignoredTemplateErrors.push('食品收纳文案含挑衣或化妆模板，已改用厨房和食品储藏场景');

  const profile = profileFor(productName);
  const factSentences = extractSentences(originalText).filter((sentence) => !isTemplateSentence(sentence));
  const appearanceFacts = unique(factSentences.filter((sentence) => /(大中小|三件套|三个|三层|双层|一巴掌|大小|孔位|颜色|材质|结构|可抽拉|可升降|栏杆)/.test(sentence)).slice(0, 8));
  const requiredElements = unique([
    ...factSentences.filter((sentence) => /(必须|需要放在|不得|注意大小|注意.*孔|完整|立着摆放)/.test(sentence)).slice(0, 8),
    quantities.length === 1 ? `参考图确认的套装数量为${quantities[0]}，必须保持一致` : '',
  ]);
  const creativePreferences = unique([
    originalText.includes('高级通透') ? '背景允许高级通透并具有明显宣传感' : '',
    originalText.includes('欧式豪华') ? '允许欧式豪华、别墅、庄园、游艇或高级住宅场景' : '',
    /(美女|帅哥|人物)/.test(originalText) ? '允许虚构人物在商品旁或真实使用商品' : '',
    originalText.includes('动物') ? '允许合理加入宠物或动物作为差异化环境元素' : '',
  ]);
  return {
    schemaVersion: 1,
    engineVersion: CREATIVE_ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    sourceFiles: sources,
    productId: product.id,
    productName,
    identityAnchor: '以当前商品文件夹中按文件名排序上传的全部参考图为唯一商品身份锚点',
    quantity: quantities.length === 1 ? quantities[0] : null,
    appearanceFacts,
    usageFacts: profile.actions,
    confirmedSellingPoints: profile.benefits,
    requiredElements,
    forbiddenChanges: ['不得改变商品形状、颜色、材质、结构、部件数量和尺寸比例', '不得增加参考图中不存在的功能或配件', '商品必须完整清晰并成为第一视觉主体'],
    scenePreferences: profile.scenes,
    creativePreferences,
    customRequirements: customRequirements.trim(),
    pendingConfirmation,
    ignoredTemplateErrors,
  };
}

function buildAngle(index, cycle = 1) {
  const shifted = index + Math.max(0, cycle - 1) * 7;
  return {
    id: `A${String(index + 1).padStart(2, '0')}-C${cycle}`,
    productOrientation: PRODUCT_ORIENTATIONS[shifted % PRODUCT_ORIENTATIONS.length],
    cameraDirection: CAMERA_DIRECTIONS[(Math.floor(index / 5) + shifted * 3) % CAMERA_DIRECTIONS.length],
    elevation: ELEVATIONS[index % ELEVATIONS.length],
    distance: DISTANCES[(index * 2 + Math.floor(index / 10) + cycle - 1) % DISTANCES.length],
    placement: PLACEMENTS[(index * 3 + Math.floor(index / 10) + cycle - 1) % PLACEMENTS.length],
  };
}

function personModeFor(index) {
  const slot = index % 5;
  if (slot < 2) return '人物正在真实使用商品，动作自然且不遮挡商品';
  if (slot === 2) return '人物位于商品侧面或后方，商品在前景完整突出';
  if (slot === 3) return '仅手部或局部人物与商品互动，但完整商品必须同时出现';
  return Math.floor(index / 5) % 2 === 0 ? '人物位于商品旁营造高级生活氛围，不能成为主角' : '本张不出现人物，以丰富豪华场景和道具形成差异化';
}

function buildCreativePlan(facts, options = {}) {
  const cycle = Math.max(1, Number(options.cycle) || 1);
  const profile = profileFor(facts.productName);
  const tasks = Array.from({ length: 50 }, (_, index) => {
    const round = Math.floor(index / 5) + 1;
    const slot = index % 5;
    const offset = index + cycle * 3;
    const luxuryBase = choose(LUXURY_SCENES, offset, '高级商业生活空间');
    return {
      imageNumber: index + 1,
      round,
      slot: slot + 1,
      salesRole: SALES_ROLES[slot],
      angle: buildAngle(index, cycle),
      personMode: personModeFor(index),
      person: slot === 4 && round % 2 === 0 ? '无人物' : `${choose(PERSON_TYPES, offset * 3, '虚构人物')}，穿${choose(APPAREL, offset * 7, '高级日常服装')}`,
      action: choose(profile.actions, offset * 2 + slot, '自然使用商品'),
      scene: `${luxuryBase}中的${choose(profile.scenes, offset * 3 + slot, '真实使用区域')}`,
      props: choose(profile.props, offset + round, '丰富高级生活道具'),
      lighting: choose(LIGHTING, offset * 4 + slot, '通透商业光线'),
      sellingPoint: choose(profile.benefits, offset + slot, '商品用途清晰直观'),
      mainImageRule: '商品完整、清晰、醒目、一眼可见；人物、动物和道具不得遮挡或弱化商品；本图可独立作为Temu商品主图',
    };
  });
  const signatures = new Set(tasks.map((task) => JSON.stringify(task.angle)));
  if (signatures.size !== 50) throw new Error('创意角度规划未能生成50个唯一组合');
  return { schemaVersion: 1, engineVersion: CREATIVE_ENGINE_VERSION, generatedAt: new Date().toISOString(), sourceFingerprint: facts.sourceFingerprint, cycle, productId: facts.productId, productName: facts.productName, taskCount: tasks.length, peopleTaskCount: tasks.filter((task) => task.person !== '无人物').length, uniqueAngleCount: signatures.size, tasks };
}

function factsPrompt(facts) {
  const lines = [
    `商品名称：${facts.productName}`, `身份锚点：${facts.identityAnchor}`,
    facts.quantity ? `确认数量：${facts.quantity}` : '数量：如TXT存在冲突或未确认，严格按照参考图，不主动增加、删除或声明数量',
    facts.appearanceFacts.length ? `已确认外观事实：${facts.appearanceFacts.join('；')}` : '',
    facts.requiredElements.length ? `必须保留：${facts.requiredElements.join('；')}` : '',
    facts.confirmedSellingPoints.length ? `可表现卖点：${facts.confirmedSellingPoints.join('；')}` : '',
    `禁止改变：${facts.forbiddenChanges.join('；')}`,
    facts.creativePreferences.length ? `创意偏好：${facts.creativePreferences.join('；')}` : '',
    facts.customRequirements ? `用户补充创意要求：${facts.customRequirements}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function taskPrompt(task) {
  const a = task.angle;
  return `图片${task.slot}（总计划第${task.imageNumber}张，角度编号${a.id}）：\n- 销售作用：${task.salesRole}\n- 商品与镜头：商品${a.productOrientation}；摄影机位于${a.cameraDirection}；${a.elevation}；${a.distance}；${a.placement}\n- 人物：${task.person}；${task.personMode}\n- 动作：${task.action}\n- 场景：${task.scene}\n- 光线与道具：${task.lighting}；可加入${task.props}\n- 本张卖点：${task.sellingPoint}\n- 主图底线：${task.mainImageRule}`;
}

function buildRoundPrompt(facts, plan, round, globalRequirements = '') {
  const selected = plan.tasks.filter((task) => task.round === round);
  if (selected.length !== 5) throw new Error(`第${round}轮创意任务不是5张`);
  return [`【商品事实（已从原TXT安全提取，原文件未修改）】`, factsPrompt(facts), globalRequirements ? `【本批次补充创意要求】\n${globalRequirements.trim()}` : '', `【第${round}轮五张差异化创意任务】`, ...selected.map(taskPrompt), FIXED_FIVE_IMAGE_PROMPT].filter(Boolean).join('\n\n');
}

async function atomicWrite(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, content, 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; } }
function reportText(facts) {
  const lines = [
    `商品：${facts.productName}`, `提取时间：${facts.generatedAt}`, `来源指纹：${facts.sourceFingerprint}`, '',
    '原始TXT保护：原文件未覆盖、未重命名、未删除。智能模式不会把原始模板全文直接发送给GPT。', '',
    `确认数量：${facts.quantity ?? '未确认，以参考图为准'}`,
    `外观事实：${facts.appearanceFacts.length ? facts.appearanceFacts.join('；') : '未从TXT确认，严格以参考图为准'}`,
    `使用与场景：${facts.scenePreferences.join('；')}`,
    `可表现卖点：${facts.confirmedSellingPoints.join('；')}`, '',
    '待确认问题：', ...(facts.pendingConfirmation.length ? facts.pendingConfirmation.map((item) => `- ${item.field}：${item.reason}（候选：${item.candidates.join('、')}）`) : ['- 无']), '',
    '已忽略的疑似模板错误：', ...(facts.ignoredTemplateErrors.length ? facts.ignoredTemplateErrors.map((item) => `- ${item}`) : ['- 无']), '',
    `如需增加或覆盖创意要求，请在商品目录创建“${CUSTOM_REQUIREMENTS_FILE}”；原始商品资料TXT仍可正常修改。`,
  ];
  return `${lines.join('\r\n')}\r\n`;
}

async function archiveManagedFiles(configDir, previousFingerprint) {
  if (!previousFingerprint) return;
  const history = path.join(configDir, '历史版本', `${new Date().toISOString().replace(/[:.]/g, '-')}-${previousFingerprint.slice(0, 8)}`);
  const managed = ['商品事实.json', '提取报告.txt', '来源指纹.json', '创意计划.json'];
  for (const name of managed) { const source = path.join(configDir, name); if (fs.existsSync(source)) { await fsp.mkdir(history, { recursive: true }); await fsp.copyFile(source, path.join(history, name)); } }
}

async function prepareProductCreativeFiles(product, options = {}) {
  const fingerprint = await sourceFingerprint(product);
  const configDir = path.join(product.dir, CONFIG_DIR_NAME);
  const fingerprintFile = path.join(configDir, '来源指纹.json');
  const previous = await readJson(fingerprintFile);
  let facts = await readJson(path.join(configDir, '商品事实.json'));
  const sourceChanged = !previous || previous.sourceFingerprint !== fingerprint || !facts || facts.engineVersion !== CREATIVE_ENGINE_VERSION;
  if (sourceChanged) {
    await archiveManagedFiles(configDir, previous?.sourceFingerprint);
    facts = await extractProductFacts(product, fingerprint);
    await atomicWrite(path.join(configDir, '商品事实.json'), `${JSON.stringify(facts, null, 2)}\n`);
    await atomicWrite(path.join(configDir, '提取报告.txt'), reportText(facts));
    await atomicWrite(fingerprintFile, `${JSON.stringify({ schemaVersion: 1, engineVersion: CREATIVE_ENGINE_VERSION, sourceFingerprint: fingerprint, sourceFiles: facts.sourceFiles, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  const plan = buildCreativePlan(facts, options);
  await atomicWrite(path.join(configDir, '创意计划.json'), `${JSON.stringify(plan, null, 2)}\n`);
  return { configDir, fingerprint, sourceChanged, facts, plan };
}

module.exports = { CREATIVE_ENGINE_VERSION, CONFIG_DIR_NAME, CUSTOM_REQUIREMENTS_FILE, FIXED_FIVE_IMAGE_PROMPT, normalizeProductName, quantityCandidates, extractProductFacts, buildCreativePlan, buildRoundPrompt, prepareProductCreativeFiles, sourceFingerprint };
