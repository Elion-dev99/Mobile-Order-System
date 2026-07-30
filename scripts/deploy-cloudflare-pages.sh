#!/usr/bin/env bash
set -euo pipefail

PROJECT_NAME="${CLOUDFLARE_PAGES_PROJECT:-mobile-order-system}"
BRANCH_NAME="${CLOUDFLARE_PAGES_BRANCH:-main}"

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN が未設定です。"
  echo "https://dash.cloudflare.com/profile/api-tokens で Create Token → Edit Cloudflare Workers を発行してください。"
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "CLOUDFLARE_ACCOUNT_ID が未設定です。"
  echo "ダッシュボード右サイドバー、または Workers 概要の Account ID を設定してください。"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLISH="$ROOT/.cf-publish"
rm -rf "$PUBLISH"
mkdir -p "$PUBLISH"

# Prefer portable copy (no rsync dependency in CI/cloud agents)
for item in admin.html cart.html index.html status.html lp.html favicon.svg css js .nojekyll; do
  if [[ -e "$ROOT/$item" ]]; then
    cp -a "$ROOT/$item" "$PUBLISH/"
  fi
done

cd "$ROOT"
npx --yes wrangler@4 pages deploy "$PUBLISH" \
  --project-name="$PROJECT_NAME" \
  --branch="$BRANCH_NAME" \
  --commit-dirty=true

rm -rf "$PUBLISH"
echo "Deploy requested for project: $PROJECT_NAME"
