#!/usr/bin/env bash
#
# relay 数据搬迁：把旧服务器上的账号 / 设备归属 / 视频素材搬到新服务器。
#
#   旧服务器：  bash deploy/relay-data.sh export
#   下载：      scp ubuntu@<旧IP>:~/remote-phone-control/relay-data-*.tar.gz .
#   上传：      scp relay-data-*.tar.gz ubuntu@<新IP>:~/
#   新服务器：  bash deploy/relay-data.sh import ~/relay-data-*.tar.gz
#
# 两件容易毁数据的事，本脚本都挡住了：
#
#   1. **WAL 模式不能裸拷 .db**。源库的最新事务都还在 -wal 里，.db 本身可能
#      只有 4KB 的文件头。这里走 SQLite 的在线备份接口（better-sqlite3，
#      relay 自己的依赖），产出的是一个自包含文件，不需要停 relay。
#      备份完还会数一遍表，读不出表就让导出**失败**，绝不静默产出空库。
#   2. **导入前先停 relay**。往一个正在被写入的库上覆盖文件，轻则导入无效，
#      重则库损坏。导入会先 pm2 stop，并自动把现有数据改名留档。
#
# 注意：导入会**覆盖**新服务器上的账号数据。如果新服务器已经建了客户，
# 先确认要不要保留——脚本会把旧的备份成 relay.db.bak-<时间戳>。

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PM2_NAME="${PM2_NAME:-remote-phone-relay}"

# relay 的工作目录是 relay/（pm2 → npm scripts 会把 cwd 设成工作区目录），
# 所以 RELAY_DB_FILE / RELAY_MEDIA_DIR 这类相对路径都是相对 relay/ 解析的。
# 这里必须用同一套规则：否则部署时改过这两个变量的话，脚本会去搬一个
# 「默认位置的、其实是空的」目录，看起来成功但新服务器上什么都没过来。
resolve_under_relay() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s' "$REPO_DIR/relay/$1" ;;
  esac
}

DB_PATH="$(resolve_under_relay "${RELAY_DB_FILE:-data/relay.db}")"
MEDIA_PATH="$(resolve_under_relay "${RELAY_MEDIA_DIR:-data/videos}")"

usage() {
  cat >&2 <<'EOF'
用法：
  bash deploy/relay-data.sh export [输出目录]
  bash deploy/relay-data.sh import <tar.gz 路径>
EOF
  exit 1
}

# 用 SQLite 的在线备份接口把源库（含 WAL 中的最新事务）合并成一个自包含文件。
#
# 为什么借用 better-sqlite3 而不是 sqlite3 命令行：它本来就是 relay 的依赖，
# 部署机上必然存在，因此不需要额外要求「系统里装过 sqlite3」。
#
# ⚠️ 辅助脚本必须落在 relay/ 目录里，不能放 mktemp 的临时目录：
#    CommonJS 的 require 是按**脚本自身所在目录**逐级向上找 node_modules 的，
#    跟 cwd 无关。放在 /tmp 下会直接 Cannot find module 'better-sqlite3'。
db_backup_with_node() {
  local dest="$1"
  local helper="$REPO_DIR/relay/.relay-data-backup-$$.cjs"

  cat > "$helper" <<'JS'
const Database = require("better-sqlite3");
const [src, dest] = process.argv.slice(2);
const db = new Database(src, { readonly: true });
db.backup(dest)
  .then(() => { db.close(); })
  .catch((err) => { console.error(err.message); process.exitCode = 1; });
JS

  local rc=0
  ( cd "$REPO_DIR/relay" && node "$helper" "$DB_PATH" "$dest" ) || rc=$?
  rm -f "$helper"
  return "$rc"
}

# 数一下库里有几张表。`0` 或读取失败都说明备份不可用——
# 这两种情况都必须让导出失败，而不是打出一个看起来成功的提示。
count_tables() {
  local helper="$REPO_DIR/relay/.relay-data-count-$$.cjs"

  cat > "$helper" <<'JS'
const Database = require("better-sqlite3");
const db = new Database(process.argv[2], { readonly: true });
const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get();
db.close();
process.stdout.write(String(row.n));
JS

  local out=""
  out="$( cd "$REPO_DIR/relay" && node "$helper" "$1" 2>/dev/null )" || out=""
  rm -f "$helper"
  printf '%s' "${out:-0}"
}

