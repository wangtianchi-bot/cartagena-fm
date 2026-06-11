#!/bin/bash
# build-app.sh —— 一条命令重建桌面「卡塔赫纳电台.app」（图标 + 启动器 + 签名）。
# 改了图标(make-icon.mjs)或启动脚本(start-radio.sh)后重跑即可。
set -e
cd "$(dirname "$0")"
APP="$HOME/Desktop/卡塔赫纳电台.app"

# ① 生成图标 PNG → iconset → icns
node make-icon.mjs
rm -rf Radio.iconset && mkdir Radio.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon-1024.png --out "Radio.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d icon-1024.png --out "Radio.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns Radio.iconset -o Radio.icns
rm -rf Radio.iconset

# ② 编译 .app（双击 = 跑 start-radio.sh）
cat > launcher.applescript <<EOF
do shell script "/bin/bash " & quoted form of "$(cd .. && pwd)/start-radio.sh"
EOF
rm -rf "$APP"
osacompile -o "$APP" launcher.applescript

# ③ 换图标 + ad-hoc 签名 + 刷新图标缓存
cp Radio.icns "$APP/Contents/Resources/applet.icns"
codesign --force --deep --sign - "$APP"
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true
echo "✅ 已生成：$APP"
