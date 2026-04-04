# AlgoTrader — AI-Powered Crypto Trading System

Automatizovaný obchodní systém postavený na principu **"stroj exekuuje, člověk rozhoduje"**.

## Architektura

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   SCANNER   │────▶│   ANALYST    │────▶│ RISK CONTROLLER │
│  (OpenClaw) │     │  (OpenClaw)  │     │   (OpenClaw)    │
└─────────────┘     └──────────────┘     └────────┬────────┘
      │                    │                       │
      │              ┌─────┴─────┐                 │
      │              │  MindsDB  │                 │
      │              │ predikce  │                 │
      │              └───────────┘                 │
      │                                            ▼
      │                                   ┌────────────────┐
      │                                   │   NOTIFIER     │
      │                                   │ (n8n→Telegram) │
      │                                   └───────┬────────┘
      │                                           │
      │                                    [ČLOVĚK VYBÍRÁ]
      │                                           │
      │                                           ▼
      │                                   ┌────────────────┐
      │                                   │   EXECUTOR     │
      │                                   │  (n8n→DEX/CEX) │
      │                                   └───────┬────────┘
      │                                           │
      ▼                                           ▼
┌──────────────────────────────────────────────────────────┐
│                      PostgreSQL                          │
│  portfolio · trades · signals · config · audit_log       │
└──────────────────────────────────────────────────────────┘
```

## Stack

| Komponenta | Technologie | Účel |
|---|---|---|
| Agenti | OpenClaw | Scanner, Analyst, Risk Controller |
| Orchestrace | n8n | Workflow engine, cron, API calls, notifikace |
| Predikce | MindsDB | ML modely nad historickými daty |
| Databáze | PostgreSQL | Stav portfolia, trade log, konfigurace |
| Notifikace | Telegram Bot | Doručování setup karet uživateli |
| Infra | Hetzner/Coolify | VPS hosting |

## Flow

1. **Každé 4h** n8n triggeruje Scanner agenta
2. Scanner hledá breakout kandidáty přes API (Binance/CoinGecko)
3. Kandidáti jdou do Analyst agenta → ten počítá entry/stop/TP a confidence
4. Risk Controller validuje proti pravidlům portfolia
5. Schválené setupy jdou jako **trade karty** do Telegramu
6. Uživatel vybere 0–2 setupy a potvrdí
7. Executor posílá příkazy na burzu
8. Monitor workflow každých 15 min kontroluje trailing stopy
9. Po uzavření obchodu → zápis do DB, notifikace výsledku

## Jak začít

```bash
# 1. Naklonuj repo
git clone <repo-url> && cd algo-trader

# 2. Nastav environment
cp config/env.example .env
# Vyplň API klíče (Binance/CoinGecko, Telegram, MindsDB, PostgreSQL)

# 3. Spusť databázi
psql -f db/migrations/001_init.sql

# 4. Importuj n8n workflows
# V n8n UI: Settings → Import → vybrat soubory z workflows/

# 5. Nasaď OpenClaw agenty
# Viz docs/AGENTS.md pro konfiguraci jednotlivých agentů

# 6. Spusť seed data
psql -f db/seeds/default_config.sql
```

## Dokumentace

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — detailní architektura, datové toky, sequence diagramy
- [AGENTS.md](docs/AGENTS.md) — specifikace všech OpenClaw agentů (prompty, tools, inputs/outputs)
- [WORKFLOWS.md](docs/WORKFLOWS.md) — n8n workflow specifikace
- [STRATEGY.md](docs/STRATEGY.md) — obchodní strategie, pravidla, backtestové výsledky
- [DATABASE.md](docs/DATABASE.md) — schéma databáze, relace, indexy
- [RISK_RULES.md](docs/RISK_RULES.md) — pravidla risk managementu
- [API.md](docs/API.md) — externí API integrace (Binance, CoinGecko, Telegram)

## Licence

Private — personal use only.
