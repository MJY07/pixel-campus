#!/usr/bin/env bash
# 推送到 GitHub。用法：GH_TOKEN=xxx bash deploy/push.sh
set -euo pipefail

REPO="MJY07/pixel-campus"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
: "${GH_TOKEN:?需要 GH_TOKEN 环境变量}"

cd "$DIR"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
git push -u origin main --force

echo "已推送 → https://github.com/${REPO}"
