-- Bot simulado: segue as regras das médias no BTC/USDT diário e anota o que faria,
-- sem mandar ordem nenhuma para a corretora.

-- Carteira virtual de cada regra (uma linha por regra).
CREATE TABLE bot_strategies (
  id TEXT PRIMARY KEY,         -- 'so50', 'm50_110', 'hold'
  pos INTEGER NOT NULL,        -- 1 comprado, 0 de fora
  usdt REAL NOT NULL,
  btc REAL NOT NULL,
  started_on TEXT NOT NULL,    -- candle diário (UTC, AAAA-MM-DD) em que a simulação começou
  last_day TEXT NOT NULL       -- último candle diário fechado já processado
);

-- Compras e vendas que cada regra teria feito.
CREATE TABLE bot_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  day TEXT NOT NULL,
  side TEXT NOT NULL,          -- 'buy' | 'sell'
  price REAL NOT NULL,
  qty REAL NOT NULL,
  fee REAL NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX bot_trades_day ON bot_trades(day);

-- Fotografia de cada dia: preço, médias, valor das carteiras e alertas de contexto.
CREATE TABLE bot_days (
  day TEXT PRIMARY KEY,
  close REAL NOT NULL,
  sma50 REAL,
  sma110 REAL,
  equity TEXT NOT NULL,        -- JSON { so50: { pos, value }, ... }
  context TEXT,                -- JSON com Fed, sentimento, futuros, notícias e alertas
  message TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
