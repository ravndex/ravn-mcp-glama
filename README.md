# ravn-mcp-glama

[![ravn-mcp-glama MCP server](https://glama.ai/mcp/servers/ravndex/ravn-mcp-glama/badges/score.svg)](https://glama.ai/mcp/servers/ravndex/ravn-mcp-glama)

Local/stdio MCP server for [RAVN](https://ravn.exchange) — cross-chain swap execution
across 12 venues and 16 chains, including **native (non-wrapped) Bitcoin** as either
source or destination. No signup, no API key, 0% protocol fee.

**This is a secondary distribution channel.** RAVN's primary MCP server is hosted and
needs no install at all:

```json
{
  "mcpServers": {
    "ravn": {
      "type": "streamable-http",
      "url": "https://app.ravn.exchange/api/mcp"
    }
  }
}
```

This package exists for clients and directories that need to build and run an MCP server
from source rather than connect to a remote URL — it's a thin client over the same public
REST API ([`docs.ravn.exchange`](https://docs.ravn.exchange),
[`openapi.json`](https://app.ravn.exchange/openapi.json)) any integrator already calls.
Every tool call here makes a real HTTP request to production. There is no separate logic,
no internal RAVN code, and nothing here that isn't already public.

## Install

```bash
git clone https://github.com/ravndex/ravn-mcp-glama
cd ravn-mcp-glama
npm install
npm run build
```

```json
{
  "mcpServers": {
    "ravn": {
      "command": "node",
      "args": ["/path/to/ravn-mcp-glama/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `ravn_quote` | Best-priced route across all 12 venues for a given pair/amount |
| `ravn_execute` | Turn a quote into a signable transaction, typed data, or a deposit address |
| `ravn_status` | Normalized swap status (pending → processing → success) |
| `ravn_health` | Which venues are live right now |
| `ravn_btc_prepare_send` | Builds a ready-to-sign PSBT for a Bitcoin-source deposit — runs entirely locally against [mempool.space](https://mempool.space)'s public API, no RAVN server involved |

## Custody

RAVN never holds funds and this server never asks for a private key. `ravn_execute`
returns a payload for **you** to sign — a transaction to broadcast, typed data to sign, or
a deposit address to send to.

## Links

- Docs: <https://docs.ravn.exchange>
- Hosted MCP server (no install): `https://app.ravn.exchange/api/mcp`
- Examples: <https://github.com/ravndex/ravn-examples>
- App: <https://app.ravn.exchange>

MIT licensed.
