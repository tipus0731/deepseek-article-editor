/* ================= 智能改写 + 自动判重 + 预览 + 保存 Word（依赖 app.js 的全局函数） =================
 * 规则：最多尝试 3 次；重复度 ≤5% 达标；≥8% 降重重写（最多 3 次后不再尝试）；5%~8% 合格。
 * 完成后：显示含图片的导出预览 + 保存按钮（Android Word 存 Pictures 根目录 /storage/emulated/0/Pictures，网页存浏览器下载目录）。
 * 判重 = 全文文本相似度（文皮皮思路，字符 8-gram Jaccard）。
 */
(function () {
  'use strict';
  if (window.__smartLoaded) return;
  window.__smartLoaded = true;

  let lastDocx = null;
  let lastSim = null; // 最近一次智能改写的重复率（用于 Word 文件名）

  function buildSmartMessages(original, prevSim) {
    const baseMsgs = buildMessages(original);
    let user = baseMsgs[1].content;
    user += '\n\n【图片处理】' + getImgPrompt();
    if (prevSim != null) {
      user += '\n\n' + getDedupPrompt().replace('{sim}', (prevSim * 100).toFixed(1));
    }
    return [{ role: 'system', content: baseMsgs[0].content }, { role: 'user', content: user }];
  }

    function splitTextBlocks(text) {
    const blocks = [];
    const raw = String(text || '').replace(/(\[图片\]|【图片】)/g, ' ').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    for (const p of raw) {
      if (/^#{1,6}\s/.test(p)) blocks.push({ type: 'h', text: p.replace(/^#{1,6}\s*/, '') });
      else blocks.push({ type: 'p', text: p });
    }
    return blocks;
  }

  /* 按“原文位置”对齐插入图片（替代原来只在改写文本 [图片] 标记处插图，标记一丢图就全跑末尾的问题）：
   * 1) 记录每张图在原文中前面相邻的段落（锚点段落序号）；
   * 2) 在改写文本中用相似度找到与锚点段落最对应的改写段落（找不到→按段落比例映射兜底）；
   * 3) 图片插到对应改写段之后，保持图片原顺序。 */
  function blocksWithImages(originalText, rewriteText, images) {
    const imageList = images || [];
    if (!imageList.length) return splitTextBlocks(rewriteText);
    const origBlocks = splitTextBlocks(originalText || '');

    // 锚点：每张图在原文中的“前一段落”序号
    const anchors = [];
    {
      const parts = String(originalText || '').split(/(\[图片\]|【图片】)/g);
      let paraBefore = 0;
      for (let i = 0; i < parts.length; i++) {
        if (i % 2 === 1) { anchors.push(Math.max(0, paraBefore - 1)); continue; }
        paraBefore += parts[i].split(/\n+/).map((s) => s.trim()).filter(Boolean).length;
      }
      if (!anchors.length) for (let i = 0; i < imageList.length; i++) anchors.push(0);
    }

    const rewBlocks = splitTextBlocks(rewriteText);
    const inserts = imageList.map((img, i) => {
      let oa = (anchors[i] != null && origBlocks.length) ? Math.min(anchors[i], origBlocks.length - 1) : -1;
      let after = -1;
      if (oa >= 0) {
        const oaText = origBlocks[oa].text || '';
        let best = -1, bestSim = 0.12;
        for (let j = 0; j < rewBlocks.length; j++) {
          const s = textSimilarity(oaText, rewBlocks[j].text);
          if (s > bestSim) { bestSim = s; best = j; }
        }
        if (best >= 0) after = best;
      }
      if (after < 0 && rewBlocks.length) {
        const ratio = (oa >= 0 && origBlocks.length > 1)
          ? oa / (origBlocks.length - 1)
          : (imageList.length > 1 ? i / (imageList.length - 1) : 0);
        after = Math.min(rewBlocks.length - 1, Math.max(0, Math.round(ratio * (rewBlocks.length - 1))));
      }
      return { after, img };
    });

    const blocks = [];
    rewBlocks.forEach((b, j) => {
      blocks.push(b);
      for (const ins of inserts) if (ins.after === j) blocks.push(ins.img);
    });
    for (const ins of inserts) if (ins.after < 0) blocks.push(ins.img);
    return blocks;
  }

  /* 单张图片 → Word PNG 块：
   * 1) 已去水印的（blobUrl）优先；
   * 2) 否则按当前水印位置/比例自动裁切；
   * 3) 裁切失败回退原图。 */
  function pngFromItem(item, wmPos, wmRatio) {
    if (item && item.blobUrl) {
      return loadImgForDocx(item.blobUrl).catch(() => autoCropOrOriginal(item, wmPos, wmRatio));
    }
    return autoCropOrOriginal(item, wmPos, wmRatio);
  }
  async function autoCropOrOriginal(item, wmPos, wmRatio) {
    if (!item || !item.url) throw new Error('无图片地址');
    try {
      const blob = await cropImageToBlob(item.url, wmPos, wmRatio);
      const burl = URL.createObjectURL(blob);
      try {
        const png = await loadImgForDocx(burl);
        setTimeout(() => URL.revokeObjectURL(burl), 60000);
        return png;
      } catch (e) {
        URL.revokeObjectURL(burl);
        throw e;
      }
    } catch (e) {
      return loadImgForDocx(item.url);
    }
  }

  /* 批量准备图片块：items=[{url, blobUrl}] → [{type:'img', data, w, h}] */
  async function preparePngImages(items, opts) {
    const out = [];
    const list = items || [];
    const wmPos = (opts && opts.wmPos) || document.getElementById('wmPos').value;
    const wmRatio = (opts && opts.wmRatio) != null
      ? opts.wmRatio
      : Number(document.getElementById('wmRatio').value) / 100;
    const autoCrop = (opts && opts.autoCrop != null)
      ? !!opts.autoCrop
      : (typeof autoCropEnabled === 'function') ? autoCropEnabled() : true; // 批量导出可传 opts.autoCrop=true 默认去水印
    for (let i = 0; i < list.length; i++) {
      try {
        let png;
        if (autoCrop) {
          // 已裁切（blobUrl）优先，否则自动裁切去水印，失败回退原图
          png = await pngFromItem(list[i], wmPos, wmRatio);
        } else {
          png = await loadImgForDocx(list[i].blobUrl || list[i].url);
        }
        out.push({ type: 'img', data: png.data, w: png.w, h: png.h });
      } catch (e) {
        if (opts && opts.log) opts.log('⚠ 第 ' + (i + 1) + ' 张图片跳过：' + e.message);
      }
    }
    return out;
  }

  async function downloadDocx(buffer, name) {
    if (IS_ANDROID && window.AndroidBridge && window.AndroidBridge.beginSave) {
      // 分块传输 base64（每块 12KB，3 的倍数保证 base64 拼接正确），避免大文件单次传参失败
      window.AndroidBridge.beginSave(name, false);
      const CHUNK = 0x3000;
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const sub = buffer.subarray(i, i + CHUNK);
        let bin = '';
        for (let j = 0; j < sub.length; j++) bin += String.fromCharCode(sub[j]);
        window.AndroidBridge.appendChunk(btoa(bin));
      }
      window.AndroidBridge.endSave();
      return;
    }
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function logAuto(text) {
    const el = document.getElementById('autoLog');
    el.classList.remove('hidden');
    const p = document.createElement('div');
    p.textContent = text;
    el.appendChild(p);
    el.scrollTop = el.scrollHeight;
  }

  /* ---- 重复率大屏显示 ---- */
  function updateSimDisplay(attempt, pct) {
    document.getElementById('simDisplay').classList.remove('hidden');
    document.getElementById('simAttempts').textContent = '第 ' + attempt + '/3 次尝试';
    const v = document.getElementById('simValue');
    const st = document.getElementById('simStatus');
    v.textContent = pct + '%';
    if (pct <= 5) {
      v.className = 'sim-value ok';
      st.textContent = '✅ 达标（≤5%）';
      st.className = 'sim-status ok';
    } else if (pct < 8) {
      v.className = 'sim-value mid';
      st.textContent = '✅ 合格（5%~8%）';
      st.className = 'sim-status mid';
    } else {
      v.className = 'sim-value bad';
      st.textContent = '⚠ 超标（≥8%）' + (attempt >= 3 ? '，不再尝试' : '，将降重重写');
      st.className = 'sim-status bad';
    }
  }

  /* ---- 导出预览（标题/段落/图片按位置渲染） ---- */
  function renderPreview(blocks) {
    const body = document.getElementById('previewBody');
    document.getElementById('previewArea').classList.remove('hidden');
    body.innerHTML = '';
    for (const b of blocks) {
      if (b.type === 'img') {
        const blob = new Blob([b.data], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = document.createElement('img');
        img.src = url;
        img.className = 'preview-img';
        img.alt = '文章配图';
        body.appendChild(img);
      } else if (b.type === 'h') {
        const h = document.createElement('div');
        h.className = 'preview-h';
        h.textContent = b.text;
        body.appendChild(h);
      } else {
        const p = document.createElement('p');
        p.textContent = b.text;
        body.appendChild(p);
      }
    }
  }

  /* ---- 保存按钮（常驻）：优先用智能改写结果，否则用当前输出即时生成 ---- */
  function initSaveButton() {
    document.getElementById('saveWordBtn').onclick = async () => {
      if (isExpired()) { logAuto('❌ 软件已到期，功能已停止使用'); return; }
      const btn = document.getElementById('saveWordBtn');
      btn.disabled = true;
      btn.textContent = '导出中…';
      try {
        // 始终用“当前状态”重建 Word：已裁切用裁切图，未裁切自动裁切，保证图片最新且必进文档
        let text = outputText || '';
        if (!text.trim()) throw new Error('当前没有可导出的内容，请先点击「开始修改」或「智能改写」生成文章');
        const cut = cutFactCheck(text); // 剔除「事实核查表」及之后内容
        if (cut.length < text.length) logAuto('✂ 已剔除「事实核查表」及其后的内容');
        text = cut;
        const pngImages = await preparePngImages(articleImages || []);
        const blocks = blocksWithImages(lastOriginal, text, pngImages);
        const buffer = buildDocx('生成文章', blocks);
        const name = docxNameFromText(text, '生成文章', lastSim);
        await downloadDocx(buffer, name);
        logAuto('💾 已保存：' + name);
      } catch (e) {
        logAuto('❌ 导出失败：' + e.message);
      }
      btn.disabled = false;
      btn.textContent = '💾 导出 Word 文档';
    };
  }
  function updateSaveHint() {
    document.getElementById('saveWordHint').textContent = IS_ANDROID
      ? '导出后保存到手机「Pictures」文件夹（/storage/emulated/0/Pictures）'
      : '导出到浏览器下载目录（Ctrl+J 可查看）';
  }

  async function runSmartRewrite() {
    if (isExpired()) { setStatus('软件已到期（2026-08-20），功能已停止使用', 'error'); return; }
    if (window.__smartBusy) return;
    const original = getSourceText();
    if (!original) return;

    // 重置相关区域（保存按钮常驻显示，不隐藏）
    document.getElementById('simDisplay').classList.add('hidden');
    document.getElementById('previewArea').classList.add('hidden');
    const logEl = document.getElementById('autoLog');
    logEl.classList.remove('hidden');
    logEl.innerHTML = '';

    // 图片源：已去水印的用裁切结果，其余按当前水印设置自动裁切，失败回退原图
    const imgItems = articleImages || [];
    let pngImages = [];
    if (imgItems.length) {
      logAuto('正在准备 ' + imgItems.length + ' 张图片（裁切去水印 + 转换 Word 格式）…');
      pngImages = await preparePngImages(imgItems, { log: logAuto });
      const failed = imgItems.length - pngImages.length;
      logAuto('图片就绪：' + pngImages.length + '/' + imgItems.length + ' 张' + (failed ? '（跳过 ' + failed + ' 张）' : '') + ((typeof autoCropEnabled === 'function' && autoCropEnabled()) ? '（已自动去水印）' : ''));
    }

    const apiKey = document.getElementById('apiKey').value.trim();
    if (apiKey) storeSet('dsw_apikey', apiKey);
    const model = document.getElementById('model').value;

    window.__smartBusy = true;
    document.getElementById('smartBtn').disabled = true;
    logAuto('开始智能改写（最多 3 次尝试，判重目标 ≤5%）');

    let finalText = '';
    let finalSim = 1;
    let attemptsUsed = 0;

    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        attemptsUsed = attempt;
        logAuto('—— 第 ' + attempt + '/3 次改写 ——');
        setStatus('第 ' + attempt + '/3 次改写中…', 'loading');
        const messages = buildSmartMessages(original, attempt > 1 ? finalSim : null);
        lastOriginal = original;
        outputText = '';
        document.getElementById('outResult').textContent = '';
        document.getElementById('outResult').classList.remove('hidden');
        document.getElementById('outEmpty').classList.add('hidden');
        switchView('result');
        startTimer('正在改写（第 ' + attempt + '/3 次）…');
        await streamRewrite({ apiKey, model, messages }, new AbortController().signal);
        stopTimer();
        renderRichResult();

        const sim = textSimilarity(original, outputText);
        finalSim = sim;
        finalText = cutFactCheck(outputText); // 剔除「事实核查表」及之后内容（预览/导出用）
        const pct = (sim * 100).toFixed(1);
        updateSimDisplay(attempt, parseFloat(pct));
        logAuto('本次重复度：' + pct + '% （目标 ≤5%，重试线 ≥8%）');

        if (sim <= 0.05) { logAuto('✅ 重复度 ' + pct + '% ≤ 5%，达标！'); break; }
        if (sim < 0.08) { logAuto('✅ 重复度 ' + pct + '%（5%~8% 合格区间）。'); break; }
        if (attempt < 3) {
          logAuto('⚠ 重复度 ' + pct + '% ≥ 8%，进行下一次降重改写…');
        } else {
          logAuto('⚠ 3 次尝试后重复度仍 ' + pct + '% ≥ 8%，不再尝试，按当前版本生成。');
        }
      }

      // 记录本次重复率（供保存按钮命名），生成预览 + 准备 Word（不自动下载，等用户点保存）
      lastSim = finalSim;
      setStatus('正在生成导出预览…', 'loading');
      const blocks = blocksWithImages(original, finalText, pngImages);
      renderPreview(blocks);
      const docxBuf = buildDocx('生成文章', blocks);
      const name = docxNameFromText(finalText, '生成文章', finalSim);
      lastDocx = { buffer: docxBuf, name: name };
      updateSaveHint();
      logAuto('📄 预览已生成：' + blocks.length + ' 个内容块（含图片 ' + pngImages.length + ' 张）。点击「💾 导出 Word 文档」保存。');
      setStatus('✅ 完成：重复度 ' + (finalSim * 100).toFixed(1) + '%（' + attemptsUsed + '/3 次尝试），可预览并保存 Word');
    } catch (e) {
      stopTimer();
      setStatus('❌ ' + e.message, 'error');
    } finally {
      window.__smartBusy = false;
      document.getElementById('smartBtn').disabled = false;
    }
  }

  /* ================= 多链接并发处理：所有链接同时 抓取 → 改写 → 导出含图 Word ================= */
  function parseLinks() {
    const raw = String(document.getElementById('linkUrl').value || '');
    const seen = new Set();
    const urls = [];
    for (const seg of raw.split(/[\s,，;；]+/)) {
      const u = seg.trim();
      if (/^https?:\/\//i.test(u) && !seen.has(u)) { seen.add(u); urls.push(u); }
    }
    return urls;
  }
  /* 导出文件名：内容（去空白）前 10 个字 + 重复率（如 xxx_重复率12.3%.docx） */
  function docxNameFromText(text, fallback, simPct) {
    const t = String(text || '').replace(/\s+/g, '');
    let n = t.slice(0, 10);
    if (!n) n = fallback || '生成文章';
    n = n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    if (!n) n = '生成文章';
    let suffix = '';
    if (simPct != null) suffix = '_重复率' + (simPct * 100).toFixed(1) + '%';
    return n + suffix + '.docx';
  }

  /* 剔除「事实核查表」及其之后的所有内容（导出预览与 Word 共用） */
  function cutFactCheck(text) {
    const t = String(text || '');
    const i = t.indexOf('事实核查表');
    if (i < 0) return t;
    return t.slice(0, i).replace(/\s+$/, '');
  }

  function safeDocxName(title, index) {
    let n = String(title || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_');
    n = n.replace(/[\u0000-\u001f]/g, '');
    if (!n) n = '文章' + (index + 1);
    if (n.length > 40) n = n.slice(0, 40);
    return n + '.docx';
  }

  /* ================= 原生并行 AI 改写（Android Java 线程池） ================= */
  // JS 一次性把全部改写任务交给 MainActivity 的 ExecutorService 多线程并发调用
  // DeepSeek / 自定义 OpenAI 兼容接口（非流式，每个线程同步等待全文返回），突破 WebView 同域连接数限制。
  let nativeAiSeq = 0;
  const nativeAiPending = {}; // cbId -> state{ byId, total, done, timer, finish }
  window.onNativeAiResult = function (cbId, taskId, res) {
    const h = nativeAiPending && nativeAiPending[cbId];
    if (!h) return;
    const p = h.byId.get(taskId);
    if (p) {
      h.byId.delete(taskId);
      if (res && res.ok && typeof res.text === 'string') p.resolve(res.text);
      else p.reject(new Error((res && res.error) || 'AI 调用失败'));
    }
    h.done++;
    if (h.done >= h.total) h.finish();
  };
  /** 提交一批改写任务到原生线程池；返回与 taskList 对齐的结果数组（失败项为 {__err}） */
  function nativeAiBatch(taskList) {
    return new Promise((batchResolve) => {
      const cbId = 'ai' + (++nativeAiSeq) + '_' + Date.now();
      const byId = new Map();
      const proms = taskList.map((t) => new Promise((resolve, reject) => byId.set(t.id, { resolve, reject })));
      const state = {
        byId, done: 0, total: taskList.length, timer: null,
        finish: () => { clearTimeout(state.timer); delete nativeAiPending[cbId]; batchResolve(); },
      };
      state.timer = setTimeout(() => {
        byId.forEach((p) => p.reject(new Error('原生 AI 调用超时（240 秒）')));
        state.finish();
      }, 240000);
      nativeAiPending[cbId] = state;
      window.AndroidBridge.batchAiRewrite(JSON.stringify(taskList), cbId);
      batchResolve(Promise.all(proms.map((p) => p.catch((e) => ({ __err: e.message })))));
    });
  }

  async function runBatchLinks() {
    if (window.__batchBusy) return;
    if (isExpired()) { setStatus('软件已到期（2026-08-20），功能已停止使用', 'error'); return; }
    const urls = parseLinks();
    if (!urls.length) {
      logAuto('⚠ 链接框为空或没有有效的 http(s) 链接，请粘贴链接（每行一个）');
      return;
    }
    const apiKey = document.getElementById('apiKey').value.trim();
    if (apiKey) storeSet('dsw_apikey', apiKey);
    const model = document.getElementById('model').value;
    const apiBase = String((els.apiBase && els.apiBase.value) || '').trim();
    const reasoningEffort = (els.thinking && els.thinking.checked && !/api\.deepseek\.com$/i.test(apiBase))
      ? ({ max: 'high', high: 'high', medium: 'medium', low: 'low' }[els.effort.value] || 'high')
      : '';

    window.__batchBusy = true;
    const btn = document.getElementById('batchBtn');
    if (btn) { btn.disabled = true; btn.textContent = '并发处理中…'; }
    const logEl = document.getElementById('autoLog');
    logEl.classList.remove('hidden');

    const nativeAI = !!(IS_ANDROID && window.AndroidBridge && typeof window.AndroidBridge.batchAiRewrite === 'function');
    const tBatch = Date.now(); // 并发处理总耗时计时
    logAuto('📚 开始并发处理 ' + urls.length + ' 个链接（所有链接同时抓取 → AI 改写 → 导出 Word，全流程并行）');
    if (nativeAI) logAuto('🤖 已启用「原生 Java 线程池」并行调用 AI 接口（不受 WebView 同域连接数限制）');

    const articles = []; // { idx, url, title, text, pngImages, messages, tOne, ok, err, stage }

    // ---- 阶段1（全并行）：抓取文章 + 裁切图片 + 组装 AI 任务 ----
    await Promise.all(urls.map(async (url, i) => {
      const rec = { idx: i + 1, url, tOne: Date.now(), ok: false, err: null };
      articles.push(rec);
      setStatus('正在同时处理 ' + rec.idx + '/' + urls.length + ' 篇…', 'loading');
      logAuto('—— [' + rec.idx + '/' + urls.length + '] ' + url + ' ——');
      try {
        const data = await fetchOne(url);
        if (!data) throw new Error('没有获取到内容');
        const articleText = String(data.text || '').trim();
        if (!articleText) throw new Error('抓取到的正文为空');
        const imgs = (data.images || []).filter((u) => typeof u === 'string' && u);
        logAuto('✅ 抓取成功：' + (data.title || '(无标题)') + '（正文 ' + articleText.length + ' 字，图片 ' + imgs.length + ' 张）');

        // 图片 → 自动裁切水印 + Word 可嵌入 PNG（批量导出默认去除水印）
        const items = imgs.map((u) => ({ url: u, blobUrl: '' }));
        const pngImages = await preparePngImages(items, { log: logAuto, autoCrop: true });

        rec.title = data.title;
        rec.text = articleText;
        rec.pngImages = pngImages;
        rec.messages = buildSmartMessages(articleText, null); // 复用当前全部修改条件 + 图片占位要求
        rec.ok = true;
      } catch (e) {
        rec.err = e.message;
        logAuto('❌ 第 ' + rec.idx + ' 条抓取/图片失败：' + e.message);
      }
    }));

    // ---- 阶段2（全并行）：AI 改写（Android 走原生 Java 线程池；Web 走 JS 并行流式） ----
    const aiResults = new Map(); // idx -> { ok, text } | { ok:false, err }
    const ready = articles.filter((a) => a.ok);
    logAuto('⏳ AI 改写中（' + ready.length + ' 篇，' + (model === 'deepseek-reasoner' ? '思考模型' : '快速模型')
      + (nativeAI ? '，原生 Java 多线程' : '，JS 并行') + '）…');
    if (nativeAI) {
      const texts = await nativeAiBatch(ready.map((a) => ({
        id: String(a.idx), apiKey, apiBase, model, messages: a.messages, reasoningEffort,
      })));
      texts.forEach((r, j) => {
        const a = ready[j];
        if (r && r.__err) aiResults.set(a.idx, { ok: false, err: r.__err });
        else aiResults.set(a.idx, { ok: true, text: String(r || '').trim() });
      });
    } else {
      await Promise.all(ready.map(async (a) => {
        const collector = { text: '' };
        try {
          await streamRewrite({ apiKey, model, messages: a.messages }, new AbortController().signal, collector);
          aiResults.set(a.idx, { ok: true, text: String(collector.text || '').trim() });
        } catch (e) {
          aiResults.set(a.idx, { ok: false, err: e.message });
        }
      }));
    }

    // ---- 阶段3（全并行）：构建并导出 Word（文件名 = 正文前 10 字 + 重复率） ----
    await Promise.all(ready.map(async (a) => {
      const r = aiResults.get(a.idx);
      if (!r || !r.ok) { a.ok = false; a.err = (r && r.err) || 'AI 未返回内容'; a.stage = '改写'; return; }
      try {
        let out = String(r.text || '').trim();
        if (!out) throw new Error('AI 未返回内容');
        const cut = cutFactCheck(out); // 剔除「事实核查表」及之后内容
        if (cut.length < out.length) logAuto('✂ [第 ' + a.idx + ' 篇] 已剔除「事实核查表」及其后的内容');
        out = cut;
        const sim = textSimilarity(a.text, out); // 本次重复率
        const blocks = blocksWithImages(a.text, out, a.pngImages || []);
        const docxName = docxNameFromText(out, a.title || ('文章' + a.idx), sim);
        const docxBuf = buildDocx(a.title || '生成文章', blocks);
        logAuto('📄 [第 ' + a.idx + ' 篇] 保存 Word：' + docxName + '（重复率 ' + (sim * 100).toFixed(1) + '%，' + (a.pngImages || []).length + ' 张图片）…');
        await downloadDocx(docxBuf, docxName);
        logAuto('💾 [第 ' + a.idx + ' 篇] 已保存：' + docxName + '（⏱ 本条耗时 ' + formatDuration(Date.now() - a.tOne) + '）');
      } catch (e) {
        a.ok = false; a.err = e.message; a.stage = '导出';
        logAuto('❌ 第 ' + a.idx + ' 条导出失败：' + e.message);
      }
    }));

    const totalMs = Date.now() - tBatch; // 并发处理总耗时
    const okList = articles.filter((a) => a.ok);
    const failList = articles.filter((a) => !a.ok);
    window.__batchBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '📚 并发批量生成 Word'; }
    setStatus(
      '✅ 批量完成：成功 ' + okList.length + ' 篇，失败 ' + failList.length + ' 篇（共 ' + urls.length + ' 条链接），总耗时 ' + formatDuration(totalMs),
      failList.length ? 'error' : ''
    );
    logAuto('⏱ 总耗时：' + formatDuration(totalMs) + '（成功 ' + okList.length + ' 篇，失败 ' + failList.length + ' 篇）');
    if (failList.length) {
      logAuto('失败明细：');
      failList.forEach((f) => logAuto('  ✗ ' + f.url + ' → ' + (f.stage ? '[' + f.stage + '] ' : '') + f.err));
    } else {
      logAuto('🎉 全部完成，Word 已导出（Android 在「Pictures」目录 /storage/emulated/0/Pictures，网页在浏览器下载目录）。');
    }
  }

    window.runSmartRewrite = runSmartRewrite;
  window.runBatchLinks = runBatchLinks;
  initSaveButton();
  updateSaveHint();
  if (document.getElementById('smartBtn')) {
    document.getElementById('smartBtn').addEventListener('click', runSmartRewrite);
  }
  if (document.getElementById('batchBtn')) {
    document.getElementById('batchBtn').addEventListener('click', runBatchLinks);
  }
})();