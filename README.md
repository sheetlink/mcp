# SheetLink MCP Server

Connect Claude to your bank transactions via SheetLink.

## What it does

Exposes three tools to Claude:

- **`list_accounts`** — lists your connected bank accounts
- **`list_transactions`** — fetches transactions with optional date, account, and category filters
- **`get_spending_summary`** — aggregates spending by category or merchant for a date range

## Requirements

- SheetLink MAX tier (for API key access)
- Node.js 18+

## Setup

### 1. Get your API key

Log in to [sheetlink.app/dashboard/api-keys](https://sheetlink.app/dashboard/api-keys) and create an API key.

### 2. Configure Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sheetlink": {
      "command": "npx",
      "args": ["-y", "@sheetlink/mcp"],
      "env": {
        "SHEETLINK_API_KEY": "sl_your_api_key_here"
      }
    }
  }
}
```

### 3. Restart Claude Desktop

That's it. Ask Claude things like:

- *"What did I spend on restaurants last month?"*
- *"Show me my top spending categories for Q1"*
- *"List all transactions over $100 from Chase this week"*
- *"Build me a P&L for March using my bank data"*

## Tools

### `list_accounts`
Lists all connected bank accounts with institution name and last sync time.

### `list_transactions`
| Parameter | Type | Description |
|---|---|---|
| `item_id` | string | Filter to a specific bank (from `list_accounts`) |
| `start_date` | string | YYYY-MM-DD |
| `end_date` | string | YYYY-MM-DD |
| `category` | string | Partial match on Plaid category (e.g. `FOOD_AND_DRINK`) |
| `limit` | number | Max results (default 100) |

### `get_spending_summary`
| Parameter | Type | Description |
|---|---|---|
| `item_id` | string | Limit to one bank |
| `start_date` | string | YYYY-MM-DD |
| `end_date` | string | YYYY-MM-DD |
| `group_by` | `category` \| `merchant` | Default: `category` |

## Development

```bash
npm install
npm run build
SHEETLINK_API_KEY=sl_your_key node dist/index.js
```
