'use strict';

/* ================= 元素引用 ================= */
const $ = (id) => document.getElementById(id);
const els = {
  apiKey: $('apiKey'), toggleKey: $('toggleKey'), model: $('model'),
  serverKeyBadge: $('serverKeyBadge'), keyField: $('keyField'),
  inputText: $('inputText'), inputCount: $('inputCount'), inputWarn: $('inputWarn'),
  panePaste: $('pane-paste'), paneLink: $('pane-link'),
  linkUrl: $('linkUrl'), fetchBtn: $('fetchBtn'), linkResult: $('linkResult'),
  wordChips: $('wordChips'), wordInput: $('wordInput'), addWord: $('addWord'),
  loadPreset: $('loadPreset'), clearWords: $('clearWords'),
  style: $('style'), length: $('length'), targetLenField: $('targetLenField'),
  targetLen: $('targetLen'), audience: $('audience'),
  optAd: $('optAd'), optProof: $('optProof'), optHead: $('optHead'), optFact: $('optFact'),
  customReq: $('customReq'),
  status: $('status'),
  outResult: $('outResult'), outDiff: $('outDiff'), diffBody: $('diffBody'),
  outEmpty: $('outEmpty'), outCount: $('outCount'),
  copyBtn: $('copyBtn'), downloadBtn: $('downloadBtn'), clearOut: $('clearOut'),
  reasonBox: $('reasonBox'), reasonText: $('reasonText'),
  sampleBtn: $('sampleBtn'),
  modeBanner: $('modeBanner'),
  thinking: $('thinking'), effort: $('effort'), effortField: $('effortField'),
  apiBase: $('apiBase'), customModel: $('customModel'),
  saveModelBtn: $('saveModelBtn'), resetModelBtn: $('resetModelBtn'),
  linkArticle: $('linkArticle'), linkTitle: $('linkTitle'), linkSourceTag: $('linkSourceTag'),
  sysPrompt: $('sysPrompt'), dedupPrompt: $('dedupPrompt'),
  savePromptsBtn: $('savePromptsBtn'), resetPromptsBtn: $('resetPromptsBtn'),
  promptGroupSel: $('promptGroupSel'), newGroupBtn: $('newGroupBtn'), delGroupBtn: $('delGroupBtn'),
  useTextBtn: $('useTextBtn'),
  imgPanel: $('imgPanel'), imgGrid: $('imgGrid'),
  wmPos: $('wmPos'), wmRatio: $('wmRatio'), wmRatioVal: $('wmRatioVal'),
  autoCropChk: $('autoCropChk'),
  cropAllBtn: $('cropAllBtn'), downloadAllBtn: $('downloadAllBtn'),
};

const API_BASE = 'https://api.deepseek.com';
let DIRECT = location.protocol === 'file:' || location.protocol === 'about:';

/* ================= 本地持久化存储（Android 用 SharedPreferences，网页用 localStorage） =================
 * 目的：API Key / 提示词等数据存本地，APK 覆盖升级不丢失。
 */
function storeGet(key) {
  if (window.AndroidBridge && typeof window.AndroidBridge.getPref === 'function') {
    return window.AndroidBridge.getPref(key);
  }
  try { return localStorage.getItem(key); } catch { return null; }
}
function storeSet(key, value) {
  if (window.AndroidBridge && typeof window.AndroidBridge.savePref === 'function') {
    window.AndroidBridge.savePref(key, value);
    return;
  }
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
function storeRemove(key) {
  if (window.AndroidBridge && typeof window.AndroidBridge.removePref === 'function') {
    window.AndroidBridge.removePref(key);
    return;
  }
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
const IS_ANDROID = typeof window.AndroidBridge !== 'undefined';

/* ================= 软件试用期限制（到期禁用） =================
 * 到期时间：2026-08-20 00:00（北京时间）= 2026-08-19T16:00:00Z
 * 到期后：页面弹遮罩、按钮禁用，核心函数全部拦截（改日期请改下面这一处）。
 */
const EXPIRY_MS = Date.parse('2026-08-19T16:00:00Z'); // 1787155200000
function isExpired() { return Date.now() >= EXPIRY_MS; }
function enforceExpiry() {
  if (!isExpired()) return false;
  document.body.classList.add('expired-lock');
  const ov = document.createElement('div');
  ov.id = 'expiryOverlay';
  ov.innerHTML =
    '<div class="expiry-box">' +
    '<div class="expiry-title">🚫 软件已到期</div>' +
    '<p>本软件试用期已于 <b>2026年8月20日</b> 到期，功能已停止使用。</p>' +
    '<p>如需继续使用，请联系开发者授权。</p>' +
    '</div>';
  document.body.appendChild(ov);
  ['runBtn', 'smartBtn', 'saveWordBtn', 'fetchBtn', 'copyBtn', 'downloadBtn', 'useTextBtn', 'cropAllBtn', 'downloadAllBtn', 'sampleBtn']
    .forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = true; });
  return true;
}
enforceExpiry();

// Android 打包版：把 Blob 转 base64 交给原生桥保存到相册/下载目录（分块传输，大文件安全）
function saveBlobAndroid(blob, name, kind) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = String(reader.result).split(',')[1] || '';
        const isImg = kind === 'image';
        if (window.AndroidBridge.beginSave) {
          window.AndroidBridge.beginSave(name, isImg);
          const CHUNK = 0x3000;
          for (let i = 0; i < b64.length; i += CHUNK) {
            window.AndroidBridge.appendChunk(b64.slice(i, i + CHUNK));
          }
          window.AndroidBridge.endSave();
        } else if (isImg) {
          window.AndroidBridge.saveImage(b64, name);
        } else {
          window.AndroidBridge.saveText(b64, name);
        }
        resolve();
      } catch (e) { reject(e); }
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
}

// 直连模式下抓取网页使用的公共跨域代理（自动逐个尝试）
const PROXIES = [
  { name: 'corslol', build: (u) => 'https://api.cors.lol/?url=' + encodeURIComponent(u) },
  { name: 'allorigins-json', build: (u) => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u) },
  { name: 'allorigins', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  { name: 'corsproxy.io', build: (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u) },
  { name: 'codetabs', build: (u) => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u) },
];
const tabBtns = Array.from(document.querySelectorAll('.tab'));
const segBtns = Array.from(document.querySelectorAll('.seg-btn'));

const PRESET_WORDS = ['国家级', '最高级', '最佳', '顶级', '极致', '独一无二', '全网最低', '销量第一', '史上最强'];

const SAMPLE_ARTICLE = [
  '标题：XX智能手环 X9 全新上市，行业最佳之选',
  '',
  '好消息！XX智能手环 X9 今天正式开售啦！作为国内销量第一的智能穿戴产品，X9 采用了独家研发的第三代光学传感器，心率监测精准度达到了行业最高水平，绝对让你满意。',
  '',
  '产品亮点：',
  '1. 14 天超长续航，充电 10 分钟可用一周，全网最低功耗，充电速度世界第一。',
  '2. 1.43 英寸 AMOLED 屏幕，阳光下依然清晰可见，极致轻薄，佩戴毫无负担。',
  '3. 支持 120+ 运动模式，防水等级 IP68，游泳、跑步、骑行一网打尽。',
  '',
  '现在下单立减 50 元，仅限今天！错过今天就要再等一年！我们敢承诺，这是市面上最好的手环，没有之一。赶快点击下方链接抢购吧！',
].join('\n');

/* ================= 状态 ================= */
let activeTab = 'paste';
let running = false;
let abort = null;
let lastOriginal = '';
let outputText = '';
let currentView = 'result';
let timerStart = 0;
let timerInterval = null;

