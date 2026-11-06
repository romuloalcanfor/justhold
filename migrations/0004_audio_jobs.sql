-- Trava da geração de voz: a primeira pessoa que aperta "Ouvir" numa análise reserva a vez e
-- o Worker chama a voz do Grok uma única vez; quem chega junto espera o arquivo ficar pronto.
CREATE TABLE audio_jobs (
  key TEXT PRIMARY KEY,        -- 'analises/<id>-<pt|en>.mp3'
  started_at INTEGER NOT NULL
);
