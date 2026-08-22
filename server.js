#!/usr/bin/env node
/**
 * 文章助手 · 本地服务
 * ----------------------------------
 * 零依赖实现，需要 Node.js 18+（内置 fetch）。
 *
 * 启动：
 *   node server.js
 *   （可选环境变量：PORT=7070、HOST=127.0.0.1、DEEPSEEK_API_KEY=sk-xxx）
 *
 * 接口：
 *   GET  /                      静态页面
 *   GET  /api/config            是否已配置服务端 Key
 *   POST /api/rewrite           调用 DeepSeek Chat Completions（流式转发）
 *   POST /api/fetch-article     抓取链接并提取正文（避免浏览器跨域限制）
 *
 * 注意：这是本地个人工具，服务端会转发你的 API Key，请勿部署到公网。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 7070;
const HOST = process.env.HOST || '127.0.0.1';
const SERVER_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE = 'https://api.deepseek.com';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_ARTICLE_CHARS = 30000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
// 软件试用期限制：2026-08-28 00:00（北京时间）到期后接口全部拒绝（改日期请改下面这一处）
const EXPIRY_MS = 1787846400000; // 2026-08-27T16:00:00Z
const isExpiredNow = () => Date.now() >= EXPIRY_MS;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* ---------------- 网页正文提取（轻量，无依赖） ---------------- */
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

function extractArticle(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';

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

  const text = lines.join('\n').slice(0, MAX_ARTICLE_CHARS);
  return { title, text };
}

/* ---------------- 属性提取辅助（提取 <img> 属性值，兼容单双引号） ---------------- */
function attrValueJs(tag, attr) {
  let m = tag.match(new RegExp(attr + '=\"([^\"]*)\"', 'i'));
  if (m && m[1]) return m[1];
  m = tag.match(new RegExp(attr + "='([^']*)'", 'i'));
  return m && m[1] ? m[1] : null;
}
function pickArticleImage(tag) {
  let url = attrValueJs(tag, 'data-img-url') || attrValueJs(tag, 'data-src') || attrValueJs(tag, 'src');
  if (!url || !/^https?:/i.test(url.trim())) return null;
  const lu = url.trim().toLowerCase();
  if (/emoji|icon|logo|avatar|badge|favicon|loading|spinner|placeholder|smiley|sticker/.test(lu)) return null;
  return url.trim();
}

/* ---------------- 今日头条文章提取（article-content） ---------------- */
function extractToutiao(html) {
  const idx = html.search(/(?:id|class)="[^"]*article-content[^"]*"/i);
  let seg = '';
  if (idx >= 0) {
    const start = html.indexOf('>', idx) + 1;
    seg = html.slice(start, start + 80000);
    let endMatch = seg.search(/<(div|section|footer)[^>]*(?:class|id)="[^"]*(?:article-tag|article-bottom|article-footer|author-box|user-card|article-vote|article-comment|article-recommend|recommend|feed-card|hot-board|related)[^"]*"/i);
    if (endMatch > 0) seg = seg.slice(0, endMatch);
    else {
      const guard = seg.search(/(?:id|class)="[^"]*(?:recommend|feed-card|hot-board|article-footer|related-news)[^"]*"/i);
      if (guard > 0) seg = seg.slice(0, guard);
    }
  } else {
    seg = html; // 未找到 article-content 时退化为整页提取
  }

  const paragraphs = [];
  const images = [];
  let m;
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = pRe.exec(seg)) !== null) {
    const inner = m[1]
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<img[^>]*>/gi, (tag) => (pickArticleImage(tag) ? ' [图片] ' : ''))
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (inner) paragraphs.push(inner);
  }
  const imgRe = /<img[^>]*>/gi;
  while ((m = imgRe.exec(seg)) !== null) {
    const url = pickArticleImage(m[0]);
    if (url) images.push(url);
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 120) : '';
  return {
    title,
    text: paragraphs.join('\n').slice(0, MAX_ARTICLE_CHARS),
    images: [...new Set(images)].slice(0, 30),
  };
}

