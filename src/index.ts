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
    allTransactions = allTransactions.filter(
      (t) =>
        ((t.category_primary as string) ?? "").toUpperCase().includes(cat) ||
        ((t.category_detailed as string) ?? "").toUpperCase().includes(cat)
    );
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
    const name = t.merchant_name ?? t.description ?? t.description_raw ?? "Unknown";
    const cat = t.category_primary ?? "";
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
        ? ((t.merchant_name ?? t.description ?? "Unknown") as string)
        : ((t.category_primary ?? "Uncategorized") as string);
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
