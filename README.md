# ✍️ 文章助手

一个本地运行的网页工具：**粘贴文本或导入链接 → 按预设规则 → 调用 DeepSeek 官网 API 自动改写文章**。

支持预制修改条件：**禁止词/敏感词过滤、语气风格、篇幅调整、目标读者、去除广告、修正错别字、自动分节加小标题**等，并提供「结果 / 对照差异」双视图与一键复制、下载。

## 功能

- 📋 **两种输入方式**（支持**今日头条链接**：自动提取 `article-content` 正文与全部图片）
  - 直接粘贴文章文本
  - 输入文章链接，由本地服务抓取网页并提取正文（规避浏览器跨域限制）
- 🚫 **禁止词 / 敏感词管理**
  - 预置示例（《广告法》极限词：最佳、国家级、顶级、销量第一…），可自由增删，自动持久化
  - 模型会逐词检查，用合规表达替换、改写或删除含禁止词的句子
- ⚙️ **预制修改条件** + ✍️ **自定义修改要求输入框**（自由填写额外要求，如：删除第一段、改写为第三人称…）
  - 语气风格：保持 / 正式书面 / 平实易懂 / 轻松口语 / 热情感染力
  - 篇幅：保持 / 精简 / 扩写（可设目标字数）
  - 目标读者：大众 / 专业人士 / 消费者 / 学生
  - 选项：去除广告与无关信息、修正错别字与语法、长文分节加小标题、保留事实数据不编造
- 🤖 **模型选择**：deepseek-chat（快速）/ deepseek-reasoner（深度思考，可查看思考过程）
- ⚡ **流式输出**：生成过程实时显示，可随时停止；**总耗时实时计时**，完成后显示「N 字，总耗时 X 秒」
- 🖼 **图片去水印**（本地 JS 裁切）：头条文章图片水印一键去除——选择水印位置（右下角/左下角/顶部/底部整条）与裁切比例，canvas 本地裁切导出，可逐张/批量下载，图片不上传任何服务器
- 🔍 **对照差异**：句子级 LCS 差异高亮，红色删除线 = 被删改，绿色高亮 = 新增/替换
- 📤 一键复制、下载 .txt（UTF-8 BOM，记事本不乱码）

## 快速开始

**两种使用方式，任选其一：**

### 方式一：直接双击打开（推荐，无需安装）

直接双击 `public/index.html` 在浏览器中打开即可使用，无需 Node.js：

