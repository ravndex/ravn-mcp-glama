#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { prepareBtcSend } from "./btc-prepare-send.js";

/**
 * Local/stdio MCP server for RAVN — a thin client over the same public REST API
 * (https://app.ravn.exchange/api/v1) any integrator already calls, documented at
 * https://docs.ravn.exchange and https://app.ravn.exchange/openapi.json.
 *
 * RAVN's primary MCP distribution is the hosted, zero-install remote server at
 * https://app.ravn.exchange/api/mcp — point any MCP client at that URL directly and skip
 * this package entirely. This one exists as a second, local/stdio distribution channel for
 * clients or directories (Glama) that need to clone, build, and run an MCP server from
 * source rather than connect to a remote URL. Every tool call here makes a real HTTP
 * request to the same production API — no separate logic, no internal RAVN code, nothing
 * beyond what any external integrator can already see.
 */

const RAVN_API_BASE = "https://app.ravn.exchange/api/v1";

const chainIdField = z.number().int().describe("Numeric chain id, e.g. 1=Ethereum, 8453=Base, -1=Bitcoin, -2=Solana — see ravn_health for the live venue list");
const tokenField = z.string().describe("Token contract address, or 0xEeeeeEeeeEeEeeEeEeEeeeEEeeeeEeeeeeeeEEeE for the chain's native coin");
const apiKeyField = z.string().optional().describe("Your RAVN API key, if you have one — raises your rate limit (see https://docs.ravn.exchange/tools/get-api-key)");

const quoteInputSchema = {
  inputChainId: chainIdField,
  outputChainId: chainIdField,
  inputToken: tokenField,
  outputToken: tokenField,
  inputAmount: z.string().describe("Positive integer string, in the input token's smallest unit (no decimals)"),
  userAddress: z.string().describe("Address the input asset will be sent from"),
  destinationAddress: z.string().optional().describe("Where output should land, if different from userAddress"),
  refundAddress: z.string().optional().describe("Where to refund the input asset if the swap fails — defaults to userAddress"),
  slippageBps: z.number().int().min(1).max(5000).optional().describe("Max acceptable slippage in basis points"),
  rankingMode: z.enum(["best_output", "fastest"]).optional().describe("best_output (default) picks the highest net output; fastest picks the quickest-settling quote within slippageBps"),
  apiKey: apiKeyField,
};

const executeInputSchema = {
  quoteToken: z.string().describe("The quoteToken returned by ravn_quote"),
  destinationAddress: z.string().optional().describe("Late-bound output recipient, for venues that need it at execution time rather than quote time"),
  refundAddress: z.string().optional().describe("Late-bound refund recipient if the swap fails"),
  apiKey: apiKeyField,
};

const statusInputSchema = {
  quoteToken: z.string().describe("The quoteToken from ravn_quote — the venue is decoded from it"),
  ref: z.string().describe("deposit address (DEPOSIT venues) or statusRef (SIGNATURE venues) from ravn_execute"),
  apiKey: apiKeyField,
};

const btcPrepareSendInputSchema = {
  fromAddress: z.string().describe("Your Bitcoin address holding the UTXOs to spend — native SegWit (bc1q…) or Taproot (bc1p…) only"),
  toAddress: z.string().describe("depositAddress from ravn_execute"),
  amountSats: z.string().describe("depositAmount from ravn_execute, in satoshis"),
  feeRateSatsPerVb: z.number().positive().optional().describe("Omit to use mempool.space's current halfHourFee estimate"),
  network: z.enum(["mainnet", "testnet"]).optional().describe("Defaults to mainnet"),
};

async function callRavn(path: string, init: { method: "GET" | "POST"; body?: unknown; apiKey?: string; query?: Record<string, string> }) {
  const url = new URL(`${RAVN_API_BASE}${path}`);
  if (init.query) for (const [k, v] of Object.entries(init.query)) url.searchParams.set(k, v);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.apiKey) headers["x-api-key"] = init.apiKey;

  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json();
  return { content: [{ type: "text" as const, text: JSON.stringify(json) }], structuredContent: json };
}