/* ================= 通用工具 ================= */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function flash(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
function setStatus(text, cls) {
  els.status.textContent = text || '';
  els.status.className = 'status' + (cls ? ' ' + cls : '');
  els.status.classList.toggle('hidden', !text);
}
function setRunning(v) {
  running = v;
  if (els.runBtn && els.stopBtn) {
    els.runBtn.classList.toggle('hidden', v);
    els.stopBtn.classList.toggle('hidden', !v);
  }
}
function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + ' 秒';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m + ' 分 ' + sec + ' 秒';
}
function startTimer(prefix) {
  timerStart = Date.now();
  if (timerInterval) clearInterval(timerInterval);
  setStatus(prefix, 'loading');
  timerInterval = setInterval(() => {
    setStatus(prefix + '（已用时 ' + formatDuration(Date.now() - timerStart) + '）', 'loading');
  }, 500);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  return Date.now() - timerStart;
}

/* ================= 浏览器端网页抓取（直连模式） ================= */
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ensp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'");
}
function detectCharset(contentType, buf) {
  let m = contentType.match(/charset=([\w-]+)/i);
  if (m) return m[1].toLowerCase() === 'gb2312' ? 'gbk' : m[1].toLowerCase();
  const head = new TextDecoder('utf-8').decode(buf.slice(0, 2048));
  m = head.match(/charset=["']?([\w-]+)/i);
  if (m) return m[1].toLowerCase() === 'gb2312' ? 'gbk' : m[1].toLowerCase();
  return 'utf-8';
}
function extractArticleText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 120) : '';
  let h = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|iframe|svg|nav|header|footer|aside|form|button|select|input|textarea|video|audio|canvas|template|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = decodeEntities(h)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  const text = lines.join('\n').slice(0, 30000);
  return { title, text };
}
function extractToutiaoFromHtml(html) {
  const idx = html.search(/(?:id|class)="[^"]*article-content[^"]*"/i);
  if (idx < 0) return null;
  const start = html.indexOf('>', idx) + 1;
  let seg = html.slice(start, start + 80000);
  let endMatch = seg.search(/<(div|section|footer)[^>]*(?:class|id)="[^"]*(?:article-tag|article-bottom|article-footer|author-box|user-card|article-vote|article-comment|article-recommend|recommend|feed-card|hot-board|related)[^"]*"/i);
  if (endMatch > 0) seg = seg.slice(0, endMatch);
  else {
    const guard = seg.search(/(?:id|class)="[^"]*(?:recommend|feed-card|hot-board|article-footer|related-news)[^"]*"/i);
    if (guard > 0) seg = seg.slice(0, guard);
  }

  const paragraphs = [];
  const images = [];
  let m;
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = pRe.exec(seg)) !== null) {
    const inner = m[1]
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<img[^>]*>/gi, (tag) => (pickImageUrlJs(tag) ? ' [图片] ' : ''))
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (inner) paragraphs.push(inner);
  }
  const imgRe = /<img[^>]*>/gi;
  while ((m = imgRe.exec(seg)) !== null) {
    const u = pickImageUrlJs(m[0]);
    if (u) images.push(u);
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 120) : '';
  return {
    title,
    text: paragraphs.join('\n').slice(0, 30000),
    images: [...new Set(images)].slice(0, 30),
  };
}
function attrValueJs(tag, attr) {
  let m = tag.match(new RegExp(attr + '=\"([^\"]*)\"', 'i'));
  if (m && m[1]) return m[1];
  m = tag.match(new RegExp(attr + "='([^']*)'", 'i'));
  return m && m[1] ? m[1] : null;
}
function pickImageUrlJs(tag) {
  let url = attrValueJs(tag, 'data-img-url');
  if (url == null) url = attrValueJs(tag, 'data-src');
  if (url == null) url = attrValueJs(tag, 'src');
  if (!url || !/^https?:/i.test(url.trim())) return null;
  const u = url.trim().toLowerCase();
  const bad = ['emoji', 'icon', 'logo', 'avatar', 'badge', 'favicon', 'loading', 'spinner', 'placeholder', 'smiley', 'sticker'];
  for (const b of bad) if (u.includes(b)) return null;
  return url.trim();
}
/* ================= 今日头条：info 接口 / 移动端 RENDER_DATA 备用解析（桌面页常被 JS 反爬挑战拦截） ================= */
function toutiaoArticleId(url) {
  let m = /\/article\/(\d{6,})/i.exec(String(url));
  if (m) return m[1];
  m = /\/w\/(\d{6,})/i.exec(String(url)); // 微头条 /w/ 格式
  if (m) return m[1];
  m = /\/i(\d{6,})/i.exec(String(url));
  if (m) return m[1];
  // 兜底：URL 中任意 6 位以上数字串（覆盖 /note/ /item/ 等新格式）
  m = /(\d{6,})/.exec(String(url));
  return m ? m[1] : null;
}
function toutiaoHtmlToResult(contentHtml, title) {
  const paragraphs = [];
  const images = [];
  let seg = String(contentHtml).replace(/<img[^>]*>/gi, (tag) => (pickImageUrlJs(tag) ? ' [图片] ' : ''));
  seg = seg
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const line of seg.split('\n')) {
    const l = line.trim();
    if (l) paragraphs.push(l);
  }
  String(contentHtml).replace(/<img[^>]*>/gi, (tag) => {
    const u = pickImageUrlJs(tag);
    if (u) images.push(u);
    return '';
  });
  return { title: String(title || '').slice(0, 120), text: paragraphs.join('\n'), images: [...new Set(images)].slice(0, 30) };
}
function extractToutiaoRenderDataJs(html) {
  const m = /<script id="RENDER_DATA" type="application\/json">([\s\S]*?)<\/script>/i.exec(String(html));
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
  const info = (obj && obj.articleInfo) || null;
  if (!info) return null;
  let content = '';
  try { content = String(info.content || ''); } catch { /* ignore */ }
  if (!content || !content.replace(/<[^>]+>/g, '').trim()) return null;
  let title = '';
  try { title = String(info.title || ''); } catch { /* ignore */ }
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!title && t) title = decodeEntities(t[1].trim());
  return { content, title };
}

