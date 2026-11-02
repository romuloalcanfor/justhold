# JustHold

Gráfico de cripto ao vivo no estilo TradingView, com dados públicos da Binance.
No ar em https://justhold.ai

- `grafico/`: o site (HTML/CSS/JS puro, sem build). Gráficos com [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (TradingView, Apache 2.0).
- `wrangler.jsonc`: publicação na Cloudflare (Workers + assets).

## Rodar local

```bash
python3 -m http.server 5173 --directory grafico
```

Abrir http://localhost:5173

## Publicar

```bash
npx wrangler deploy
```
