/* ================= 智能改写 + 自动判重 + 预览 + 保存 Word（依赖 app.js 的全局函数） =================
 * 规则：最多尝试 3 次；重复度 ≤5% 达标；≥8% 降重重写（最多 3 次后不再尝试）；5%~8% 合格。
 * 完成后：显示含图片的导出预览 + 保存按钮（Android 存 Pictures/文章助手，网页存浏览器下载目录）。
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
      ? '导出后保存到手机「Pictures / 文章助手」文件夹'
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

    window.__batchBusy = true;
    const btn = document.getElementById('batchBtn');
    if (btn) { btn.disabled = true; btn.textContent = '批量处理中…'; }
    const logEl = document.getElementById('autoLog');
    logEl.classList.remove('hidden');

    const tBatch = Date.now(); // 并发处理总耗时计时
    logAuto('📚 开始并发处理 ' + urls.length + ' 个链接（所有链接同时抓取 → AI 改写 → 导出 Word，全流程并行）');
    const ok = [], fail = [];
    let seq = 0; // 任务序号（仅日志/命名用）

    async function processOne(url) {
      const idx = ++seq;
      const tOne = Date.now(); // 本条耗时计时
      setStatus('正在同时处理 ' + idx + '/' + urls.length + ' 篇…', 'loading');
      logAuto('—— [' + idx + '/' + urls.length + '] ' + url + ' ——');
      try {
        const data = await fetchOne(url);
        if (!data) throw new Error('没有获取到内容');
        const articleText = String(data.text || '').trim();
        if (!articleText) throw new Error('抓取到的正文为空');
        const imgs = (data.images || []).filter((u) => typeof u === 'string' && u);
        logAuto('✅ 抓取成功：' + (data.title || '(无标题)') + '（正文 ' + articleText.length + ' 字，图片 ' + imgs.length + ' 张）');

        // 图片 → 自动裁切水印 + Word 可嵌入 PNG（每条文章用自己的配图；批量导出默认去除水印）
        const items = imgs.map((u) => ({ url: u, blobUrl: '' }));
        const pngImages = await preparePngImages(items, { log: logAuto, autoCrop: true });

        // AI 改写（复用当前全部修改条件 + 图片占位要求）；并行任务各自收集输出，互不干扰
        logAuto('⏳ 调用 AI 改写中（' + (model === 'deepseek-reasoner' ? '思考模型' : '快速模型') + '）…');
        const messages = buildSmartMessages(articleText, null);
        const collector = { text: '' };
        await streamRewrite({ apiKey, model, messages }, new AbortController().signal, collector);
        let out = String(collector.text || '').trim();
        if (!out) throw new Error('AI 未返回内容');
        const cut = cutFactCheck(out); // 剔除「事实核查表」及之后内容
        if (cut.length < out.length) logAuto('✂ 已剔除「事实核查表」及其后的内容');
        out = cut;
        const sim = textSimilarity(articleText, out); // 本次重复率

        // 生成并保存 Word（图片按文章中的 [图片] 位置嵌入；文件名 = 正文前 10 字 + 重复率）
        const blocks = blocksWithImages(articleText, out, pngImages);
        const docxName = docxNameFromText(out, data.title || ('文章' + idx), sim);
        const docxBuf = buildDocx(data.title || '生成文章', blocks);
        logAuto('📄 保存 Word：' + docxName + '（重复率 ' + (sim * 100).toFixed(1) + '%，' + pngImages.length + ' 张图片）…');
        await downloadDocx(docxBuf, docxName);
        ok.push({ url, title: data.title, images: pngImages.length });
        logAuto('💾 已保存：' + docxName + '（⏱ 本条耗时 ' + formatDuration(Date.now() - tOne) + '）');
      } catch (e) {
        fail.push({ url, err: e.message });
        logAuto('❌ 第 ' + idx + ' 条失败：' + e.message);
      }
    }

    // 全并发：所有链接同时处理（每条链接内 抓取→图片→改写→导出 全流程并行，互不影响）
    await Promise.all(urls.map((url) => processOne(url)));
    const totalMs = Date.now() - tBatch; // 并发处理总耗时
    window.__batchBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '📚 并发批量生成 Word'; }
    setStatus(
      '✅ 批量完成：成功 ' + ok.length + ' 篇，失败 ' + fail.length + ' 篇（共 ' + urls.length + ' 条链接），总耗时 ' + formatDuration(totalMs),
      fail.length ? 'error' : ''
    );
    logAuto('⏱ 总耗时：' + formatDuration(totalMs) + '（成功 ' + ok.length + ' 篇，失败 ' + fail.length + ' 篇）');
    if (fail.length) {
      logAuto('失败明细：');
      fail.forEach((f) => logAuto('  ✗ ' + f.url + ' → ' + f.err));
    } else {
      logAuto('🎉 全部完成，Word 已导出（Android 在「Pictures / 文章助手」，网页在浏览器下载目录）。');
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
