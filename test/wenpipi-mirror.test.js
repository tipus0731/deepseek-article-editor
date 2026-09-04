#!/usr/bin/env node
/* wenpipi-mirror 一致性测试：证明「工具判重 = 文皮皮·河图引擎原文件」。
 * 直接加载仓库内打包的文皮皮引擎（public/wenpipi-engine.js = engine/qm.copy.core.js?v=2024111101 原样），
 * 与 app.js 的 textSimilarity 在相同输入下逐位对比；同时校验引擎已接入产品链路。 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

/* 1) 加载打包引擎（与 /sim worker 同一文件；Node 下用 self 垫片 + 显式 this） */
const engineSrc = fs.readFileSync(path.join(root, 'public', 'wenpipi-engine.js'), 'utf8');
globalThis.self = globalThis;
const m = new Function(engineSrc + '\nreturn { QmWppCopeEngine, diff_match_patch };').call(globalThis);
delete globalThis.self;
if (!m || !m.QmWppCopeEngine || typeof m.QmWppCopeEngine.CompareText !== 'function') {
  throw new Error('wenpipi-engine.js 未暴露 QmWppCopeEngine.CompareText');
}
globalThis.diff_match_patch = m.diff_match_patch; // 供 app.js textSimilarity 兜底路径使用

/* 2) 加载产品判重函数（app.js 判重段） */
const appjs = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const s = appjs.indexOf('/* ================= 判重（与文皮皮·河图引擎');
const e = appjs.indexOf('/* 判重挡位切换');
if (s < 0 || e < 0) throw new Error('app.js 判重段定位失败');
globalThis.__textSimilarity = new Function('storeGet', 'diff_match_patch', appjs.slice(s, e) + '\nreturn textSimilarity;')(() => null, globalThis.diff_match_patch);

/* 3) 加载产品清洗（与产品同源） */
const sjs = fs.readFileSync(path.join(root, 'public', 'smart-rewrite.js'), 'utf8');
function extractFn(src, name) {
  const st = src.indexOf('function ' + name + '(');
  const o = src.indexOf('{', st);
  let d = 0;
  for (let j = o; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) return src.slice(st, j + 1); } }
  throw new Error('未找到 ' + name);
}
const clean = new Function(extractFn(sjs, 'pureText') + '\nreturn pureText;')();

/* 4) 引擎直调（与 /sim 页面完全相同的消息） */
function engineSim(t1, t2, level) {
  const out = { workerId: 0, moduleId: 'compare', msgBody: { subModuleId: 'result', dsHtml: '', similarity: 0 } };
  m.QmWppCopeEngine.CompareText({ workerId: 0, moduleId: 'compare', isSpeed: level, inputText1: t1, inputText2: t2 }, out);
  return parseFloat(out.msgBody.similarity);
}
function localSim(a, b, level) { return parseFloat((globalThis.__textSimilarity(a, b, level) * 100).toFixed(2)); }

