# Risk Management — Pravidla

## Hierarchie pravidel

```
SYSTÉM STOP (nejvyšší priorita)
  │
  ▼
MĚSÍČNÍ DRAWDOWN LIMIT
  │
  ▼
DENNÍ LOSS LIMIT
  │
  ▼
PER-TRADE PRAVIDLA
  │
  ▼
COOLDOWN PRAVIDLA
```

## Systém Stop

Systém se automaticky zastaví a odmítá VŠECHNY obchody když:

1. Měsíční drawdown překročí 6% — STOP do konce měsíce
2. Kapitál klesne pod $50 — STOP dokud se manuálně nedoplní
3. Uživatel zadá `/stop` — STOP dokud nezadá `/start`

Obnovení: automaticky 1. den nového měsíce (pravidlo 1), manuálně (pravidlo 2, 3).

## Per-Trade pravidla

| Pravidlo | Limit | Příklad ($1000 kapitál) |
|---|---|---|
| Max risk per trade | 2% | Max ztráta $20 na obchod |
| Max position size | 45% | Max $450 v jedné pozici |
| Max open positions | 3 | Souběžně |
| Min R:R ratio | 1.5:1 | Pokud spočitatelné |
| Price freshness | 30 min | Signál starší 30 min = expired |
| Price deviation | 1% | Cena se nesmí pohnout víc než 1% od analýzy |

## Cooldown pravidla

| Pravidlo | Podmínka | Akce |
|---|---|---|
| Post-loss cooldown | Po každé ztrátě | Čekej 4 hodiny |
| Consecutive losses | 4 ztráty za sebou | Pauza 24 hodin |

## Denní limit

Max denní ztráta: 4% kapitálu ($40 při $1000). Po dosažení se systém vypne do půlnoci UTC.

## Měsíční drawdown

Max měsíční drawdown: 6% počátečního měsíčního kapitálu. Po dosažení se systém vypne do 1. dne dalšího měsíce.

```
Příklad:
Měsíční start: $1000
Max loss: $60
Po dosažení $940 → SYSTÉM STOP
```

## Pravidlo korelace

Neotevírat 2 pozice na stejném coinu. Neotevírat 2 long pozice na vysoce korelovaných coinech (zjednodušeně: max 2 long pozice současně).

## Kdo co kontroluje

| Kontrola | Provádí | Kdy |
|---|---|---|
| Per-trade risk | Risk Controller agent | Před každým obchodem |
| Trailing stop | Monitor workflow | Každých 15 minut |
| Denní reset | Daily Reset workflow | Půlnoc UTC |
| Měsíční reset | Monthly Reset workflow | 1. den měsíce |
| Systém stop | Risk Controller | Kontinuálně |
| Manuální stop | Telegram Handler | Na příkaz uživatele |

## Fail-Safe principy

1. Pokud DB není dostupná → REJECT ALL
2. Pokud Binance API selže → NEEXEKUOVAT, notifikovat
3. Pokud cokoliv nejasné → REJECT (nikdy default approve)
4. Monitor workflow nemeže stop zpět — stop se posouvá JEN ve směru zisku
5. Risk Controller má VETO právo — žádný jiný agent ho nemůže overridnout
