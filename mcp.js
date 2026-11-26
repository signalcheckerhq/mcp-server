// Cloudflare Pages Function: the SignalCheckerHQ MCP server at https://signalcheckerhq.org/mcp
// Added 2026-11-26 (Ilona: "do it all" on the marketing research, idea 3). AI assistants (Claude, ChatGPT and others that
// speak the Model Context Protocol) can call our free, read-only checks. Streamable HTTP transport, stateless, JSON
// responses only (no SSE stream, no sessions). Nothing is stored and no account or key is needed.
// Tools: check_signal_call (same engine as the Telegram bot), liquidation_price, position_size, leverage_survival.
import { checkMessage, budgetFetch, ORDER } from "./api/tg.js";
import { makeCore, LABELS } from "./_lib/sccore.js";

const VERSION = "1.0.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  "access-control-expose-headers": "mcp-protocol-version",
};
const NFA = "Past prices, not a forecast. Not financial advice. More free tools: https://signalcheckerhq.org/tools/";
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOLS = [
  {
    name: "check_signal_call",
    title: "Check a crypto signal call after fees",
    description: "Replays a crypto trading signal (a long/short call with entry, stop and targets, as posted in Telegram or Discord) on real exchange prices from the time it was posted, and returns what really happened: whether the entry filled, which targets were hit, whether the stop or liquidation came first, and the result after fees (and on margin when leverage is given). Use it when someone shares a signal and asks if it really won. Covers up to the first 3 calls in the text; calls must be at least 1 hour and at most about 30 days old.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The signal post as written, e.g. 'BTC LONG entry 91500 SL 89800 TP1 93000 TP2 94500 10x'." },
        posted_at: { type: "string", description: "When the call was posted, ISO 8601 (e.g. 2026-11-20T14:00:00Z). Needed unless the text itself contains the date and time." },
        lang: { type: "string", enum: ["en", "es", "ru"], description: "Language of the answer. Default en." },
      },
      required: ["text"],
    },
    annotations: RO,
  },
  {
    name: "liquidation_price",
    title: "Liquidation price and stop check",
    description: "Calculates the liquidation price of an isolated-margin crypto futures position (long or short) from entry price and leverage, the distance to it, and, if a stop-loss is given, whether liquidation would come before the stop and the highest leverage the stop allows. Pure calculation, no market data.",
    inputSchema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["long", "short"] },
        entry: { type: "number", exclusiveMinimum: 0, description: "Entry price." },
        leverage: { type: "number", minimum: 1, maximum: 200 },
        stop: { type: "number", exclusiveMinimum: 0, description: "Optional stop-loss price." },
        maintenance_margin_pct: { type: "number", minimum: 0, maximum: 10, description: "Maintenance margin in percent. Default 0.5." },
      },
      required: ["side", "entry", "leverage"],
    },
    annotations: { ...RO, openWorldHint: false },
  },
  {
    name: "position_size",
    title: "Position size from risk",
    description: "Works out how big a trade can be so that hitting the stop-loss loses only the chosen share of the account, fees included, plus the margin needed at a given leverage and whether liquidation comes before the stop. Pure calculation.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "number", exclusiveMinimum: 0, description: "Account size in USD." },
        risk_pct: { type: "number", exclusiveMinimum: 0, maximum: 100, description: "Share of the account to risk, in percent (e.g. 1)." },
        entry: { type: "number", exclusiveMinimum: 0 },
        stop: { type: "number", exclusiveMinimum: 0 },
        leverage: { type: "number", minimum: 1, maximum: 200, description: "Optional. Default 1." },
        fee_pct: { type: "number", minimum: 0, maximum: 1, description: "Fee per side in percent. Default 0.05." },
      },
      required: ["account", "risk_pct", "entry", "stop"],
    },
    annotations: { ...RO, openWorldHint: false },
  },
  {
    name: "leverage_survival",
    title: "Which leverage survived a coin's normal swings",
    description: "Tests every hour of roughly the last 1,000 hours as an entry on real hourly prices of a coin and reports, for 2x to 100x, the share of entries that would have been liquidated within the holding time by normal price swings (isolated margin), and the highest leverage that 90% and 99% of entries survived. Use it to answer 'what leverage is safe for this coin?' with data.",
    inputSchema: {
      type: "object",
      properties: {
        coin: { type: "string", description: "Ticker, e.g. BTC, ETH, SOL." },
        side: { type: "string", enum: ["long", "short"], description: "Default long." },
        hold_hours: { type: "integer", minimum: 1, maximum: 168, description: "How long the position is held. Default 24." },
        maintenance_margin_pct: { type: "number", minimum: 0, maximum: 5, description: "Default 0.5." },
      },
      required: ["coin"],
    },
    annotations: RO,
  },
];

