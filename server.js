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
// 软件试用期限制：2099-08-28 00:00（北京时间）到期后接口全部拒绝（改日期请改下面这一处）
const EXPIRY_MS = 4091529600000; // 2099-08-27T16:00:00Z
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
  let title = '';
  const wxTitle = html.match(/<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
    || html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);
  if (wxTitle) title = decodeEntities(wxTitle[1].trim());
  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';
  }

  let seg = html;
  const wxContent = html.match(/<div[^>]*class="[^"]*rich_media_content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (wxContent) {
    seg = wxContent[1];
  } else {
    seg = seg
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|iframe|svg|nav|header|footer|aside|form|button|select|input|textarea|video|audio|canvas|template|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  }

  const images = [];
  const imgRe = /<img[^>]*>/gi;
  let im;
  while ((im = imgRe.exec(seg)) !== null) {
    const u = pickArticleImage(im[0]);
    if (u) images.push(u);
  }

  let segProcessed = seg
    .replace(/<img[^>]*>/gi, (tag) => (pickArticleImage(tag) ? ' \n[图片]\n ' : ''))
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const processedParagraphs = decodeEntities(segProcessed)
    .split('\n')
    .map((l) => l.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter((l) => l.length > 0);

  let segRaw = seg
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const rawParagraphs = decodeEntities(segRaw)
    .split('\n')
    .map((l) => l.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter((l) => l.length > 0);

  const rawText = rawParagraphs.join('\n').slice(0, MAX_ARTICLE_CHARS);
  const processedText = processedParagraphs.join('\n').slice(0, MAX_ARTICLE_CHARS);

  return {
    title,
    rawText,
    processedText,
    text: processedText,
    images: [...new Set(images)].slice(0, 30),
  };
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

  const rawParagraphs = [];
  const processedParagraphs = [];
  const images = [];
  let m;
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = pRe.exec(seg)) !== null) {
    const innerRaw = m[1]
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<img[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t\u3000]+/g, ' ')
      .trim();
    if (innerRaw) rawParagraphs.push(innerRaw);

    const innerProcessed = m[1]
      .replace(/<br[^>]*>/gi, '\n')
      .replace(/<img[^>]*>/gi, (tag) => (pickArticleImage(tag) ? ' \n[图片]\n ' : ''))
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/[ \t\u3000]+/g, ' ')
      .trim();
    if (innerProcessed) {
      for (const sub of innerProcessed.split('\n')) {
        const s = sub.trim();
        if (s) processedParagraphs.push(s);
      }
    }
  }
  const imgRe = /<img[^>]*>/gi;
  while ((m = imgRe.exec(seg)) !== null) {
    const url = pickArticleImage(m[0]);
    if (url) images.push(url);
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 120) : '';
  const rawText = rawParagraphs.join('\n').slice(0, MAX_ARTICLE_CHARS);
  const processedText = processedParagraphs.join('\n').slice(0, MAX_ARTICLE_CHARS);
  return {
    title,
    rawText,
    processedText,
    text: processedText,
    images: [...new Set(images)].slice(0, 30),
  };
}

/* ---------------- 今日头条：info 接口 / 移动端 RENDER_DATA（桌面页被反爬 JS 挑战拦截时的备用通道） ---------------- */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function toutiaoArticleId(url) {
  let m = /\/(?:article|w|i|group|item|trending)\/(\d{6,})/i.exec(url || '');
  if (m) return m[1];
  m = /(\d{6,})/.exec(url || '');
  return m ? m[1] : null;
}

/**
 * 将头条正文 HTML 转换为两篇文章：
 * 1. rawText: 原始文章，纯净真实段落，不做任何人工添加[图片]占位或剔除处理，用于直接Word导出与文皮皮查重对比
 * 2. processedText: 预处理文章，在每个配图位置保留 [图片] 占位标记，供 AI 生成使用
 */
