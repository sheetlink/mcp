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
  const items = data.items as Array<{
    item_id: string;
    institution_name: string;
    last_synced_at: string | null;
  }>;

  if (!items.length) {
    return "No bank accounts connected. Visit sheetlink.app to connect a bank.";
  }

  return items
    .map(
      (item) =>
        `• ${item.institution_name} (item_id: ${item.item_id}, last synced: ${item.last_synced_at ?? "never"})`
    )
    .join("\n");
}

async function listTransactions(args: {
  item_id?: string;
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

  const lines = transactions.map((t) => {
    const amount = typeof t.amount === "number" ? t.amount.toFixed(2) : t.amount;
    const name = t.merchant_name ?? t.description_raw ?? "Unknown";
    const pfc = t.personal_finance_category as { primary?: string } | null;
    const cat = pfc?.primary ?? "";
    return `${t.date}  ${String(name).padEnd(35)}  $${String(amount).padStart(8)}  ${cat}`;
  });

  const header = `${"Date".padEnd(10)}  ${"Merchant".padEnd(35)}  ${"Amount".padStart(9)}  Category`;
  const separator = "─".repeat(header.length);
  const result = [header, separator, ...lines].join("\n");

  return truncated
    ? `${result}\n\n(Showing first ${limit} of ${allTransactions.length} transactions. Use a narrower date range or increase limit.)`
    : result;
}

async function getSpendingSummary(args: {
  item_id?: string;
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

async function listInvestmentHoldings(args: { item_id?: string }) {
  const targets = await investmentTargets(args.item_id);
  if (!targets.length) return "No connected accounts found.";

  const rows: Array<Record<string, unknown>> = [];
  for (const item of targets) rows.push(...(await tryHoldings(item.item_id)));

  if (!rows.length) {
    return "No investment holdings found. Connect a brokerage and choose \"Investment account\" (SheetLink MAX), then sync.";
  }

  const lines = rows.map((h) => {
    const ticker = String(h.ticker_symbol ?? "").padEnd(8);
    const name = String(h.security_name ?? "Unknown").slice(0, 28).padEnd(28);
    const qty = h.quantity != null ? Number(h.quantity).toString() : "";
    const val = h.institution_value != null ? `$${Number(h.institution_value).toFixed(2)}` : "";
    return `${ticker}  ${name}  qty ${qty.padStart(10)}  ${val.padStart(12)}`;
  });
  const header = `${"Ticker".padEnd(8)}  ${"Security".padEnd(28)}  ${"Quantity".padStart(14)}  ${"Value".padStart(12)}`;
  return [header, "─".repeat(header.length), ...lines].join("\n");
}

async function listInvestmentActivity(args: { item_id?: string; start_date?: string; end_date?: string; limit?: number }) {
  const targets = await investmentTargets(args.item_id);
  if (!targets.length) return "No connected accounts found.";

  let rows: Array<Record<string, unknown>> = [];
  for (const item of targets) rows.push(...(await tryActivity(item.item_id)));

  if (args.start_date) rows = rows.filter((t) => (t.date as string) >= args.start_date!);
  if (args.end_date) rows = rows.filter((t) => (t.date as string) <= args.end_date!);
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const limit = args.limit ?? 100;
  const truncated = rows.length > limit;
  const shown = rows.slice(0, limit);

  if (!shown.length) {
    return "No investment activity found. Enable investment tracking on a brokerage (SheetLink MAX) and sync.";
  }

  const lines = shown.map((t) => {
    const type = String(t.type ?? "").padEnd(10);
    const name = String(t.name ?? t.ticker_symbol ?? "").slice(0, 30).padEnd(30);
    const qty = t.quantity != null ? Number(t.quantity).toString() : "";
    const amt = t.amount != null ? `$${Number(t.amount).toFixed(2)}` : "";
    return `${t.date}  ${type}  ${name}  ${qty.padStart(8)}  ${amt.padStart(12)}`;
  });
  const header = `${"Date".padEnd(10)}  ${"Type".padEnd(10)}  ${"Description".padEnd(30)}  ${"Qty".padStart(8)}  ${"Amount".padStart(12)}`;
  const result = [header, "─".repeat(header.length), ...lines].join("\n");
  return truncated ? `${result}\n\n(Showing first ${limit} of ${rows.length}. Narrow the date range or raise limit.)` : result;
}

async function getPortfolioSummary(args: { item_id?: string; group_by?: "sector" | "security" }) {
  const targets = await investmentTargets(args.item_id);
  if (!targets.length) return "No connected accounts found.";

  const holdings: Array<Record<string, unknown>> = [];
  for (const item of targets) holdings.push(...(await tryHoldings(item.item_id)));

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
        "List all bank accounts connected to SheetLink, including institution names and last sync time.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "list_transactions",
      description:
        "Fetch bank transactions from SheetLink. Optionally filter by account, date range, or spending category. Returns date, merchant, amount, and category for each transaction.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description:
              "Filter to a specific bank account (item_id from list_accounts). Omit to fetch all accounts.",
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
        "Get a spending summary aggregated by category or merchant for a given date range. Useful for answering questions like 'how much did I spend on food last month?' or 'what are my top spending categories?'",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description:
              "Limit summary to a specific bank account. Omit for all accounts.",
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
        "List current investment holdings (positions) across connected brokerages: ticker, security name, quantity, and current value. Requires SheetLink MAX and a brokerage connected as an investment account.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Limit to a specific brokerage (item_id from list_accounts). Omit for all.",
          },
        },
        required: [],
      },
    },
    {
      name: "list_investment_activity",
      description:
        "List investment activity (buys, sells, dividends, interest, fees) across brokerages, optionally filtered by date range. Requires SheetLink MAX and investment tracking enabled.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Limit to a specific brokerage. Omit for all.",
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
        "Summarize the investment portfolio: total value and allocation grouped by sector (default) or individual security, with each group's percentage of the portfolio. Useful for 'what's my allocation?' or 'what are my largest positions?'. Requires SheetLink MAX.",
      inputSchema: {
        type: "object",
        properties: {
          item_id: {
            type: "string",
            description: "Limit to a specific brokerage. Omit for all.",
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
