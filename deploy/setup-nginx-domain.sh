#!/usr/bin/env bash
#
# 给 relay 配域名 + Let's Encrypt 证书。
#
#   sudo bash deploy/setup-nginx-domain.sh jyglobal.top you@example.com
#
# 第三个参数可选，是否同时签发 www（默认签发）：
#   sudo bash deploy/setup-nginx-domain.sh jyglobal.top you@example.com --no-www
#
# 可重复执行：证书已存在就只重写配置，不会重复申请（避免撞 Let's Encrypt 限流）。
#
# ── 为什么要分两步 ────────────────────────────────────────────
#
# deploy/nginx.conf.example 里引用了
#   /etc/letsencrypt/live/<域名>/fullchain.pem
# 而证书**还不存在**。此时 `nginx -t` 直接失败，nginx 启动不了；
# 而 certbot 的 webroot 校验又需要 nginx 已经在 80 端口提供
# /.well-known/acme-challenge/ —— 于是死锁。
#
# 解法就是本脚本：
#   第一步  先装一份**只有 80 端口**的配置（不发证书也能过 nginx -t）
#   第二步  certbot 用它完成 webroot 校验、签下证书
#   第三步  再换成完整的 80+443 配置
#
# 顺带处理两个容易漏的点：
#   - 删掉 Ubuntu 自带的 sites-enabled/default，否则它先匹配，域名会 404
#   - 用 restart 而不是 reload：实测 reload 后旧 worker 仍按老配置跑，
#     只有 restart 才真正换掉（这个坑排查了很久）

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
WANT_WWW=1
if [ "${3:-}" = "--no-www" ]; then
  WANT_WWW=0
fi

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "用法：sudo bash deploy/setup-nginx-domain.sh <域名> <邮箱> [--no-www]" >&2
  echo "例如：sudo bash deploy/setup-nginx-domain.sh jyglobal.top you@example.com" >&2
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_AVAILABLE="/etc/nginx/sites-available/remote-phone-control"
SITE_ENABLED="/etc/nginx/sites-enabled/remote-phone-control"
WEBROOT="/var/www/certbot"

# 证书里的域名列表（第一个决定 /etc/letsencrypt/live/<名字> 的目录名）
CERT_ARGS=(-d "$DOMAIN")
SERVER_NAMES="$DOMAIN"
if [ "$WANT_WWW" -eq 1 ]; then
  CERT_ARGS+=(-d "www.$DOMAIN")
  SERVER_NAMES="$DOMAIN www.$DOMAIN"
fi

CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

echo "==> 域名:  $SERVER_NAMES"
echo "==> 邮箱:  $EMAIL"
echo "==> 仓库:  $REPO_DIR"
echo

mkdir -p "$WEBROOT"

# ── 1. 先放一份只有 80 端口的配置 ───────────────────────────────
echo "==> [1/4] 装载 HTTP-only 配置（先让 80 端口能过 nginx -t）"

cat > "$SITE_AVAILABLE" <<EOF
# 由 deploy/setup-nginx-domain.sh 生成的**中间态**配置。
# 它只做两件事：响应 ACME 校验、把其余流量反代到 relay 的 5081。
# 签完证书后本文件会被替换成带 443 的完整配置。
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAMES;

    location /.well-known/acme-challenge/ {
        root $WEBROOT;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:5081;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_request_buffering off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:5081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       \$host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }

    location = /health {
        proxy_pass http://127.0.0.1:5081/health;
        proxy_set_header Host \$host;
    }

    location / {
        root /var/www/remote-phone-control;
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

ln -sf "$SITE_AVAILABLE" "$SITE_ENABLED"

# Ubuntu 自带的 default 站点会抢先匹配，导致域名返回 404 或默认页
if [ -e /etc/nginx/sites-enabled/default ]; then
  rm -f /etc/nginx/sites-enabled/default
  echo "    已移除 sites-enabled/default"
fi

nginx -t
systemctl restart nginx
echo "    nginx 已重启（80 端口可用）"
echo

# ── 2. 签证书 ───────────────────────────────────────────────────
echo "==> [2/4] 申请证书"

if [ -f "$CERT_DIR/fullchain.pem" ]; then
  echo "    证书已存在（$CERT_DIR），跳过申请"
else
  # --keep-until-expiring 让重复执行变成 no-op，避免撞限流
  certbot certonly \
    --webroot -w "$WEBROOT" \
    "${CERT_ARGS[@]}" \
    --email "$EMAIL" \
    --agree-tos --no-eff-email \
    --non-interactive \
    --keep-until-expiring

  if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
    echo "证书签发失败，请检查：" >&2
    echo "  1) DNS 是否已把 $DOMAIN 解析到本机公网 IP" >&2
    echo "  2) 安全组/防火墙是否放行 80 端口（Let's Encrypt 从境外校验）" >&2
    exit 1
  fi
fi

echo "    证书: $CERT_DIR/fullchain.pem"
echo

# ── 3. 换成完整配置（80 + 443）──────────────────────────────────
echo "==> [3/4] 装载 80 + 443 完整配置"

if [ ! -f "$REPO_DIR/deploy/nginx.conf.example" ]; then
  echo "找不到 $REPO_DIR/deploy/nginx.conf.example" >&2
  exit 1
fi

# 模板里写好的是 your-domain.com（含 www 与证书路径），这里统一替换
sed "s/your-domain\.com/$DOMAIN/g" \
  "$REPO_DIR/deploy/nginx.conf.example" > "$SITE_AVAILABLE"

# --no-www 时把 www. 也摘掉
if [ "$WANT_WWW" -eq 0 ]; then
  sed -i "s/server_name $DOMAIN www\.$DOMAIN;/server_name $DOMAIN;/" "$SITE_AVAILABLE"
fi

nginx -t
# 用 restart 不是 reload：reload 后旧 worker 可能仍在跑老配置
systemctl restart nginx
echo "    nginx 已重启（80 跳转 + 443 生效）"
echo

# ── 4. 自查 ─────────────────────────────────────────────────────
echo "==> [4/4] 自查"

echo -n "    证书到期时间: "
openssl x509 -enddate -noout -in "$CERT_DIR/fullchain.pem" | cut -d= -f2

echo -n "    HTTPS /health: "
# 走域名本身，顺便验证证书链与 SNI 都对
if curl -fsS --max-time 10 "https://$DOMAIN/health" 2>/dev/null; then
  echo
else
  echo "（失败）"
  echo "    DNS 可能还没生效，或 443 未在安全组放行。稍后手工重试："
  echo "      curl -v https://$DOMAIN/health"
fi

echo
cat <<EOF
==> 完成。

  ⚠️ 别忘了这两件：
    1) 云控制台「安全组 / 防火墙」放行 80 与 443
       （只放行 443 是不够的：certbot 续期要用 80）
    2) 5081 应该**不要**对公网开放，浏览器和 Agent 都只走 443

  自动续期已由 apt 安装的 certbot.timer 负责，可自查：
      systemctl list-timers | grep certbot
      certbot renew --dry-run
EOF
