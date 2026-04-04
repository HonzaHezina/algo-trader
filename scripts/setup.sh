#!/usr/bin/env bash
# AlgoTrader — Initial Setup Script
# Spusť jednou po klonování repozitáře

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# ─── 1. Copy .env ────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp config/env.example .env
  warn ".env vytvořen z env.example — VYPLŇ HODNOTY před pokračováním!"
  warn "  nano .env"
  exit 1
else
  info ".env existuje ✓"
fi

# ─── 2. Validate critical .env vars ──────────────────────────────────────────
source .env

check_var() {
  local var="$1"
  local val="${!var:-}"
  if [ -z "$val" ] || [[ "$val" == *"CHANGE_ME"* ]]; then
    error "Proměnná $var není nastavena nebo obsahuje CHANGE_ME. Vyplň .env"
  fi
}

check_var POSTGRES_PASSWORD
check_var N8N_PASSWORD
check_var N8N_ENCRYPTION_KEY
check_var OPENCLAW_API_KEY
check_var ANTHROPIC_API_KEY

info "Kritické proměnné OK ✓"

# ─── 3. Start PostgreSQL ──────────────────────────────────────────────────────
info "Spouštím PostgreSQL..."
docker compose up -d postgres

info "Čekám na PostgreSQL..."
until docker compose exec postgres pg_isready -U algotrader -q 2>/dev/null; do
  sleep 2
  printf '.'
done
echo ""
info "PostgreSQL připraven ✓"

# ─── 4. Start OpenClaw ───────────────────────────────────────────────────────
info "Spouštím OpenClaw..."
docker compose up -d openclaw

info "Čekám na OpenClaw (může trvat 30s)..."
TIMEOUT=60
COUNT=0
until curl -sf "http://localhost:18789/healthz" > /dev/null 2>&1; do
  sleep 3
  COUNT=$((COUNT + 3))
  printf '.'
  if [ $COUNT -ge $TIMEOUT ]; then
    error "OpenClaw nereaguje po ${TIMEOUT}s. Zkontroluj: docker compose logs openclaw"
  fi
done
echo ""
info "OpenClaw připraven ✓"

# ─── 5. Start n8n ────────────────────────────────────────────────────────────
info "Spouštím n8n..."
docker compose up -d n8n

info "Čekám na n8n..."
TIMEOUT=60
COUNT=0
until curl -sf "http://localhost:5678/healthz" > /dev/null 2>&1; do
  sleep 3
  COUNT=$((COUNT + 3))
  printf '.'
  if [ $COUNT -ge $TIMEOUT ]; then
    error "n8n nereaguje po ${TIMEOUT}s. Zkontroluj: docker compose logs n8n"
  fi
done
echo ""
info "n8n připraven ✓"

# ─── 6. Import n8n workflows ─────────────────────────────────────────────────
if [ -d workflows ] && ls workflows/*.json 1> /dev/null 2>&1; then
  info "Importuji n8n workflows..."
  bash scripts/import_workflows.sh
else
  warn "Žádné workflow JSONy nalezeny v workflows/ — přeskakuji import"
fi

# ─── 7. Done ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  AlgoTrader setup dokončen!             ${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo "  n8n UI:       http://localhost:5678"
echo "  OpenClaw UI:  http://localhost:18789?token=${OPENCLAW_API_KEY:-TOKEN}"
echo ""
echo "Další kroky:"
echo "  1. Otevři n8n → nastav PostgreSQL credentials (AlgoTrader PostgreSQL)"
echo "  2. Otevři n8n → nastav Telegram credentials (AlgoTrader Telegram)"
echo "  3. Aktivuj workflow '01 - Scanner Pipeline'"
echo "  4. Zkontroluj zdraví systému: bash scripts/health_check.sh"
