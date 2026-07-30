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

rsync -a \
  --exclude '.git' \
  --exclude '.github' \
  --exclude 'node_modules' \
  --exclude 'attached_assets' \
  --exclude '.cf-publish' \
  --exclude '.firebaserc' \
  --exclude 'firebase.json' \
  --exclude 'firestore.rules' \
  --exclude 'scripts' \
  "$ROOT/" "$PUBLISH/"

cd "$ROOT"
npx --yes wrangler@4 pages deploy "$PUBLISH" \
  --project-name="$PROJECT_NAME" \
  --branch="$BRANCH_NAME" \
  --commit-dirty=true

echo "Deploy requested for project: $PROJECT_NAME"