/* 5) 用例：三篇文章（文皮皮口径） + 引擎行为边界 */
const cases = [
  { name: '案例1 丁俊晖/赵心童', a: ['丹尼尔·威尔斯问赵心童，你的杆子是不是涩手啊？赵公子微笑着说，是有点涩手[捂脸]','英国最近是不是下雨了？擦杆子的声音观众都能听见。','威尔斯也看到赵公子老是逛袋，他自己失误也特别多[流泪]','尽管是赵公子4:2赢了晋级32强，','但是没怎么发力，这种随机赛制挺好玩，匹配到对手实力一般，没给到赵公子压力，前三轮是太轻松了有点。','丁俊晖没能坚持下去，直接1:4脆败给博伊科了，有点可惜![流泪]','吕昊天发力了，4:2击败威尔士的杜安·琼斯，晋级到16强，给昊哥点赞![赞]','常冰玉夺冠后遗症[捂脸]，1:4不敌威尔士的杰克·琼斯，稳定性还需加强![看]','拿一次冠军🏆是有偶然性的，斯诺克球员必须保持高度的专注，大家技术差不了多少，世界前128的其实都很准，无非就是看谁在场上手更稳，精神更集中!','静下心来磨炼球技才是长久之道!'].join('\n'), b: '丁俊晖1:4，赵心童4:2。\n\n同一片球台，两种收场。\n\n赵心童的杆子有点涩手，擦杆声被直播收得清清楚楚。\n\n英国最近潮气重，球杆发涩，手感也受影响。\n\n威尔斯自己失误一堆，没给赵心童上强度。\n\n4:2晋级32强，赵心童前三轮都没碰上硬茬，赢得轻巧。\n\n吕昊天4:2拿下威尔士的杜安·琼斯，进了16强。\n\n常冰玉1:4输给杰克·琼斯，夺冠之后那口气没接上。\n\n斯诺克这行，128个人个个有准头。\n\n真站到台子上，拼的是谁手不抖、心不散。\n\n赵心童这状态，下一轮遇到硬手，你押他晋级吗？' },
  { name: '案例2 赵心童帮主', a: ['为啥赵心童是中国斯诺克新的帮主？','看看英格兰公开赛大家的表现？','光明左使吴宜泽输球出局了，','光明右使常冰玉输球也被淘汰了，','前任帮主丁俊辉输球也打道回府了！','紫衫龙王白雨露拼到了最后，也输球了！','白眉鹰王肖国栋同教比武，也输球了！','青翼蝠王周跃龙资格赛就古德拜了！','','目前只剩下，','金毛狮王达达虎和赵公子一起并肩奋战了！','这一战就像水浒梁上好汉一样，','征方腊说损兵折将！'].join('\n'), b: '英格兰公开赛打到现在，中国选手就剩俩人了。\n\n吴宜泽没顶住，常冰玉也没顶住，丁俊晖跟着回了家。白雨露是几个人里撑得最久的，最后还是没赢。肖国栋同门这场球，也输了。周跃龙更早，资格赛就出局了。一个接一个，全掉下去了。\n\n现在签表上还在的，一个赵心童，一个达达虎。\n\n这一路下来，像梁山好汉征方腊，折了不少人。\n\n赵心童这个新“帮主”，你看他能当多久？' },
  { name: '案例3 王欣瑜', a: ['王欣瑜的状态真的始终成迷？一会儿好，一会儿不好，明明第二盘能6:2爆虐对手了，第三盘接发球、回球又这么软了！','目前，她和卡琳斯卡娅的比赛进入到决胜盘的争夺，对手4:1暂时领先，有一个破发球局的优势，接下去的几个发球局，王欣瑜再不能有任何的松懈了，如果再被破一个，那就真的一点机会都没有了。','争取回破对手一个，王欣瑜，加油。你可是我们中国的“一姐”！！！'].join('\n'), b: '刷到王欣瑜决胜盘的比分，心里紧了一下。第二盘还6:2，打得干脆利落。\n\n第三盘回来，接发球质量突然往下掉，回球软，落点也压不住。卡琳斯卡娅已经4:1领先，手上还多一个破发优势。\n\n王欣瑜现在每一步都在悬崖边。后面自己的发球局，一个都不能再丢。再被破一次，这盘就真的没得打了。\n\n先别想整盘，先盯着眼前这一局，想办法破回来一个。把第二盘那个节奏找回来。\n\n你说这盘，还能不能翻过来？' },
];

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log('  ✓ ' + label);
  else { failures++; console.error('  ✗ ' + label + (detail ? '  → ' + detail : '')); }
}
console.log('== 镜像一致性：工具判重 vs 文皮皮引擎原文件（同一输入） ==');
for (const cse of cases) {
  const A = clean(cse.a);
  const B = clean(cse.b);
  for (const lv of [1, 2, 3]) {
    const loc = localSim(A, B, lv);
    const eng = engineSim(A, B, lv);
    check(cse.name + '（挡位' + lv + '）本地=' + loc + '% vs 引擎=' + eng + '%', Math.abs(loc - eng) < 0.005, '差值 ' + Math.abs(loc - eng).toFixed(4));
  }
}
console.log('== 引擎行为边界（同样必须一致） ==');
const edges = [
  ['完全相同', '经济下行周期里，稳健比激进更重要，现金流是企业的生命线。', '经济下行周期里，稳健比激进更重要，现金流是企业的生命线。'],
  ['包含关系', '春天来了，万物复苏，公园里的樱花开了，孩子们在草地上放风筝。', '万物复苏'],
  ['其一为空', '', 'abc'],
  ['完全无关', 'aaaa', 'bbbbbbbbbbbb'],
  ['负值样张', '甲'.repeat(30) + '碎片' + '乙'.repeat(30) + '碎片' + '丙'.repeat(30), '孑'.repeat(40) + '碎片' + '丑'.repeat(15) + '碎片' + '寅'.repeat(40)],
];
for (const [name, a, b] of edges) {
  const loc = localSim(a, b, 1);
  const eng = engineSim(a, b, 1);
  check('边界·' + name + ' 本地=' + loc + '% vs 引擎=' + eng + '%', Math.abs(loc - eng) < 0.005, '差值 ' + Math.abs(loc - eng).toFixed(4));
}
console.log('== 产品链路已接入引擎 ==');
check('app.js 判重委托 QmWppCopeEngine.CompareText', appjs.includes('QmWppCopeEngine.CompareText'));
check('index.html 引入 wenpipi-engine.js', fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8').includes('wenpipi-engine.js'));
check('引擎文件非空且为原文件（含 diff_match_patch + 段落检测）', engineSrc.includes('QmWppCopeEngine') && engineSrc.includes('CompareTextParagraphs') && engineSrc.length > 20000);
if (failures) { console.log('\n❌ ' + failures + ' 项失败'); process.exit(1); }
console.log('\n✅ 全部通过：工具判重 = 文皮皮引擎原文件（内容一致）');
