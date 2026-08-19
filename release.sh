#!/usr/bin/env bash
# ============================================================
# 文章助手 · 一键发版脚本
# 自动：读取当前版本 -> +1 -> 更新四处版本号 -> 同步 assets
#       -> 打包 APK（检测到 Windows 构建环境时）-> 提交并推送 GitHub
# 用法：GITHUB_TOKEN=ghp_xxx ./release.sh [版本说明]
# ============================================================
set -e
cd "$(dirname "$0")"
export GIT_CONFIG_GLOBAL=/dev/null  # 绕过本机 git 全局 URL 重写（本地 gh-proxy）
export GIT_TERMINAL_PROMPT=0
NOTE="$*"

# ---------- 1) 读取当前版本号 ----------
VER=$(grep -oP 'versionName "\K[0-9]+\.[0-9]+' android-app/app/build.gradle | head -1)
VC=$(grep -oP 'versionCode \K[0-9]+' android-app/app/build.gradle | head -1)
if [ -z "$VER" ] || [ -z "$VC" ]; then
  echo "✗ 无法从 android-app/app/build.gradle 解析版本号"; exit 1
fi
MAJOR=${VER%%.*}; MINOR=${VER##*.}
NEW_MINOR=$((MINOR + 1))
NEW_VER="$MAJOR.$NEW_MINOR"
NEW_VC=$((VC + 1))
echo "==> 版本：v$VER (code $VC) -> v$NEW_VER (code $NEW_VC)"${NOTE:+" | 说明：$NOTE"}

# ---------- 2) 更新四处版本号 ----------
sed -i "s/title=\"版本号\">v[0-9.]*/title=\"版本号\">v$NEW_VER/" public/index.html
sed -i "s/文章助手 v[0-9.]* 已启动/文章助手 v$NEW_VER 已启动/" server.js
sed -i "s/versionCode [0-9]*/versionCode $NEW_VC/" android-app/app/build.gradle
sed -i "s/versionName \"[0-9.]*\"/versionName \"$NEW_VER\"/" android-app/app/build.gradle
sed -i 's/"version": "[0-9.]*"/"version": "'"$NEW_VER"'.0"/' package.json
echo "==> 版本号已更新：index.html / server.js / build.gradle / package.json"

# ---------- 3) 同步网页资源到 APK assets ----------
cp public/index.html public/style.css public/app.js public/smart-rewrite.js android-app/app/src/main/assets/
echo "==> assets 已同步"

# ---------- 4) 打包 APK（Windows 侧 Gradle + Android SDK） ----------
if [ -d /mnt/c/Users/25864/AppData/Local/Android/Sdk ] && command -v cmd.exe >/dev/null 2>&1; then
  rm -rf /mnt/c/editor-build && mkdir -p /mnt/c/editor-build
  tar --exclude='.git' --exclude='build' --exclude='.gradle' -cf - . | (cd /mnt/c/editor-build && tar -xf -)
  cmd.exe /c "cd /d C:\\editor-build\\android-app && set ANDROID_HOME=C:\\Users\\25864\\AppData\\Local\\Android\\Sdk && C:\\gradle\\gradle-8.12\\bin\\gradle.bat assembleDebug --no-daemon" || { echo "✗ APK 构建失败"; rm -rf /mnt/c/editor-build; exit 1; }
  mkdir -p release
  cp /mnt/c/editor-build/android-app/app/build/outputs/apk/debug/app-debug.apk "release/文章助手-v$NEW_VER-debug.apk"
  rm -rf /mnt/c/editor-build
  echo "==> APK 已生成：release/文章助手-v$NEW_VER-debug.apk"
else
  echo "  (未检测到 Windows 侧构建环境，跳过 APK 打包；代码仍会提交推送)"
fi

# ---------- 5) 提交并推送（github 直连不稳时自动重试） ----------
git add -A
git commit -m "release v$NEW_VER: 自动版本号递增"${NOTE:+" - $NOTE"} || echo "(无改动可提交)"
if [ -z "$GITHUB_TOKEN" ]; then echo "✗ 未设置 GITHUB_TOKEN 环境变量，跳过推送"; exit 1; fi
echo "==> 推送中（最多 5 次重试）…"
ok=0
for i in 1 2 3 4 5; do
  if git push "https://$GITHUB_TOKEN@github.com/tipus0731/deepseek-article-editor" main >/tmp/release_push.log 2>&1; then ok=1; echo "==> 已推送 main -> v$NEW_VER"; break; fi
  echo "  第 $i 次推送失败，重试…"; sleep 5
done
if [ "$ok" != "1" ]; then echo "✗ 推送失败（详见 /tmp/release_push.log）"; exit 1; fi
echo "✅ 发版完成：v$NEW_VER  release/文章助手-v$NEW_VER-debug.apk"
