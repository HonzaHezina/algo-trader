#!/usr/bin/env bash
# AlgoTrader — Health Check
# Zkontroluje stav všech služeb

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $name"
    FAIL=$((FAIL + 1))
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# Load .env if present
[ -f .env ] && source .env 2>/dev/null || true

echo ""
echo "═══════════════════════════════════"
echo "  AlgoTrader Health Check"
echo "═══════════════════════════════════"
echo ""

echo "── Docker Services ─────────────────"
check "postgres container running" "docker compose ps postgres | grep -q 'running\|Up'"
check "n8n container running"      "docker compose ps n8n | grep -q 'running\|Up'"
check "openclaw container running" "docker compose ps openclaw | grep -q 'running\|Up'"

echo ""
echo "── Service Endpoints ───────────────"
check "PostgreSQL reachable (5432)"  "docker compose exec -T postgres pg_isready -U algotrader -q"
check "n8n reachable (5678)"         "curl -sf http://localhost:5678/healthz"
check "OpenClaw reachable (18789)"   "curl -sf http://localhost:18789/healthz"

echo ""
echo "── Database ────────────────────────"
check "watchlist table exists"   "docker compose exec -T postgres psql -U algotrader -d algotrader -c 'SELECT 1 FROM watchlist LIMIT 1' -q"
check "signals table exists"     "docker compose exec -T postgres psql -U algotrader -d algotrader -c 'SELECT 1 FROM signals LIMIT 1' -q"
check "portfolio row exists"     "docker compose exec -T postgres psql -U algotrader -d algotrader -c 'SELECT 1 FROM portfolio WHERE id=1' -q"
check "risk_config row exists"   "docker compose exec -T postgres psql -U algotrader -d algotrader -c 'SELECT 1 FROM risk_config WHERE id=1' -q"

echo ""
echo "── OpenClaw Agents ─────────────────"
check "analyst SOUL.md exists"         "[ -f agents/openclaw-workspace/analyst/SOUL.md ]"
check "risk_controller SOUL.md exists" "[ -f agents/openclaw-workspace/risk_controller/SOUL.md ]"

if [ -n "${OPENCLAW_API_KEY:-}" ] && [ "${OPENCLAW_API_KEY}" != "CHANGE_ME_OPENCLAW_TOKEN" ]; then
  check "OpenClaw API auth works" \
    "curl -sf -H 'Authorization: Bearer ${OPENCLAW_API_KEY}' http://localhost:18789/api/sessions"
else
  echo -e "  ${YELLOW}⚠${NC} OPENCLAW_API_KEY not set — skipping API auth check"
fi

echo ""
echo "── External APIs ───────────────────"
check "Binance API reachable"    "curl -sf 'https://api.binance.com/api/v3/ping'"
check "Telegram API reachable"   "curl -sf 'https://api.telegram.org' -o /dev/null"

echo ""
echo "───────────────────────────────────"
TOTAL=$((PASS + FAIL))
if [ $FAIL -eq 0 ]; then
  echo -e "  ${GREEN}Vše OK: ${PASS}/${TOTAL} kontrol prošlo${NC}"
else
  echo -e "  ${RED}${FAIL} selhání z ${TOTAL} kontrol${NC}"
fi
echo ""
