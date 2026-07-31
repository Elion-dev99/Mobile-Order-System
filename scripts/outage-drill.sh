#!/usr/bin/env bash
# Cardinal outage drill — simulate server down → auto maintenance → clear.
# Does NOT launch Cursor agents (dispatchOnDrill=false).
# Requires: OPS_API_SECRET matching Cloudflare.
set -euo pipefail

BASE="${BASE_URL:-https://mobile-order-system.pages.dev}"
SECRET="${OPS_API_SECRET:?OPS_API_SECRET required}"
HOLD_SEC="${HOLD_SEC:-10}"

hdr=(-H "content-type: application/json" -H "x-ops-secret: $SECRET")

json_get() {
  python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"
}

is_true() { [ "$1" = "True" ] || [ "$1" = "true" ]; }
is_false() { [ "$1" = "False" ] || [ "$1" = "false" ]; }

echo "======== OUTAGE DRILL ========"
echo "base=$BASE hold=${HOLD_SEC}s (no Cursor agent launch)"
echo

echo "1) BEFORE — GET /api/maintenance"
BEFORE=$(curl -sS "$BASE/api/maintenance")
echo "$BEFORE" | python3 -m json.tool | head -20
BEFORE_ON=$(echo "$BEFORE" | json_get "bool(d.get('effective') or d.get('maintenance'))")
echo "maintenance_effective=$BEFORE_ON"
echo

echo "2a) EDGE DRILL — POST /api/maintenance drill_outage"
EDGE=$(curl -sS -X POST "$BASE/api/maintenance" "${hdr[@]}" -d '{
  "action":"drill_outage",
  "autoClear":false,
  "updatedBy":"outage-drill"
}')
echo "$EDGE" | python3 -m json.tool | head -45
EDGE_ON=$(echo "$EDGE" | json_get "bool((d.get('afterOn') or {}).get('maintenance') or (d.get('afterOn') or {}).get('effective') or d.get('maintenance'))")
EDGE_PERSIST=$(echo "$EDGE" | json_get "(d.get('afterOn') or d).get('persisted')")
echo "edge_afterOn=$EDGE_ON persisted=$EDGE_PERSIST"
echo

echo "2b) CARDINAL TICK — simulateUnhealthy (server path)"
TICK=$(curl -sS -X POST "$BASE/api/cardinal" "${hdr[@]}" -d '{
  "action":"tick",
  "simulateUnhealthy":true,
  "dispatchOnDrill":false,
  "source":"outage-drill",
  "baseUrl":"'"$BASE"'"
}')
echo "$TICK" | python3 -c "import sys,json; d=json.load(sys.stdin); m=d.get('maintenance') or {}; print(json.dumps({k:d.get(k) for k in ['ok','unhealthy','shouldMaintain','dispatched','simulateUnhealthy']}, ensure_ascii=False)); print('maint', {k:m.get(k) for k in ['maintenance','source','updatedBy','persisted','persistError','effective']})"
TICK_OK=$(echo "$TICK" | json_get "d.get('ok')")
SHOULD=$(echo "$TICK" | json_get "d.get('shouldMaintain')")
DISPATCHED=$(echo "$TICK" | json_get "d.get('dispatched')")
PERSISTED=$(echo "$TICK" | json_get "(d.get('maintenance') or {}).get('persisted')")
echo "tick_ok=$TICK_OK shouldMaintain=$SHOULD dispatched=$DISPATCHED persisted=$PERSISTED"
echo

echo "3) DURING — GET /api/maintenance (expect ON, retry)"
DURING_ON=False
DURING=""
for i in 1 2 3 4 5 6; do
  DURING=$(curl -sS "$BASE/api/maintenance?ts=$(date +%s%N)")
  DURING_ON=$(echo "$DURING" | json_get "bool(d.get('effective') or d.get('maintenance'))")
  DURING_SRC=$(echo "$DURING" | json_get "d.get('source')")
  DURING_BY=$(echo "$DURING" | json_get "d.get('updatedBy')")
  echo "  try#$i effective=$DURING_ON source=$DURING_SRC updatedBy=$DURING_BY"
  if is_true "$DURING_ON"; then
    break
  fi
  sleep 1
done
echo "$DURING" | python3 -m json.tool | head -25
echo

echo "4) HOLD ${HOLD_SEC}s (guest banner window)"
sleep "$HOLD_SEC"
echo

echo "5) CLEAR — drill_clear + healthy tick"
CLEAR=$(curl -sS -X POST "$BASE/api/maintenance" "${hdr[@]}" -d '{
  "action":"drill_clear",
  "updatedBy":"outage-drill"
}')
echo "$CLEAR" | python3 -c "import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ['ok','action','maintenance','effective','source','updatedBy','persisted']})"

TICK2=$(curl -sS -X POST "$BASE/api/cardinal" "${hdr[@]}" -d '{
  "action":"tick",
  "simulateUnhealthy":false,
  "force":false,
  "source":"outage-drill-recovery",
  "baseUrl":"'"$BASE"'"
}')
echo "$TICK2" | python3 -c "import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ['ok','unhealthy','shouldMaintain','dispatched']})"
echo

echo "6) AFTER — GET /api/maintenance (expect OFF)"
AFTER_ON=True
AFTER=""
for i in 1 2 3 4 5 6; do
  AFTER=$(curl -sS "$BASE/api/maintenance?ts=$(date +%s%N)")
  AFTER_ON=$(echo "$AFTER" | json_get "bool(d.get('effective') or d.get('maintenance'))")
  echo "  try#$i effective=$AFTER_ON"
  if is_false "$AFTER_ON"; then
    break
  fi
  sleep 1
done
echo "$AFTER" | python3 -m json.tool | head -20
echo

echo "======== VERDICT ========"
PASS=1

if ! is_true "$TICK_OK"; then echo "FAIL: tick not ok"; PASS=0; fi
if ! is_true "$SHOULD"; then echo "FAIL: shouldMaintain not true"; PASS=0; fi
if is_true "$DISPATCHED"; then echo "FAIL: agent dispatched"; PASS=0; fi
if is_false "$PERSISTED"; then
  echo "FAIL: Cache API write not persisted (no_cache_api?)"
  PASS=0
fi
if ! is_true "$EDGE_ON" && ! is_true "$DURING_ON"; then
  echo "FAIL: maintenance never observed ON"
  PASS=0
fi
if ! is_true "$DURING_ON"; then
  echo "WARN: GET did not observe ON (edge POST may still have written)"
  if ! is_true "$EDGE_ON"; then PASS=0; fi
fi
if is_true "$AFTER_ON"; then
  echo "FAIL: maintenance still ON after clear"
  PASS=0
fi

if [ "$PASS" -eq 1 ]; then
  echo "PASS: outage → auto-maint ON → clear OFF (no agent launch)"
  exit 0
fi
echo "FAIL: see steps above"
exit 1
