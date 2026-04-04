# Setup Guide — Claude Code + GitHub + Hetzner/Coolify

Kompletní návod jak nastavit Claude Code aby uměl: pushovat na GitHub, deployovat na Hetzner přes Coolify, a pracovat s tímhle projektem.

## KROK 0: Co potřebuješ mít předem

```
✅ Node.js 18+ (pro Claude Code)
✅ Claude Code nainstalovaný (npm install -g @anthropic-ai/claude-code)
✅ GitHub účet
✅ Hetzner VPS s Coolify (nebo ho založíme)
✅ Telegram účet (pro bota)
```

---

## KROK 1: GitHub Personal Access Token

Jdi na: https://github.com/settings/tokens?type=beta (Fine-grained tokens)

Vytvoř token s těmito oprávněními:
- Repository access: "All repositories" nebo vyber konkrétní
- Permissions:
  - Contents: Read and Write
  - Issues: Read and Write
  - Pull requests: Read and Write
  - Metadata: Read-only

**Ulož token** — uvidíš ho jen jednou. Dej si ho třeba do `~/.env.tokens`:
```bash
echo 'GITHUB_PAT=github_pat_XXXXXXXXXXXX' >> ~/.env.tokens
```

---

## KROK 2: Připoj GitHub MCP do Claude Code

```bash
# Nejjednodušší způsob — HTTP transport (Claude Code 2.1.1+)
claude mcp add -s user --transport http github \
  https://api.githubcopilot.com/mcp \
  -H "Authorization: Bearer TVŮJ_GITHUB_PAT"

# Ověř že funguje:
claude mcp list
# Měl bys vidět "github ✓"
```

Alternativa přes Docker (pokud HTTP nefunguje):
```bash
claude mcp add github \
  -e GITHUB_PERSONAL_ACCESS_TOKEN=TVŮJ_GITHUB_PAT \
  -- docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN \
  ghcr.io/github/github-mcp-server
```

---

## KROK 3: Vytvoř GitHub repo a pushni projekt

V Claude Code (v terminálu v adresáři projektu):
```bash
# Inicializuj git
cd algo-trader
git init
git add .
git commit -m "Initial commit: AlgoTrader architecture"

# Pak řekni Claude Code:
# "Vytvoř nový privátní GitHub repo algo-trader a pushni tam tento kód"
# Claude to udělá přes GitHub MCP automaticky
```

Nebo ručně:
```bash
gh repo create algo-trader --private --source=. --push
# (potřebuješ GitHub CLI: brew install gh)
```

---

## KROK 4: Hetzner VPS + Coolify

### Pokud ještě nemáš VPS:
1. Jdi na https://www.hetzner.com/cloud
2. Vytvoř server: **CPX21** (3 vCPU, 4GB RAM, 80GB) — stačí pro tento projekt
3. OS: **Ubuntu 24.04**
4. Přidej svůj SSH klíč
5. Zapamatuj si IP adresu

### Instalace Coolify:
```bash
ssh root@TVOJE_IP

# Instalace Coolify (one-liner)
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash

# Po instalaci jdi na:
# http://TVOJE_IP:8000
# Vytvoř admin účet
```

### Propojení Coolify s GitHubem:
1. V Coolify UI: **Settings → Sources → Add GitHub App**
2. Sleduj průvodce — vytvoří GitHub App a propojí se s tvým účtem
3. Pak můžeš deployovat přímo z GitHub repo

---

## KROK 5: Docker Compose pro AlgoTrader

Tohle přidej do projektu — Claude Code to pak deployne přes Coolify:

```yaml
# docker-compose.yml (v rootu projektu)
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: algotrader
      POSTGRES_USER: algotrader
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./db/migrations/001_init.sql:/docker-entrypoint-initdb.d/001_init.sql
      - ./db/seeds/default_config.sql:/docker-entrypoint-initdb.d/002_seeds.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U algotrader"]
      interval: 10s
      timeout: 5s
      retries: 5

  n8n:
    image: n8nio/n8n:latest
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=${N8N_USER}
      - N8N_BASIC_AUTH_PASSWORD=${N8N_PASSWORD}
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_PORT=5432
      - DB_POSTGRESDB_DATABASE=n8n
      - DB_POSTGRESDB_USER=algotrader
      - DB_POSTGRESDB_PASSWORD=${POSTGRES_PASSWORD}
      - WEBHOOK_URL=https://n8n.${DOMAIN}
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      postgres:
        condition: service_healthy
    expose:
      - "5678"

volumes:
  pg_data:
  n8n_data:
```

---

## KROK 6: Deploy na Coolify

V Coolify UI:
1. **Projects → New Project** → "AlgoTrader"
2. **New Resource → Application → GitHub App**
3. Vyber repo `algo-trader`
4. Build Pack: **Docker Compose**
5. Compose file: `/docker-compose.yml`
6. Environment variables: nastav `POSTGRES_PASSWORD`, `N8N_USER`, `N8N_PASSWORD`, `DOMAIN`
7. **Deploy**

Nebo přes Coolify API (pro automatizaci z Claude Code):
```bash
# Deploy přes API
curl -X POST "https://coolify.TVOJE_IP.sslip.io/api/v1/deploy" \
  -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"uuid": "TVOJE_APP_UUID"}'
```

---

## KROK 7: CLAUDE.md — instrukce pro Claude Code

Tohle je nejdůležitější soubor. Dej ho do rootu projektu. Claude Code ho automaticky přečte a bude vědět co dělat:

**Soubor už je vytvořený v projektu jako `CLAUDE.md`** — viz další soubor.

---

## KROK 8: Coolify MCP (volitelné — pro deploy z Claude Code)

Pro plnou automatizaci můžeš přidat Coolify jako MCP server:

```bash
# Existuje komunitní Coolify MCP server
npx @coolify/mcp-server --url https://coolify.TVOJE_DOMENA --token TVŮJ_TOKEN

# Nebo jednodušeji — SSH MCP pro přímý přístup k serveru
claude mcp add ssh-server \
  -- npx -y @anthropic-ai/mcp-server-ssh \
  --host TVOJE_IP --user root --key ~/.ssh/id_rsa
```

---

## Finální workflow

Po tomhle setupu řekneš Claude Code:

```
"Vytvoř nový feature branch, implementuj Scanner agenta podle AGENTS.md,
pushni na GitHub a deployni na Coolify."
```

A Claude Code:
1. Přečte CLAUDE.md → ví co je projekt, stack, pravidla
2. Přečte docs/AGENTS.md → ví specifikaci Scanner agenta
3. Napíše kód
4. Pushne přes GitHub MCP
5. Triggerne deploy přes Coolify API nebo SSH

**Celý setup uděláš jednou. Pak už jen pracuješ.**