const n = (v, d = 2) => Number(v).toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 2 : v >= 1 ? 4 : 8, minimumFractionDigits: 0 });
const usd = v => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pc = (v, d = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v * 100).toFixed(d) + "%";
const txt = s => ({ content: [{ type: "text", text: s }] });
const err = s => ({ content: [{ type: "text", text: s }], isError: true });
const fin = v => typeof v === "number" && isFinite(v);

function htmlToText(h) {
  return String(h).replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export function liq(side, entry, lev, mm) { return side === "long" ? entry * (1 - 1 / lev + mm) : entry * (1 + 1 / lev - mm); }

export function liquidationPrice(a) {
  const side = a.side, E = a.entry, L = a.leverage, mm = (fin(a.maintenance_margin_pct) ? a.maintenance_margin_pct : 0.5) / 100;
  if (!(side === "long" || side === "short") || !(fin(E) && E > 0) || !(fin(L) && L >= 1 && L <= 200)) return err("Need side (long/short), entry > 0 and leverage 1–200.");
  const p = liq(side, E, L, mm), dist = Math.abs(p - E) / E, out = [];
  out.push(`${side === "long" ? "Long" : "Short"} ${n(E)} at ${L}x (isolated, ${(mm * 100).toFixed(2)}% maintenance margin):`);
  out.push(1 / L <= mm ? "Liquidation price: at or beyond the entry. This leverage leaves no room at all." : `Liquidation price ≈ ${n(p)} (${pc(side === "long" ? -dist : dist)} from entry).`);
  if (fin(a.stop) && a.stop > 0) {
    const S = a.stop, sd = side === "long" ? (E - S) / E : (S - E) / E;
    if (sd <= 0) out.push(`The stop ${n(S)} is on the wrong side of the entry for a ${side}.`);
    else {
      const first = side === "long" ? p >= S : p <= S;
      const maxL = 1 / (sd + mm);
      out.push(first ? `Liquidation comes BEFORE the stop ${n(S)} (${pc(-sd)} away): the stop would never fire.` : `The stop ${n(S)} (${pc(-sd)} away) comes before liquidation.`);
      out.push(`Highest leverage this stop allows: about ${maxL < 10 ? maxL.toFixed(1) : Math.floor(maxL)}x.`);
    }
  }
  out.push("Exchanges add fees, funding and their own mark price, so real liquidation can come a little earlier. Calculator: https://signalcheckerhq.org/liquidation-calculator/");
  return txt(out.join("\n"));
}

export function positionSize(a) {
  const A = a.account, r = a.risk_pct / 100, E = a.entry, S = a.stop, L = fin(a.leverage) ? a.leverage : 1, f = (fin(a.fee_pct) ? a.fee_pct : 0.05) / 100;
  if (![A, r, E, S].every(v => fin(v) && v > 0) || E === S || !(L >= 1 && L <= 200) || r > 1) return err("Need account, risk_pct, entry and stop > 0, entry ≠ stop, leverage 1–200.");
  const side = S < E ? "long" : "short", sd = Math.abs(E - S) / E, risk = A * r;
  const lossPerUnit = sd + 2 * f;                     // stop distance plus fees on the way in and out
  const size = risk / lossPerUnit, units = size / E, margin = size / L;
  const out = [`${side === "long" ? "Long" : "Short"}: entry ${n(E)}, stop ${n(S)} (${(sd * 100).toFixed(2)}% away), risking ${(r * 100).toFixed(2)}% of ${usd(A)} = ${usd(risk)}.`,
    `Position size ≈ ${usd(size)} (${n(units)} coins). Fees of ${(f * 100).toFixed(3)}% per side are included in the loss at the stop.`,
    `Margin needed at ${L}x: ${usd(margin)}${margin > A ? " — more than the whole account, so this risk is not possible at this leverage." : "."}`];
  if (L > 1) {
    const p = liq(side, E, L, 0.005), before = side === "long" ? p >= S : p <= S;
    out.push(before ? `Warning: at ${L}x liquidation (≈ ${n(p)}) comes before the stop. Use at most about ${Math.floor(1 / (sd + 0.005))}x.` : `At ${L}x liquidation (≈ ${n(p)}) is beyond the stop. Leverage changes the margin, not the risk.`);
  }
  out.push("Calculator: https://signalcheckerhq.org/position-size-calculator/");
  return txt(out.join("\n"));
}

export async function leverageSurvival(a, nowMs = Date.now()) {
  const coin = String(a.coin || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(USDT|USDC|USD|PERP)$/, "").slice(0, 12);
  const lng = (a.side || "long") !== "short", H = Number.isInteger(a.hold_hours) ? a.hold_hours : 24, mm = (fin(a.maintenance_margin_pct) ? a.maintenance_margin_pct : 0.5) / 100;
  if (!coin || !(H >= 1 && H <= 168) || !(mm >= 0 && mm <= 0.05)) return err("Need a coin ticker, hold_hours 1–168 and maintenance_margin_pct 0–5.");
  const end = Math.floor(nowMs / 3600e3) * 3600e3, start = end - (1000 + H + 2) * 3600e3;
  const core = makeCore(LABELS.en, { order: ORDER, fetch: budgetFetch(12, nowMs) });
  let cs;
  try { cs = (await core.candles(coin, start, end)).filter(c => c[0] * 1000 < end); } catch (e) { return err(`No hourly prices found for ${coin} on Coinbase, Gate.io or Binance.`); }
  const E = Math.min(1000, cs.length - H);
  if (E < 50) return err(`Not enough hourly prices for ${coin}.`);
  const off = cs.length - H - E, w = [];
  for (let i = 0; i < E; i++) {
    const e = cs[off + i][4]; let m = 0;
    for (let k = 1; k <= H; k++) { const b = cs[off + i + k]; const mv = lng ? (e - b[1]) / e : (b[2] - e) / e; if (mv > m) m = mv; }
    w.push(m);
  }
  const share = L => { const d = 1 / L - mm; let c = 0; for (const x of w) if (d <= 0 || x >= d) c++; return c / w.length; };
  const s = w.slice().sort((x, y) => x - y), q = p => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  const safe = p => { const x = 1 / (q(p) + mm); return x < 10 ? x.toFixed(1) + "x" : Math.floor(x) + "x"; };
  const from = new Date(cs[off][0] * 1000).toISOString().slice(0, 10), to = new Date(cs[cs.length - 1][0] * 1000).toISOString().slice(0, 10);
  const rows = [2, 3, 5, 10, 20, 25, 50, 75, 100].map(L => `${String(L).padStart(3)}x: ${(share(L) * 100).toFixed(1).padStart(5)}% of entries liquidated`);
  return txt([`${coin} ${lng ? "long" : "short"}, held ${H}h, ${E} hourly entries from ${from} to ${to} (source: ${({ cb: "Coinbase", gt: "Gate.io", bn: "Binance" })[core.src(coin)] || "exchange"}; isolated margin, ${(mm * 100).toFixed(2)}% maintenance margin):`,
    ...rows,
    `Highest leverage that 90% of entries survived: ${safe(0.9)}; 99% of entries: ${safe(0.99)}.`,
    "Fees and funding not included. Interactive version: https://signalcheckerhq.org/leverage-survival-calculator/", NFA].join("\n"));
}

export async function checkSignal(a, nowMs = Date.now()) {
  const text = typeof a.text === "string" ? a.text.slice(0, 5000) : "";
  if (!text.trim()) return err("Need the signal text.");
  let posted = null;
  if (a.posted_at) { posted = Date.parse(a.posted_at); if (!isFinite(posted)) return err("posted_at must be an ISO 8601 date and time, e.g. 2026-11-20T14:00:00Z."); }
  const lang = ["en", "es", "ru"].includes(a.lang) ? a.lang : "en";
  const r = await checkMessage(text, posted, lang, nowMs);
  let t = htmlToText(r.html); const cut = t.indexOf("\n\n" + t.split("\n").find(x => x.includes("utm_source=telegram")));
  if (cut > 0) t = t.slice(0, cut);
  return txt(t + "\n\nCheck more calls or a whole channel: https://signalcheckerhq.org/signal-checker-demo/?utm_source=mcp\nPast prices, not a forecast. Not financial advice.");
}

export async function callTool(name, args, nowMs) {
  args = args && typeof args === "object" ? args : {};
  if (name === "liquidation_price") return liquidationPrice(args);
  if (name === "position_size") return positionSize(args);
  if (name === "leverage_survival") return leverageSurvival(args, nowMs);
  if (name === "check_signal_call") return checkSignal(args, nowMs);
  return null;
}

const INSTRUCTIONS = "SignalCheckerHQ checks crypto trading claims on real prices with fees counted. Use check_signal_call when a user shares a signal post and asks whether it really won; liquidation_price and position_size for planning a leveraged trade; leverage_survival to show how often each leverage was liquidated on a coin's real hourly prices. All tools are free and read-only. Results are about past prices, not forecasts or advice.";

export async function handleRpc(m, nowMs = Date.now()) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return { jsonrpc: "2.0", id: m && m.id !== undefined ? m.id : null, error: { code: -32600, message: "Invalid Request" } };
  const id = m.id, isNote = id === undefined || id === null;
  const ok = result => (isNote ? null : { jsonrpc: "2.0", id, result });
  const bad = (code, message) => (isNote ? null : { jsonrpc: "2.0", id, error: { code, message } });
  const p = m.params || {};
  switch (m.method) {
    case "initialize": {
      const v = PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0];
      return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "signalcheckerhq", title: "SignalCheckerHQ", version: VERSION, websiteUrl: "https://signalcheckerhq.org/mcp-server/" }, instructions: INSTRUCTIONS });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      if (!TOOLS.some(t => t.name === p.name)) return bad(-32602, "Unknown tool: " + p.name);
      try { return ok(await callTool(p.name, p.arguments, nowMs)); }
      catch (e) { return ok(err("The check failed: " + (e && e.message || "error") + ". Try again in a minute.")); }
    }
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
    default:
      if (m.method.startsWith("notifications/")) return null;
      return bad(-32601, "Method not found: " + m.method);
  }
}

const J = (o, status = 200, extra = {}) => new Response(o === null ? null : JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra } });

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request }) {
  // No server-to-client stream: MCP clients get 405 here, as the spec allows. People who open the address get the info page.
  if ((request.headers.get("accept") || "").includes("text/event-stream")) return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", ...CORS } });
  return Response.redirect(new URL("/mcp-server/", request.url).toString(), 302);
}

export async function onRequestPost({ request }) {
  let body;
  try { body = await request.json(); } catch (e) { return J({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(body)) {
    if (!body.length || body.length > 10) return J({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
    const out = (await Promise.all(body.map(x => handleRpc(x)))).filter(Boolean);
    return out.length ? J(out) : new Response(null, { status: 202, headers: CORS });
  }
  const r = await handleRpc(body);
  return r ? J(r) : new Response(null, { status: 202, headers: CORS });
}
