/* ================= 智能改写 + 自动判重 + 预览 + 保存 Word（依赖 app.js 的全局函数） =================
 * 规则：最多尝试 3 次；重复度 ≤5% 达标；≥8% 降重重写（最多 3 次后不再尝试）；5%~8% 合格。
 * 完成后：显示含图片的导出预览 + 保存按钮（Android 存 下载/DeepSeek文章助手，网页存浏览器下载目录）。
 * 判重 = 全文文本相似度（文皮皮思路，字符 8-gram Jaccard）。
 */
(function () {
  'use strict';
  if (window.__smartLoaded) return;
  window.__smartLoaded = true;

  let lastDocx = null;

  function buildSmartMessages(original, prevSim) {
    const baseMsgs = buildMessages(original);
    let user = baseMsgs[1].content;
    user += '\n\n【图片处理】' + getImgPrompt();
    if (prevSim != null) {
      user += '\n\n' + getDedupPrompt().replace('{sim}', (prevSim * 100).toFixed(1));
    }
    return [{ role: 'system', content: baseMsgs[0].content }, { role: 'user', content: user }];
  }

  function splitBlocksForDocx(text, images) {
    const blocks = [];
    const parts = String(text).split(/\[图片\]/g);
    let imgIdx = 0;
    const paragraphize = (t) => {
      const raw = String(t).split(/\n+/).map((s) => s.trim()).filter(Boolean);
      for (const p of raw) {
        if (/^#{1,6}\s/.test(p)) blocks.push({ type: 'h', text: p.replace(/^#{1,6}\s*/, '') });
        else blocks.push({ type: 'p', text: p });
      }
    };
    parts.forEach((seg, i) => {
      if (i > 0 && imgIdx < images.length) {
        blocks.push(images[imgIdx++]);
      }
      paragraphize(seg);
    });
    return blocks;
  }

  async function downloadDocx(buffer, name) {
    if (window.IS_ANDROID && window.AndroidBridge && window.AndroidBridge.beginSave) {
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
        let buffer, name;
        if (lastDocx) {
          buffer = lastDocx.buffer;
          name = lastDocx.name;
        } else {
          const text = window.outputText || '';
          if (!text.trim()) throw new Error('当前没有可导出的内容，请先点击「开始修改」或「智能改写」生成文章');
          // 用当前图片（优先已去水印）生成含图 Word
          const pngImages = [];
          for (const src of (window.articleImages || []).map((x) => x.blobUrl || x.url)) {
            try {
              const png = await loadImgForDocx(src);
              pngImages.push({ type: 'img', data: png.data, w: png.w, h: png.h });
            } catch { /* 跳过失败图片 */ }
          }
          const blocks = splitBlocksForDocx(text, pngImages);
          buffer = buildDocx('生成文章', blocks);
          name = '生成文章.docx';
        }
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
    document.getElementById('saveWordHint').textContent = window.IS_ANDROID
      ? '导出后保存到手机「下载 / DeepSeek文章助手」文件夹'
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

    // 图片源：优先已去水印的 blob，其次原图 URL
    const picSources = window.articleImages.map((x) => x.blobUrl || x.url);
    let pngImages = [];
    if (picSources.length) {
      logAuto('正在准备 ' + picSources.length + ' 张图片（转换为 Word 可嵌入格式）…');
      for (let i = 0; i < picSources.length; i++) {
        try {
          const png = await loadImgForDocx(picSources[i]);
          pngImages.push({ type: 'img', data: png.data, w: png.w, h: png.h });
        } catch (e) {
          logAuto('⚠ 第 ' + (i + 1) + ' 张图片跳过：' + e.message);
        }
      }
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
        finalText = outputText;
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

      // 生成预览 + 准备 Word（不自动下载，等用户点保存）
      setStatus('正在生成导出预览…', 'loading');
      const blocks = splitBlocksForDocx(finalText, pngImages);
      renderPreview(blocks);
      const docxBuf = buildDocx('生成文章', blocks);
      const name = '生成文章-重复度' + (finalSim * 100).toFixed(1) + '%-尝试' + attemptsUsed + '次.docx';
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

  window.runSmartRewrite = runSmartRewrite;
  initSaveButton();
  updateSaveHint();
  if (document.getElementById('smartBtn')) {
    document.getElementById('smartBtn').addEventListener('click', runSmartRewrite);
  }
})();