async function directFetchArticle(url) {
  if (isExpired()) throw new Error('软件已到期，功能已停止使用');
  // 头条优先走 info 接口 / 移动端 RENDER_DATA（公共代理也能抓到）
  let ttHost = false;
  let ttId = null;
  try { ttHost = /(^|\.)toutiao\.com$/i.test(new URL(url).hostname); } catch { /* ignore */ }
  if (ttHost) ttId = toutiaoArticleId(url);
  if (ttId) {
    // 免费公共代理常被限流（429/408），重试两轮，轮间延时 1.5s
    for (let round = 0; round < 2; round++) {
    for (const via of [
      { kind: 'info', target: 'https://m.toutiao.com/i' + ttId + '/info/' },
      { kind: 'render', target: 'https://m.toutiao.com/i' + ttId + '/' },
    ]) {
      for (const p of PROXIES) {
        try {
          const res = await fetch(p.build(via.target), { signal: AbortSignal.timeout(25000) });
          if (!res.ok) continue;
          const buf = new Uint8Array(await res.arrayBuffer());
          if (via.kind === 'info') {
            let raw = new TextDecoder('utf-8').decode(buf);
            let j = null;
            try {
              j = JSON.parse(raw);
              // allorigins /get 返回 {"contents":"<json字符串>"}，需要解开一层
              if (j && typeof j.contents === 'string' && /^[\s]*[{[]/.test(j.contents)) j = JSON.parse(j.contents);
            } catch { j = null; }
            const d = (j && j.data) || {};
            let content = String(d.content || '');
            let title = String(d.title || '');
            let extraImages = [];
            // 微头条（/w/ 链接）：正文在 thread.thread_base，图片在 large_image_list
            if (!content.replace(/<[^>]+>/g, '').trim()) {
              const tb = d.thread && d.thread.thread_base;
              if (tb) {
                content = String(tb.content || tb.title || '');
                if (!title) title = String(tb.title || '');
                const list = tb.large_image_list;
                if (Array.isArray(list)) {
                  for (const it of list) {
                    const u = it && typeof it === 'object' ? String(it.url || '') : String(it || '');
                    if (u && pickImageUrlJs('<img src="' + u + '">')) extraImages.push(u);
                  }
                }
              }
            }
            if (content && content.replace(/<[^>]+>/g, '').trim()) {
              const r2 = toutiaoHtmlToResult(content, title);
              const allImgs = [...new Set([...(r2.images || []), ...extraImages])].slice(0, 30);
              if (r2.text || allImgs.length) return { title: r2.title, text: r2.text, images: allImgs, url, via: p.name, source: 'toutiao' };
            }
          } else {
            let html = new TextDecoder('utf-8').decode(buf);
            try {
              const w = JSON.parse(html);
              if (w && typeof w.contents === 'string' && w.contents.includes('<')) html = w.contents;
            } catch { /* 普通 HTML */ }
            const rd = extractToutiaoRenderDataJs(html);
            if (rd) {
              const r2 = toutiaoHtmlToResult(rd.content, rd.title);
              if (r2.text || r2.images.length) return { title: r2.title, text: r2.text, images: r2.images, url, via: p.name, source: 'toutiao' };
            }
          }
        } catch { /* 下一个代理 */ }
      }
    }
    if (round === 0) await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  let lastErr = null;
  for (const p of PROXIES) {
    try {
      const res = await fetch(p.build(url), { signal: AbortSignal.timeout(25000) });
      if (!res.ok) { lastErr = new Error(p.name + ' 返回 HTTP ' + res.status); continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      const charset = detectCharset(res.headers.get('content-type') || '', buf);
      const html = new TextDecoder(charset).decode(buf);
      const tt = extractToutiaoFromHtml(html);
      if (tt && (tt.text || tt.images.length)) {
        return { title: tt.title, text: tt.text, images: tt.images, url, via: p.name, source: 'toutiao' };
      }
      const extracted = extractArticleText(html);
      if (extracted.text) {
        return { title: extracted.title, text: extracted.text, images: [], url, via: p.name };
      }
      lastErr = new Error(p.name + ' 未能提取到正文');
    } catch (e) {
      lastErr = e;
    }
  }
  if (ttHost) {
    throw new Error(
      '网页直连模式抓取头条失败：公共代理被限流或拦截（' + (lastErr ? lastErr.message : '未知错误') + '）。' +
      '头条对无 cookie 请求和代理 IP 限制严格，请改用以下任一方式：① 安装 APK（原生通道最稳）；② 用 node server.js 启动本地服务模式；③ 直接复制文章文本粘贴。'
    );
  }
  throw new Error(
    '所有公共代理均失败（' + (lastErr ? lastErr.message : '未知错误') + '）。' +
    '该网站可能禁止代理访问或为动态渲染页面；可改用 node server.js 本地服务模式，或直接复制文本粘贴。'
  );
}

/* ================= 禁止词管理 ================= */
function getWords() {
  try {
    const w = JSON.parse(storeGet('dsw_words') || 'null');
    if (Array.isArray(w)) return w.filter(Boolean);
  } catch { /* ignore */ }
  return [...PRESET_WORDS];
}
function saveWords(words) {
  storeSet('dsw_words', JSON.stringify(words));
}
function renderWords() {
  els.wordChips.innerHTML = '';
  const words = getWords();
  if (!words.length) {
    els.wordChips.innerHTML = '<span class="chip-empty">未设置禁止词（可选）</span>';
    return;
  }
  words.forEach((w, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = escapeHtml(w) + '<button class="chip-x" type="button" title="移除">×</button>';
    chip.querySelector('.chip-x').addEventListener('click', () => {
      const arr = getWords();
      arr.splice(i, 1);
      saveWords(arr);
      renderWords();
    });
    els.wordChips.appendChild(chip);
  });
}
function addWord() {
  const v = els.wordInput.value.trim();
  if (!v) return;
  const arr = getWords();
  if (arr.includes(v)) { flash('该词已存在'); return; }
  arr.push(v);
  saveWords(arr);
  els.wordInput.value = '';
  renderWords();
}

/* ================= 输入来源与字数 ================= */
function getSourceText(silent) {
  let v = '';
  if (activeTab === 'link') {
    v = els.linkResult.value.trim();
    if (!v && !silent) flash('链接正文为空，请先「抓取正文」，或切回「粘贴文本」', true);
  } else {
    v = els.inputText.value.trim();
  }
  return v;
}
function updateCounts() {
  const src = activeTab === 'link' ? els.linkResult.value : els.inputText.value;
  const n = src.replace(/\s/g, '').length;
  els.inputCount.textContent = n + ' 字';
  els.inputWarn.classList.toggle('hidden', n <= 30000);
  const m = outputText.replace(/\s/g, '').length;
  els.outCount.textContent = m + ' 字';
}

/* ================= 页签 ================= */
function switchTab(name) {
  activeTab = name;
  tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  els.panePaste.classList.toggle('hidden', name !== 'paste');
  els.paneLink.classList.toggle('hidden', name !== 'link');
  updateCounts();
}

/* ================= 提示词（默认值 + 本地自定义，存储在本地不受 APK 更新影响） ================= */
const DEFAULT_SYSTEM_PROMPT =
  '你是一位资深中文编辑，擅长在保持事实准确的前提下按规则修改文章。\n' +
  '硬性要求：\n' +
  '1. 只输出修改后的完整文章正文，不输出任何解释、总结或前后缀；\n' +
  '2. 不要用 Markdown 代码块包裹文章；\n' +
  '3. 保留原文的关键事实、数据、人名、时间与引用；\n' +
  '4. 输出应是一篇连贯、完整、可直接发布的文章。';
const DEFAULT_IMG_PROMPT = '若原文中包含 [图片] 标记，请在改写后的对应位置原样保留这些 [图片] 标记（每个标记单独占一行），以便后续把原图嵌入文档。';
const DEFAULT_DEDUP_PROMPT = '【降重要求】上一版与原文相似度 {sim}% 偏高（目标 ≤5%）。请进行更大程度的改写：调整句式结构、更换同义表达、重组段落顺序、增删过渡内容，但不得改变事实与数据，也不得编造。';
/* ---- 多组提示词（本地存储；旧版单组数据自动迁移为第一组） ---- */
const PROMPT_GROUPS_KEY = 'dsw_prompt_groups';
const PROMPT_ACTIVE_KEY = 'dsw_prompt_active';
function getPromptGroups() {
  try {
    const arr = JSON.parse(storeGet(PROMPT_GROUPS_KEY) || 'null');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* ignore */ }
  const legacy = {
    id: 'default', name: '默认组',
    sys: storeGet('dsw_sys_prompt') || '',
    img: storeGet('dsw_img_prompt') || '',
    dedup: storeGet('dsw_dedup_prompt') || '',
  };
  const groups = [legacy];
  storeSet(PROMPT_GROUPS_KEY, JSON.stringify(groups));
  return groups;
}
function getActiveGroup() {
  const groups = getPromptGroups();
  const activeId = storeGet(PROMPT_ACTIVE_KEY);
  return groups.find((g) => g.id === activeId) || groups[0];
}
function getSysPrompt() {
  const g = getActiveGroup();
  return g && g.sys && String(g.sys).trim() ? String(g.sys).trim() : DEFAULT_SYSTEM_PROMPT;
}
function getImgPrompt() {
  const g = getActiveGroup();
  return g && g.img && String(g.img).trim() ? String(g.img).trim() : DEFAULT_IMG_PROMPT;
}
function getDedupPrompt() {
  const g = getActiveGroup();
  return g && g.dedup && String(g.dedup).trim() ? String(g.dedup).trim() : DEFAULT_DEDUP_PROMPT;
}

/* ================= 规则 → Prompt ================= */
function buildMessages(text) {
  const words = getWords();
  const rules = [];

  if (words.length) {
    rules.push(
      '禁止词处理：修改后的文章中不得再出现以下禁止/敏感词：' + words.join('、') +
      '。处理方式：能替换的用合规、中性的表达替换；无法替换的改写所在句子以避开；确实无法避开的删除该句。修改完成后逐词检查，确保没有遗漏。'
    );
  }

  const styleMap = {
    formal: '正式、书面化，用词严谨，避免口语与夸张',
    plain: '平实易懂，句子简短，少用生僻词',
    casual: '轻松自然的口语风格，亲切不生硬',
    warm: '热情、有感染力，适当使用积极正向的表达',
  };
  if (els.style.value !== 'keep') rules.push('语气风格：将全文调整为「' + styleMap[els.style.value] + '」。');

  const target = parseInt(els.targetLen.value, 10) || 0;
  if (els.length.value === 'shrink') {
    rules.push(
      target > 0
        ? '篇幅：精简全文，目标约 ' + target + ' 字。删除冗余与重复表达，合并啰嗦段落，但关键事实、数据、结论不得删减。'
        : '篇幅：精简全文，删除冗余与重复表达，保留所有关键信息。'
    );
  } else if (els.length.value === 'expand') {
    rules.push(
      target > 0
        ? '篇幅：扩写全文至约 ' + target + ' 字。在不编造事实的前提下补充背景、细节与展开论述，保持逻辑连贯。'
        : '篇幅：在不编造事实的前提下适度扩写，补充背景与细节。'
    );
  }

  const custom = els.customReq.value.trim();
  if (custom) rules.push('用户自定义要求：' + custom);

  const opts = [];
  if (els.optAd.checked) opts.push('去除广告推广、营销话术与无关内容');
  if (els.optProof.checked) opts.push('修正错别字、语病与标点错误');
  if (els.optHead.checked) opts.push('将长文按主题分节，并为每节添加简洁小标题');
  if (els.optFact.checked) opts.push('保留原文的事实、数据、人名、时间与引用，不得编造或臆测');
  if (opts.length) rules.push('其他要求：' + opts.join('；') + '。');

  const audienceMap = { general: '普通大众', professional: '专业读者', consumer: '消费者/客户', student: '学生' };
  if (els.audience.value !== 'general') {
    rules.push('目标读者：面向「' + (audienceMap[els.audience.value] || '普通大众') + '」，据此调整用词深浅与解释详略。');
  }

  const system = getSysPrompt();

  const user =
    '请根据以下规则修改文章：\n' +
    rules.map((r, i) => (i + 1) + '. ' + r).join('\n') +
    '\n\n--- 文章开始 ---\n' + text + '\n--- 文章结束 ---';

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/* ================= 流式调用 DeepSeek ================= */
async function streamRewrite(body, signal, out) {
  // out = {text:''}（可选）：批量并发时传入，增量写入 out.text，不再写全局 outputText / 更新界面
  if (isExpired()) throw new Error('软件已到期，功能已停止使用');
  let res;
  if (DIRECT) {
    // 直连模式：默认 DeepSeek 官方，也支持自定义 OpenAI 兼容供应商
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) throw new Error('请先在右上角填写 API Key（sk-...）');
    const apiBase = (String(els.apiBase.value || '').trim().replace(/\/+$/, '') || API_BASE);
    if (!/^https?:\/\//i.test(apiBase)) throw new Error('API 地址格式无效，需以 http(s):// 开头');
    const model = (String(els.customModel.value || '').trim()) || body.model;
    const payload = { model: model, messages: body.messages, stream: true, temperature: 1.0 };
    if (model === 'deepseek-chat') payload.max_tokens = 8192;
    // 自定义供应商：按档位发送思考强度（官方 DeepSeek 由 deepseek-reasoner 自带思考，不传该参数）
    if (els.thinking.checked && !/api\.deepseek\.com$/i.test(apiBase)) {
      const map = { max: 'high', high: 'high', medium: 'medium', low: 'low' };
      const lv = map[els.effort.value] || 'high';
      payload.reasoning_effort = lv;
    }
    try {
      res = await fetch(apiBase + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('__ABORT__');
      throw new Error('无法连接 api.deepseek.com：' + e.message + '。请检查网络；若浏览器拦截跨域（CORS），请改用 node server.js 启动本地服务模式。');
    }
  } else {
    // 服务模式：经本地服务转发（附带供应商地址与思考强度）
    const apiBase = String(els.apiBase.value || '').trim();
    const effort = (els.thinking.checked && /^https?:\/\//i.test(apiBase) && !/api\.deepseek\.com$/i.test(apiBase))
      ? ({ max: 'high', high: 'high', medium: 'medium', low: 'low' }[els.effort.value] || 'high')
      : '';
    const srvBody = Object.assign({}, body, { apiBase: apiBase || undefined, reasoning_effort: effort || undefined });
    try {
      res = await fetch('/api/rewrite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(srvBody),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('__ABORT__');
      throw new Error('请求失败：' + e.message);
    }
  }

  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const msg = data && data.error
      ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error))
      : '请求失败（HTTP ' + res.status + '）';
    throw new Error(msg);
  }
  if (!ct.includes('text/event-stream')) {
    const txt = await res.text().catch(() => '');
    throw new Error('服务响应异常：' + txt.slice(0, 300));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reasoningBuf = '';

  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('__ABORT__');
      throw new Error('读取响应失败：' + e.message);
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (!delta) continue;
      if (delta.reasoning_content) {
        reasoningBuf += delta.reasoning_content;
        if (!out) {
          els.reasonText.appendChild(document.createTextNode(delta.reasoning_content));
          els.reasonBox.classList.remove('hidden');
        }
      }
      if (delta.content) {
        if (out) {
          out.text += delta.content;
        } else {
          outputText += delta.content;
          els.outResult.appendChild(document.createTextNode(delta.content));
          updateCounts();
        }
      }
    }
  }
}

/* ================= 执行修改 ================= */
function resetOutput() {
  outputText = '';
  els.outResult.textContent = '';
  els.outResult.classList.add('hidden');
  els.outDiff.classList.add('hidden');
  els.outEmpty.classList.remove('hidden');
  els.reasonText.textContent = '';
  els.reasonBox.classList.add('hidden');
  switchView('result');
  updateCounts();
}

async function runRewrite() {
  if (isExpired()) { flash('软件已到期（2026-08-20），功能已停止使用', true); return; }
  if (running) return;
  const text = getSourceText();
  if (!text) return;
  const messages = buildMessages(text);
  if (!messages) return;

  const apiKey = els.apiKey.value.trim();
  if (apiKey) storeSet('dsw_apikey', apiKey);
  const model = els.model.value;

  lastOriginal = text;
  resetOutput();
  setRunning(true);
  abort = new AbortController();
  const statusPrefix =
    model === 'deepseek-reasoner'
      ? (DIRECT ? '正在直连 DeepSeek 官网（deepseek-reasoner 思考较慢）…' : '正在连接 DeepSeek（deepseek-reasoner 思考较慢）…')
      : (DIRECT ? '正在直连 DeepSeek 官网…' : '正在连接 DeepSeek…');
  startTimer(statusPrefix);

  try {
    await streamRewrite({ apiKey, model, messages }, abort.signal);
    const elapsed = stopTimer();
    if (outputText) {
      els.outResult.classList.remove('hidden');
      els.outEmpty.classList.add('hidden');
      renderRichResult();
      setStatus('✅ 修改完成（' + outputText.replace(/\s/g, '').length + ' 字，总耗时 ' + formatDuration(elapsed) + '）');
    } else {
      setStatus('⚠ 模型未返回内容，请重试或更换模型（耗时 ' + formatDuration(elapsed) + '）', 'error');
    }
  } catch (e) {
    const elapsed = stopTimer();
    if (e.message === '__ABORT__') {
      if (outputText) {
        els.outResult.classList.remove('hidden');
        els.outEmpty.classList.add('hidden');
        renderRichResult();
        setStatus('⏹ 已停止（保留当前已生成的部分，耗时 ' + formatDuration(elapsed) + '）');
      } else {
        setStatus('⏹ 已停止（耗时 ' + formatDuration(elapsed) + '）', 'error');
      }
    } else {
      setStatus('❌ ' + e.message + '（耗时 ' + formatDuration(elapsed) + '）', 'error');
    }
  } finally {
    setRunning(false);
    abort = null;
  }
}

/* ================= 结果渲染 ================= */
function renderRich(text) {
  const lines = text.split('\n');
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</div>'; inList = false; } };
  for (const line of lines) {
    const t = line.trim();
    if (!t) { closeList(); continue; }
    let esc = escapeHtml(t)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    if (/^#{1,6}\s+/.test(t)) {
      closeList();
      const level = (t.match(/^#+/) || [''])[0].length;
      html += '<p class="h h' + Math.min(level, 3) + '">' + esc.replace(/^#{1,6}\s*/, '') + '</p>';
    } else if (/^[-*•]\s+/.test(t)) {
      if (!inList) { html += '<div class="list">'; inList = true; }
      html += '<p class="li">' + esc.replace(/^[-*•]\s*/, '') + '</p>';
    } else {
      closeList();
      html += '<p>' + esc + '</p>';
    }
  }
  closeList();
  return html;
}
function renderRichResult() {
  els.outResult.innerHTML = renderRich(outputText);
}

/* ================= 差异对照（句子级 LCS） ================= */
function splitSentences(s) {
  return s.split(/(?<=[。！？!?；;：:])\s*/).filter(Boolean);
}
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  if (!n) return b.map((x) => ({ type: 'add', b: x }));
  if (!m) return a.map((x) => ({ type: 'del', a: x }));
  if (n * m > 250000) {
    return [{ type: 'rep', a: a.join(' '), b: b.join(' ') }];
  }
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * (m + 1) + j;
      dp[idx] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'same', a: a[i] }); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { ops.push({ type: 'del', a: a[i] }); i++; }
    else { ops.push({ type: 'add', b: b[j] }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', a: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', b: b[j] }); j++; }
  return ops;
}

function paraDiffHtml(a, b) {
  const sa = splitSentences(a), sb = splitSentences(b);
  if (sa.length * sb.length > 20000) {
    return '<p class="diff-rep"><del>' + escapeHtml(a) + '</del> <ins>' + escapeHtml(b) + '</ins></p>';
  }
  const ops = lcsOps(sa, sb);
  let html = '<p class="diff-rep">';
  let delBuf = [], addBuf = [];
  const flush = () => {
    if (delBuf.length) { html += '<del>' + escapeHtml(delBuf.join('')) + '</del>'; delBuf = []; }
    if (addBuf.length) { html += '<ins>' + escapeHtml(addBuf.join('')) + '</ins>'; addBuf = []; }
  };
  for (const op of ops) {
    if (op.type === 'same') { flush(); html += escapeHtml(op.a); }
    else if (op.type === 'del') delBuf.push(op.a);
    else addBuf.push(op.b);
  }
  flush();
  html += '</p>';
  return html;
}

function renderDiff() {
  if (!lastOriginal || !outputText) {
    els.diffBody.innerHTML = '<p class="empty">暂无对照内容，请先生成修改结果。</p>';
    return;
  }
  const pa = lastOriginal.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const pb = outputText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const ops = lcsOps(pa, pb);

  let html = '';
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.type === 'same') {
      html += '<p>' + escapeHtml(op.a) + '</p>';
      k++;
      continue;
    }
    const dels = [], adds = [];
    while (k < ops.length && (ops[k].type === 'del' || ops[k].type === 'add')) {
      if (ops[k].type === 'del') dels.push(ops[k].a);
      else adds.push(ops[k].b);
      k++;
    }
    if (dels.length && !adds.length) {
      html += '<p class="diff-del"><del>' + escapeHtml(dels.join('\n')) + '</del></p>';
    } else if (!dels.length && adds.length) {
      html += '<p class="diff-add"><ins>' + escapeHtml(adds.join('\n')) + '</ins></p>';
    } else {
      html += paraDiffHtml(dels.join('\n'), adds.join('\n'));
    }
  }
  els.diffBody.innerHTML = html || '<p class="empty">（结果与原文一致）</p>';
}

function switchView(view) {
  currentView = view;
  segBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const showResult = view === 'result';
  els.outResult.classList.toggle('hidden', !showResult || !outputText);
  els.outDiff.classList.toggle('hidden', showResult || !outputText);
  if (view === 'diff' && outputText) renderDiff();
}

/* ================= 复制 / 下载 ================= */
async function copyOutput() {
  if (!outputText) { flash('暂无内容可复制', true); return; }
  try {
    await navigator.clipboard.writeText(outputText);
    flash('已复制到剪贴板');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = outputText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    flash('已复制到剪贴板');
  }
}
function downloadOutput() {
  if (!outputText) { flash('暂无内容可下载', true); return; }
  const blob = new Blob(['\uFEFF' + outputText], { type: 'text/plain;charset=utf-8' });
  const name = '文章助手修改结果_' + new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-').replace(':', '') + '.txt';
  if (IS_ANDROID) {
    saveBlobAndroid(blob, name, 'text')
      .then(() => flash('已保存到 下载/文章助手'))
      .catch((e) => flash('保存失败：' + e.message, true));
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ================= 事件绑定 ================= */
tabBtns.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

els.inputText.addEventListener('input', updateCounts);
els.linkResult.addEventListener('input', updateCounts);

els.fetchBtn.addEventListener('click', async () => {
  if (isExpired()) { flash('软件已到期，功能已停止使用', true); return; }
  const url = els.linkUrl.value.trim();
  if (!/^https?:\/\//i.test(url)) { flash('请输入有效的 http(s) 链接', true); return; }
  els.fetchBtn.disabled = true;
  els.fetchBtn.textContent = '抓取中…';
  try {
    // Android APK：优先使用原生 Java 抓取（HttpURLConnection，无 CORS，最稳）
    if (IS_ANDROID && window.AndroidBridge && typeof window.AndroidBridge.fetchArticle === 'function') {
      els.fetchBtn.textContent = '原生抓取中…';
      const cbId = 'fetch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      if (nativeFetchTimer) clearTimeout(nativeFetchTimer);
      nativeFetchTimer = setTimeout(() => {
        els.fetchBtn.disabled = false;
        els.fetchBtn.textContent = '抓取正文（首条）';
        flash('原生抓取超时（30 秒），请重试或复制文本粘贴', true);
      }, 30000);
      window.AndroidBridge.fetchArticle(url, cbId);
      return;
    }
    let data;
    if (DIRECT) {
      data = await directFetchArticle(url);
    } else {
      const res = await fetch('/api/fetch-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error((j && j.error) || '抓取失败（HTTP ' + res.status + '）');
      data = j;
    }
    fillArticle(data);
  } catch (e) {
    flash('抓取失败：' + e.message, true);
  } finally {
    els.fetchBtn.disabled = false;
    els.fetchBtn.textContent = '抓取正文（首条）';
  }
});

els.addWord.addEventListener('click', addWord);
els.wordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addWord(); } });
els.loadPreset.addEventListener('click', () => { saveWords([...PRESET_WORDS]); renderWords(); flash('已载入示例禁止词'); });
els.clearWords.addEventListener('click', () => { saveWords([]); renderWords(); });


segBtns.forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
els.copyBtn.addEventListener('click', copyOutput);
els.downloadBtn.addEventListener('click', downloadOutput);
els.clearOut.addEventListener('click', () => {
  lastOriginal = '';
  outputText = '';
  resetOutput();
  flash('已清空输出');
});

els.toggleKey.addEventListener('click', () => {
  els.apiKey.type = els.apiKey.type === 'password' ? 'text' : 'password';
});
/* ---- 提示词设置（本地存储，升级不丢） ---- */
function fillPromptGroup(g) {
  els.sysPrompt.value = (g && g.sys) || ''; // 图片嵌入提示词已移除（固定使用内置默认）

  els.dedupPrompt.value = (g && g.dedup) || '';
}
function loadPromptSettings() {
  const groups = getPromptGroups();
  const active = getActiveGroup();
  els.promptGroupSel.innerHTML = '';
  groups.forEach((g, i) => {
    const o = document.createElement('option');
    o.value = g.id;
    o.textContent = (i + 1) + '. ' + (g.name || '提示词组');
    els.promptGroupSel.appendChild(o);
  });
  els.promptGroupSel.value = active.id;
  fillPromptGroup(active);
}
els.promptGroupSel.addEventListener('change', () => {
  // 切换组前先把当前编辑自动保存到原组，防止丢失
  const groups = getPromptGroups();
  const prevId = storeGet(PROMPT_ACTIVE_KEY);
  const prev = groups.find((x) => x.id === prevId) || getActiveGroup();
  if (prev) { prev.sys = els.sysPrompt.value.trim(); prev.dedup = els.dedupPrompt.value.trim(); }
  storeSet(PROMPT_GROUPS_KEY, JSON.stringify(groups));
  storeSet(PROMPT_ACTIVE_KEY, els.promptGroupSel.value);
  fillPromptGroup(getActiveGroup());
});
/* ---- 模型与接口设置（本地存储） ---- */
function loadModelSettings() {
  const t = storeGet('dsw_thinking');
  els.thinking.checked = t === null ? true : t === '1';
  const e = storeGet('dsw_effort') || 'max';
  els.effort.value = ['max', 'high', 'medium', 'low'].includes(e) ? e : 'max';
  els.apiBase.value = storeGet('dsw_api_base') || '';
  els.customModel.value = storeGet('dsw_custom_model') || '';
  syncThinkingUI();
}
function syncThinkingUI() {
  // 思考模式开启 → Pro（reasoner）；关闭 → Flash（chat）
  els.model.value = els.thinking.checked ? 'deepseek-reasoner' : 'deepseek-chat';
  els.effortField.classList.toggle('hidden', !els.thinking.checked);
}
els.thinking.addEventListener('change', () => { syncThinkingUI(); storeSet('dsw_thinking', els.thinking.checked ? '1' : '0'); });
els.effort.addEventListener('change', () => storeSet('dsw_effort', els.effort.value));
els.saveModelBtn.addEventListener('click', () => {
  storeSet('dsw_thinking', els.thinking.checked ? '1' : '0');
  storeSet('dsw_effort', els.effort.value);
  storeSet('dsw_api_base', els.apiBase.value.trim());
  storeSet('dsw_custom_model', els.customModel.value.trim());
  flash('模型设置已保存到本地（升级 APK 不丢失）');
});
els.resetModelBtn.addEventListener('click', () => {
  storeRemove('dsw_thinking'); storeRemove('dsw_effort');
  storeRemove('dsw_api_base'); storeRemove('dsw_custom_model');
  els.thinking.checked = true;
  els.effort.value = 'max';
  els.apiBase.value = '';
  els.customModel.value = '';
  syncThinkingUI();
  flash('已恢复默认模型设置');
});

els.savePromptsBtn.addEventListener('click', () => {
  const groups = getPromptGroups();
  const g = groups.find((x) => x.id === els.promptGroupSel.value) || groups[0];
  g.sys = els.sysPrompt.value.trim(); // 图片嵌入提示词已移除，固定使用内置默认（getImgPrompt）
  g.dedup = els.dedupPrompt.value.trim();
  storeSet(PROMPT_GROUPS_KEY, JSON.stringify(groups));
  flash('当前提示词组已保存到本地（升级 APK 不会丢失）');
});
els.newGroupBtn.addEventListener('click', () => {
  const groups = getPromptGroups();
  const ng = { id: 'g' + Date.now(), name: '提示词组' + (groups.length + 1), sys: '', img: '', dedup: '' };
  groups.push(ng);
  storeSet(PROMPT_GROUPS_KEY, JSON.stringify(groups));
  storeSet(PROMPT_ACTIVE_KEY, ng.id);
  loadPromptSettings();
  flash('已新建提示词组：' + ng.name);
});
els.delGroupBtn.addEventListener('click', () => {
  const groups = getPromptGroups();
  if (groups.length <= 1) { flash('至少保留一组提示词', true); return; }
  const id = els.promptGroupSel.value;
  const idx = groups.findIndex((x) => x.id === id);
  if (idx >= 0) {
    groups.splice(idx, 1);
    storeSet(PROMPT_GROUPS_KEY, JSON.stringify(groups));
    storeSet(PROMPT_ACTIVE_KEY, groups[0].id);
    loadPromptSettings();
    flash('已删除当前提示词组');
  }
});
els.resetPromptsBtn.addEventListener('click', () => {
  const groups = getPromptGroups();
  const g = groups.find((x) => x.id === els.promptGroupSel.value) || groups[0];
  g.sys = ''; g.dedup = '';
  storeSet(PROMPT_GROUPS_KEY, JSON.stringify(groups));
  els.sysPrompt.value = '';
  els.dedupPrompt.value = '';
  flash('当前组已恢复默认提示词');
});

/* 链接输入框一键清除（清空链接与抓取结果） */
document.getElementById('clearLinkBtn').addEventListener('click', () => {
  els.linkUrl.value = '';
  els.linkArticle.classList.add('hidden');
  els.linkResult.value = '';
  els.linkTitle.textContent = '';
  els.linkSourceTag.classList.add('hidden');
  articleImages = [];
  els.imgGrid.innerHTML = '';
  els.imgPanel.classList.add('hidden');
  updateCounts();
  flash('已清除链接与抓取内容');
});

els.sampleBtn.addEventListener('click', () => {
  els.inputText.value = SAMPLE_ARTICLE;
  switchTab('paste');
  updateCounts();
  flash('已填入示例文章，可直接开始修改');
});
els.length.addEventListener('change', () => {
  els.targetLenField.classList.toggle('hidden', els.length.value === 'keep');
});

/* ================= 初始化 ================= */
(async function init() {
  let serverAvailable = false;
  if (!DIRECT) {
    try {
      const res = await fetch('/api/config');
      serverAvailable = res.ok;
      if (serverAvailable) {
        const cfg = await res.json();
        if (cfg.hasServerKey) {
          els.keyField.classList.add('hidden');
          els.serverKeyBadge.classList.remove('hidden');
        }
      }
    } catch { /* 服务不可达 → 回退直连模式 */ }
  }

  if (serverAvailable) {
    els.modeBanner.textContent = '🖥 本地服务模式：API 经本机服务转发，支持「导入链接」抓取。';
    els.modeBanner.classList.add('server');
  } else {
    DIRECT = true;
    els.modeBanner.textContent =
      '🔗 本地文件模式（直接打开）：请求直达 api.deepseek.com，请在右上角填写 API Key。「导入链接」经由公共跨域代理抓取（部分网站可能失败，敏感内容请用粘贴文本）。';
    els.modeBanner.classList.add('direct');
  }
  els.modeBanner.classList.remove('hidden');

  const savedKey = storeGet('dsw_apikey') || '';
  if (savedKey) els.apiKey.value = savedKey;

  const savedModel = storeGet('dsw_model');
  if (savedModel && [...els.model.options].some((o) => o.value === savedModel)) els.model.value = savedModel;
  els.model.addEventListener('change', () => storeSet('dsw_model', els.model.value));

  renderWords();
  loadPromptSettings();
  loadModelSettings();
  updateCounts();
})();

/* ================= 文章抓取结果填充 + Android 原生回调 ================= */
function fillArticle(data) {
  els.linkArticle.classList.remove('hidden');
  els.linkResult.value = data.text || '';
  els.linkTitle.textContent = data.title || '';
  els.linkSourceTag.classList.toggle('hidden', data.source !== 'toutiao');
  const imgs = (data.images || []).filter((u) => typeof u === 'string' && u);
  if (imgs.length) {
    articleImages = imgs.map((u) => ({ url: u, status: 'orig', blobUrl: '' }));
    els.imgPanel.classList.remove('hidden');
    renderImgGrid();
  } else {
    els.imgPanel.classList.add('hidden');
    articleImages = [];
    els.imgGrid.innerHTML = '';
  }
  updateCounts();
  const viaTxt = !data.via ? '' : (data.via === 'native' ? '（原生抓取）' : (data.via === 'toutiao' ? '（头条接口）' : '（经 ' + data.via + ' 代理）'));
  flash('抓取成功' + (data.title ? '：《' + data.title + '》' : '') + (imgs.length ? '，含 ' + imgs.length + ' 张图片' : '') + viaTxt);
}

let nativeFetchTimer = null;
const pendingFetches = {}; // 批量处理用：cbId -> {resolve, reject, timer}

/* 抓取一个链接 → Promise（Android 走原生桥，网页走服务/直连） */
function fetchOne(url) {
  return new Promise((resolve, reject) => {
    try {
      if (IS_ANDROID && window.AndroidBridge && typeof window.AndroidBridge.fetchArticle === 'function') {
        const cbId = 'b' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const timer = setTimeout(() => {
          delete pendingFetches[cbId];
          reject(new Error('原生抓取超时（30 秒）'));
        }, 30000);
        pendingFetches[cbId] = { resolve, reject, timer };
        window.AndroidBridge.fetchArticle(url, cbId);
        return;
      }
      (async () => {
        let data;
        if (DIRECT) {
          data = await directFetchArticle(url);
        } else {
          const res = await fetch('/api/fetch-article', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          });
          const j = await res.json().catch(() => null);
          if (!res.ok) throw new Error((j && j.error) || '抓取失败（HTTP ' + res.status + '）');
          data = j;
        }
        resolve(data);
      })().catch((e) => reject(e));
    } catch (e) {
      reject(e);
    }
  });
}

window.onNativeFetchArticle = function (cbId, data) {
  if (isExpired()) { flash('软件已到期，功能已停止使用', true); return; }
  // 批量通道：按 cbId 路由到对应 Promise
  if (cbId && pendingFetches[cbId]) {
    const h = pendingFetches[cbId];
    delete pendingFetches[cbId];
    if (h.timer) clearTimeout(h.timer);
    let d = data;
    try { if (typeof d === 'string') d = JSON.parse(d); } catch { /* keep */ }
    if (!d) { h.reject(new Error('抓取失败：返回数据异常')); return; }
    if (d.error) { h.reject(new Error('抓取失败：' + d.error)); return; }
    h.resolve(d);
    return;
  }
  // 单条抓取：原有界面逻辑
  if (nativeFetchTimer) { clearTimeout(nativeFetchTimer); nativeFetchTimer = null; }
  els.fetchBtn.disabled = false;
  els.fetchBtn.textContent = '抓取正文（首条）';
  let d = data;
  try { if (typeof d === 'string') d = JSON.parse(d); } catch { /* keep */ }
  if (!d) { flash('抓取失败：返回数据异常', true); return; }
  if (d.error) { flash('抓取失败：' + d.error, true); return; }
  fillArticle(d);
};


/* ================= 判重（仿文皮皮·河图引擎思路：全文文本相似度） =================
 * 文皮皮原理：找出两篇文章“相同的地方”，相同内容占比即相似度（越大越抄袭）。
 * 本地实现：字符 8-gram 公共成分 + Jaccard（0~1），×100 即重复度百分比。
 */
function makeGrams(text, n) {
  const k = n || 4;
  const clean = String(text || '').replace(/\s+/g, '');
  const s = new Set();
  if (!clean) return s;
  if (clean.length <= k) { s.add(clean); return s; }
  for (let i = 0; i <= clean.length - k; i++) s.add(clean.slice(i, i + k));
  return s;
}
function textSimilarity(a, b) {
  const A = makeGrams(a), B = makeGrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const g of small) if (big.has(g)) inter++;
  return inter / (A.size + B.size - inter); // Jaccard
}

/* ================= 最小 .docx 生成器（纯 JS，STORE zip，无依赖） ================= */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function utf8Bytes(s) { return new TextEncoder().encode(s); }
function makeZipStore(files) {
  let offset = 0;
  const locals = [], centrals = [];
  for (const f of files) {
    const nb = utf8Bytes(f.name);
    const crc = crc32(f.data);
    const lh = new Uint8Array(30);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, f.data.length, true);
    dv.setUint32(22, f.data.length, true);
    dv.setUint16(26, nb.length, true);
    const ch = new Uint8Array(46);
    const cd = new DataView(ch.buffer);
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint32(12, offset, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, nb.length, true);
    cd.setUint32(42, offset, true);
    locals.push(lh, nb, f.data);
    centrals.push(ch, nb);
    offset += 30 + nb.length + f.data.length;
  }
  const cdStart = offset;
  let cdLen = 0;
  for (const c of centrals) cdLen += c.length;
  const eocd = new Uint8Array(22);
  const eo = new DataView(eocd.buffer);
  eo.setUint32(0, 0x06054b50, true);
  eo.setUint16(8, files.length, true);
  eo.setUint16(10, files.length, true);
  eo.setUint32(12, cdLen, true);
  eo.setUint32(16, cdStart, true);
  const total = cdStart + cdLen + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of locals) { out.set(part, p); p += part.length; }
  for (const part of centrals) { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function imageParagraphXml(rid, cx, cy, id) {
  return '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">'
    + '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + id + '" name="Picture ' + id + '"/>'
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + id + '" name="image' + id + '.png"/><pic:cNvPicPr/></pic:nvPicPr>'
    + '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}
function buildDocx(title, blocks) {
  // blocks: [{type:'h'|'p', text} | {type:'img', data:Uint8Array(png), w, h}]
  const media = [], rels = [];
  let imgId = 0;
  const bodyXml = [];
  for (const b of blocks) {
    if (b.type === 'img') {
      imgId++;
      const rid = 'rIdImg' + imgId;
      media.push({ name: 'word/media/image' + imgId + '.png', data: b.data });
      rels.push('<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + imgId + '.png"/>');
      const w = b.w || 500, h = b.h || 375;
      const dispW = Math.min(500, w);
      const dispH = Math.round(h * (dispW / w));
      bodyXml.push(imageParagraphXml(rid, Math.round(dispW * 9525), Math.round(dispH * 9525), imgId));
    } else if (b.type === 'h') {
      bodyXml.push('<w:p><w:pPr><w:spacing w:before="160" w:after="120"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + escXml(b.text) + '</w:t></w:r></w:p>');
    } else {
      bodyXml.push('<w:p><w:r><w:t xml:space="preserve">' + escXml(b.text) + '</w:t></w:r></w:p>');
    }
  }
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<w:body>' + bodyXml.join('')
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>';
  const typesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>';
  const files = [
    { name: '[Content_Types].xml', data: utf8Bytes(typesXml) },
    { name: '_rels/.rels', data: utf8Bytes(rootRels) },
    { name: 'word/document.xml', data: utf8Bytes(docXml) },
    { name: 'word/_rels/document.xml.rels', data: utf8Bytes(docRels) },
  ];
  for (const m of media) files.push({ name: m.name, data: m.data });
  return makeZipStore(files);
}

/* ================= 图片 -> PNG bytes（供 Word 内嵌） ================= */
function imageToPngBytes(img) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((b) => {
        if (!b) { reject(new Error('图片转换失败（可能跨域受限）')); return; }
        b.arrayBuffer().then((ab) => resolve({ data: new Uint8Array(ab), w: canvas.width, h: canvas.height }))
          .catch((e) => reject(e));
      }, 'image/png');
    } catch (e) { reject(new Error('图片转换失败：' + e.message)); }
  });
}
async function loadImgForDocx(src) {
  const img = await loadImageWithFallback(src);
  return imageToPngBytes(img);
}

