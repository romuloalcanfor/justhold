-- Análise do mercado da home, em português e inglês. Escrita pelo Claude quando o dono pede e
-- publicada por scripts/analise.mjs.
CREATE TABLE analyses (
  id TEXT PRIMARY KEY,         -- 'AAAA-MM-DD-<slot>' (dia em Brasília)
  slot TEXT NOT NULL,          -- 'manha' | 'tarde' | 'fechamento'
  day TEXT NOT NULL,           -- dia em Brasília, AAAA-MM-DD
  created_at INTEGER NOT NULL,
  data TEXT NOT NULL,          -- JSON { pt, en, sources, market }
  model TEXT,
  usage TEXT                   -- reservado (custo, se um dia for gerada por API)
);
CREATE INDEX analyses_created ON analyses(created_at);

-- Carteiras demo (investimento de teste) de quem tem conta: uma linha por usuário, com a
-- lista inteira em JSON. Quem não tem conta guarda só no navegador.
CREATE TABLE demo_wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
