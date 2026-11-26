# SignalCheckerHQ MCP server

Free, read-only remote [MCP](https://modelcontextprotocol.io) server that lets AI assistants check crypto trading claims on real prices, with fees counted.

**Server URL:** `https://signalcheckerhq.org/mcp` (Streamable HTTP, no API key, no sign-up, nothing stored)

More: https://signalcheckerhq.org/mcp-server/

## Tools

| Tool | What it does |
|---|---|
| `check_signal_call` | Replays a crypto signal post (entry, stop, targets, leverage) on real exchange prices from the time it was posted: did the entry fill, which targets hit, stop or liquidation first, result after fees and on margin. |
| `liquidation_price` | Liquidation price of an isolated-margin long or short, whether it comes before your stop, and the highest leverage your stop allows. |
| `position_size` | Position size so the stop loses only the chosen share of the account (fees included), margin needed, liquidation vs stop. |
| `leverage_survival` | For a coin: share of the last ~1,000 hourly entries that 2x–100x would have lost to liquidation within the holding time, and the leverage 90% / 99% of entries survived. |

All tools are annotated `readOnlyHint: true`.

## Add it

**Claude** (claude.ai or desktop): Settings → Connectors → Add custom connector → paste `https://signalcheckerhq.org/mcp`.

**ChatGPT**: where custom connectors are available (developer mode), add a connector with the same URL.

**Cursor / VS Code / Windsurf / other clients:**

```json
{
  "mcpServers": {
    "signalcheckerhq": { "url": "https://signalcheckerhq.org/mcp" }
  }
}
```

Clients that only speak stdio can use a bridge such as `npx mcp-remote https://signalcheckerhq.org/mcp`.

## Try it with curl

```bash
curl -s https://signalcheckerhq.org/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"liquidation_price","arguments":{"side":"long","entry":90000,"leverage":20,"stop":87000}}}'
```

## Example prompts

- "Did this signal really win? ETH SHORT 3450, SL 3520, TP 3300, 20x, posted Nov 20 at 14:00 UTC"
- "What leverage is safe on SOL if I hold for 2 days?"
- "I have $2,000 and risk 1%. Entry 91,000, stop 89,500. How big should the position be at 5x?"

## Rules and limits

- Prices: public hourly (and 1-minute where available) data from Gate.io, Coinbase and Binance.
- Liquidation: isolated margin, 0.5% maintenance margin by default. Exchanges add fees, funding and mark price, so real liquidation can come a little earlier.
- Signal calls: 1 hour to ~30 days old; up to 3 calls per request. When a stop and a target fall in the same candle and finer data is missing, the stop counts first. Full counting rules: https://signalcheckerhq.org/how-we-count/
- Results are about past prices. Not forecasts, not signals, not financial advice.

## About

Built by [SignalCheckerHQ](https://signalcheckerhq.org): free tools and open-source [TradingView scripts](https://github.com/signalcheckerhq/tradingview-scripts) that check crypto signals and bots on real prices. Contact: support@signalcheckerhq.org

`mcp.js` is the Cloudflare Pages Function that runs the server, for reference (it imports the site's signal-check engine, which is not included here).

License of this README and the tool descriptions: MIT.