# ────────────────────────── export ──────────────────────────
do_export() {
  local out_dir="${1:-$REPO_DIR}"
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  local archive="$out_dir/relay-data-$stamp.tar.gz"

  if [ ! -f "$DB_PATH" ]; then
    echo "找不到数据库：$DB_PATH" >&2
    echo "如果你改过 RELAY_DB_FILE，请先 export 它再运行本脚本。" >&2
    exit 1
  fi

  local stage
  stage="$(mktemp -d)"
  mkdir -p "$stage/relay/data"

  echo "==> 导出 relay 数据"

  # 1) 数据库：必须产出一个**自包含**的库文件。
  #
  #    绝不能直接 `cp relay.db`：relay 跑在 WAL 模式，最新事务都还在 -wal 里，
  #    .db 本身可能只有 4KB 的文件头。实测踩过这个坑 —— 裸拷 + 只还原 .db
  #    得到的是一张表都没有的「空库」，而脚本一路打印成功，静默丢数据。
  #
  #    这里用 SQLite 的在线备份接口（把 WAL 一并合并进目标文件），
  #    不需要停 relay。首选 better-sqlite3 —— 它是 relay 自己的依赖，
  #    部署机上一定有，不依赖系统装没装 sqlite3 命令行。
  local db_method=""
  local dest_db="$stage/relay/data/relay.db"

  if db_backup_with_node "$dest_db"; then
    db_method="better-sqlite3 在线备份（relay 无需停机）"
  elif command -v sqlite3 > /dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$dest_db'"
    db_method="sqlite3 .backup（relay 无需停机）"
  else
    echo "导出失败：没有可用的在线备份手段。" >&2
    echo "  better-sqlite3 不在 $REPO_DIR/relay/node_modules（先跑 npm ci）" >&2
    echo "  且系统里没有 sqlite3 命令（sudo apt install -y sqlite3）" >&2
    echo "" >&2
    echo "  这里刻意**不**退化成『直接拷贝 .db 文件』：WAL 模式下那样拷出来的" >&2
    echo "  库缺最新事务，甚至可能一张表都没有，但脚本会显示成功。" >&2
    rm -rf "$stage"
    exit 1
  fi

  local db_size
  db_size="$(du -h "$dest_db" | cut -f1)"
  echo "    数据库：$db_method，$db_size"

  # 自检：备份出来的库必须真的能读出表，否则宁可在这里失败
  local table_count
  table_count="$(count_tables "$dest_db")"
  if [ "${table_count:-0}" -le 0 ]; then
    echo "导出失败：备份出来的库读不到任何表（${table_count:-无法读取}）。" >&2
    echo "  源库：$DB_PATH" >&2
    rm -rf "$stage"
    exit 1
  fi
  echo "    自检：$table_count 张表"

  # 自检时用 better-sqlite3 打开过目标库，WAL 模式的库会留下 -shm/-wal。
  # 备份本身已经是自包含的（无待回放事务），这两个文件纯属噪音；
  # 更要紧的是**导入端只认 relay.db**，留着它们会让「归档里有个带数据的
  # -wal」看起来像是会被还原。直接删掉，让归档只有一个文件、含义唯一。
  rm -f "$dest_db-wal" "$dest_db-shm"

  # 2) 视频素材
  if [ -d "$MEDIA_PATH" ]; then
    cp -r "$MEDIA_PATH" "$stage/relay/data/videos"
    local count size
    count="$(find "$stage/relay/data/videos" -type f | wc -l)"
    size="$(du -sh "$stage/relay/data/videos" | cut -f1)"
    echo "    视频素材：$count 个文件，$size"
  else
    echo "    视频素材：无（$MEDIA_PATH 不存在）"
  fi

  tar czf "$archive" -C "$stage" .
  rm -rf "$stage"

  echo
  echo "==> 已生成：$archive（$(du -h "$archive" | cut -f1)）"
  echo
  # hostname -I 在部分环境（容器、Git Bash）不可用，取不到就不要印出一个
  # 让人困惑的 `user@:路径`。
  # 注意必须在 `set -e` + `pipefail` 下容错：命令不存在时整条管道非零，
  # 会把「导出已经成功」的脚本在这里直接判失败。
  local self_ip=""
  if command -v hostname > /dev/null 2>&1; then
    self_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  local src_hint="${self_ip:-<旧服务器IP>}"

  echo "下一步（在你自己的电脑上执行）："
  echo "    scp $(whoami)@$src_hint:$archive ."
  echo "    scp $(basename "$archive") ubuntu@<新服务器IP>:~/"
  echo "然后在新服务器上："
  echo "    bash deploy/relay-data.sh import ~/$(basename "$archive")"
}

