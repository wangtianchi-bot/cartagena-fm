#!/bin/bash
# start-radio.sh —— 一键启动电台：拉起网易云 sidecar + 本地服务，等就绪后开浏览器。
# 被桌面「卡塔赫纳电台.app」双击调用；也可单独 ./start-radio.sh 跑。
# 设计目标：双击一次就稳。崩过、僵尸占端口、PATH 不全，都能自愈。
# Finder 启动的 app 只有最简 PATH，这里把常见的 node 安装目录补进来（含 ~/.local/bin，node 实际就在那）。
for d in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin "$HOME/.hermes/node/bin" "$HOME/.volta/bin" "$HOME/.nvm/current/bin"; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")" || exit 1

NETEASE_PORT=3000
SERVER_PORT=8080

# 端口被占着（不代表进程是活的）
bound()      { lsof -ti "tcp:$1" >/dev/null 2>&1; }
# 服务真的能响应 HTTP —— 这才算“在跑”
responding() { curl -s -o /dev/null --max-time 2 "http://localhost:$1" 2>/dev/null; }
# 端口被占但不响应 = 僵尸，杀掉腾位置
kill_port()  { lsof -ti "tcp:$1" 2>/dev/null | xargs kill -9 2>/dev/null; sleep 1; }

# 确保某端口上的服务处于“能响应”状态：活着就跳过，僵尸先清，没起就拉起
# 用法：ensure <端口> <日志> <启动命令...>
ensure() {
  local port="$1" logf="$2"; shift 2
  if responding "$port"; then
    return 0                       # 已经在好好跑，啥都不动
  fi
  bound "$port" && kill_port "$port"   # 占着端口却不响应 → 僵尸，清掉
  nohup "$@" >"$logf" 2>&1 </dev/null &
  disown
}

# ① 网易云音乐 sidecar（播放源）
ensure "$NETEASE_PORT" /tmp/radio-netease.log npx NeteaseCloudMusicApi@latest

# ② 电台本地服务（含定时器 / 周报 / 飞书推送）
ensure "$SERVER_PORT" /tmp/radio-server.log npm start

# ③ 等主服务“真的能响应”（最多 ~25s），再开浏览器——避免开出一个连接失败的空页
for _ in $(seq 1 50); do
  responding "$SERVER_PORT" && break
  sleep 0.5
done

if responding "$SERVER_PORT"; then
  open "http://localhost:$SERVER_PORT"
else
  # 起不来：弹出日志让你/我能立刻看到报错，而不是默默失败
  open -a Console /tmp/radio-server.log 2>/dev/null || open -t /tmp/radio-server.log
fi
