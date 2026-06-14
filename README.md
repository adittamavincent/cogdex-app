# Cogdex App

A minimal Next.js (App Router) backend hosted on Vercel. Its sole job is to receive webhooks from Notion button automations and either create a new typed entry page in a Notion database, compile selected entries and system prompts into a structured XML context block, manage project branches, apply code diff patches to canvas files, or reset database views.

No user-facing frontend. No auth system. No database other than Notion. Single-user personal tool.

---

## What It Does

| Webhook Action | Behaviour |
|---|---|
| `User` / `Response` / `Canvas` | Creates a new typed page in the Entries database under the active branch. |
| `Canvas Update` | Reads git diff content from a Canvas page, applies patch to the previous Canvas page version, and appends the full version of the canvas code back below the diff block. |
| `Compile` | Reads all `Include=true` Entries + System Prompts → builds a `<cogdex>` XML block → writes it to a new `Compile` entry page. |
| `Branch` | Creates or activates a new Branch page for the Project, randomizes its emoji icon, sets it to active, and deactivates all other branches. |
| `New Branch` | Sets a specific Branch page to Active and deactivates other branches. |
| `User Comment` | Scans the previous entry, copies comments, and links references between the two most recent entries. |
| `Reset` | Wipes the current project page's blocks and clones the Branch, Entry, and System Prompt database views inside it based on original template views. |

The compiled XML output can be exported from Notion as Markdown and pasted into any LLM as structured context.

### Optimization & Formatting Design

To prevent Vercel Serverless Function timeouts (`FUNCTION_INVOCATION_TIMEOUT`) and optimize Markdown exports, the compilation system is designed with:
- **Parallel Content Fetching**: Page database queries and block structures are fetched concurrently via `Promise.all` instead of sequentially, reducing Notion API query time to a single concurrent batch.
- **Grouped Multi-line Text Packing**: Rather than creating a separate Notion block for every line of XML (which triggers blank double-spacing in Markdown exports and requires hundreds of API calls), lines are grouped into paragraph blocks of up to 1900 characters (separated by `\n`). This results in a clean, raw, single-spaced Markdown output identical to local files, and reduces API write requests to just one or two per compile job.

---

## Tech Stack

- **Runtime**: Node.js (latest LTS)
- **Framework**: Next.js 16 (App Router)
- **Package manager**: pnpm
- **Language**: TypeScript (strict)
- **Hosting**: Vercel
- **Notion SDK**: `@notionhq/client` v5 (uses `dataSources` and `views` API)

> **Note on Notion SDK v5:** This project uses `@notionhq/client` v5 which introduced breaking changes from v4. `notion.databases.query()` is now `notion.dataSources.query({ data_source_id })` and `pages.create` uses `parent: { data_source_id }` instead of `parent: { database_id }`. The database IDs themselves are the same 32-char hex strings from the Notion URL.

---

## Project Structure

```
cogdex-app/
├── app/
│   ├── api/
│   │   └── cogdex/
│   │       └── webhook/
│   │           └── route.ts       ← single webhook entry point
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx                   ← plain status page
├── lib/
│   ├── notion.ts                  ← Notion client singleton
│   ├── entries.ts                 ← create entry, branch, canvas, and reset logic
│   ├── compile.ts                 ← compile + XML build logic
│   ├── logger.ts                  ← centralized logging
│   └── types.ts                   ← shared TypeScript types
├── vercel.json                    ← maxDuration: 60 for compile jobs
├── .env.local                     ← not committed
└── package.json
```

---

## Environment Variables

Create `.env.local` (never commit this file):

```env
NOTION_TOKEN=secret_xxxxxxxxxxxx
COGDEX_WEBHOOK_SECRET=pick_a_long_random_string_here

# Group 1: Project (No View ID required)
NOTION_PROJECT_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Group 2: Branch, Entry, System Prompt (DB and View IDs)
NOTION_BRANCH_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_BRANCH_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

NOTION_ENTRY_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_ENTRY_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

NOTION_SYSTEM_PROMPT_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_SYSTEM_PROMPT_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: customize incoming headers (defaults shown below)
COGDEX_SECRET_HEADER=x-cogdex-secret
COGDEX_PAGE_TYPE_HEADER=x-cogdex-page-type
```

Generate a secure secret: `openssl rand -hex 32`

Set the same variables in **Vercel → Project → Settings → Environment Variables**.

---

## Webhook API

**Endpoint:** `POST /api/cogdex/webhook`

**How it works:** Each button in Thought Management sends a webhook. The `x-cogdex-page-type` header identifies which button was pressed. Notion automatically sends the current row's page data in the request body — no body configuration is needed by the user.

The backend reads `body.data.id` from Notion's payload as the `thoughtId`, then triggers the corresponding action.

**Headers (set by you in Notion — the only config):**

| Header | Value | Purpose |
|---|---|---|
| `x-cogdex-secret` | your secret | authentication |
| `x-cogdex-page-type` | `User` / `Response` / `Canvas` / `Canvas Update` / `Compile` / `Branch` / `New Branch` / `User Comment` / `Reset` | which button was pressed |

**Body:** Sent automatically by Notion — do not configure. Notion sends:
```json
{
  "source": { "automation_id": "...", "user_id": "...", ... },
  "data": {
    "object": "page",
    "id": "<Thought Management / Branch / Page ID>",
    "parent": { "data_source_id": "<data source ID>" },
    "properties": {}
  }
}
```

---

## Notion Setup (one-time manual steps)

### 1. Create Notion Integration

Go to [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations) → New integration named `Cogdex App`.  
Capabilities needed: **Read content**, **Update content**, **Insert content**.  
Copy the Internal Integration Token → this is your `NOTION_TOKEN`.

### 2. Create Databases

**Thought Management** (columns):
- `Title` (Title)
- `Fungsi` (Select)
- `Outcome` (Select)
- `Tag` (Multi-select)
- `Open Ended?` (Checkbox)
- `Date Deprecated` (Date)
- `Build Github` (URL)
- Buttons for triggering webhooks (`User`, `Response`, `Canvas`, `Compile`, `Branch`, `Reset`, etc.)

**Branches** (columns):
- `Name` (Title)
- `Project` (Relation → Thought Management DB)
- `Active` (Checkbox)

**Entries** (columns):
- `Title` (Title)
- `Type` (Select): User, Response, Canvas, Compile, etc.
- `Number` (Number)
- `Include` (Checkbox)
- `Thought Management` (Relation → Thought Management DB)
- `Branch` (Relation → Branches DB)
- `Created` (Created time)

**System Prompt** (columns):
- `Name` (Title)
- `Include` (Checkbox)
- `Priority` (Number)

Write system prompt content in the **page body** of each entry.

### 3. Connect Integration to Databases

For each database: open as full page → `...` → Connections → add `Cogdex App`.

### 4. Get Database and View IDs

Retrieve your Database IDs and their default View IDs from the URLs or via API and add them to your env configuration.

---

## Deployment

```bash
pnpm build          # verify TypeScript compiles cleanly
pnpm dlx vercel     # first deploy — follow prompts
```

After deploy, webhook URL: `https://<your-vercel-url>/api/cogdex/webhook`

---

## Local Development

```bash
pnpm dev
```

Status page available at `http://localhost:3000`
