#!/bin/bash
# start-radio.sh —— 一键启动电台：拉起网易云 sidecar + 本地服务，等就绪后开浏览器。
# 被桌面「卡塔赫纳电台.app」双击调用；也可单独 ./start-radio.sh 跑。
# Finder 启动的 app 只有最简 PATH，这里把常见的 node 安装目录补进来（按需自行增减）。
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.hermes/node/bin" "$HOME/.volta/bin" "$HOME/.nvm/current/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")" || exit 1

NETEASE_PORT=3000
SERVER_PORT=8080

# 已在跑就不重复起（lsof 查端口占用）
running() { lsof -ti "tcp:$1" >/dev/null 2>&1; }

# ① 网易云音乐 sidecar（播放源）：nohup + disown 脱离父进程，app 退出后继续活着
if ! running "$NETEASE_PORT"; then
  nohup npx NeteaseCloudMusicApi@latest >/tmp/radio-netease.log 2>&1 </dev/null &
  disown
fi

# ② 电台本地服务（含定时器 / 周报 / 飞书推送）
if ! running "$SERVER_PORT"; then
  nohup npm start >/tmp/radio-server.log 2>&1 </dev/null &
  disown
fi

# ③ 等服务起来（最多 ~15s），再开浏览器——避免开了个连接失败的空页
for _ in $(seq 1 30); do
  curl -s "http://localhost:$SERVER_PORT" >/dev/null 2>&1 && break
  sleep 0.5
done
open "http://localhost:$SERVER_PORT"
