#!/usr/bin/env bash
#
# 新服务器初始化（Ubuntu 22.04 / 24.04）。
#
#   sudo bash deploy/bootstrap.sh
#
# 装齐：Node 20、nginx、pm2、git、certbot、sqlite3、编译工具链。
# 可重复执行（已经装过的会跳过），不会碰任何数据。
#
# ── 为什么把 Node 版本钉在 20 ─────────────────────────────────
#
# 不是为了保守，是踩过：
#   - 本机用 Node 24 开发时选了 `node:sqlite`（24 才有），
#     部署到 Node 20 的服务器直接 `ERR_UNKNOWN_BUILTIN_MODULE`。
#   - `better-sqlite3@13` 要求 node >= 22，装到 Node 20 上会失败。
# 现在用的是 `better-sqlite3@12` + `process.loadEnvFile`（需 Node >= 20.12），
# 两者在 Node 20 上都成立。**换 Node 大版本前先跑一遍 relay 的测试套件。**
#
# ── 为什么装 build-essential ──────────────────────────────────
#
# better-sqlite3 是原生模块，优先用预编译包；一旦没有匹配的预编译包
# （换 Node 版本、换架构时就会遇到），会退化成 node-gyp 现场编译，
# 那时缺 python3/make/g++ 就是一个看不懂的报错。提前装上是几 MB 的事。

set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行：sudo bash deploy/bootstrap.sh" >&2
  exit 1
fi

echo "==> 系统：$(. /etc/os-release && echo "$PRETTY_NAME")"
echo

# ── 1. 基础包 ──────────────────────────────────────────────────
echo "==> [1/4] 安装基础包"
export DEBIAN_FRONTEND=noninteractive
# needrestart 会在 apt 之后弹交互提示，卡住无人值守的安装
export NEEDRESTART_MODE=l

apt-get update -qq
apt-get install -y -qq \
  git curl ca-certificates gnupg \
  nginx \
  certbot python3-certbot-nginx \
  sqlite3 \
  build-essential python3

echo "    nginx:   $(nginx -v 2>&1 | sed 's/^nginx version: //')"
echo "    certbot: $(certbot --version 2>&1)"
echo "    sqlite3: $(sqlite3 --version | cut -d' ' -f1)"
echo

# ── 2. Node 20 ─────────────────────────────────────────────────
echo "==> [2/4] 安装 Node 20"

install_node() {
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
}

current_major=""
if command -v node > /dev/null 2>&1; then
  current_major="$(node -p 'process.versions.node.split(".")[0]')"
fi

if [ "$current_major" = "20" ]; then
  echo "    已装 Node $(node -v)，跳过"
else
  if [ -n "$current_major" ]; then
    echo "    当前是 Node $(node -v)（主版本 $current_major），将换成 20.x"
  fi
  install_node
fi

echo "    node: $(node -v)"
echo "    npm:  $(npm -v)"
echo

# ── 3. pm2 ─────────────────────────────────────────────────────
echo "==> [3/4] 安装 pm2"
if command -v pm2 > /dev/null 2>&1; then
  echo "    已装 pm2 $(pm2 --version)，跳过"
else
  npm install -g pm2 > /dev/null
  echo "    已装 pm2 $(pm2 --version)"
fi
echo

# ── 4. 目录 ────────────────────────────────────────────────────
echo "==> [4/4] 准备目录"
# ACME 校验文件放这里（HTTP-only 配置与最终配置都指向它）
mkdir -p /var/www/certbot
# 前端产物发布目录
mkdir -p /var/www/remote-phone-control

echo "    /var/www/certbot"
echo "    /var/www/remote-phone-control"
echo

cat <<'EOF'
==> 初始化完成。接下来：

  1) 克隆代码（放在 ubuntu 家目录下）
       cd ~ && git clone <你的仓库地址> remote-phone-control

  2) 配 relay 环境变量（至少这三项）
       cd ~/remote-phone-control
       nano relay/.env        # 不存在会自动新建

     写入：
       ADMIN_PASSWORD=<强密码>
       AGENT_SECRET=<openssl rand -hex 32 的输出>
       NODE_ENV=production

     ⚠️ 别用 `cat > relay/.env` —— `>` 是截断写入，会把已配好的
        SMTP 参数等清空，之后 relay 会拒绝启动，而你以为是自己没配。

  3) 部署（拉代码 + 装依赖 + 构建前端 + 发布 + 重启 relay）
       bash deploy/deploy.sh

  4) 配域名与 HTTPS（脚本会处理「证书还没签时 nginx -t 过不了」的顺序）
       sudo bash deploy/setup-nginx-domain.sh <域名> <邮箱>

  5) 开机自启
       pm2 save && pm2 startup      # 按提示执行它输出的那行命令

ⓘ NODE_ENV=production 不只是性能开关：不设时 relay 会把注册验证码
  直接放进接口响应里方便调试，对外服务等于留了个取码后门。
EOF
