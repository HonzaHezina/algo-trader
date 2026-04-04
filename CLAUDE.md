# CLAUDE.md — Project Instructions for Claude Code

## Project

AlgoTrader — AI-powered crypto trading system. Trend-following strategie s ATR trailing stop. OpenClaw agenti + n8n orchestrace + PostgreSQL + Telegram notifikace.

## Stack

- **Agents:** OpenClaw (3 agenti: Scanner, Analyst, Risk Controller)
- **Orchestrace:** n8n (workflows, cron, webhooks)
- **DB:** PostgreSQL 16
- **Notifikace:** Telegram Bot API
- **Predikce:** MindsDB (volitelné, fáze 2)
- **Infra:** Hetzner VPS, Coolify, Docker Compose
- **Data API:** Binance API (OHLCV, ordery)

## Klíčová dokumentace

Před jakoukoliv prací přečti relevantní docs:

- `docs/ARCHITECTURE.md` — celkový systém, datové toky, sequence diagramy
- `docs/AGENTS.md` — specifikace 3 agentů: system prompty, tools, I/O schémata, error handling
- `docs/WORKFLOWS.md` — 8 n8n workflows s hotovými code nodes (JavaScript)
- `docs/STRATEGY.md` — obchodní pravidla, parametry strategie, backtest výsledky
- `docs/DATABASE.md` — DB schéma, relace, helper funkce
- `docs/RISK_RULES.md` — risk management pravidla
- `docs/API.md` — Binance, Telegram, MindsDB integrace

## Adresářová struktura

```
algo-trader/
├── CLAUDE.md              ← THIS FILE
├── README.md
├── docker-compose.yml     ← deployment definice
├── .env                   ← secrets (NIKDY necommituj)
├── config/env.example     ← template pro .env
├── agents/
│   ├── scanner/           ← config.json + system_prompt.md
│   ├── analyst/
│   └── risk_controller/
├── workflows/             ← exportované n8n workflow JSONy
├── db/
│   ├── migrations/        ← SQL migrace (spouštěj v pořadí)
│   └── seeds/             ← výchozí data
├── lib/                   ← sdílený kód (indikátory, utils)
├── scripts/               ← utility skripty
├── tests/                 ← testy
└── docs/                  ← veškerá dokumentace
```

## Konvence

### Git
- Branch naming: `feature/scanner-agent`, `fix/trailing-stop-calc`, `chore/docker-setup`
- Commit messages: česky, stručně, imperativ: "Přidej Scanner agenta", "Oprav ATR výpočet"
- NIKDY necommituj `.env`, API klíče, tokeny

### Kód
- n8n Code Nodes: JavaScript (ES2020+), žádné externích dependencies
- Utility skripty: Python 3.11+ nebo Node.js 20+
- SQL: PostgreSQL 16 syntax, snake_case pojmenování
- JSON konfigurace: 2-space indent

### Testování
- Každý agent musí mít unit test na svůj output schema
- Každý n8n code node musí mít test s mock daty
- Backtest skripty v `tests/`

## Deployment

### Lokální vývoj
```bash
docker compose up -d postgres
psql -h localhost -U algotrader -d algotrader -f db/migrations/001_init.sql
psql -h localhost -U algotrader -d algotrader -f db/seeds/default_config.sql
docker compose up -d n8n
```

### Produkce (Coolify)
```bash
# Push na GitHub → Coolify auto-deploy (webhook)
git push origin main

# Nebo manuální deploy přes Coolify API:
curl -X POST "https://coolify.DOMAIN/api/v1/deploy" \
  -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"uuid": "${COOLIFY_APP_UUID}"}'
```

### Environment variables (produkce)
Nastav v Coolify UI nebo přes API:
```
POSTGRES_PASSWORD=***
N8N_USER=***
N8N_PASSWORD=***
BINANCE_API_KEY=***
BINANCE_API_SECRET=***
TELEGRAM_BOT_TOKEN=***
TELEGRAM_CHAT_ID=***
DOMAIN=algotrader.example.com
```

## Implementační pořadí

Dodržuj toto pořadí. Každý krok musí fungovat před přechodem na další:

1. ✅ Architektura a dokumentace (hotovo)
2. ⬜ Docker Compose + PostgreSQL + n8n (infra základ)
3. ⬜ Scanner agent — nejjednodušší, ověří celý data pipeline
4. ⬜ Telegram Notifier — vidíš výstup Scanneru
5. ⬜ Analyst agent — obohatí signály o trade karty
6. ⬜ Risk Controller agent — validace proti pravidlům
7. ⬜ Telegram Handler — /approve, /reject, /status příkazy
8. ⬜ Executor workflow — exekuce na Binance
9. ⬜ Monitor workflow — trailing stop management
10. ⬜ MindsDB predikce (fáze 2, volitelné)

## Bezpečnost

- API klíče POUZE v .env, NIKDY v kódu nebo gitu
- Binance API: nastav IP whitelist na VPS IP
- Telegram bot: verifikuj chat_id, ignoruj zprávy od jiných uživatelů
- n8n: basic auth, HTTPS přes Coolify/Traefik
- Risk Controller: NIKDY default approve, vždy fail-safe reject

## Specifika pro AI agenta (tebe)

- Když implementuješ agenta, přečti jeho `system_prompt.md` A `config.json` — obě musí být konzistentní
- Když píšeš n8n code node, podívej se do `docs/WORKFLOWS.md` na příklady
- Když měníš DB schéma, vytvoř NOVOU migraci (`002_xxx.sql`), neupravuj 001
- Když přidáváš nový workflow, exportuj ho jako JSON do `workflows/`
- Před pushem: ověř že `.env` NENÍ v staged files
- Při nejistotě ohledně obchodní logiky, viz `docs/STRATEGY.md`
