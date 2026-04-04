#!/usr/bin/env bash
# AlgoTrader — Import n8n Workflows
# Importuje všechny workflow JSONy přes n8n REST API

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

[ -f .env ] && source .env 2>/dev/null || true

N8N_URL="${N8N_URL:-http://localhost:5678}"
N8N_USER="${N8N_USER:-admin}"
N8N_PASSWORD="${N8N_PASSWORD:-}"

if [ -z "$N8N_PASSWORD" ]; then
  echo -e "${RED}[ERROR]${NC} N8N_PASSWORD není nastaven v .env"
  exit 1
fi

AUTH="$(echo -n "${N8N_USER}:${N8N_PASSWORD}" | base64)"

import_workflow() {
  local file="$1"
  local name
  name="$(basename "$file" .json)"

  echo -n "  Importuji ${name}... "

  local response
  response=$(curl -sf \
    -X POST \
    "${N8N_URL}/api/v1/workflows" \
    -H "Authorization: Basic ${AUTH}" \
    -H "Content-Type: application/json" \
    -d @"$file" 2>&1) || {
    echo -e "${RED}FAIL${NC}"
    echo "    Error: $response"
    return 1
  }

  local wf_id
  wf_id=$(echo "$response" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo -e "${GREEN}OK${NC} (id: ${wf_id:-unknown})"
}

echo ""
echo "Importuji n8n workflows z workflows/*.json"
echo "N8N: ${N8N_URL}"
echo ""

IMPORTED=0
FAILED=0

for wf_file in workflows/*.json; do
  [ -f "$wf_file" ] || continue
  if import_workflow "$wf_file"; then
    IMPORTED=$((IMPORTED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "Importováno: ${IMPORTED}, Selhání: ${FAILED}"

if [ $FAILED -gt 0 ]; then
  echo -e "${YELLOW}Tip: Pokud workflow již existuje, smaž ho nejdřív v n8n UI${NC}"
  exit 1
fi

echo -e "${GREEN}Import dokončen!${NC}"
echo ""
echo "Další kroky v n8n:"
echo "  1. Settings → Credentials → Přidej 'AlgoTrader PostgreSQL'"
echo "  2. Settings → Credentials → Přidej 'AlgoTrader Telegram'"
echo "  3. Aktivuj workflow '01 - Scanner Pipeline'"