- 页面自动进入「🔗 本地文件模式」：请求**直达 api.deepseek.com**；「导入链接」经由公共跨域代理（allorigins / corsproxy.io / codetabs 自动轮换）抓取网页并提取正文
- 在右上角填写 [platform.deepseek.com](https://platform.deepseek.com) 申请的 API Key 即可
- ⚠️ 直连模式的链接抓取依赖公共代理：部分反爬/动态渲染网站可能失败，且链接会经过第三方代理，敏感页面请直接用「粘贴文本」；本地服务模式则无此限制

### 方式二：本地服务模式（支持导入链接）

环境要求：**Node.js 18+**（推荐 20+），无需安装任何 npm 依赖。

```bash
cd deepseek-article-editor
node server.js
```

浏览器打开 **http://127.0.0.1:7070** 即可使用。该模式额外支持「导入链接」抓取网页正文（由本机服务代为抓取，规避浏览器跨域限制）。

### 获取 DeepSeek API Key

1. 打开 [platform.deepseek.com](https://platform.deepseek.com) 注册并登录
2. 进入「API Keys」→ 创建新 Key（格式 `sk-...`）
3. 在页面右上角填入 Key（仅保存在浏览器 localStorage，可点击 👁 显示）

> 方式二也可改用环境变量配置，前端无需填写：
> ```bash
> set DEEPSEEK_API_KEY=sk-xxxx        # Windows CMD
> $env:DEEPSEEK_API_KEY = "sk-xxxx"   # PowerShell
> node server.js
> ```

## 目录结构

```
deepseek-article-editor/
├── server.js          # 本地服务：静态页面 + DeepSeek 流式代理 + 链接抓取（零依赖）
├── package.json
├── public/
│   ├── index.html     # 页面结构
│   ├── style.css      # 样式
│   └── app.js         # 前端逻辑：规则构建、流式渲染、差异对照
└── README.md
```

## 服务接口

| 接口 | 说明 |
| --- | --- |
| `GET /` | 页面 |
| `GET /api/config` | 是否已配置服务端 Key |
| `POST /api/rewrite` | 流式转发至 `https://api.deepseek.com/chat/completions` |
| `POST /api/fetch-article` | 抓取链接并提取正文（`{url}`，服务模式） |

> 直连模式（双击 HTML）下，链接抓取在浏览器内完成：经公共跨域代理获取 HTML → 自动识别编码（UTF-8/GBK）→ 剔除导航/脚本/广告 → 提取标题与正文。
>
> **今日头条说明**：头条有较强反爬（WAF），本机家庭网络下 `node server.js` 服务模式成功率较高；直连模式经公共代理成功率较低。抓取失败时页面会给出提示，可复制正文后粘贴。头条图片 URL 带签名与防盗链，加载失败时程序会自动改用公共代理重试；水印去除为纯本地 canvas 裁切，图片不会离开你的浏览器。

可通过环境变量 `PORT`（默认 7070）、`HOST`（默认 127.0.0.1）修改监听地址。

## 常见问题

- **链接抓取失败**：部分网站有反爬或为 JS 动态渲染（微信公众号、某些新闻站）。请直接复制正文后「粘贴文本」。
- **修改结果被截断**：单次输出有 token 上限，超长文章建议先精简或分段修改。
- **deepseek-reasoner 较慢**：深度思考模型会先推理再输出，属正常现象；需要快速出稿请选 deepseek-chat。
- **403 / 余额不足**：请检查 API Key 是否正确、账户是否有余额（platform.deepseek.com → Usage）。

## 📱 打包成 Android APK

项目已附带完整的 Android WebView 壳工程（零第三方依赖），网页资源直接打包进 APK，无需服务器。

```
deepseek-article-editor/
├── android-app/                 # Android 打包工程
│   ├── settings.gradle
│   ├── build.gradle
│   └── app/
│       ├── build.gradle
│       └── src/main/
│           ├── AndroidManifest.xml
│           ├── java/com/ds/articleeditor/MainActivity.java   # WebView 壳 + JS 桥
│           └── assets/          # 打包进 APK 的网页（index.html/style.css/app.js）
└── public/                      # 网页源文件（改这里，重新复制到 assets 再打包）
```

### 方式二：GitHub Actions 云构建（推荐，无需安装任何工具）

已内置 CI 配置 `.github/workflows/build-apk.yml`，推送代码后 GitHub 云端自动构建 APK，无需本机安装 Android Studio：

1. 在 GitHub 上新建一个仓库（Public 或 Private 均可）
2. 推送整个 `deepseek-article-editor` 目录：

```bash
cd deepseek-article-editor
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

3. 打开仓库的 **Actions** 页，等待「Build Android APK」工作流跑完（约 5-10 分钟，首次较慢）
4. 在构建记录底部 **Artifacts** 下载 `deepseek-article-app-debug`，解压得到 `app-debug.apk`，传到手机安装即可

工作流说明：
- **自动同步网页**：构建前自动把 `public/` 下三个文件复制进 `android-app/.../assets`，所以你只需修改 `public/`，推送即自动出包
- **触发时机**：推送修改了 `public/**`、`android-app/**` 或 workflow 文件时自动构建；也可在 Actions 页点 **Run workflow** 手动构建
- 产物为 debug 签名 APK，可直接安装使用；如需上架应用商店，另行配置签名（release keystore）
### 构建步骤（需要 Android Studio）

1. 安装 [Android Studio](https://developer.android.com/studio)（自带 JDK 17，首次构建自动下载 Gradle 与 SDK）
2. 打开 `android-app` 目录（File → Open），等待 Gradle Sync 完成
3. 菜单 **Build → Build APK(s)**，完成后 APK 位于：
   `android-app/app/build/outputs/apk/debug/app-debug.apk`
4. 把 APK 传到手机安装（首次安装需允许“未知来源”）

> 命令行构建：安装 JDK 17 + Android SDK 后，在 `android-app` 目录执行 `gradle assembleDebug`。

### APK 内网页的差异

- **无 CORS 限制**：WebView 开启 `allowUniversalAccessFromFileURLs`，直连 `api.deepseek.com`、头条图床、公共代理均不受浏览器跨域约束，链接抓取成功率更高
- **下载变保存**：「下载 .txt / 图片」通过 JS 桥保存到手机 **相册/文章助手** 与 **Pictures/文章助手**（Android 10+ 免权限，9 及以下需存储权限）
- 「原图」在新窗口打开时自动跳转系统浏览器
- API Key 仍只存在本机（WebView 的 localStorage），不会上传

### 网页更新后重新打包

```bash
# 把 public 下三个文件复制到 assets（覆盖）
copy public\index.html android-app\app\src\main\assets\
copy public\style.css  android-app\app\src\main\assets\
copy public\app.js     android-app\app\src\main\assets\
```

然后在 Android Studio 里重新 Build 即可。

## 安全说明

- API Key 只保存在**你本机浏览器**并经由**你本机服务**转发到 api.deepseek.com，不经第三方。
- 该服务仅供个人本地使用，**请勿部署到公网**（否则他人可借用你的 Key）。
- 生成结果请人工复核后再使用，遵守目标平台的内容规范与法律法规。