/* ================= 图片去水印（本地 canvas 裁切，不上传） ================= */
let articleImages = []; // { url, status: 'orig'|'done'|'fail', blobUrl }

function loadImageForCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
}
async function loadImageWithFallback(url) {
  try {
    return await loadImageForCanvas(url);
  } catch {
    for (const p of PROXIES) {
      try { return await loadImageForCanvas(p.build(url)); } catch { /* 下一个代理 */ }
    }
    throw new Error('图片加载失败（直连与公共代理均失败，可能防盗链）');
  }
}
function cropRect(w, h, pos, ratio) {
  const r = Math.min(0.5, Math.max(0.02, ratio));
  const sw = Math.round(w * r), sh = Math.round(h * r);
  switch (pos) {
    case 'bottom-left': return { cw: w - sw, ch: h - sh, sx: sw, sy: 0 };
    case 'top-right': return { cw: w - sw, ch: h - sh, sx: 0, sy: sh };
    case 'top-left': return { cw: w - sw, ch: h - sh, sx: sw, sy: sh };
    case 'bottom': return { cw: w, ch: h - sh, sx: 0, sy: 0 };
    case 'bottom-right':
    default: return { cw: w - sw, ch: h - sh, sx: 0, sy: 0 };
  }
}
async function cropImageToBlob(url, pos, ratio) {
  const img = await loadImageWithFallback(url);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) throw new Error('图片尺寸无效');
  const { cw, ch, sx, sy } = cropRect(w, h, pos, ratio);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw, ch);
  let blob = null;
  try {
    blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', 0.92));
    if (!blob) blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  } catch (e) {
    throw new Error('canvas 导出被浏览器拦截（跨域保护）：' + e.message);
  }
  if (!blob) throw new Error('图片导出失败');
  return blob;
}

