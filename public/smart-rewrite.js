/* ================= 智能改写 + 自动判重 + 预览 + 保存 Word（依赖 app.js 的全局函数） =================
 * 规则：最多尝试 3 次；重复度 ≤5% 达标；>5% 自动带降重要要求重写（最多 3 次后不再尝试）。
 * 完成后：显示含图片的导出预览 + 保存按钮（Android Word 存 下载/文章助手，网页存浏览器下载目录）。
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

  /* 图片插入（混合算法，修复部分文章图片位置错乱）：
   * 1) 优先：改写文本中 AI 保留的 [图片]/【图片】 标记处，按顺序插入图片（最准确）；
   * 2) 图片比标记多（标记丢失/被合并）：剩余图片退回“原文锚点+相似度+比例映射”；
   * 3) 改写文本完全没有标记：整体走锚点算法。 */
  function blocksWithImages(originalText, rewriteText, images) {
    const imageList = images || [];
    if (!imageList.length) return splitTextBlocks(rewriteText);
    // 插图位置：可在「图片去水印」面板选择按原文段落插入，或全部追加到文章末尾
    const placement = (typeof imagePlacementMode === 'function') ? imagePlacementMode() : 'paragraph';
    if (placement === 'end') {
      const blocks = splitTextBlocks(rewriteText);
      for (const img of imageList) blocks.push(img);
      return blocks;
    }

    const rewRaw = String(rewriteText || '');

    const rewParts = rewRaw.split(/(\[图片\]|【图片】)/g);
    const markerCount = Math.floor((rewParts.length - 1) / 2);
    if (markerCount > 0) {
      const blocks = [];
      let imgIdx = 0;
      for (let i = 0; i < rewParts.length; i++) {
        if (i % 2 === 1) {
          if (imgIdx < imageList.length) blocks.push(imageList[imgIdx++]);
          continue;
        }
        const sub = splitTextBlocks(rewParts[i]);
        for (const b of sub) blocks.push(b);
      }
      const rest = imageList.slice(imgIdx);
      if (!rest.length) return blocks;
      return appendByAnchor(blocks, rest, originalText, imgIdx);
    }
    return appendByAnchor(splitTextBlocks(rewRaw), imageList, originalText, 0);
  }

  /* 把剩余图片按“原文锚点→改写段相似度→比例映射”追加到块列表（图片保持原顺序） */
  function appendByAnchor(blocks, images, originalText, anchorOffset) {
    const imageList = images || [];
    if (!imageList.length) return blocks;

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

    const inserts = imageList.map((img, i) => {
      const ai = i + anchorOffset;
      let oa = (anchors[ai] != null && origBlocks.length) ? Math.min(anchors[ai], origBlocks.length - 1) : -1;
      let after = -1;
      if (oa >= 0) {
        const oaText = origBlocks[oa].text || '';
        let best = -1, bestSim = 0.12;
        for (let j = 0; j < blocks.length; j++) {
          const s = textSimilarity(oaText, blocks[j].text || '');
          if (s > bestSim) { bestSim = s; best = j; }
        }
        if (best >= 0) after = best;
      }
      if (after < 0 && blocks.length) {
        const ratio = (oa >= 0 && origBlocks.length > 1)
          ? oa / (origBlocks.length - 1)
          : (imageList.length > 1 ? i / (imageList.length - 1) : 0);
        after = Math.min(blocks.length - 1, Math.max(0, Math.round(ratio * (blocks.length - 1))));
      }
      return { after, img };
    });

    const out = [];
    blocks.forEach((b, j) => {
      out.push(b);
      for (const ins of inserts) if (ins.after === j) out.push(ins.img);
    });
    for (const ins of inserts) if (ins.after < 0) out.push(ins.img);
    return out;
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
      // 分块传输 base64：String.fromCharCode.apply 批量转换比逐字符拼接快约百倍；
      // 分块必须为 3 的倍数（0x6000=24576），否则中间块带 "=" 填充，
      // 拼接后 Android Base64.decode 会报 "bad base64"（v1.34 曾用 32KB 触发此 bug）；
      // endSave 在 Java 侧立即返回（解码+写盘在后台线程池并行执行），导出不再串行阻塞
      window.AndroidBridge.beginSave(name, false);
      const CHUNK = 0x6000; // 24KB，3 的倍数，保证各块拼接成合法 base64
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const sub = buffer.subarray(i, i + CHUNK);
        window.AndroidBridge.appendChunk(btoa(String.fromCharCode.apply(null, sub)));
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
    } else {
      v.className = 'sim-value bad';
      st.textContent = '⚠ 超标（>5%）' + (attempt >= 3 ? '，不再尝试' : '，将降重重写');
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
      ? '导出后保存到手机「下载 / 文章助手」文件夹'
      : '导出到浏览器下载目录（Ctrl+J 可查看）';
  }

  async function runSmartRewrite() {
    if (isExpired()) { setStatus('软件已到期（2026-08-28），功能已停止使用', 'error'); return; }
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
    // 已配置自定义模型名时优先使用自定义模型（默认 DeepSeek 下拉框自动隐藏）
    const model = effectiveModel(document.getElementById('model').value);

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
        // 空内容自动重试：同一轮最多重试 3 次（上游偶发 200 空回复/思考超限）
        let got = false;
        for (let tries = 1; tries <= 2 && !got; tries++) {
          outputText = '';
          document.getElementById('outResult').textContent = '';
          document.getElementById('outResult').classList.remove('hidden');
          document.getElementById('outEmpty').classList.add('hidden');
          switchView('result');
          startTimer('正在改写（第 ' + attempt + '/3 次）…');
          await streamRewrite({ apiKey, model, messages }, new AbortController().signal);
          stopTimer();
          renderRichResult();
          got = String(outputText || '').trim().length > 0;
          if (!got && tries < 2) { logAuto('⚠ AI 返回空内容，重试 ' + tries + '/2…'); await sleep(1500 * tries); }
        }
        if (!got) { finalText = ''; finalSim = 1; logAuto('⚠ AI 连续 3 次返回空内容'); break; }

        const sim = textSimilarity(original, outputText);
        finalSim = sim;
        finalText = cutFactCheck(outputText); // 剔除「事实核查表」及之后内容（预览/导出用）
        const pct = (sim * 100).toFixed(1);
        updateSimDisplay(attempt, parseFloat(pct));
        logAuto('本次重复度：' + pct + '% （目标 ≤5%，>5% 自动降重重写）');

        if (sim <= 0.05) { logAuto('✅ 重复度 ' + pct + '% ≤ 5%，达标！'); break; }
        if (attempt < 3) {
          logAuto('⚠ 重复度 ' + pct + '% > 5%，进行下一次降重改写…');
        } else {
          logAuto('⚠ 3 次尝试后重复度仍 ' + pct + '% > 5%，不再重试，按当前版本预览并保存导出。');
        }
      }

      if (!String(finalText || '').trim()) {
        setStatus('❌ AI 多次返回空内容，请重试或更换模型（可尝试 V4 Flash 或降低并发）', 'error');
        logAuto('❌ 本次改写失败：AI 连续多次返回空内容');
        return;
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
      setStatus('❌ ' + classifyError(e).label + ': ' + e.message, 'error');
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
  /* 批量导出：使用链接最后一段 URI 作为文件名（去掉常见网页扩展名，非法字符替换为 _，并附加重复率） */
  function docxNameFromUrl(url, simPct) {
    let n = '';
    try {
      const u = new URL(String(url || ''));
      const segs = u.pathname.split('/').filter(Boolean);
      n = segs.length ? segs[segs.length - 1] : (u.hostname || '');
      try { n = decodeURIComponent(n); } catch (e) { /* 保持原样 */ }
    } catch (e) {
      n = String(url || '').replace(/^https?:\/\//i, '');
    }
    n = n.replace(/\.(html?|php|jsp|asp|aspx|shtml)$/i, ''); // 去掉常见网页扩展名
    n = n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    if (!n) n = '链接文章';
    if (n.length > 60) n = n.slice(0, 60);
    let suffix = '';
    if (simPct != null) suffix = '_重复率' + (simPct * 100).toFixed(1) + '%';
    return n + suffix + '.docx';
  }

  /* 批量导出：使用抓取到的文章标题作为文件名（清理非法字符，超长截断；不带重复率后缀） */
  function docxNameFromTitle(title) {
    let n = String(title || '').replace(/\s+/g, ' ').trim();
    n = n.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim();
    if (!n) n = '无标题文章';
    if (n.length > 60) n = n.slice(0, 60);
    return n + '.docx';
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
  const nativeAiPending = {}; // cbId -> state{ byId, total, done, timer, lastActive, finish }
  /* 原生 AI 空闲看门狗：替代旧的「240 秒一刀切」总时长限制。
     只有连续 NATIVE_AI_IDLE_MS 毫秒收不到任何流式增量/结果回调才判定连接中断，
     深度思考 + 长文等正常慢速生成不会被误杀。 */
  const NATIVE_AI_IDLE_MS = 120000;        // 连续 120 秒无任何输出 → 判定中断
  const NATIVE_AI_WATCHDOG_TICK_MS = 15000; // 每 15 秒巡检一次
  /* Java 流式增量回调：把 AI 已生成的增量文本推给对应任务的 onChunk（进度条实时显示） */
  window.onNativeAiChunk = function (cbId, taskId, o) {
    const h = nativeAiPending && nativeAiPending[cbId];
    if (!h) return;
    h.lastActive = Date.now(); // 收到任何增量即视为连接存活，刷新看门狗
    const p = h.byId.get(taskId);
    if (p && typeof p.onChunk === 'function' && o && (o.c || o.r)) p.onChunk({ content: o.c || '', reasoning: o.r || '' });
  };
  window.onNativeAiResult = function (cbId, taskId, res) {
    const h = nativeAiPending && nativeAiPending[cbId];
    if (!h) return;
    h.lastActive = Date.now();
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
      const proms = taskList.map((t) => new Promise((resolve, reject) => byId.set(t.id, { resolve, reject, onChunk: t.onChunk })));
      const state = {
        byId, done: 0, total: taskList.length, timer: null,
        lastActive: Date.now(),
        finish: () => { clearInterval(state.timer); delete nativeAiPending[cbId]; batchResolve(); },
      };
      /* 空闲看门狗：周期巡检，仅在连续 NATIVE_AI_IDLE_MS 无任何输出时才拒绝剩余任务，
         正在正常生成的任务永远不会被总时长误杀 */
      state.timer = setInterval(() => {
        if (Date.now() - state.lastActive < NATIVE_AI_IDLE_MS) return;
        byId.forEach((p) => p.reject(new Error('原生 AI 调用超时（连续 ' + Math.round(NATIVE_AI_IDLE_MS / 1000) + ' 秒无输出，判定连接中断）')));
        state.finish();
      }, NATIVE_AI_WATCHDOG_TICK_MS);
      nativeAiPending[cbId] = state;
      window.AndroidBridge.batchAiRewrite(JSON.stringify(taskList), cbId);
      batchResolve(Promise.all(proms.map((p) => p.catch((e) => ({ __err: e.message })))));
    });
  }

  /* 并发限流工具：同时最多运行 limit 个任务；limit<=0 或 Infinity 表示「不限」（全部同时）。
     返回与 items 对齐的结果数组；任务抛错时该位置为 Error 对象。 */
  function mapConcurrent(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0, done = 0;
    const max = (Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : Infinity;
    return new Promise((resolve) => {
      const tick = (k) => {
        if (next >= items.length) return;
        const i = next++;
        Promise.resolve()
          .then(() => fn(items[i], i, k))
          .then((v) => { results[i] = v; })
          .catch((e) => { results[i] = (e instanceof Error) ? e : new Error(String(e)); })
          .then(() => { if (++done === items.length) resolve(results); else tick(k); });
      };
      const workers = Math.min(max, items.length);
      for (let k = 0; k < workers; k++) tick(k);
      if (items.length === 0) resolve(results);
    });
  }

  async function runBatchLinks() {
    if (window.__batchBusy) return;
    if (isExpired()) { setStatus('软件已到期（2026-08-28），功能已停止使用', 'error'); return; }
    const urls = parseLinks();
    if (!urls.length) {
      logAuto('⚠ 链接框为空或没有有效的 http(s) 链接，请粘贴链接（每行一个）');
      return;
    }
    const apiKey = document.getElementById('apiKey').value.trim();
    if (apiKey) storeSet('dsw_apikey', apiKey);
    // 已配置自定义模型名时优先使用自定义模型（默认 DeepSeek 下拉框自动隐藏）
    const model = effectiveModel(document.getElementById('model').value);
    const apiBase = String((els.apiBase && els.apiBase.value) || '').trim();
    const reasoningEffort = (els.thinking && els.thinking.checked && !/api\.deepseek\.com$/i.test(apiBase))
      ? ({ max: 'high', high: 'high', medium: 'medium', low: 'low' }[els.effort.value] || 'high')
      : '';

    // 全局并发数：10 / 50 / 100 / 500 / 不限（0）；同一篇文章由同一并发槽从头到尾流水线处理
    const concVal = els.batchConc && els.batchConc.value != null ? String(els.batchConc.value).trim() : '10';
    const concNum = parseInt(concVal, 10);
    const concurrency = (Number.isFinite(concNum) && concNum > 0) ? concNum : Infinity;
    if (els.batchConc) storeSet('dsw_batch_conc', concVal);

    window.__batchBusy = true;
    const btn = document.getElementById('batchBtn');
    if (btn) { btn.disabled = true; btn.textContent = '并发处理中…'; }
    const logEl = document.getElementById('autoLog');
    logEl.classList.remove('hidden');

    const nativeAI = !!(IS_ANDROID && window.AndroidBridge && typeof window.AndroidBridge.batchAiRewrite === 'function');
    const tBatch = Date.now(); // 流水线总耗时计时
    logAuto('📚 开始流水线处理 ' + urls.length + ' 个链接（全局并发上限：' + (concurrency === Infinity ? '不限' : concurrency) + '；每篇由同一并发槽串起 抓取→AI改写(≤5%判重,最多3轮)→导出Word）');
    logAuto('🚀 已同时开启 ' + (concurrency === Infinity ? '全部' : concurrency) + ' 个并发槽：每篇由独立槽处理，完成后自动领取下一篇，直到全部处理完');
    const minChars = parseInt(String((els.minChars && els.minChars.value) || '0'), 10) || 0;
    const minImages = parseInt(String((els.minImages && els.minImages.value) || '0'), 10) || 0;
    if (minChars > 0 || minImages > 0) logAuto('⛔ 过滤已开启：正文 < ' + minChars + ' 字 或 图片 < ' + minImages + ' 张 的文章将跳过 AI 改写');
    if (nativeAI) logAuto('🤖 Android：AI 调用走 Java 原生线程池（安全上限 MAX_AI_THREADS=100）');

    const usedNames = new Set(); // 本次批量已用文件名（同步段内分配，并发安全）
    let inFlight = 0; // 当前同时在处理的篇数（并发可视化）
    let doneCount = 0, okCount = 0, failCount = 0, skippedCount = 0;
    const failList = [];

    // ---- 线程进度面板：每个并发槽一条进度条（最多展示 30 条，其余后台运行） ----
    const threadPanel = document.getElementById('threadPanel');
    const totalSlots = Math.max(1, Math.min(urls.length, concurrency === Infinity ? urls.length : concurrency));
    const maxBars = 30;
    const barCount = Math.min(totalSlots, maxBars);
    const bars = [];
    if (threadPanel) {
      threadPanel.innerHTML = '';
      threadPanel.classList.remove('hidden');
      for (let s = 0; s < barCount; s++) {
        const item = document.createElement('div');
        item.className = 'thread-item';
        item.innerHTML = '<div class="tb-head"><span class="tb-title">线程 #' + (s + 1) + '</span>'
          + '<span class="tb-stage">等待任务</span>'
          + '<span class="tb-url"></span>'
          + '<span class="tb-elapsed"></span></div>'
          + '<div class="tb-track"><div class="tb-fill"></div></div>'
          + '<div class="tb-stream"></div>';
        threadPanel.appendChild(item);
        bars.push({
          item,
          stage: item.querySelector('.tb-stage'),
          url: item.querySelector('.tb-url'),
          elapsed: item.querySelector('.tb-elapsed'),
          fill: item.querySelector('.tb-fill'),
          stream: item.querySelector('.tb-stream'),
          t0: 0,
        });
      }
      if (totalSlots > maxBars) {
        const note = document.createElement('div');
        note.className = 'tb-note';
        note.textContent = '另有 ' + (totalSlots - maxBars) + ' 路并发在后台运行（进度省略）';
        threadPanel.appendChild(note);
      }
    }
    const elapsedTimer = setInterval(() => {
      for (const b of bars) {
        if (b.t0 && b.elapsed && b.stage && !/(✅|❌|⏭|等待任务)/.test(b.stage.textContent)) {
          b.elapsed.textContent = '⏱ ' + formatDuration(Date.now() - b.t0);
        }
      }
    }, 1000);

    /* 单篇 AI 调用（Android 走 Java 线程池单任务，网页走 JS 并发流式）；
       5xx/429 失败后全局冷却 2.5 秒，避免风暴持续冲击上游 */
    let coolUntil = 0;
    const aiCall = async (a, slot) => {
      const wait = coolUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        if (nativeAI) {
          const r = await nativeAiBatch([{
            id: String(a.idx), apiKey, apiBase, model, messages: a.messages, reasoningEffort,
            concurrency: 1,
            displayStream: (slot != null && slot < bars.length),
            onChunk: (o) => {
              if (slot == null || slot >= bars.length || !bars[slot].stream) return;
              const el = bars[slot].stream;
              let add = '';
              if (o.reasoning) add += '💭 ' + o.reasoning;
              if (o.content) add += o.content;
              el.textContent = ((el.textContent || '') + add).slice(-400);
              el.scrollTop = el.scrollHeight;
            },
          }]);
          const one = (r && r[0]);
          if (one && one.__err) throw new Error(one.__err);
          return String(one || '').trim();
        }
        // 网页流式：把 AI 增量输出实时显示到该线程进度条下方
        const collector = {
          text: '',
          onChunk: (t) => {
            if (slot != null && slot < bars.length && bars[slot].stream) {
              const el = bars[slot].stream;
              el.textContent = ((el.textContent || '') + t).slice(-400);
              el.scrollTop = el.scrollHeight;
            }
          },
          onReasoning: (t) => {
            if (slot != null && slot < bars.length && bars[slot].stream) {
              const el = bars[slot].stream;
              el.textContent = ((el.textContent || '') + '💭' + t).slice(-400);
              el.scrollTop = el.scrollHeight;
            }
          },
        };
        await streamRewrite({ apiKey, model, messages: a.messages }, new AbortController().signal, collector);
        return String(collector.text || '').trim();
      } catch (e) {
        coolUntil = Date.now() + 2500; // 失败后短暂全局冷却，让上游缓口气
        throw e;
      }
    };

    // ---- 单篇文章流水线：抓取 → AI 改写(判重降重) → 导出 Word ----
    await mapConcurrent(urls, concurrency, async (url, i, slot) => {
      const idx = i + 1;
      const tOne = Date.now();
      inFlight++;
      const bar = (slot != null && slot < bars.length) ? bars[slot] : null;
      const setStage = (txt, w, streamText) => {
        if (!bar) return;
        bar.t0 = Date.now();
        bar.stage.textContent = txt;
        bar.fill.style.width = w + '%';
        bar.url.textContent = url;
        if (streamText != null) bar.stream.textContent = streamText;
        bar.item.classList.remove('done', 'failed');
      };
      setStage('🔗 抓取正文中…', 12, '');
      const concLabel = concurrency === Infinity ? '全部' : concurrency;
      setStatus('⚡ 并发 ' + concLabel + ' 路流水线运行中：进行中 ' + inFlight + ' 篇，已完成 ' + doneCount + '/' + urls.length + ' 篇…', 'loading');
      logAuto('🚀 [' + idx + '/' + urls.length + '] ' + url + '（当前同时进行 ' + inFlight + ' 篇）');
      try {
        // ① 抓取文章 + 裁切图片
        const data = await fetchOne(url);
        if (!data) throw new Error('没有获取到内容');
        const articleText = String(data.text || '').trim();
        if (!articleText) throw new Error('抓取到的正文为空');
        const imgs = (data.images || []).filter((u) => typeof u === 'string' && u);
        // 过滤设置：正文/图片低于阈值 → 跳过 AI 改写（不裁图、不改写、不导出）
        if (minChars > 0 && articleText.length < minChars) {
          skippedCount++;
          setStage('⏭ 跳过（过滤）', 100, '正文 ' + articleText.length + ' 字 < 最少 ' + minChars + ' 字');
          logAuto('⏭ [第 ' + idx + ' 篇] 跳过：正文 ' + articleText.length + ' 字 < 最少 ' + minChars + ' 字');
          return;
        }
        if (minImages > 0 && imgs.length < minImages) {
          skippedCount++;
          setStage('⏭ 跳过（过滤）', 100, '图片 ' + imgs.length + ' 张 < 最少 ' + minImages + ' 张');
          logAuto('⏭ [第 ' + idx + ' 篇] 跳过：图片 ' + imgs.length + ' 张 < 最少 ' + minImages + ' 张');
          return;
        }
        logAuto('✅ [第 ' + idx + ' 篇] 抓取成功：' + (data.title || '(无标题)') + '（正文 ' + articleText.length + ' 字，图片 ' + imgs.length + ' 张）');
        setStage('🖼 图片处理中…', 25, imgs.length ? ('共 ' + imgs.length + ' 张图片裁切去水印中…') : '');
        const pngImages = await preparePngImages(imgs.map((u) => ({ url: u, blobUrl: '' })), { log: logAuto, autoCrop: true });

        // ② AI 改写 + 自动判重降重（≤5% 达标；>5% 最多 3 轮；3 轮后仍超标也导出）
        const rec = { idx, messages: buildSmartMessages(articleText, null) };
        let out = '';
        let sim = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          rec.messages = buildSmartMessages(articleText, attempt > 1 ? sim : null);
          setStage('🧠 AI 改写中（第 ' + attempt + '/3 轮）…', 55, '等待 AI 流式输出…');
          const rStart = Date.now();
          // 空内容自动重试：上游偶发 200 空回复/思考超限，同一轮最多重试 2 次
          out = '';
          for (let tries = 1; tries <= 2 && !out; tries++) {
            out = await aiCall(rec, slot);
            if (!out && tries < 2) {
              logAuto('⚠ [第 ' + idx + ' 篇] AI 返回空内容，重试 ' + tries + '/2…');
              await sleep(1500);
            }
          }
          if (!out) throw new Error('AI 未返回内容（已重试：可能是思考超限或上游空回复，可稍后重试或降低并发）');
          const cut = cutFactCheck(out);
          if (cut.length < out.length) logAuto('✂ [第 ' + idx + ' 篇] 已剔除「事实核查表」及其后的内容');
          out = cut;
          sim = textSimilarity(articleText, out);
          const pct = (sim * 100).toFixed(1);
          logAuto('[第 ' + idx + ' 篇] 第 ' + attempt + '/3 次改写，重复率 ' + pct + '% → ' + (sim <= 0.05 ? '✅ 达标（≤5%）' : '⚠ 超标（>5%）')
            + (sim > 0.05 && attempt < 3 ? '，继续降重…' : sim > 0.05 ? '，已尝试 3 次，按当前版本导出' : '')
            + '（本轮 AI 耗时 ' + formatDuration(Date.now() - rStart) + '）');
          if (sim <= 0.05) break;
        }

        setStage('📊 判重计算中…', 78, '重复率 ' + ((sim != null ? sim : 1) * 100).toFixed(1) + '%');
        // ③ 构建并导出 Word（文件名默认 = 正文前 10 字 + 重复率；勾选链接作为文件名时使用链接 + 重复率；重名自动加序号）
        const blocks = blocksWithImages(articleText, out, pngImages);
        const useLinkName = (typeof useLinkNameEnabled === 'function') ? useLinkNameEnabled() : false;
        const useTitleName = (typeof useTitleNameEnabled === 'function') ? useTitleNameEnabled() : false;
        // 命名优先级：文章标题 > 链接最后一段 URI > 正文前 10 字
        let docxName = useTitleName
          ? docxNameFromTitle(data.title)
          : useLinkName
            ? docxNameFromUrl(url, sim != null ? sim : 1)
            : docxNameFromText(out, data.title || ('文章' + idx), sim != null ? sim : 1);
        if (usedNames.has(docxName)) {
          const dot = docxName.lastIndexOf('.');
          const ext = dot >= 0 ? docxName.slice(dot) : '';
          const base = dot >= 0 ? docxName.slice(0, dot) : docxName;
          let seq = 1;
          do { seq++; docxName = base + '_' + seq + ext; } while (usedNames.has(docxName));
        }
        usedNames.add(docxName);
        const docxBuf = buildDocx(data.title || '生成文章', blocks);
        logAuto('📄 [第 ' + idx + ' 篇] 保存 Word：' + docxName + '（重复率 ' + ((sim != null ? sim : 1) * 100).toFixed(1) + '%，' + pngImages.length + ' 张图片）…');

        setStage('📦 生成 Word 中…', 92, docxName);
        await downloadDocx(docxBuf, docxName);
        logAuto('💾 [第 ' + idx + ' 篇] 已保存：' + docxName + '（⏱ 本条耗时 ' + formatDuration(Date.now() - tOne) + '）');
        okCount++;
        if (bar) {
          bar.stage.textContent = '✅ 完成';
          bar.fill.style.width = '100%';
          bar.stream.textContent = '已导出：' + docxName;
          bar.elapsed.textContent = '⏱ ' + formatDuration(Date.now() - tOne);
          bar.item.classList.add('done');
        }
      } catch (e) {
        failCount++;
        // 报错分类：程序出错 = 我方代码异常；异常获取 = 外部网络/接口异常
        const c = classifyError(e);
        const errText = c.label + ': ' + (e && e.message ? e.message : String(e));
        failList.push({ idx, url, err: errText });
        if (bar) {
          bar.stage.textContent = '❌ ' + c.label;
          bar.fill.style.width = '100%';
          bar.stream.textContent = errText;
          bar.item.classList.add('failed');
        }
        logAuto('❌ 第 ' + idx + ' 条失败[' + c.label + ']：' + errText);
      } finally {
        inFlight--;
        doneCount++;
        const concLabel2 = concurrency === Infinity ? '全部' : concurrency;
        setStatus('⚡ 并发 ' + concLabel2 + ' 路流水线：进行中 ' + inFlight + ' 篇，已完成 ' + doneCount + '/' + urls.length + ' 篇（成功 ' + okCount + '，失败 ' + failCount + '）', 'loading');
      }
    });

    clearInterval(elapsedTimer);
    const totalMs = Date.now() - tBatch; // 流水线总耗时
    window.__batchBusy = false;
    if (btn) { btn.disabled = false; btn.textContent = '📚 并发批量生成 Word'; }
    setStatus(
      '✅ 批量完成：成功 ' + okCount + ' 篇，跳过 ' + skippedCount + ' 篇，失败 ' + failCount + ' 篇（共 ' + urls.length + ' 条链接），总耗时 ' + formatDuration(totalMs),
      failCount ? 'error' : ''
    );
    logAuto('⏱ 总耗时：' + formatDuration(totalMs) + '（成功 ' + okCount + ' 篇，跳过 ' + skippedCount + ' 篇，失败 ' + failCount + ' 篇）');
    if (failList.length) {
      logAuto('失败明细：');
      failList.forEach((f) => logAuto('  ✗ ' + f.url + ' → ' + f.err));
    } else {
      logAuto('🎉 全部完成，Word 已导出（Android 在「下载 / 文章助手」，网页在浏览器下载目录）。');
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