# ────────────────────────── import ──────────────────────────
do_import() {
  local archive="${1:-}"
  [ -n "$archive" ] || usage
  [ -f "$archive" ] || { echo "找不到压缩包：$archive" >&2; exit 1; }

  echo "==> 导入 relay 数据：$archive"
  echo

  # 先停下来，避免往正在写入的库上覆盖
  local stopped=0
  if command -v pm2 > /dev/null 2>&1 && pm2 describe "$PM2_NAME" > /dev/null 2>&1; then
    echo "==> 停止 relay（pm2 stop $PM2_NAME）"
    pm2 stop "$PM2_NAME" > /dev/null
    stopped=1
  fi

  local stage
  stage="$(mktemp -d)"
  tar xzf "$archive" -C "$stage"

  if [ ! -f "$stage/relay/data/relay.db" ]; then
    echo "压缩包里没有 relay/data/relay.db，格式不对" >&2
    rm -rf "$stage"
    [ "$stopped" -eq 1 ] && pm2 start "$PM2_NAME" > /dev/null
    exit 1
  fi

  # 目标目录可能不在默认位置（RELAY_DB_FILE / RELAY_MEDIA_DIR 指到别的盘时），
  # 所以按变量本身推导父目录，不能只想当然地建 relay/data
  mkdir -p "$(dirname "$DB_PATH")"
  mkdir -p "$(dirname "$MEDIA_PATH")"

  # 留档：导入是破坏性操作，出问题要能退回去
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  if [ -f "$DB_PATH" ]; then
    mv "$DB_PATH" "$DB_PATH.bak-$stamp"
    for suffix in -wal -shm; do
      [ -f "$DB_PATH$suffix" ] && rm -f "$DB_PATH$suffix"
    done
    echo "    已留档旧库：relay.db.bak-$stamp"
  fi

  if [ -d "$MEDIA_PATH" ]; then
    mv "$MEDIA_PATH" "$MEDIA_PATH.bak-$stamp"
    echo "    已留档旧素材目录：videos.bak-$stamp"
  fi

  cp "$stage/relay/data/relay.db" "$DB_PATH"
  if [ -d "$stage/relay/data/videos" ]; then
    cp -r "$stage/relay/data/videos" "$MEDIA_PATH"
  fi

  # 保持与仓库其它文件同一属主，避免 relay 读不了
  if [ -n "${SUDO_USER:-}" ]; then
    chown -R "$SUDO_USER:$SUDO_USER" "$REPO_DIR/relay/data"
  fi

  rm -rf "$stage"

  echo "    数据库已导入"
  if [ -d "$MEDIA_PATH" ]; then
    echo "    视频素材：$(find "$MEDIA_PATH" -type f | wc -l) 个文件"
  fi

  if [ "$stopped" -eq 1 ]; then
    echo
    echo "==> 重启 relay"
    pm2 start "$PM2_NAME" > /dev/null
    sleep 2
    pm2 logs "$PM2_NAME" --lines 15 --nostream || true
  else
    echo
    echo "ⓘ pm2 里没有 $PM2_NAME，请自行启动 relay 再验证。"
  fi

  cat <<EOF

==> 完成。请核对：
    curl -s https://<域名>/health
  期望 agents/devices 数量与旧环境一致。

  如果不对，旧数据还在：
    relay/data/relay.db.bak-$stamp
    relay/data/videos.bak-$stamp
EOF
}

case "${1:-}" in
  export) shift; do_export "${1:-}" ;;
  import) shift; do_import "${1:-}" ;;
  *) usage ;;
esac
