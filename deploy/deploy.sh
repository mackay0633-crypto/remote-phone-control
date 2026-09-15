#!/usr/bin/env bash
#
# 一键部署：拉代码 → 装依赖 → 构建前端 → 发布静态文件 → 重启 relay
#
# 用法：
#   bash deploy/deploy.sh
#
# 设计说明：前端产物发布到 /var/www/remote-phone-control，
# 而不是直接让 nginx 读仓库里的 web/dist。原因：
#
#   Ubuntu 的家目录是 0750（drwxr-x---），nginx 以 www-data 运行，
#   根本进不去 /home/ubuntu，会直接 403。
#   把产物发布到 /var/www 是标准做法，也避免为了省一次拷贝
#   而把整个家目录对 nginx 开放。
#
# 之所以用脚本而不是手工敲这几条，是因为「两份副本」最容易出的事
# 就是忘记同步 —— 这个脚本保证每次都是同一个动作。

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_ROOT="/var/www/remote-phone-control"
PM2_NAME="${PM2_NAME:-remote-phone-relay}"

echo "==> 仓库: $REPO_DIR"
echo "==> 发布目录: $WEB_ROOT"

cd "$REPO_DIR"

echo
echo "==> [1/5] 拉取代码"
git pull

echo
echo "==> [2/5] 安装依赖（npm ci，不会改动 lock 文件）"
npm ci

echo
echo "==> [3/5] 构建前端"
npm run build --workspace web

if [ ! -f "$REPO_DIR/web/dist/index.html" ]; then
  echo "构建产物不存在，中止" >&2
  exit 1
fi

echo
echo "==> [4/5] 发布静态文件"
sudo mkdir -p "$WEB_ROOT"
sudo rm -rf "${WEB_ROOT:?}"/*
sudo cp -r "$REPO_DIR/web/dist/." "$WEB_ROOT/"
sudo chown -R www-data:www-data "$WEB_ROOT"
echo "    已发布 $(find "$WEB_ROOT" -type f | wc -l) 个文件"

echo
echo "==> [5/5] 重启 relay"
if pm2 describe "$PM2_NAME" > /dev/null 2>&1; then
  pm2 restart "$PM2_NAME"
else
  echo "    pm2 里没有 $PM2_NAME，跳过（首次部署请手动 pm2 start）"
fi

echo
echo "==> 完成。健康检查："
curl -s http://127.0.0.1/health || echo "    （relay 未响应，检查 pm2 logs）"
echo