const server = new McpServer({
  name: "ravn",
  title: "RAVN",
  version: "1.0.0",
  description:
    "Cross-chain swap execution across 12 venues and 16 chains, including native " +
    "(non-wrapped) Bitcoin as either source or destination. No signup, no API key, 0% " +
    "protocol fee. This package is a local/stdio client over RAVN's public REST API — " +
    "for zero-install, point any MCP client at the hosted server instead: " +
    "https://app.ravn.exchange/api/mcp",
  websiteUrl: "https://ravn.exchange",
});

server.registerTool(
  "ravn_quote",
  {
    title: "Get a RAVN swap quote",
    description:
      "Get a swap quote from RAVN — same-chain or cross-chain, across 16 chains including native (non-wrapped) Bitcoin and Solana as source or destination. Free, no API key or payment required. Returns a quoteToken; pass it to ravn_execute to get a signable/broadcastable execution payload.",
    inputSchema: quoteInputSchema,
    annotations: { title: "Get a RAVN swap quote", readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const { apiKey, ...body } = args;
    return callRavn("/quote", { method: "POST", body, apiKey });
  }
);

server.registerTool(
  "ravn_execute",
  {
    title: "Execute a RAVN swap quote",
    description:
      "Turn a quoteToken from ravn_quote into an execution payload. Returns one of three shapes (executionType): TRANSACTION (sign and broadcast yourself), SIGNATURE (sign, RAVN submits), or DEPOSIT (send the input asset to a given address). RAVN never takes custody of funds — you always sign or send from your own wallet. TRANSACTION and SIGNATURE may also include an `approval` — an ERC-20 approve() you must broadcast and wait to be MINED before the transaction/signature, or it fails (reverts on TRANSACTION; on SIGNATURE the order is accepted and silently never fills). Only present when the sold token needs it — omitted for native-coin sells and already-approved tokens.",
    inputSchema: executeInputSchema,
    annotations: { title: "Execute a RAVN swap quote", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => {
    const { apiKey, ...body } = args;
    return callRavn("/execute", { method: "POST", body, apiKey });
  }
);

server.registerTool(
  "ravn_status",
  {
    title: "Check RAVN swap status",
    description:
      "Poll the status of a swap by its quoteToken and the ref returned by ravn_execute (deposit address for DEPOSIT venues, statusRef for SIGNATURE venues). Status is authoritative where the venue exposes it; some venues (Rift, Jupiter, Bebop, 0x Gasless) report 'unknown' honestly rather than guessing.",
    inputSchema: statusInputSchema,
    annotations: { title: "Check RAVN swap status", readOnlyHint: true, openWorldHint: true },
  },
  async ({ quoteToken, ref, apiKey }) => {
    return callRavn("/status", { method: "GET", apiKey, query: { quoteToken, ref } });
  }
);

server.registerTool(
  "ravn_health",
  {
    title: "Check RAVN venue health",
    description: "Liveness check across every venue RAVN routes through — call before a swap if you want to know whether a route is degraded ahead of time.",
    inputSchema: {},
    annotations: { title: "Check RAVN venue health", readOnlyHint: true, openWorldHint: true },
  },
  async () => callRavn("/health", { method: "GET" })
);

server.registerTool(
  "ravn_btc_prepare_send",
  {
    title: "Prepare a signable Bitcoin transaction for a RAVN DEPOSIT",
    description:
      "Turns a DEPOSIT-type ravn_execute result (depositAddress + depositAmount) into a ready-to-sign PSBT, so you don't have to write your own UTXO selection and fee-estimation code. Fetches your UTXOs and the current network fee rate from mempool.space (public, no auth). RAVN never sees or touches a private key — sign the returned PSBT with your own wallet and broadcast it yourself. Only one signer is ever needed (unlike PSBT flows that require coordinating signatures across multiple UTXO-holding wallets), because every RAVN BTC-source venue resolves to a plain single-recipient payment. Runs entirely locally against mempool.space — no RAVN server involved.",
    inputSchema: btcPrepareSendInputSchema,
    annotations: { title: "Prepare a signable Bitcoin transaction for a RAVN DEPOSIT", readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    const result = await prepareBtcSend(args);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
