#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import https from "https";

const API_BASE = "api.sheetlink.app";
const API_KEY = process.env.SHEETLINK_API_KEY;

if (!API_KEY) {
  console.error("Error: SHEETLINK_API_KEY environment variable is required");
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function apiFetch(path: string, options: { method?: string; body?: string } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyData = options.body ?? null;
    const reqOptions: https.RequestOptions = {
      hostname: API_BASE,
      path,
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        ...(bodyData ? { "Content-Length": Buffer.byteLength(bodyData) } : {}),
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`SheetLink API error ${res.statusCode}: ${data}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`Failed to parse response: ${data}`)); }
        }
      });
    });

    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ── Tool handlers ────────────────────────────────────────────────────────────

async function listAccounts() {
  const data = await apiFetch("/api/items");
  const items = (data.items ?? []) as Array<Record<string, unknown>>;

  if (!items.length) {
    return "No bank accounts connected. Visit sheetlink.app to connect a bank.";
  }

  // Full-column JSON: every field /api/items returns per connection, including the nested accounts
  // list (account_id, name, mask, type, subtype, balances), nicknames, and the sync exclude set.
  return JSON.stringify({ count: items.length, items }, null, 2);
}

async function listTransactions(args: {
  item_id?: string;
  account_id?: string;
  start_date?: string;
  end_date?: string;
  category?: string;
  limit?: number;
}) {
  // Get items to sync
  const itemsData = await apiFetch("/api/items");
  const items = itemsData.items as Array<{ item_id: string; institution_name: string }>;

  if (!items.length) {
    return "No bank accounts connected.";
  }

  const targetItems = args.item_id
    ? items.filter((i) => i.item_id === args.item_id)
    : items;

  if (!targetItems.length) {
    return `No item found with item_id: ${args.item_id}`;
  }

  // Sync each item and collect transactions
  let allTransactions: Array<Record<string, unknown>> = [];

  for (const item of targetItems) {
    const syncData = await apiFetch("/api/sync", {
      method: "POST",
      body: JSON.stringify({ item_id: item.item_id }),
    });
    allTransactions.push(...(syncData.transactions ?? []));
  }

  // Filter by specific account within the bank(s)
  if (args.account_id) {
    allTransactions = allTransactions.filter((t) => t.account_id === args.account_id);
  }

  // Filter by date range
  if (args.start_date) {
    allTransactions = allTransactions.filter(
      (t) => (t.date as string) >= args.start_date!
    );
  }
  if (args.end_date) {
    allTransactions = allTransactions.filter(
      (t) => (t.date as string) <= args.end_date!
    );
  }

  // Filter by category
  if (args.category) {
    const cat = args.category.toUpperCase();
    allTransactions = allTransactions.filter((t) => {
      const pfc = t.personal_finance_category as { primary?: string; detailed?: string } | null;
      return (
        (pfc?.primary ?? "").toUpperCase().includes(cat) ||
        (pfc?.detailed ?? "").toUpperCase().includes(cat)
      );
    });
  }

  // Sort newest first
  allTransactions.sort((a, b) =>
    (b.date as string).localeCompare(a.date as string)
  );

  // Apply limit
  const limit = args.limit ?? 100;
  const truncated = allTransactions.length > limit;
  const transactions = allTransactions.slice(0, limit);

  if (!transactions.length) {
    return "No transactions found matching the given filters.";
  }

  // Full-column JSON: return every transaction field the backend provides (amount, dates, merchant,
  // category, payment channel, location, etc.) so Claude can answer any question, not just the
  // trimmed date/merchant/amount view.
  return JSON.stringify(
    { count: transactions.length, total: allTransactions.length, truncated, transactions },
    null,
    2
  );
}

async function getSpendingSummary(args: {
  item_id?: string;
  account_id?: string;
  start_date?: string;
  end_date?: string;
  group_by?: "category" | "merchant";
}) {
  const itemsData = await apiFetch("/api/items");
  const items = itemsData.items as Array<{ item_id: string }>;

  if (!items.length) return "No bank accounts connected.";

  const targetItems = args.item_id
    ? items.filter((i) => i.item_id === args.item_id)
    : items;

  let allTransactions: Array<Record<string, unknown>> = [];

  for (const item of targetItems) {
    const syncData = await apiFetch("/api/sync", {
      method: "POST",
      body: JSON.stringify({ item_id: item.item_id }),
    });
    allTransactions.push(...(syncData.transactions ?? []));
  }

  // Filter by specific account
  if (args.account_id) {
    allTransactions = allTransactions.filter((t) => t.account_id === args.account_id);
  }

  // Filter by date range
  if (args.start_date) {
    allTransactions = allTransactions.filter(
      (t) => (t.date as string) >= args.start_date!
    );
  }
  if (args.end_date) {
    allTransactions = allTransactions.filter(
      (t) => (t.date as string) <= args.end_date!
    );
  }

  if (!allTransactions.length) {
    return "No transactions found in the given date range.";
  }

  // Group and sum
  const groupBy = args.group_by ?? "category";
  const totals: Record<string, number> = {};

  for (const t of allTransactions) {
    const key =
      groupBy === "merchant"
        ? ((t.merchant_name ?? t.description_raw ?? "Unknown") as string)
        : (((t.personal_finance_category as { primary?: string } | null)?.primary) ?? "Uncategorized");
    totals[key] = (totals[key] ?? 0) + (t.amount as number);
  }

  // Sort by spend descending
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  const totalSpend = sorted.reduce((sum, [, v]) => sum + v, 0);
  const dateRange =
    args.start_date && args.end_date
      ? `${args.start_date} to ${args.end_date}`
      : args.start_date
      ? `from ${args.start_date}`
      : args.end_date
      ? `through ${args.end_date}`
      : "all time";

  const lines = sorted.map(
    ([key, amt]) =>
      `${key.padEnd(40)}  $${amt.toFixed(2).padStart(10)}`
  );

  return [
    `Spending summary by ${groupBy} (${dateRange})`,
    `Total: $${totalSpend.toFixed(2)}`,
    "─".repeat(55),
    ...lines,
  ].join("\n");
}

// ── Investments (MAX + investment tracking enabled) ──────────────────────────
// These call the CLI-facing /api/investments/* endpoints. Only brokerage items with investment
// tracking enabled (chosen at connect) return data; others are skipped. A per-item 4xx (not
// enabled / still warming / reconnect) is swallowed so one brokerage never fails the whole call.

// Fetch the investment items to operate on, honoring an optional item_id filter.
async function investmentTargets(item_id?: string): Promise<Array<{ item_id: string; institution_name: string }>> {
  const itemsData = await apiFetch("/api/items");
  const items = itemsData.items as Array<{ item_id: string; institution_name: string }>;
  return item_id ? items.filter((i) => i.item_id === item_id) : items;
}

// Try to pull holdings for one item; return [] on any per-item gate/error (never throws).
async function tryHoldings(item_id: string): Promise<Array<Record<string, unknown>>> {
  try {
    const data = await apiFetch("/api/investments/holdings", {
      method: "POST",
      body: JSON.stringify({ item_id }),
    });
    return (data.holdings ?? []) as Array<Record<string, unknown>>;
  } catch {
    return []; // not enabled / warming / reconnect / no brokerage -> skip this item
  }
}

async function tryActivity(item_id: string): Promise<Array<Record<string, unknown>>> {
  try {
    const data = await apiFetch("/api/investments/transactions", {
      method: "POST",
      body: JSON.stringify({ item_id }),
    });
    return (data.investment_transactions ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

// Full column sets, matching the Google Sheets extension + Excel add-in exactly, so Claude gets
// every field (cost_basis, prices, sector, option data, etc.) to answer any question. Returned as
// JSON — the right shape for an LLM to reason over, vs. a lossy ASCII table.
const HOLDINGS_COLUMNS = [
  "account_id", "security_id", "security_name", "ticker_symbol", "security_type", "security_subtype",
  "cusip", "isin", "sedol", "quantity", "cost_basis", "institution_price", "institution_value",
  "price_as_of", "price_datetime", "vested_quantity", "vested_value", "close_price", "close_price_as_of",
  "is_cash_equivalent", "market_identifier_code", "sector", "industry", "security_update_datetime",
  "option_contract_type", "option_expiration_date", "option_strike_price", "option_underlying_ticker",
  "iso_currency_code", "source_institution",
];
const ACTIVITY_COLUMNS = [
  "investment_transaction_id", "account_id", "security_id", "date", "name", "type", "subtype",
  "quantity", "price", "amount", "fees", "ticker_symbol", "security_name", "iso_currency_code",
  "cancel_transaction_id", "source_institution",
];

function project(row: Record<string, unknown>, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols) out[c] = row[c] ?? null;
  return out;
}

async function listInvestmentHoldings(args: { item_id?: string; account_id?: string }) {
  const targets = await investmentTargets(args.item_id);
  if (!targets.length) return "No connected accounts found.";

  let rows: Array<Record<string, unknown>> = [];
  for (const item of targets) rows.push(...(await tryHoldings(item.item_id)));
  if (args.account_id) rows = rows.filter((h) => h.account_id === args.account_id);

  if (!rows.length) {
    return "No investment holdings found. Connect a brokerage and choose \"Investment account\" (SheetLink MAX), then sync.";
  }

  // Full-column JSON so cost_basis, prices, sector, option fields, etc. are all available.
  const holdings = rows.map((h) => project(h, HOLDINGS_COLUMNS));
  return JSON.stringify({ count: holdings.length, holdings }, null, 2);
}

async function listInvestmentActivity(args: { item_id?: string; account_id?: string; start_date?: string; end_date?: string; limit?: number }) {
  const targets = await investmentTargets(args.item_id);
  if (!targets.length) return "No connected accounts found.";

  let rows: Array<Record<string, unknown>> = [];
  for (const item of targets) rows.push(...(await tryActivity(item.item_id)));

  if (args.account_id) rows = rows.filter((t) => t.account_id === args.account_id);
  if (args.start_date) rows = rows.filter((t) => (t.date as string) >= args.start_date!);
  if (args.end_date) rows = rows.filter((t) => (t.date as string) <= args.end_date!);
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const limit = args.limit ?? 100;
  const truncated = rows.length > limit;
  const shown = rows.slice(0, limit);

  if (!shown.length) {
    return "No investment activity found. Enable investment tracking on a brokerage (SheetLink MAX) and sync.";
  }

  // Full-column JSON (all 16 activity fields).
  const activity = shown.map((t) => project(t, ACTIVITY_COLUMNS));
  return JSON.stringify(
    { count: activity.length, total: rows.length, truncated, activity },
    null,
    2
  );
}

async function getPortfolioSummary(args: { item_id?: string; account_id?: string; group_by?: "sector" | "security" }) {
  const targets = await investmentTargets(args.item_id);
  if (!targets.length) return "No connected accounts found.";

  let holdings: Array<Record<string, unknown>> = [];
  for (const item of targets) holdings.push(...(await tryHoldings(item.item_id)));
  if (args.account_id) holdings = holdings.filter((h) => h.account_id === args.account_id);

  if (!holdings.length) {
    return "No investment holdings found. Connect a brokerage with investment tracking (SheetLink MAX) and sync.";
  }

  const totalValue = holdings.reduce((sum, h) => sum + (Number(h.institution_value) || 0), 0);
  const groupBy = args.group_by ?? "sector";
  const totals: Record<string, number> = {};
  for (const h of holdings) {
    const key = groupBy === "security"
      ? (String(h.ticker_symbol ?? h.security_name ?? "Unknown"))
      : (String(h.sector ?? "Uncategorized"));
    totals[key] = (totals[key] ?? 0) + (Number(h.institution_value) || 0);
  }
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  const lines = sorted.map(([key, amt]) => {
    const pct = totalValue > 0 ? ((amt / totalValue) * 100).toFixed(1) : "0.0";
    return `${key.slice(0, 34).padEnd(34)}  $${amt.toFixed(2).padStart(12)}  ${pct.padStart(5)}%`;
  });
  return [
    `Portfolio summary by ${groupBy}`,
    `Total value: $${totalValue.toFixed(2)}  (${holdings.length} positions)`,
    "─".repeat(56),
    ...lines,
  ].join("\n");
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "sheetlink", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_accounts",
      description:
        "List all connected banks/brokerages as JSON with full details: item_id, institution, last sync, nicknames, and the nested per-account list (account_id, name, mask, type, subtype, balances). Use the item_id and account_id values here to filter the other tools.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "list_transactions",
      description:
        "Fetch bank transactions from SheetLink as JSON with the full field set (amount, dates, merchant, category, payment channel, location, etc.). Filter by bank (item_id), specific account (account_id), date range, or category.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description:
              "Filter to a specific bank/institution (item_id from list_accounts). Omit for all banks.",
          },
          account_id: {
            type: "string",
            description:
              "Filter to a specific account within a bank (account_id from list_accounts' nested accounts). Omit for all accounts.",
          },
          start_date: {
            type: "string",
            description: "Start date filter in YYYY-MM-DD format (inclusive).",
          },
          end_date: {
            type: "string",
            description: "End date filter in YYYY-MM-DD format (inclusive).",
          },
          category: {
            type: "string",
            description:
              "Filter by spending category (e.g. FOOD_AND_DRINK, TRANSPORTATION, SHOPPING). Partial match, case-insensitive.",
          },
          limit: {
            type: "number",
            description: "Maximum number of transactions to return (default: 100).",
          },
        },
        required: [],
      },
    },
    {
      name: "get_spending_summary",
      description:
        "Get a spending summary aggregated by category or merchant for a date range. Useful for 'how much did I spend on food last month?' or 'what are my top spending categories?'",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Limit to a specific bank/institution. Omit for all.",
          },
          account_id: {
            type: "string",
            description: "Limit to a specific account within a bank. Omit for all accounts.",
          },
          start_date: {
            type: "string",
            description: "Start date in YYYY-MM-DD format.",
          },
          end_date: {
            type: "string",
            description: "End date in YYYY-MM-DD format.",
          },
          group_by: {
            type: "string",
            enum: ["category", "merchant"],
            description: "Group spending by category (default) or merchant.",
          },
        },
        required: [],
      },
    },
    {
      name: "list_investment_holdings",
      description:
        "List current investment holdings (positions) across brokerages as JSON with the full field set: ticker, security name, quantity, cost_basis, institution_price, institution_value, sector, industry, option details, and more. Requires SheetLink MAX and a brokerage connected as an investment account.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Limit to a specific brokerage (item_id from list_accounts). Omit for all.",
          },
          account_id: {
            type: "string",
            description: "Limit to a specific investment account within a brokerage. Omit for all.",
          },
        },
        required: [],
      },
    },
    {
      name: "list_investment_activity",
      description:
        "List investment activity (buys, sells, dividends, interest, fees) across brokerages as JSON with the full field set (type, subtype, quantity, price, amount, fees, ticker, security). Filter by brokerage, account, or date range. Requires SheetLink MAX.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Limit to a specific brokerage. Omit for all.",
          },
          account_id: {
            type: "string",
            description: "Limit to a specific investment account within a brokerage. Omit for all.",
          },
          start_date: { type: "string", description: "Start date in YYYY-MM-DD format (inclusive)." },
          end_date: { type: "string", description: "End date in YYYY-MM-DD format (inclusive)." },
          limit: { type: "number", description: "Max rows to return (default: 100)." },
        },
        required: [],
      },
    },
    {
      name: "get_portfolio_summary",
      description:
        "Summarize the investment portfolio: total value and allocation grouped by sector (default) or individual security, with each group's percentage. Useful for 'what's my allocation?' or 'what are my largest positions?'. Requires SheetLink MAX.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Limit to a specific brokerage. Omit for all.",
          },
          account_id: {
            type: "string",
            description: "Limit to a specific investment account within a brokerage. Omit for all.",
          },
          group_by: {
            type: "string",
            enum: ["sector", "security"],
            description: "Group allocation by sector (default) or individual security.",
          },
        },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result: string;

    if (name === "list_accounts") {
      result = await listAccounts();
    } else if (name === "list_transactions") {
      result = await listTransactions(args as Parameters<typeof listTransactions>[0]);
    } else if (name === "get_spending_summary") {
      result = await getSpendingSummary(args as Parameters<typeof getSpendingSummary>[0]);
    } else if (name === "list_investment_holdings") {
      result = await listInvestmentHoldings(args as Parameters<typeof listInvestmentHoldings>[0]);
    } else if (name === "list_investment_activity") {
      result = await listInvestmentActivity(args as Parameters<typeof listInvestmentActivity>[0]);
    } else if (name === "get_portfolio_summary") {
      result = await getPortfolioSummary(args as Parameters<typeof getPortfolioSummary>[0]);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