function toutiaoHtmlToResult(contentHtml, title, extraImages) {
  const images = [];
  const rawParagraphs = [];
  const processedParagraphs = [];

  const imgRe = /<img[^>]*>/gi;
  let im;
  while ((im = imgRe.exec(contentHtml)) !== null) {
    const u = pickArticleImage(im[0]);
    if (u) images.push(u);
  }

  let segProcessed = String(contentHtml)
    .replace(/<img[^>]*>/gi, (tag) => (pickArticleImage(tag) ? ' \n[图片]\n ' : ''))
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  for (const line of segProcessed.split('\n')) {
    const l = decodeEntities(line).replace(/[ \t\u3000\u00A0]+/g, ' ').trim();
    if (l) processedParagraphs.push(l);
  }

  let segRaw = String(contentHtml)
    .replace(/<img[^>]*>/gi, '')
    .replace(/<br[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  for (const line of segRaw.split('\n')) {
    const l = decodeEntities(line).replace(/[ \t\u3000\u00A0]+/g, ' ').trim();
    if (l) rawParagraphs.push(l);
  }

  const rawText = rawParagraphs.join('\n\n').slice(0, MAX_ARTICLE_CHARS);
  let processedText = processedParagraphs.join('\n\n').slice(0, MAX_ARTICLE_CHARS);

  const allImgs = [...new Set([...images, ...(extraImages || [])])].slice(0, 30);
  if (allImgs.length && !processedText.includes('[图片]')) {
    const paras = processedText.split('\n\n');
    const withImgs = [];
    let imgIdx = 0;
    for (let i = 0; i < paras.length; i++) {
      withImgs.push(paras[i]);
      if (imgIdx < allImgs.length) {
        withImgs.push('[图片]');
        imgIdx++;
      }
    }
    while (imgIdx < allImgs.length) {
      withImgs.push('[图片]');
      imgIdx++;
    }
    processedText = withImgs.join('\n\n');
  }

  let cleanTitle = decodeEntities(String(title || '')).split('\n')[0].replace(/<[^>]+>/g, '').replace(/[:：，,。!！\s]+$/, '').trim();
  if (cleanTitle.length > 80) cleanTitle = cleanTitle.slice(0, 80).trim();

  return {
    title: cleanTitle,
    rawText,
    processedText,
    text: processedText,
    images: allImgs,
  };
}

function extractToutiaoRenderData(html) {
  const m = /<script id="RENDER_DATA" type="application\/json">([\s\S]*?)<\/script>/i.exec(html || '');
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
  const info = (obj && obj.articleInfo) || null;
  let content = '';
  let title = '';
  let extraImages = [];

  if (info) {
    content = String(info.content || '');
    title = String(info.title || '');
  }

  let isMicro = false;
  // 微头条（thread）兜底：支持 threadBase 与 thread_base
  if (!content || !content.replace(/<[^>]+>/g, '').trim()) {
    const thread = (info && info.thread) || (obj && (obj.thread || (obj.data && obj.data.thread))) || null;
    const tb = (thread && (thread.threadBase || thread.thread_base)) || (obj && (obj.threadBase || obj.thread_base)) || null;
    if (tb) {
      isMicro = true;
      content = String(tb.content || tb.title || '');
      const firstLine = String(tb.title || content || '').split('\n')[0].replace(/<[^>]+>/g, '').replace(/[:：，,。!！\s]+$/, '').trim();
      if (firstLine) title = firstLine;
      const list = tb.largeImageList || tb.large_image_list;
      if (Array.isArray(list)) {
        for (const it of list) {
          const u = it && typeof it === 'object' ? String(it.url || '') : String(it || '');
          if (u && pickArticleImage('<img src="' + u + '">')) extraImages.push(u);
        }
      }
    }
  }

  if (!isMicro && obj && obj.seoTDK && obj.seoTDK.title) {
    const cleanSeoTitle = String(obj.seoTDK.title).replace(/(?:\s+网友)?\s*[_-].*今日头条.*$/i, '').trim();
    if (cleanSeoTitle) title = cleanSeoTitle;
  }
  if (!title || title === content || title.includes('\n') || title.length > 80) {
    const firstLine = String(content).split('\n')[0].replace(/<[^>]+>/g, '').replace(/[:：，,。!！\s]+$/, '').trim();
    if (firstLine) title = firstLine.slice(0, 80);
  }

  if (!content || !content.replace(/<[^>]+>/g, '').trim()) return null;
  return toutiaoHtmlToResult(content, title, extraImages);
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

  const payload = { model, messages: body.messages, stream: true, temperature: 0.95 };
  payload.max_tokens = 131072; // 默认输出上限 128K（所有模型统一）
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
  let url = String(body.url || '').trim();
  const urlMatch = url.match(/https?:\/\/[^\s"'<>\u4e00-\u9fa5]+/i);
  if (urlMatch) {
    url = urlMatch[0].replace(/[.,;:!?，。？！；：“”‘’()（）\[\]{}<>]+$/, '').trim();
  }
  if (!/^https?:\/\//i.test(url)) {
    return sendJson(res, 400, { error: '链接格式无效，请输入以 http(s):// 开头的网址' });
  }

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { /* ignore */ }
  let isToutiao = /(^|\.)toutiao\.com$/i.test(hostname);

  let ttId = isToutiao ? toutiaoArticleId(url) : null;

  // 头条短链（如 https://m.toutiao.com/is/xxxx/）无数字 ID：跟随重定向获取真实目标 URL 与 ID
  if (isToutiao && !ttId) {
    try {
      const redir = await fetch(url, {
        headers: {
          'User-Agent': MOBILE_UA,
          Referer: 'https://m.toutiao.com/',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (redir && redir.url) {
        ttId = toutiaoArticleId(redir.url);
      }
    } catch { /* ignore */ }
  }

  // 今日头条优先：单次移动端 SSR 请求，一步到位直接解析 RENDER_DATA（免去桌面 UA 反爬 JS 挑战）
  if (isToutiao && ttId) {
    const hdrs = {
      'User-Agent': MOBILE_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://m.toutiao.com/',
      'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Android";v="13"',
      'Sec-Ch-Ua-Mobile': '?1',
      'Sec-Ch-Ua-Platform': '"Android"',
    };

    try {
      const renderRes = await fetch('https://m.toutiao.com/i' + ttId + '/', {
        headers: hdrs,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (renderRes.ok) {
        const html = await renderRes.text();
        const rd = extractToutiaoRenderData(html);
        if (rd && (rd.rawText || rd.images.length)) {
          return sendJson(res, 200, {
            title: rd.title,
            rawText: rd.rawText,
            processedText: rd.processedText,
            text: rd.processedText,
            images: rd.images,
            url,
            source: 'toutiao',
            via: 'render',
          });
        }
      }
    } catch { /* 备用 info 接口 */ }

    // 备用：info JSON 接口
    try {
      const infoRes = await fetch('https://m.toutiao.com/i' + ttId + '/info/', {
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'application/json;q=0.9,text/html;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://m.toutiao.com/',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (infoRes.ok) {
        const j = await infoRes.json();
        const d = (j && j.data) || {};
        let content = String(d.content || '');
        let title = String(d.title || '');
        let extraImages = [];
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
          const rr = toutiaoHtmlToResult(content, title, extraImages);
          if (rr.rawText || rr.images.length) {
            return sendJson(res, 200, {
              title: rr.title,
              rawText: rr.rawText,
              processedText: rr.processedText,
              text: rr.processedText,
              images: rr.images,
              url,
              source: 'toutiao',
              via: 'info',
            });
          }
        }
      }
    } catch { /* fallback */ }
  }

  // 通用抓取（头条坚决使用移动 UA 避免 _$jsvmprt WAF 拦截；其他网站兼顾移动与桌面兼容性）
  const headers = {
    'User-Agent': isToutiao
      ? MOBILE_UA
      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (isToutiao) headers.Referer = 'https://m.toutiao.com/';

  let fetchUrl = url;
  if (isToutiao) {
    // 强制转换为移动端 m.toutiao.com，获取包含 RENDER_DATA 的移动 SSR 页面，避开桌面端 _$jsvmprt WAF 反爬
    fetchUrl = url.replace(/^(https?:\/\/)(?:www\.)?toutiao\.com/i, '$1m.toutiao.com');
  }

  let upstream;
  try {
    upstream = await fetch(fetchUrl, {
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

  let result = null;
  if (isToutiao) {
    result = extractToutiaoRenderData(html) || extractToutiao(html);
  } else {
    result = extractArticle(html);
  }

  if (!result || (!result.rawText && (!result.images || !result.images.length))) {
    return sendJson(res, 422, {
      error: isToutiao
        ? '未能从今日头条页面提取到正文（可能被 WAF 拦截或页面结构变化），请复制文本后直接粘贴。'
        : '未能从该页面提取到正文（可能是动态渲染页面或反爬限制），请复制文本后直接粘贴。',
    });
  }
  sendJson(res, 200, {
    title: result.title,
    rawText: result.rawText,
    processedText: result.processedText,
    text: result.processedText,
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
      return sendJson(res, 403, { error: '软件已到期（2099-08-28），功能已停止使用' });
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
  console.log('  文章助手 v1.60 已启动');
  console.log('  访问地址: http://' + HOST + ':' + PORT);
  console.log(
    SERVER_KEY
      ? '  API Key: 已从环境变量 DEEPSEEK_API_KEY 读取（前端无需填写）'
      : '  API Key: 未配置，请在页面右上角填写'
  );
  console.log('  提示: Ctrl+C 停止服务');
  console.log('──────────────────────────────────────────────');
});
