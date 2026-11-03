# JustHold

**Gráfico de cripto ao vivo, no estilo TradingView, grátis. Login opcional para levar suas configurações junto.**
*Live crypto charts, TradingView-style, free and open source.*

[![Site](https://img.shields.io/badge/no%20ar-justhold.ai-2962ff)](https://justhold.ai)
[![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-089981)](LICENSE)
[![Sem build](https://img.shields.io/badge/HTML%20%2B%20JS-sem%20build-f7df1e)](public/)

**👉 [Abrir o gráfico: justhold.ai/grafico](https://justhold.ai/grafico/)**

![JustHold: gráfico BTCBRL diário com médias móveis e watchlist](.github/assets/screenshot.png)

## Por que existe

Eu usava o TradingView todo dia, mas só alguns recursos dele. A assinatura venceu e eu montei
o meu próprio gráfico: os mesmos indicadores que eu uso, com dados públicos da Binance, sem
anúncio e sem pagar nada.

## O que tem

- **Candles ao vivo** pelo WebSocket da Binance, com contagem regressiva até o fechamento da vela
- **Tempos gráficos** de 1m, 5m, 15m, 1h, 4h, D, W e M, e atalhos de período (1D, 5D, 1M, 3M, 6M, YTD, 1A, 5A, Todos)
- **Médias móveis**: SMA 50 que muda de cor conforme a direção, e SMA 200 / SMA 50 do semanal sobrepostas em qualquer tempo gráfico
- **Watchlist** com pares em BRL e USDT, variação do dia e desempenho (1W, 1M, 3M, 6M, YTD, 1A). Dá para reordenar arrastando
- **Ferramentas**: régua (Shift + clique) com variação de preço e de tempo, e linhas horizontais (Alt + H)
- **Escala logarítmica**, autoescala e histórico infinito ao arrastar para a esquerda
- **Busca** de qualquer par listado na Binance
- Suas preferências ficam salvas no navegador e, se você criar uma conta (e-mail e senha), também na conta: watchlist, médias, linhas e layout aparecem iguais em qualquer computador
- **Homepage** com um tabuleiro de xadrez 3D que joga sozinho a Partida da Ópera (Morphy, 1858)

## Como funciona

HTML, CSS e JavaScript puro, **sem build e sem dependências de npm**. Os gráficos usam o
[Lightweight Charts](https://github.com/tradingview/lightweight-charts) (TradingView, Apache 2.0),
o tabuleiro da homepage usa o [three.js](https://threejs.org) (MIT) e os dados de mercado vêm direto
da [API pública da Binance](https://developers.binance.com/docs/binance-spot-api-docs) para o navegador.
O site é publicado na Cloudflare: um Worker serve as páginas e a API de contas, e as contas e
preferências ficam num banco D1.

```
public/                  # o site
├── index.html           # homepage
├── site.css
├── js/
│   ├── xadrez.js        # tabuleiro 3D animado
│   └── conta.js         # cliente da API de contas
├── entrar/index.html    # login e cadastro
├── grafico/             # o gráfico
│   ├── index.html
│   ├── styles.css
│   ├── js/
│   │   ├── app.js         # interface, watchlist, ferramentas e sincronização com a conta
│   │   ├── api.js         # REST e WebSocket da Binance
│   │   ├── indicators.js  # médias móveis
│   │   └── ruler.js       # régua de medição
│   └── vendor/lightweight-charts.js
└── vendor/              # three.js
src/worker.js            # API: cadastro, login (senha com PBKDF2), sessão por cookie e preferências
migrations/              # tabelas do banco D1
```

## Rodar local

```bash
git clone https://github.com/romuloalcanfor/justhold.git
cd justhold
npx wrangler d1 migrations apply justhold --local
npx wrangler dev --port 5174
```

Abra http://localhost:5174 (o gráfico fica em http://localhost:5174/grafico/)

## Publicar

```bash
npx wrangler d1 migrations apply justhold --remote
npx wrangler deploy
```

## Próximos passos

- [ ] Mais indicadores (EMA, RSI, Bollinger)
- [ ] Alertas de preço
- [ ] Outros ativos além de cripto
- [ ] Bot que executa regras objetivas de trade, com backtest antes de usar dinheiro real

Ideias e bugs são bem-vindos nas [issues](https://github.com/romuloalcanfor/justhold/issues).

## Apoie

Se o JustHold te ajuda, deixe uma ⭐ aqui no repositório. Isso ajuda outras pessoas a encontrarem o projeto.

## Aviso

O JustHold mostra dados públicos de mercado e **não é recomendação de investimento**.

## Licença

[MIT](LICENSE) © Rômulo Alcanfor
