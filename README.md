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

**How it works:** Each button in Thought Management sends a webhook. The `x-cogdex-page-type` header identifies which button was pressed. Notion automatically sends the current row's page data in the request body — no body configuration is needed by the user.

The backend reads `body.data.id` from Notion's payload as the `thoughtId`, then creates or compiles the related Entry.

**Headers (set by you in Notion — the only config):**

| Header | Value | Purpose |
|---|---|---|
| `x-cogdex-secret` | your secret | authentication |
| `x-cogdex-page-type` | `User` / `Response` / `Agreement` / `Checkpoint` / `Attachment` / `Compile` | which button was pressed |

**Body:** Sent automatically by Notion — do not configure. Notion sends:
```json
{
  "source": { "automation_id": "...", "user_id": "...", ... },
  "data": {
    "object": "page",
    "id": "<Thought Management page ID>",
    "parent": { "data_source_id": "<TM data source ID>" },
    "properties": {}
  }
}
```

**Action is derived from `x-cogdex-page-type`:**
- Any type except `Compile` → creates a new Entry with that type (inheriting `Title` and page `icon` from the latest numbered entry in that project if `Continue Branch` is checked in the Thought Management page).
- `Compile` → compiles all included entries into an XML context page


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
- `Continue Branch` (Checkbox, default unchecked)
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

For each database, open it as a full page, then check its URL:
```
https://www.notion.so/<workspace>/<DATABASE_ID>?v=...
```

The 32-char hex string before `?v=` is the ID to copy.

> **Important for Notion SDK v5:** The code uses `dataSources.query({ data_source_id })`. The `data_source_id` for a database may differ from the `database_id` shown in some contexts. To get the correct `data_source_id`, open the database → `...` → open as page → check the URL, **or** retrieve the ID from a relation property's details (the `data_source_id` field). If queries return "object not found", swap to the other ID.

### 5. Configure Buttons as Webhook Automations

All 6 buttons share the same URL. The **only difference between buttons is the `x-cogdex-page-type` header value**. No body configuration is needed — Notion sends the page data automatically.

For each button, configure:
- **Trigger:** Button clicked
- **Action:** Send webhook
- **URL:** `https://<your-vercel-url>/api/cogdex/webhook`
- **Method:** POST
- **Body:** leave empty — Notion sends the page data automatically

**Headers** (two headers per button, only `x-cogdex-page-type` differs):

| Key | Value |
|---|---|
| `x-cogdex-secret` | your `COGDEX_WEBHOOK_SECRET` value |
| `x-cogdex-page-type` | see table below |

> ⚠️ Do **not** add `Content-Type` — reserved header, causes errors.

| Button | `x-cogdex-page-type` value |
|---|---|
| `+ User` | `User` |
| `+ Response` | `Response` |
| `+ Agreement` | `Agreement` |
| `+ Checkpoint` | `Checkpoint` |
| `+ Attachment` | `Attachment` |
| `📦 Compile` | `Compile` |



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