/* ---------------- 今日头条：info 接口 / 移动端 RENDER_DATA（桌面页被反爬 JS 挑战拦截时的备用通道） ---------------- */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function toutiaoArticleId(url) {
  let m = /\/article\/(\d{6,})/i.exec(url || '');
  if (m) return m[1];
  m = /\/w\/(\d{6,})/i.exec(url || ''); // 微头条 /w/ 格式
  if (m) return m[1];
  m = /\/i(\d{6,})/i.exec(url || '');
  if (m) return m[1];
  // 兜底：URL 中任意 6 位以上数字串（覆盖 /note/ /item/ 等新格式）
  m = /(\d{6,})/.exec(url || '');
  return m ? m[1] : null;
}
function toutiaoHtmlToResult(contentHtml, title) {
  const paragraphs = [];
  const images = [];
  let seg = String(contentHtml).replace(/<img[^>]*>/gi, (tag) => (pickArticleImage(tag) ? ' [图片] ' : ''));
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
    const u = pickArticleImage(tag);
    if (u) images.push(u);
    return '';
  });
  return {
    title: String(title || '').slice(0, 120),
    text: paragraphs.join('\n').slice(0, MAX_ARTICLE_CHARS),
    images: [...new Set(images)].slice(0, 30),
  };
}
function extractToutiaoRenderData(html) {
  const m = /<script id="RENDER_DATA" type="application\/json">([\s\S]*?)<\/script>/i.exec(html || '');
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

/* ---------------- API 路由 ---------------- */
async function handleRewrite(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON' });
  }

  const apiKey = String(body.apiKey || '').trim() || SERVER_KEY;
  if (!apiKey) {
    return sendJson(res, 400, {
      error: '未提供 DeepSeek API Key。请在页面右上角填写，或在启动服务时设置环境变量 DEEPSEEK_API_KEY。',
    });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendJson(res, 400, { error: 'messages 不能为空' });
  }
  const model = typeof body.model === 'string' && body.model ? body.model : 'deepseek-v4-flash';

  // 支持自定义 OpenAI 兼容供应商：body.apiBase 覆盖默认地址，body.reasoning_effort 透传思考强度
  const upstreamBase = (typeof body.apiBase === 'string' && /^https?:\/\//i.test(body.apiBase))
    ? body.apiBase.replace(/\/+$/, '')
    : DEEPSEEK_BASE;
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '';

  const payload = { model, messages: body.messages, stream: true, temperature: 1.0 };
  if (model === 'deepseek-v4-flash') payload.max_tokens = 8192; // v4-pro 使用其默认输出上限
  if (effort && /^(low|medium|high)$/.test(effort)) payload.reasoning_effort = effort;

  // 5xx/429/网络错误自动重试（最多 5 次，指数退避，429 加倍），减少上游间歇性故障透传给前端
  let upstream = null;
  let upstreamStatus = 0;
  let upstreamText = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      upstream = await fetch(upstreamBase + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000),
      });
      upstreamStatus = upstream.status;
      if (upstream.ok) break;
      if ((upstreamStatus >= 500 || upstreamStatus === 429) && attempt < 5) {
        upstreamText = await upstream.text().catch(() => '');
        await sleepMs((upstreamStatus === 429 ? 3000 : 1500) * attempt);
        continue;
      }
      break;
    } catch (e) {
      upstream = null;
      upstreamStatus = 0;
      upstreamText = e.message;
      if (attempt < 5) { await sleepMs(attempt * 1500); continue; }
      break;
    }
  }

  if (!upstream || !upstream.ok) {
    const errText = upstream ? await upstream.text().catch(() => '') : upstreamText;
    return sendJson(res, upstream ? upstreamStatus : 502, {
      error: 'DeepSeek API 返回错误（' + (upstream ? upstreamStatus : 502) + '）：' + errText.slice(0, 600),
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try {
    const { pipeline } = require('stream/promises');
    await pipeline(upstream.body, res);
  } catch {
    // 客户端断开等情况，忽略
  }
}

async function handleFetchArticle(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON' });
  }
  const url = String(body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return sendJson(res, 400, { error: '链接格式无效，请输入以 http(s):// 开头的网址' });
  }

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { /* ignore */ }
  const isToutiao = /(^|\.)toutiao\.com$/i.test(hostname);

  // 头条电脑端网页常被“JS 反爬挑战”拦截（页面只有 _\$jsvmprt 脚本，无正文），
  // 优先走移动端 info 接口 / RENDER_DATA。为降低被 WAF 按“无 cookie 快速请求”识别拦截的几率：
  // 1) 先访问一次移动站拿 tt_webid cookie；2) 带 cookie 请求；3) 失败延迟 1.2s 重试一次。
  if (isToutiao) {
    const ttId = toutiaoArticleId(url);
    if (ttId) {
      const sleepMs = (ms) => new Promise((ok) => setTimeout(ok, ms));
      // 模拟浏览器首次访问，获取 tt_webid cookie
      let ttCookie = '';
      try {
        const seed = await fetch('https://m.toutiao.com/i' + ttId + '/', {
          headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        const sc = seed.headers.get('set-cookie') || '';
        const cm = /tt_webid=([^;]+)/i.exec(sc);
        if (cm) ttCookie = 'tt_webid=' + cm[1];
      } catch { /* 拿不到 cookie 也继续尝试 */ }
      const candidates = [
        { kind: 'info', target: 'https://m.toutiao.com/i' + ttId + '/info/' },
        { kind: 'render', target: 'https://m.toutiao.com/i' + ttId + '/' },
      ];
      for (const cand of candidates) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const hdrs = {
              'User-Agent': MOBILE_UA,
              Accept: cand.kind === 'info' ? 'application/json;q=0.9,text/html;q=0.8' : 'text/html;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9',
              Referer: 'https://m.toutiao.com/',
            };
            if (ttCookie) hdrs.Cookie = ttCookie;
            const cRes = await fetch(cand.target, { headers: hdrs, redirect: 'follow', signal: AbortSignal.timeout(20000) });
            if (!cRes.ok) { if (attempt === 0) { await sleepMs(1200); continue; } break; }
            const cBuf = Buffer.from(await cRes.arrayBuffer());
            if (cBuf.length > MAX_PAGE_BYTES) break;
            let rr = null;
            if (cand.kind === 'info') {
              const j = JSON.parse(cBuf.toString('utf-8'));
              const d = (j && j.data) || {};
              let content = String(d.content || '');
              let title = String(d.title || '');
              let extraImages = [];
              // 微头条（/w/ 链接）：正文在 thread.thread_base（纯文本），图片在 large_image_list
              if (!content.replace(/<[^>]+>/g, '').trim()) {
                const tb = d.thread && d.thread.thread_base;
                if (tb) {
                  content = String(tb.content || tb.title || '');
                  if (!title) title = String(tb.title || '');
                  const list = tb.large_image_list;
                  if (Array.isArray(list)) {
                    for (const it of list) {
                      const u = it && typeof it === 'object' ? String(it.url || '') : String(it || '');
                      if (u && pickArticleImage('<img src="' + u + '">')) extraImages.push(u);
                    }
                  }
                }
              }
              if (content && content.replace(/<[^>]+>/g, '').trim()) {
                rr = toutiaoHtmlToResult(content, title);
                const allImgs = [...new Set([...(rr.images || []), ...extraImages])].slice(0, 30);
                rr.images = allImgs;
              }
            } else {
              const rd = extractToutiaoRenderData(cBuf.toString('utf-8'));
              if (rd) rr = toutiaoHtmlToResult(rd.content, rd.title);
            }
            if (rr && (rr.text || rr.images.length)) {
              return sendJson(res, 200, { title: rr.title, text: rr.text, images: rr.images, url, source: 'toutiao', via: 'toutiao' });
            }
            if (attempt === 0) { await sleepMs(1200); continue; }
            break;
          } catch { if (attempt === 0) { await sleepMs(1200); continue; } break; }
        }
      }
    }
  }

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (isToutiao) headers.Referer = 'https://www.toutiao.com/';

  let upstream;
  try {
    upstream = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return sendJson(res, 502, { error: '抓取失败：' + e.message });
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    return sendJson(res, 400, {
      error: '该链接返回的不是网页（' + (contentType.split(';')[0] || '未知类型') + '），请直接复制文本后粘贴。',
    });
  }
  const len = Number(upstream.headers.get('content-length') || 0);
  if (len > MAX_PAGE_BYTES) return sendJson(res, 413, { error: '页面过大（超过 8MB）' });

  const buf = Buffer.from(await upstream.arrayBuffer());
  if (buf.length > MAX_PAGE_BYTES) return sendJson(res, 413, { error: '页面过大（超过 8MB）' });

  const charset = (contentType.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
  let html;
  try {
    html = new TextDecoder(charset.toLowerCase() === 'gb2312' ? 'gbk' : charset).decode(buf);
  } catch {
    html = buf.toString('utf-8');
  }

  let result;
  if (isToutiao) {
    result = extractToutiao(html);
  } else {
    const r = extractArticle(html);
    result = { title: r.title, text: r.text, images: [] };
  }
  if (!result.text && (!result.images || !result.images.length)) {
    return sendJson(res, 422, {
      error: isToutiao
        ? '未能从今日头条页面提取到正文（可能被 WAF 拦截或页面结构变化），请复制文本后直接粘贴。'
        : '未能从该页面提取到正文（可能是动态渲染页面或反爬限制），请复制文本后直接粘贴。',
    });
  }
  sendJson(res, 200, {
    title: result.title,
    text: result.text,
    images: result.images || [],
    url,
    source: isToutiao ? 'toutiao' : 'generic',
  });
}

/* ---------------- 静态资源 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 500, { error: 'read error' });
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 服务 ---------------- */
const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad request' });
  }
  try {
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, { hasServerKey: Boolean(SERVER_KEY), expired: isExpiredNow() });
    }
    if (isExpiredNow()) {
      return sendJson(res, 403, { error: '软件已到期（2026-08-28），功能已停止使用' });
    }
    if (req.method === 'POST' && pathname === '/api/rewrite') return handleRewrite(req, res);
    if (req.method === 'POST' && pathname === '/api/fetch-article') return handleFetchArticle(req, res);
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: '服务器内部错误：' + e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  文章助手 v1.36 已启动');
  console.log('  访问地址: http://' + HOST + ':' + PORT);
  console.log(
    SERVER_KEY
      ? '  API Key: 已从环境变量 DEEPSEEK_API_KEY 读取（前端无需填写）'
      : '  API Key: 未配置，请在页面右上角填写'
  );
  console.log('  提示: Ctrl+C 停止服务');
  console.log('──────────────────────────────────────────────');
});
