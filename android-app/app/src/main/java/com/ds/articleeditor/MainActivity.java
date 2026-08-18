package com.ds.articleeditor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.LinkedHashSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * DeepSeek 文章修改助手 - Android 壳
 *
 * 以 WebView 加载本地网页（assets/index.html）。
 * 关键设置：setAllowUniversalAccessFromFileURLs(true)
 * 使 file:// 页面可以直连 api.deepseek.com 与任意图片 CDN，无 CORS 限制。
 */
public class MainActivity extends Activity {

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowUniversalAccessFromFileURLs(true); // 关键：file:// 页面访问网络无 CORS 限制
        s.setAllowFileAccessFromFileURLs(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);

        webView.setWebViewClient(new WebViewClient());

        webView.setWebChromeClient(new WebChromeClient() {
            // window.open("...") -> 用系统浏览器打开（“原图”查看等）
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView newWV = new WebView(MainActivity.this);
                newWV.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, String url) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                        } catch (Exception ignored) {
                        }
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(newWV);
                resultMsg.sendToTarget();
                return true;
            }
        });

        // 软件试用期限制：2026-08-20 00:00（北京时间）到期后在原生层直接拦截，不加载应用
        if (System.currentTimeMillis() >= 1787155200000L) {
            new AlertDialog.Builder(this)
                    .setTitle("软件已到期")
                    .setMessage("本软件试用期已于 2026年8月20日 到期，功能已停止使用。\n如需继续使用，请联系开发者授权。")
                    .setPositiveButton("退出", (d, w) -> finish())
                    .setCancelable(false)
                    .show();
            return;
        }

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    /** JS 桥：把网页里的图片 / 文本保存到手机 */
    private class Bridge {

        @JavascriptInterface
        public void saveImage(String base64, String name) {
            saveBytes(Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT),
                    name, true);
        }

        @JavascriptInterface
        public void saveText(String base64, String name) {
            saveBytes(Base64.decode(base64 == null ? "" : base64, Base64.DEFAULT),
                    name, false);
        }

        /* ---- 大文件分块保存（docx 含图片可达数 MB，避免单次传参失败/截断） ---- */
        private final StringBuilder pendingB64 = new StringBuilder();
        private String pendingName = null;
        private boolean pendingIsImage = false;

        @JavascriptInterface
        public void beginSave(String name, boolean isImage) {
            pendingB64.setLength(0);
            pendingName = sanitize(name);
            pendingIsImage = isImage;
        }

        @JavascriptInterface
        public void appendChunk(String b64) {
            if (b64 != null) pendingB64.append(b64);
        }

        @JavascriptInterface
        public void endSave() {
            if (pendingName == null) {
                toast("保存失败：未初始化");
                return;
            }
            String name = pendingName;
            boolean isImage = pendingIsImage;
            byte[] data = Base64.decode(pendingB64.toString(), Base64.DEFAULT);
            pendingB64.setLength(0);
            pendingName = null;
            saveBytes(data, name, isImage);
        }

        /**
         * 本地键值存储（SharedPreferences）：API Key / 提示词等持久化在应用私有区，
         * 覆盖安装升级 APK 不会丢失（卸载才会清除）。
         */
        @JavascriptInterface
        public void savePref(String key, String value) {
            if (key == null) return;
            getSharedPreferences("dsw_prefs", MODE_PRIVATE)
                    .edit().putString(key, value == null ? "" : value).apply();
        }

        @JavascriptInterface
        public String getPref(String key) {
            if (key == null) return null;
            return getSharedPreferences("dsw_prefs", MODE_PRIVATE).getString(key, null);
        }

        @JavascriptInterface
        public void removePref(String key) {
            if (key == null) return;
            getSharedPreferences("dsw_prefs", MODE_PRIVATE).edit().remove(key).apply();
        }

        /**
         * 原生抓取网页文章（在后台线程执行，完成后回调 JS）：
         * JS 调用：AndroidBridge.fetchArticle(url, callbackId)
         * 完成后执行：window.onNativeFetchArticle(callbackId, json)
         */
        @JavascriptInterface
        public void fetchArticle(final String url, final String callbackId) {
            if (url == null || url.trim().isEmpty()) {
                jsCallback(callbackId, "{\"error\":\"链接为空\"}");
                return;
            }
            new Thread(new Runnable() {
                @Override
                public void run() {
                    String json;
                    try {
                        json = fetchArticleSync(url.trim());
                    } catch (Exception e) {
                        json = "{\"error\":\"" + escapeJson(String.valueOf(e.getMessage())) + "\"}";
                    }
                    jsCallback(callbackId, json);
                }
            }).start();
        }

        private void jsCallback(final String callbackId, final String json) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (webView == null) return;
                    String js = "window.onNativeFetchArticle && window.onNativeFetchArticle("
                            + JSONObject.quote(callbackId == null ? "" : callbackId) + ", " + json + ")";
                    webView.evaluateJavascript(js, null);
                }
            });
        }

        /** 核心：用 HttpURLConnection 抓取并解析文章，返回 JSON */
        private String fetchArticleSync(String urlStr) throws Exception {
            URL url = new URL(urlStr);
            if (!url.getProtocol().startsWith("http")) throw new Exception("仅支持 http/https 链接");
            String host = url.getHost() == null ? "" : url.getHost();
            boolean isToutiao = host.endsWith("toutiao.com") || host.equals("toutiao.com");

            // 头条电脑端网页常被“JS 反爬挑战”拦截（_$jsvmprt 脚本），
            // 优先走移动端 info 接口 / RENDER_DATA：标题 + 正文 + 图片一次拿到
            String ttChannels = "";
            if (isToutiao) {
                String ttId = extractToutiaoId(urlStr);
                if (ttId != null) {
                    // 模拟浏览器先拿 tt_webid cookie，减少被 WAF 按“无 cookie 快速请求”拦截的几率
                    String ttCookie = toutiaoWebIdCookie();
                    String cookieHdr = ttCookie == null ? null : ("tt_webid=" + ttCookie);
                    // 每条通道失败时延迟 1.2s 重试一次（WAF 限流通常是暂时性的）
                    String infoJson = null;
                    for (int attempt = 0; attempt < 2 && infoJson == null; attempt++) {
                        try {
                            infoJson = httpGet("https://m.toutiao.com/i" + ttId + "/info/", true, cookieHdr);
                        } catch (Exception e) {
                            ttChannels += "（info接口失败:" + e.getMessage() + "）";
                            if (attempt == 0) { try { Thread.sleep(1200); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); } }
                        }
                    }
                    if (infoJson != null) {
                        try {
                            JSONObject root = new JSONObject(infoJson);
                            if (root.has("data")) {
                                JSONObject d = root.getJSONObject("data");
                                String content = d.optString("content", "");
                                if (!content.trim().isEmpty()
                                        && !content.replaceAll("<[^>]+>", "").trim().isEmpty()) {
                                    return extractToutiaoHtmlContent(content, d.optString("title", "")).toString();
                                }
                            }
                        } catch (Exception e) {
                            ttChannels += "（info解析失败:" + e.getMessage() + "）";
                        }
                    }
                    String pageHtml = null;
                    for (int attempt = 0; attempt < 2 && pageHtml == null; attempt++) {
                        try {
                            pageHtml = httpGet("https://m.toutiao.com/i" + ttId + "/", true, cookieHdr);
                        } catch (Exception e) {
                            ttChannels += "（移动页失败:" + e.getMessage() + "）";
                            if (attempt == 0) { try { Thread.sleep(1200); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); } }
                        }
                    }
                    if (pageHtml != null) {
                        try {
                            JSONObject rd = extractToutiaoRenderData(pageHtml);
                            if (rd != null) return rd.toString();
                        } catch (Exception e) {
                            ttChannels += "（RENDER_DATA解析失败:" + e.getMessage() + "）";
                        }
                    }
                }
            }

            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8");
            conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            conn.setRequestProperty("Accept-Encoding", "gzip");
            if (isToutiao) conn.setRequestProperty("Referer", "https://www.toutiao.com/");

            int code = conn.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            // 必须在 disconnect() 之前读取响应头
            String contentType = conn.getContentType();

            InputStream in = conn.getInputStream();
            String enc = conn.getContentEncoding();
            if ("gzip".equalsIgnoreCase(enc)) in = new GZIPInputStream(in);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            in.close();
            conn.disconnect();

            byte[] bytes = out.toByteArray();
            if (bytes.length > 8 * 1024 * 1024) throw new Exception("页面过大");

            String charset = detectCharset(contentType, bytes);
            String html = new String(bytes, charset);
            try {
                return parseArticle(html, isToutiao);
            } catch (Exception pe) {
                if (isToutiao && !ttChannels.isEmpty()) {
                    throw new Exception(pe.getMessage() + " " + ttChannels);
                }
                throw pe;
            }
        }

        /** 独立 GET 抓取（带超时/UA/Referer），返回文本 */
        /** 独立 GET 抓取（带超时/UA/Referer），返回文本 */
        private String httpGet(String urlStr, boolean mobile) throws Exception {
            return httpGet(urlStr, mobile, null);
        }

        private String httpGet(String urlStr, boolean mobile, String cookie) throws Exception {
            HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(20000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", mobile
                    ? "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
                    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36");
            conn.setRequestProperty("Accept", mobile
                    ? "application/json;q=0.9,text/html;q=0.8"
                    : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
            conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            conn.setRequestProperty("Accept-Encoding", "gzip");
            if (mobile) conn.setRequestProperty("Referer", "https://m.toutiao.com/");
            if (cookie != null && !cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);

            int code = conn.getResponseCode();
            if (code != 200) throw new Exception("HTTP " + code);
            // 必须在 disconnect() 之前读取响应头，否则部分设备会抛异常导致通道被跳过
            String contentType = conn.getContentType();
            InputStream in = conn.getInputStream();
            String enc = conn.getContentEncoding();
            if ("gzip".equalsIgnoreCase(enc)) in = new GZIPInputStream(in);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            in.close();
            conn.disconnect();
            byte[] bytes = out.toByteArray();
            if (bytes.length > 8 * 1024 * 1024) throw new Exception("页面过大");
            String charset = detectCharset(contentType, bytes);
            return new String(bytes, charset);
        }

        /** 模拟浏览器访问一次移动站，抓取 tt_webid（作为后续请求的 Cookie），拿不到返回 null */
        private String toutiaoWebIdCookie() {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL("https://m.toutiao.com/").openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36");
                conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
                int code = conn.getResponseCode();
                if (code != 200) { conn.disconnect(); return null; }
                // 在 disconnect 之前读取响应头
                String sc = conn.getHeaderField("Set-Cookie");
                conn.disconnect();
                Matcher m = Pattern.compile("tt_webid=([^;]+)").matcher(sc == null ? "" : sc);
                return m.find() ? m.group(1) : null;
            } catch (Exception e) {
                return null;
            }
        }

        /** 从头条链接中提取文章 id（/article/123... 或 /i123...） */
        private String extractToutiaoId(String url) {
            Matcher m = Pattern.compile("/article/(\\d{6,})", Pattern.CASE_INSENSITIVE).matcher(url);
            if (m.find()) return m.group(1);
            m = Pattern.compile("/i(\\d{6,})", Pattern.CASE_INSENSITIVE).matcher(url);
            return m.find() ? m.group(1) : null;
        }

        /** 把头条正文 HTML（<p> 与 pgc-img 图片块）转成 {title, text, images} */
        private JSONObject extractToutiaoHtmlContent(String contentHtml, String title) throws Exception {
            LinkedHashSet<String> images = new LinkedHashSet<>();
            // 图片 -> [图片] 占位（仅保留下一步会收录的图）
            Matcher im0 = Pattern.compile("<img[^>]*>", Pattern.CASE_INSENSITIVE).matcher(contentHtml);
            StringBuffer sb = new StringBuffer();
            while (im0.find()) {
                String rep = pickImageUrl(im0.group()) != null ? " [图片] " : "";
                im0.appendReplacement(sb, Matcher.quoteReplacement(rep));
            }
            im0.appendTail(sb);
            String seg = sb.toString()
                    .replaceAll("(?i)<br[^>]*>", "\n")
                    .replaceAll("(?i)</?(p|div|h[1-6]|li|tr|blockquote|section|article|pre)[^>]*>", "\n")
                    .replaceAll("<[^>]+>", " ")
                    .replaceAll("&nbsp;", " ")
                    .replaceAll("\\s+", " ")
                    .trim();
            StringBuilder text = new StringBuilder();
            for (String line : seg.split("\n")) {
                String l = line.trim();
                if (!l.isEmpty()) {
                    if (text.length() > 0) text.append('\n');
                    text.append(l);
                }
            }
            Matcher im = Pattern.compile("<img[^>]*>", Pattern.CASE_INSENSITIVE).matcher(contentHtml);
            while (im.find()) {
                String u = pickImageUrl(im.group());
                if (u != null) images.add(u);
            }
            JSONArray imgArr = new JSONArray();
            int cnt = 0;
            for (String u : images) {
                if (cnt++ >= 30) break;
                imgArr.put(u);
            }
            JSONObject obj = new JSONObject();
            String t = title == null ? "" : title.trim();
            obj.put("title", t.length() > 120 ? t.substring(0, 120) : t);
            obj.put("text", text.length() > 30000 ? text.substring(0, 30000) : text.toString());
            obj.put("images", imgArr);
            obj.put("source", "toutiao");
            obj.put("via", "native");
            return obj;
        }

        /** 解析移动端页面的 RENDER_DATA（URL-encoded JSON） */
        private JSONObject extractToutiaoRenderData(String html) throws Exception {
            Matcher m = Pattern.compile(
                    "<script id=\"RENDER_DATA\" type=\"application/json\">([\\s\\S]*?)</script>",
                    Pattern.CASE_INSENSITIVE).matcher(html);
            if (!m.find()) return null;
            String encoded = m.group(1);
            // URLDecoder 会把 + 变空格，先把字面 + 还原成 %2B 再解码
            String decoded = URLDecoder.decode(encoded.replace("+", "%2B"), "UTF-8");
            JSONObject root = new JSONObject(decoded);
            JSONObject info = root.has("articleInfo") ? root.getJSONObject("articleInfo") : null;
            if (info == null) return null;
            String content = info.optString("content", "");
            if (content.trim().isEmpty() || content.replaceAll("<[^>]+>", "").trim().isEmpty()) return null;
            return extractToutiaoHtmlContent(content, info.optString("title", ""));
        }

        private String detectCharset(String contentType, byte[] bytes) {
            if (contentType != null) {
                Matcher m = Pattern.compile("charset=([\\w-]+)", Pattern.CASE_INSENSITIVE).matcher(contentType);
                if (m.find()) {
                    String cs = m.group(1).toLowerCase();
                    return cs.equals("gb2312") ? "GBK" : cs;
                }
            }
            String head = new String(bytes, 0, Math.min(bytes.length, 2048));
            Matcher m = Pattern.compile("charset=[\"']?([\\w-]+)", Pattern.CASE_INSENSITIVE).matcher(head);
            if (m.find()) {
                String cs = m.group(1).toLowerCase();
                return cs.equals("gb2312") ? "GBK" : cs;
            }
            return "UTF-8";
        }

        private String decodeEntities(String s) {
            if (s == null) return "";
            return s.replaceAll("(?i)&nbsp;", " ")
                    .replaceAll("(?i)&ensp;", " ")
                    .replaceAll("(?i)&emsp;", " ")
                    .replaceAll("(?i)&amp;", "&")
                    .replaceAll("(?i)&lt;", "<")
                    .replaceAll("(?i)&gt;", ">")
                    .replaceAll("(?i)&quot;", "\"")
                    .replaceAll("(?i)&#0?39;", "'")
                    .replaceAll("(?i)&ldquo;|&rdquo;", "\"")
                    .replaceAll("(?i)&lsquo;|&rsquo;", "'");
        }

        /** 提取正文（优先 article-content；通用后备）与所有图片 */
        private String parseArticle(String html, boolean isToutiao) throws Exception {
            LinkedHashSet<String> images = new LinkedHashSet<>();
            StringBuilder text = new StringBuilder();
            String seg = html;
            String title = "";

            // 定位正文区（优先 article-content）
            Matcher cm = Pattern.compile("(?:id|class)=\"[^\"]*article-content[^\"]*\"", Pattern.CASE_INSENSITIVE).matcher(html);
            if (cm.find()) {
                int start = html.indexOf('>', cm.start());
                if (start >= 0) {
                    start += 1;
                    seg = html.substring(start, Math.min(html.length(), start + 80000));
                    // 正文结束标记（头条/通用页面多种结构都覆盖）
                    Matcher endM = Pattern.compile(
                            "<(div|section|footer)[^>]*(?:class|id)=\"[^\"]*(?:article-tag|article-bottom|article-footer|author-box|user-card|article-vote|article-comment|article-recommend|recommend|feed-card|hot-board|related)[^\"]*\"",
                            Pattern.CASE_INSENSITIVE).matcher(seg);
                    if (endM.find()) seg = seg.substring(0, endM.start());
                    else {
                        // 找不到结束标记时：尝试在正文后常见的推荐/评论关键字处截断
                        int cut = Integer.MAX_VALUE;
                        Matcher guard = Pattern.compile("(id|class)=\"[^\"]*(recommend|feed-card|hot-board|article-footer|related-news)[^\"]*\"", Pattern.CASE_INSENSITIVE).matcher(seg);
                        if (guard.find()) cut = guard.start();
                        if (cut < seg.length()) seg = seg.substring(0, Math.min(cut, seg.length()));
                    }
                }
            }

            // 段落文本
            Matcher pRe = Pattern.compile("<p[^>]*>([\\s\\S]*?)</p>", Pattern.CASE_INSENSITIVE).matcher(seg);
            while (pRe.find()) {
                // 段落内的 <img>：只给“被收录的正文图”保留 [图片] 占位（与图片列表一一对应）
                String inner = pRe.group(1);
                Matcher innerImg = Pattern.compile("<img[^>]*>", Pattern.CASE_INSENSITIVE).matcher(inner);
                StringBuffer inBuf = new StringBuffer();
                while (innerImg.find()) {
                    String rep = pickImageUrl(innerImg.group()) != null ? " [图片] " : "";
                    innerImg.appendReplacement(inBuf, Matcher.quoteReplacement(rep));
                }
                innerImg.appendTail(inBuf);
                inner = inBuf.toString()
                        .replaceAll("(?i)<br[^>]*>", "\n")
                        .replaceAll("<[^>]+>", " ")
                        .replaceAll("&nbsp;", " ")
                        .replaceAll("\\s+", " ")
                        .trim();
                if (!inner.isEmpty()) {
                    if (text.length() > 0) text.append('\n');
                    text.append(inner);
                }
            }

            // 图片：优先级 data-img-url > data-src > src；支持单/双引号；过滤非正文图
            Matcher im = Pattern.compile("<img[^>]*>", Pattern.CASE_INSENSITIVE).matcher(seg);
            while (im.find()) {
                String url = pickImageUrl(im.group());
                if (url != null) images.add(url);
            }

            Matcher tm = Pattern.compile("<title[^>]*>([\\s\\S]*?)</title>", Pattern.CASE_INSENSITIVE).matcher(html);
            if (tm.find()) title = decodeEntities(tm.group(1).trim());
            if (title.length() > 120) title = title.substring(0, 120);

            String textOut = text.toString();
            if (textOut.length() > 30000) textOut = textOut.substring(0, 30000);
            if (textOut.isEmpty() && images.isEmpty()) {
                throw new Exception(isToutiao
                        ? "未能从今日头条页面提取到正文（可能被 WAF 拦截）"
                        : "未能从该页面提取到正文（动态渲染或反爬），请复制文本粘贴");
            }
            JSONArray imgArr = new JSONArray();
            int cnt = 0;
            for (String u : images) {
                if (cnt++ >= 30) break;
                imgArr.put(u);
            }

            JSONObject obj = new JSONObject();
            obj.put("title", title);
            obj.put("text", textOut);
            obj.put("images", imgArr);
            obj.put("source", isToutiao ? "toutiao" : "generic");
            obj.put("via", "native");
            return obj.toString();
        }

        /** 从 <img> 标签中按优先级提取真实图片地址，过滤占位图/图标/头像等 */
        private String pickImageUrl(String tag) {
            String url = null;
            // 头条原图：data-img-url 优先
            url = attrValue(tag, "data-img-url");
            if (url == null) url = attrValue(tag, "data-src");
            if (url == null) url = attrValue(tag, "src");
            if (url == null) return null;
            String u = url.trim();
            if (!isRelevantImage(u)) return null;
            return u;
        }

        /** 提取属性值，兼容单双引号 */
        private String attrValue(String tag, String attr) {
            Matcher m = Pattern.compile(attr + "=\"([^\"]*)\"", Pattern.CASE_INSENSITIVE).matcher(tag);
            if (m.find() && !m.group(1).isEmpty()) return m.group(1);
            m = Pattern.compile(attr + "='([^']*)'", Pattern.CASE_INSENSITIVE).matcher(tag);
            if (m.find() && !m.group(1).isEmpty()) return m.group(1);
            return null;
        }

        /** 过滤明显不是正文配图的地址（占位/图标/头像/表情/加载图） */
        private boolean isRelevantImage(String url) {
            if (!url.startsWith("http")) return false;
            String u = url.toLowerCase();
            String[] bad = {"emoji", "icon", "logo", "avatar", "badge", "favicon", "loading", "spinner", "placeholder", "smiley", "sticker"};
            for (String b : bad) {
                if (u.contains(b)) return false;
            }
            return true;
        }

        private String escapeJson(String s) {
            if (s == null) return "";
            return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
        }


        private void saveBytes(byte[] data, String name, boolean isImage) {
            if (data.length == 0) {
                toast("保存失败：数据为空");
                return;
            }
            String safeName = sanitize(name);
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    // Android 10+：MediaStore 免权限
                    String mime = mimeFor(safeName, isImage);
                    if (isImage) {
                        ContentValues cv = new ContentValues();
                        cv.put(MediaStore.Images.Media.DISPLAY_NAME, safeName);
                        cv.put(MediaStore.Images.Media.MIME_TYPE, mime);
                        cv.put(MediaStore.Images.Media.RELATIVE_PATH,
                                Environment.DIRECTORY_PICTURES + "/DeepSeek文章助手");
                        Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                        if (uri == null) { toast("保存失败"); return; }
                        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                            os.write(data);
                        }
                        toast("已保存到相册 /DeepSeek文章助手");
                    } else {
                        ContentValues cv = new ContentValues();
                        cv.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                        cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                        cv.put(MediaStore.Downloads.RELATIVE_PATH,
                                Environment.DIRECTORY_DOWNLOADS + "/DeepSeek文章助手");
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                        if (uri == null) { toast("保存失败"); return; }
                        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                            os.write(data);
                        }
                        toast("已保存到 下载/DeepSeek文章助手");
                    }
                } else {
                    // Android 9 及以下：直接写公共目录（需要 WRITE_EXTERNAL_STORAGE）
                    File dir = new File(
                            Environment.getExternalStoragePublicDirectory(
                                    isImage ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_DOWNLOADS),
                            "DeepSeek文章助手");
                    if (!dir.exists() && !dir.mkdirs()) { toast("保存失败：无法创建目录"); return; }
                    File f = new File(dir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(f)) {
                        fos.write(data);
                    }
                    toast("已保存到 " + f.getAbsolutePath());
                }
            } catch (Exception e) {
                toast("保存失败：" + e.getMessage());
            }
        }

        /** 按扩展名返回正确的 MIME 类型（Word/图片/文本），避免系统按错误类型打开 */
        private String mimeFor(String name, boolean isImage) {
            String n = (name == null ? "" : name).toLowerCase();
            if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            if (n.endsWith(".png")) return "image/png";
            if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
            if (n.endsWith(".webp")) return "image/webp";
            if (n.endsWith(".txt")) return "text/plain";
            return isImage ? "image/webp" : "application/octet-stream";
        }

        private String sanitize(String name) {
            if (name == null) return "file";
            String n = name.replaceAll("[\\\\/:*?\"<>|\\s]+", "_");
            return n.isEmpty() ? "file" : n;
        }

        private void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}