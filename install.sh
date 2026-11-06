#!/usr/bin/env bash
# 把 dsh-batch-hero 装进 DeepSeek Harness 的某个 profile。
# 用法：bash install.sh [profile名]   默认 desktop
set -euo pipefail

PROFILE="${1:-${DSH_PROFILE:-desktop}}"
HOME_DIR="${HOME}"
PLUGIN_SRC="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="${HOME_DIR}/.dsh/plugins/dsh-batch-hero"
PROFILE_DIR="${HOME_DIR}/.dsh/profiles/${PROFILE}"

if [ ! -d "${PROFILE_DIR}" ]; then
  echo "找不到 profile 目录：${PROFILE_DIR}" >&2
  echo "可用的 profile：" >&2
  ls -1 "${HOME_DIR}/.dsh/profiles" 2>/dev/null >&2 || true
  exit 1
fi

echo "==> 插件：${PLUGIN_DIR}"
mkdir -p "$(dirname "${PLUGIN_DIR}")"
if [ "${PLUGIN_SRC}" != "${PLUGIN_DIR}" ]; then
  rm -rf "${PLUGIN_DIR}"
  cp -R "${PLUGIN_SRC}" "${PLUGIN_DIR}"
  rm -rf "${PLUGIN_DIR}/node_modules" "${PLUGIN_DIR}/src" "${PLUGIN_DIR}/build" "${PLUGIN_DIR}/demo" "${PLUGIN_DIR}/scripts"
fi

echo "==> profile：${PROFILE_DIR}"
python3 - "${PROFILE_DIR}/package.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)

deps = data.setdefault("dependencies", {})
deps["dsh-batch-hero"] = "file:../../plugins/dsh-batch-hero"

profile = data.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if "dsh-batch-hero" not in bundles:
    bundles.append("dsh-batch-hero")

with open(path, "w") as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("package.json 已更新")
PY

echo "==> 安装依赖"
cd "${PROFILE_DIR}"
if command -v pnpm >/dev/null 2>&1 && [ -f pnpm-lock.yaml ]; then
  pnpm install
elif command -v npm >/dev/null 2>&1; then
  npm install
else
  echo "没找到 pnpm / npm，请手动在该目录执行一次安装（让 node_modules 建出链接）" >&2
fi

LINK="${PROFILE_DIR}/node_modules/dsh-batch-hero"
if [ -e "${LINK}" ]; then
  echo "==> 链接："
  ls -ld "${LINK}"
fi

echo
echo "完成。完全退出 DeepSeek Harness 再打开，侧栏就会出现「批量主图」。"
