#!/usr/bin/env bash
# Cardinal auto-merge helper — squash-merge eligible cursor/* PRs.
# Invoked from .github/workflows/cardinal-auto-merge.yml
set -euo pipefail

GH_REPO="${GH_REPO:?GH_REPO required}"
ONLY_PR="${ONLY_PR:-}"
EVENT_PR="${EVENT_PR:-}"
HEAD_REF="${HEAD_REF:-}"

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
bad = []
for c in (m.get("statusCheckRollup") or []):
    name = str(c.get("name") or "")
    low = name.lower()
    # Ignore this workflow so a prior failure cannot soft-lock merges
    if "auto-merge" in low or low in ("merge", "cardinal auto-merge"):
        continue
    st = str(c.get("state") or c.get("conclusion") or "")
    if st.upper() in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "FAILING", "FAILED"):
        bad.append(name or st)
out("FAILING", ",".join(bad))
')"
}

merge_one() {
  local N="$1"
  echo "==== Evaluating PR #$N ===="
  local META
  META=$(gh pr view "$N" --repo "$GH_REPO" --json number,title,state,isDraft,headRefName,labels,url,mergeable,statusCheckRollup)
  echo "$META" | head -c 2000
  echo
  parse_meta <<<"$META"

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
