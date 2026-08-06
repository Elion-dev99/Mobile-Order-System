#!/usr/bin/env bash
# Cardinal auto-merge helper — squash-merge eligible cursor/* PRs.
# Invoked from .github/workflows/cardinal-auto-merge.yml
set -euo pipefail

GH_REPO="${GH_REPO:?GH_REPO required}"
ONLY_PR="${ONLY_PR:-}"
EVENT_PR="${EVENT_PR:-}"
HEAD_REF="${HEAD_REF:-}"

if [ "${CARDINAL_AUTOMATION_PAUSED:-false}" = "true" ]; then
  if [ "${GITHUB_EVENT_NAME:-}" != "workflow_dispatch" ]; then
    echo "Cardinal auto-merge is PAUSED (CARDINAL_AUTOMATION_PAUSED=true). Skipping."
    exit 0
  fi
  echo "PAUSED mode: workflow_dispatch only — deploy dispatch controlled by DISPATCH_DEPLOY_AFTER_MERGE"
fi

# Prefer PAT so merge push triggers on:push Deploy naturally
if [ -n "${CARDINAL_GH_PAT:-}" ]; then
  export GH_TOKEN="$CARDINAL_GH_PAT"
  echo "Using CARDINAL_GH_PAT for merge (push workflows will fire)"
fi

HIGH_RISK='^(firestore\.rules|functions/api/_ops-auth\.js)$'
BLOCK_LABELS='cardinal:escalate|do-not-merge|cardinal:hold|cardinal:no-automerge'

is_blocked_label() {
  echo "$1" | grep -Eqi "$BLOCK_LABELS" || return 1
  return 0
}

parse_meta() {
  # stdin: gh pr view JSON → exports STATE DRAFT HEAD MERGEABLE LABELS FAILING
  eval "$(python3 -c '
import json, sys, shlex
m = json.load(sys.stdin)
def out(k, v):
    print(f"{k}={shlex.quote(str(v))}")
out("STATE", m.get("state") or "")
out("DRAFT", m.get("isDraft"))
out("HEAD", m.get("headRefName") or "")
out("MERGEABLE", m.get("mergeable") or "")
labels = ",".join(l.get("name", "") for l in (m.get("labels") or []))
out("LABELS", labels)
')"
}

merge_one() {
  local N="$1"
  echo "==== Evaluating PR #$N ===="
  local META
  META=$(gh pr view "$N" --repo "$GH_REPO" --json number,title,state,isDraft,headRefName,labels,url,mergeable)
  echo "$META" | head -c 2000
  echo
  parse_meta <<<"$META"

  # Optional failing-check scan (never fail the job if API denies access)
  FAILING=""
  if CHECK_JSON=$(gh pr view "$N" --repo "$GH_REPO" --json statusCheckRollup 2>/dev/null); then
    FAILING=$(echo "$CHECK_JSON" | python3 -c '
import json,sys
m=json.load(sys.stdin)
bad=[]
for c in (m.get("statusCheckRollup") or []):
    name=str(c.get("name") or "")
    low=name.lower()
    if "auto-merge" in low or low in ("merge","cardinal auto-merge"):
        continue
    st=str(c.get("state") or c.get("conclusion") or "")
    if st.upper() in ("FAILURE","ERROR","CANCELLED","TIMED_OUT","FAILING","FAILED"):
        bad.append(name or st)
print(",".join(bad))
' 2>/dev/null || true)
  else
    echo "note: statusCheckRollup unavailable — merge will still be attempted"
  fi

  if [ "$STATE" != "OPEN" ]; then
    echo "skip: not open ($STATE)"
    return 0
  fi
  case "$HEAD" in
    cursor/*) ;;
    *) echo "skip: head $HEAD not cursor/*"; return 0 ;;
  esac
  if is_blocked_label "$LABELS"; then
    echo "skip: blocked label ($LABELS)"
    return 0
  fi
  if [ -n "$FAILING" ]; then
    echo "skip: failing checks ($FAILING)"
    return 0
  fi
  if [ "$MERGEABLE" = "CONFLICTING" ]; then
    echo "skip: conflicting"
    return 0
  fi

  local FILES
  FILES=$(gh pr diff "$N" --repo "$GH_REPO" --name-only || true)
  if [ -n "$FILES" ] && echo "$FILES" | grep -Eq "$HIGH_RISK"; then
    echo "skip: high-risk paths — human / escalate"
    gh pr comment "$N" --repo "$GH_REPO" --body "Cardinal auto-merge: **スキップ**（高リスクパス変更）。\`firestore.rules\` / ops-auth は人間または \`cardinal:escalate\` 判断が必要です。" || true
    return 0
  fi

  if [ "$DRAFT" = "True" ] || [ "$DRAFT" = "true" ]; then
    echo "Marking PR ready for review..."
    gh pr ready "$N" --repo "$GH_REPO" || true
  fi

  echo "Squash-merging #$N ..."
  if gh pr merge "$N" --repo "$GH_REPO" --squash --delete-branch; then
    echo "MERGED #$N"
    gh pr comment "$N" --repo "$GH_REPO" --body "Cardinal auto-merge: squash merge しました。Deploy 後に canary が走り、表示/API 異常なら **即ロールバック**します（\`docs/autonomy.md\`）。" || true

    # Critical: merges performed with GITHUB_TOKEN do NOT trigger on:push workflows.
    # Explicitly dispatch Deploy so canary + rollback still run.
    if [ "${DISPATCH_DEPLOY_AFTER_MERGE:-true}" = "true" ]; then
      echo "Dispatching Deploy to Cloudflare Pages on main..."
      if gh workflow run "Deploy to Cloudflare Pages" --repo "$GH_REPO" --ref main; then
        echo "Deploy workflow dispatched"
        gh pr comment "$N" --repo "$GH_REPO" --body "Cardinal auto-merge: Deploy を \`workflow_dispatch\` で起動しました（GITHUB_TOKEN マージは push ワークフローを発火しないため）。" || true
      else
        echo "WARN: failed to dispatch Deploy — run it manually or set secret CARDINAL_GH_PAT"
        gh pr comment "$N" --repo "$GH_REPO" --body "Cardinal auto-merge: **Deploy の自動起動に失敗**。Actions で Deploy を手動実行するか、\`CARDINAL_GH_PAT\` を設定してください。" || true
      fi
    fi
  else
    echo "merge failed for #$N (branch protection, permissions, or checks pending) — not failing the job"
    return 0
  fi
}

if [ -n "$ONLY_PR" ]; then
  merge_one "$ONLY_PR"
  exit 0
fi

if [ -n "$EVENT_PR" ] && [ -n "$HEAD_REF" ]; then
  case "$HEAD_REF" in
    cursor/*) merge_one "$EVENT_PR"; exit 0 ;;
    *) echo "PR event but not cursor/* — skip"; exit 0 ;;
  esac
fi

# Scheduled sweep
gh pr list --repo "$GH_REPO" --base main --state open --limit 30 --json number,headRefName \
  | python3 -c "import sys,json; [print(p['number']) for p in json.load(sys.stdin) if str(p.get('headRefName') or '').startswith('cursor/')]" \
  | while read -r N; do
      merge_one "$N" || true
    done
