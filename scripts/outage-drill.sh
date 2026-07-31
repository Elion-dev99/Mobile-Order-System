#!/usr/bin/env bash
# Cardinal outage drill — simulate server down → auto maintenance → clear.
# Does NOT launch Cursor agents (dispatchOnDrill=false).
# Requires: OPS_API_SECRET matching Cloudflare.
set -euo pipefail

BASE="${BASE_URL:-https://mobile-order-system.pages.dev}"
SECRET="${OPS_API_SECRET:?OPS_API_SECRET required}"
HOLD_SEC="${HOLD_SEC:-8}"

hdr=(-H "content-type: application/json" -H "x-ops-secret: $SECRET")

json_get() {
  python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"
}

echo "======== OUTAGE DRILL ========"
echo "base=$BASE hold=${HOLD_SEC}s (no Cursor agent launch)"
echo

echo "1) BEFORE — GET /api/maintenance"
BEFORE=$(curl -sS "$BASE/api/maintenance")
echo "$BEFORE" | python3 -m json.tool | head -20
BEFORE_ON=$(echo "$BEFORE" | json_get "d.get('effective') or d.get('maintenance')")
echo "maintenance_effective=$BEFORE_ON"
echo

echo "2) SIMULATE OUTAGE — POST /api/cardinal tick simulateUnhealthy"
TICK=$(curl -sS -X POST "$BASE/api/cardinal" "${hdr[@]}" -d '{
  "action":"tick",
  "simulateUnhealthy":true,
  "dispatchOnDrill":false,
  "source":"outage-drill",
  "baseUrl":"'"$BASE"'"
}')
echo "$TICK" | python3 -m json.tool | head -60
TICK_OK=$(echo "$TICK" | json_get "d.get('ok')")
SHOULD=$(echo "$TICK" | json_get "d.get('shouldMaintain')")
UNHEALTHY=$(echo "$TICK" | json_get "d.get('unhealthy')")
DISPATCHED=$(echo "$TICK" | json_get "d.get('dispatched')")
SIM=$(echo "$TICK" | json_get "d.get('simulateUnhealthy')")
echo "tick_ok=$TICK_OK shouldMaintain=$SHOULD unhealthy=$UNHEALTHY dispatched=$DISPATCHED simulated=$SIM"
echo

echo "3) DURING — GET /api/maintenance (expect ON)"
DURING=$(curl -sS "$BASE/api/maintenance")
echo "$DURING" | python3 -m json.tool | head -25
DURING_ON=$(echo "$DURING" | json_get "bool(d.get('effective') or d.get('maintenance'))")
DURING_SRC=$(echo "$DURING" | json_get "d.get('source')")
DURING_BY=$(echo "$DURING" | json_get "d.get('updatedBy')")
echo "maintenance_effective=$DURING_ON source=$DURING_SRC updatedBy=$DURING_BY"
echo

echo "4) HOLD ${HOLD_SEC}s (guest would show maintenance banner)"
sleep "$HOLD_SEC"
echo

echo "5) CLEAR — POST /api/maintenance drill_clear"
CLEAR=$(curl -sS -X POST "$BASE/api/maintenance" "${hdr[@]}" -d '{
  "action":"drill_clear",
  "updatedBy":"outage-drill"
}')
echo "$CLEAR" | python3 -m json.tool | head -25
echo

# Also run a healthy tick to clear any residual Cardinal auto lock
echo "6) HEALTHY TICK — ensure auto-maint cleared"
TICK2=$(curl -sS -X POST "$BASE/api/cardinal" "${hdr[@]}" -d '{
  "action":"tick",
  "simulateUnhealthy":false,
  "force":false,
  "source":"outage-drill-recovery",
  "baseUrl":"'"$BASE"'"
}')
echo "$TICK2" | python3 -c "import sys,json; d=json.load(sys.stdin); print({k:d.get(k) for k in ['ok','unhealthy','shouldMaintain','dispatched']})"
echo

echo "7) AFTER — GET /api/maintenance (expect OFF)"
AFTER=$(curl -sS "$BASE/api/maintenance")
echo "$AFTER" | python3 -m json.tool | head -20
AFTER_ON=$(echo "$AFTER" | json_get "bool(d.get('effective') or d.get('maintenance'))")
echo "maintenance_effective=$AFTER_ON"
echo

echo "======== VERDICT ========"
PASS=1
if [ "$TICK_OK" != "True" ] && [ "$TICK_OK" != "true" ]; then
  echo "FAIL: tick did not ok"
  PASS=0
fi
if [ "$SHOULD" != "True" ] && [ "$SHOULD" != "true" ]; then
  echo "FAIL: shouldMaintain not true on simulated outage"
  PASS=0
fi
if [ "$DISPATCHED" = "True" ] || [ "$DISPATCHED" = "true" ]; then
  echo "FAIL: Cursor agent was dispatched (dispatchOnDrill should be false)"
  PASS=0
fi
if [ "$DURING_ON" != "True" ] && [ "$DURING_ON" != "true" ]; then
  echo "FAIL: maintenance did not turn ON during outage"
  PASS=0
fi
if [ "$AFTER_ON" = "True" ] || [ "$AFTER_ON" = "true" ]; then
  echo "FAIL: maintenance still ON after clear — check Ops HQ"
  PASS=0
fi

if [ "$PASS" -eq 1 ]; then
  echo "PASS: outage → auto-maint ON → clear OFF (no agent launch)"
  exit 0
fi
echo "FAIL: see steps above"
exit 1
