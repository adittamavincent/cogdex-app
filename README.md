# Cogdex App

A minimal Next.js (App Router) backend hosted on Vercel. Its sole job is to receive webhooks from Notion button automations and either create a new typed entry page in a Notion database, or compile selected entries and system prompts into a structured XML context block written as a new Notion page.

No user-facing frontend. No auth system. No database other than Notion. Single-user personal tool.

---

## What It Does

| Webhook Action | Behaviour |
|---|---|
| `create` | Creates a new typed page in the Entries database with a pre-filled body template and auto-incremented `Number` |
| `compile` | Reads all `Include=true` Entries + System Prompts → builds a `<cogdex>` XML block → writes it to a new `Compile` entry page |

The compiled XML output can be exported from Notion as Markdown and pasted into any LLM as structured context.

---

## Tech Stack

- **Runtime**: Node.js (latest LTS)
- **Framework**: Next.js 16 (App Router)
- **Package manager**: pnpm
- **Language**: TypeScript (strict)
- **Hosting**: Vercel
- **Notion SDK**: `@notionhq/client` v5 (uses `dataSources` API)

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
│   └── page.tsx                   ← plain status page
├── lib/
│   ├── notion.ts                  ← Notion client singleton
│   ├── entries.ts                 ← create entry logic
│   ├── compile.ts                 ← compile + XML build logic
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
NOTION_ENTRIES_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_THOUGHT_MANAGEMENT_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_SYSTEM_PROMPT_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
COGDEX_WEBHOOK_SECRET=pick_a_long_random_string_here
```

Generate a secure secret: `openssl rand -hex 32`

Set the same variables in **Vercel → Project → Settings → Environment Variables**.

---

## Webhook API

**Endpoint:** `POST /api/cogdex/webhook`

**Required header:** `x-cogdex-secret: <COGDEX_WEBHOOK_SECRET>`

**Payload — create entry:**
```json
{
  "action": "create",
  "pageType": "User",
  "thoughtId": "{{current_page_id}}"
}
```
Valid `pageType` values: `User`, `Response`, `Agreement`, `Checkpoint`, `Attachment`, `Compile`

**Payload — compile:**
```json
{
  "action": "compile",
  "thoughtId": "{{current_page_id}}"
}
```

---

## Notion Setup (one-time manual steps)

### 1. Create Notion Integration

Go to [https://www.notion.so/profile/integrations](https://www.notion.so/profile/integrations) → New integration named `Cogdex App`.  
Capabilities needed: **Read content**, **Update content**, **Insert content**.  
Copy the Internal Integration Token → this is your `NOTION_TOKEN`.

### 2. Create Three Databases

**Thought Management** (columns):
- `Title` (Title)
- `Fungsi` (Select): Tugas, Learning, Public Address, Problem Solving, Lomba, Exploration
- `Outcome` (Select): Just Thought, Repository Private, Repository Public, List Only
- `Tag` (Multi-select): Life and Love, Bachelor, Organization, Coding Camp
- `Open Ended?` (Checkbox)
- `Date Deprecated` (Date)
- `Build Github` (URL)
- 6 Buttons: `+ User`, `+ Response`, `+ Agreement`, `+ Checkpoint`, `+ Attachment`, `📦 Compile` (configure after deploy)

**Entries** (columns):
- `Title` (Title)
- `Type` (Select): User, Response, Agreement, Checkpoint, Attachment, Compile
- `Number` (Number)
- `Include` (Checkbox)
- `Thought Management` (Relation → Thought Management DB, 2-way sync, synced name: `Entries`)
- `Created` (Created time)

**System Prompt** (columns):
- `Name` (Title)
- `Include` (Checkbox)
- `Priority` (Number) — lower = higher priority in compile output

Write system prompt content in the **page body** of each entry.

### 3. Connect Integration to All Three Databases

For each database: open as full page → `...` → Connections → add `Cogdex App`.

### 4. Get Database IDs

Copy each DB's 32-char ID from its URL (`/notion.so/<workspace>/<DATABASE_ID>?v=...`) and set in env vars.

### 5. Configure Buttons as Webhook Automations

For each button in Thought Management, configure:
- **Trigger:** Button clicked
- **Action:** Send webhook
- **URL:** `https://<your-vercel-url>/api/cogdex/webhook`
- **Method:** POST
- **Headers:** `Content-Type: application/json`, `x-cogdex-secret: <secret>`

Button payloads:
```
+ User      → { "action": "create", "pageType": "User",       "thoughtId": "{{current_page_id}}" }
+ Response  → { "action": "create", "pageType": "Response",   "thoughtId": "{{current_page_id}}" }
+ Agreement → { "action": "create", "pageType": "Agreement",  "thoughtId": "{{current_page_id}}" }
+ Checkpoint→ { "action": "create", "pageType": "Checkpoint", "thoughtId": "{{current_page_id}}" }
+ Attachment→ { "action": "create", "pageType": "Attachment", "thoughtId": "{{current_page_id}}" }
📦 Compile  → { "action": "compile",                          "thoughtId": "{{current_page_id}}" }
```

> **Verify `{{current_page_id}}` syntax** with your Notion version at [https://developers.notion.com](https://developers.notion.com) — this variable may differ.

### 6. Add Linked Entries View

Inside each Thought Management page: insert a **Linked view of database** → link to Entries → filter by `Thought Management contains current page`.

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

Status page available at `http://localhost:3000` — returns `"Cogdex App is running."`

---

## End-to-End Test

1. Open a Thought Management row → click `+ User` → new Entries row appears
2. Open that entry, write content, ensure `Include` is checked
3. Add a System Prompt page with `Include` checked and `Priority: 1`
4. Back in Thought Management → click `📦 Compile`
5. A `Compile` type entry (no Number) appears in Entries
6. Open it — the full `<cogdex>` XML block is its page content
7. Export: `...` → Export → Markdown → paste into LLM