function statusLabel(s) {
  return s === 'done' ? '✓ 已去水印' : s === 'fail' ? '✗ 失败' : '原图';
}
function setImgSrcWithFallback(img, url) {
  let tries = 0;
  img.onerror = () => {
    tries++;
    if (tries <= PROXIES.length) img.src = PROXIES[tries - 1].build(url);
    else { img.alt = '图片加载失败'; img.style.opacity = 0.3; }
  };
  img.src = url;
}
function renderImgGrid() {
  els.imgGrid.innerHTML = '';
  if (!articleImages.length) return;
  articleImages.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'img-card';
    const wrap = document.createElement('div');
    wrap.className = 'img-wrap';
    const img = document.createElement('img');
    img.alt = '图片' + (i + 1);
    img.loading = 'lazy';
    setImgSrcWithFallback(img, item.blobUrl || item.url);
    wrap.appendChild(img);
    const info = document.createElement('div');
    info.className = 'img-info';
    info.innerHTML = '<span class="tag ' + (item.status === 'done' ? 'ok' : item.status === 'fail' ? 'err' : '') + '">' + statusLabel(item.status) + '</span><span>' + (i + 1) + '/' + articleImages.length + '</span>';
    const acts = document.createElement('div');
    acts.className = 'img-actions';
    const bCrop = document.createElement('button');
    bCrop.className = 'btn sm'; bCrop.type = 'button'; bCrop.textContent = '✂ 去水印';
    bCrop.onclick = () => processOne(i);
    const bDl = document.createElement('button');
    bDl.className = 'btn sm'; bDl.type = 'button'; bDl.textContent = '下载';
    bDl.onclick = () => downloadOne(i);
    const bView = document.createElement('button');
    bView.className = 'btn ghost sm'; bView.type = 'button'; bView.textContent = '原图';
    bView.onclick = () => window.open(item.url, '_blank');
    acts.appendChild(bCrop); acts.appendChild(bDl); acts.appendChild(bView);
    card.appendChild(wrap); card.appendChild(info); card.appendChild(acts);
    els.imgGrid.appendChild(card);
  });
  els.cropAllBtn.textContent = '✂ 一键去水印（' + articleImages.length + ' 张）';
}
async function processOne(i) {
  const item = articleImages[i];
  if (!item || item.status === 'processing') return;
  item.status = 'processing';
  renderImgGrid();
  try {
    const blob = await cropImageToBlob(item.url, els.wmPos.value, Number(els.wmRatio.value) / 100);
    if (item.blobUrl) URL.revokeObjectURL(item.blobUrl);
    item.blobUrl = URL.createObjectURL(blob);
    item.status = 'done';
  } catch (e) {
    item.status = 'fail';
    item.err = e.message;
    flash('第 ' + (i + 1) + ' 张图片处理失败：' + e.message, true);
  }
  renderImgGrid();
}
async function processAll() {
  for (let i = 0; i < articleImages.length; i++) {
    if (articleImages[i].status === 'done') continue;
    await processOne(i);
  }
  const done = articleImages.filter((x) => x.status === 'done').length;
  flash('处理完成：' + done + '/' + articleImages.length + ' 张已去水印');
}
function downloadOne(i) {
  const item = articleImages[i];
  if (!item || !item.blobUrl) { flash(item && item.status === 'fail' ? '该图片处理失败，无法下载' : '请先对该图片执行去水印', true); return; }
  if (IS_ANDROID) {
    fetch(item.blobUrl)
      .then((r) => r.blob())
      .then((b) => saveBlobAndroid(b, '去水印图片_' + (i + 1) + '.webp', 'image'))
      .then(() => flash('已保存到相册 /文章助手'))
      .catch((e) => flash('保存失败：' + e.message, true));
    return;
  }
  const a = document.createElement('a');
  a.href = item.blobUrl;
  a.download = '去水印图片_' + (i + 1) + (item.blobUrl.startsWith('blob:') ? '.webp' : '.jpg');
  a.click();
}
function downloadAll() {
  const dones = articleImages.map((x, i) => ({ x, i })).filter((o) => o.x.status === 'done');
  if (!dones.length) { flash('请先执行「一键去水印」', true); return; }
  if (IS_ANDROID) {
    let count = 0;
    dones.forEach((o) => {
      fetch(o.x.blobUrl)
        .then((r) => r.blob())
        .then((b) => saveBlobAndroid(b, '去水印图片_' + (o.i + 1) + '.webp', 'image'))
        .then(() => { count++; if (count === dones.length) flash('已保存 ' + count + ' 张到相册'); })
        .catch(() => { count++; });
    });
    return;
  }
  dones.forEach((o, k) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = o.x.blobUrl;
    a.download = '去水印图片_' + (k + 1) + '.webp';
    a.click();
  }, k * 400));
}

/* ================= 图片相关事件 ================= */
els.wmRatio.addEventListener('input', () => {
  els.wmRatioVal.textContent = els.wmRatio.value + '%';
});
/* 自动去水印开关（默认开启，存本地） */
function autoCropEnabled() {
  return !els.autoCropChk || els.autoCropChk.checked;
}
els.autoCropChk.addEventListener('change', () => {
  storeSet('dsw_autocrop', els.autoCropChk.checked ? '1' : '0');
  flash(els.autoCropChk.checked ? '自动去水印已开启' : '自动去水印已关闭');
});
{
  const v = storeGet('dsw_autocrop');
  els.autoCropChk.checked = v === null ? true : v === '1';
}
els.cropAllBtn.addEventListener('click', processAll);
els.downloadAllBtn.addEventListener('click', downloadAll);
els.useTextBtn.addEventListener('click', () => {
  const t = els.linkResult.value.trim();
  if (!t) { flash('链接页暂无正文，请先抓取', true); return; }
  els.inputText.value = t;
  switchTab('paste');
  updateCounts();
  flash('文章文本已填入「粘贴文本」，可设置修改条件后开始修改');
});
