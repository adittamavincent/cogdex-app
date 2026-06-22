# Cogdex App

Minimal Next.js (App Router) backend hosted on Vercel. Receives webhooks from Notion button automations to manage typed entries, export structured XML contexts, apply git diff patches, sync memorandum code, and restore project-scoped database views.

No user-facing frontend. No auth system. No database other than Notion. Single-user personal tool.

---

## What It Does

Buttons in Notion send webhooks to the Cogdex API, configured with a custom header representing the action/page type.

### Notion Page Types & Acronyms
- **CHAT**: Regular chat/session
- **MEMO**: Memorandum/file management
- **USER**: User input
- **RESP**: Response
- **EXPO**: Export
- **CMNT**: Comment
- **UPDT**: Update
- **SYST**: System
- **TASK**: Task automation/execution
- **REPO**: Repository snapshot/state

### Action Actions

| Webhook Action / Custom Header | Triggered From | Behavior |
|---|---|---|
| `CHAT USER` / `CHAT RESP` / `MEMO EXPO` / `MEMO RESP` / `CHAT EXPO` / `CHAT CMNT` / `TASK EXPO` / `TASK RESP` / `REPO SNAP` | **Project Page** | Creates a new entry page in the **Entry** database linked to the project. |
| `MEMO RESP` | **Entry Page** | Gathers previous version, applies git diff block patch, appends updated full file code back below diff. |
| `MEMO UPDT` | **Project Page** | Gathers all `MEMO RESP` and `MEMO EXPO` entries for the project. Applies git diffs sequentially to construct latest file code. Writes updated content to a single Memorandum page in the **Memorandum** database (archives duplicates). Links project to memorandum. |
| `CHAT EXPO` | **Project Page** (As exporting endpoint) | Gathers `Include=true` Entries + System Prompts + latest Memorandum. Exports `<cogdex>` XML block. Writes output to new `CHAT EXPO` page in the **Entry** database. |
| `TASK EXPO` | **Project Page** (As exporting endpoint) | Gathers `Include=true` Entries + System Prompts + latest Memorandum + latest Repository Snapshot. Exports `<cogdex>` XML block containing the Task operational protocol. Writes output to new `TASK EXPO` page in the **Entry** database. |
| `REPO SNAP` | **Project Page** | Downloads codebase from GitHub URL, compiles structure using repomix, and writes output as paragraphs of code blocks to a new `REPO SNAP` page in the **Entry** database. |
| `CHAT CMNT` | **Project/Entry Page** | Copies comments from previous entry, links references between two most recent entries. |
| `SYST LINK` | **Project Page** | Wipes current Project page blocks. Clones Entry, System Prompt, and Memorandum database views inside it based on template views, filtered to current Project. |

---

## Notion Database Schemas

To sync properly with the codebase, configure these four databases in Notion:

### 1. Project Database
- `Name` (Title)
- `Memorandum` (Relation → Memorandum DB, single select/limit to 1 page)

### 2. Entry Database
- `Name` (Title) — Stores the incremented entry number (e.g. `1`, `2`, `3`).
- `Type` (Select) — Values: `CHAT USER`, `CHAT RESP`, `MEMO EXPO`, `MEMO RESP`, `CHAT EXPO`, `CHAT CMNT`, `MEMO UPDT`, `REPO SNAP`, `TASK EXPO`, `TASK RESP`.
- `Include` (Checkbox) — Set to `true` to include in context exports (automatically unchecked for export entries like `CHAT EXPO` and `MEMO EXPO`).
- `Project` (Relation → Project DB)
- `Entries Referenced` (Relation → Entry DB)
- `System Prompt Used` (Relation → System Prompt DB)

### 3. Memorandum Database
- `Name` (Title) — Holds latest chronological entry number.
- `Project` (Relation → Project DB)

### 4. System Prompt Database
- `Name` (Title)
- `Include` (Checkbox) — Set to `true` to include in context exports.
- `Priority` (Number) — Sorting order for XML context blocks.

---

## Tech Stack

- **Runtime**: Node.js (latest LTS)
- **Framework**: Next.js 16 (App Router)
- **Package manager**: pnpm
- **Language**: TypeScript (strict)
- **Hosting**: Vercel
- **Notion SDK**: `@notionhq/client` v5 (uses `dataSources` and `views` API)

> **Note on Notion SDK v5:** `notion.databases.query()` is now `notion.dataSources.query({ data_source_id })` and `pages.create` uses `parent: { data_source_id }` instead of `parent: { database_id }`.

---

## Project Structure

```
cogdex-app/
├── app/
│   ├── api/
│   │   └── cogdex/
│   │       └── webhook/
│   │           └── route.ts       ← webhook endpoint
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx                   ← status page
├── lib/
│   ├── notion.ts                  ← Notion client singleton
│   ├── entries.ts                 ← entry generation, diff patch, and views setup
│   ├── export.ts                  ← XML context export logic
│   ├── logger.ts                  ← logger utility
│   └── types.ts                   ← TS types
├── vercel.json                    ← maxDuration config
├── .env.local                     ← local configuration
└── package.json
```

---

## Environment Variables

Create `.env.local`:

```env
NOTION_TOKEN=secret_xxxxxxxxxxxx
COGDEX_WEBHOOK_SECRET=pick_a_long_random_string_here

# Databases (IDs are 32-char hex strings)
NOTION_ENTRY_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_SYSTEM_PROMPT_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_MEMORANDUM_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_BRANCH_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Templates for View Cloning
NOTION_ENTRY_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_SYSTEM_PROMPT_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_MEMORANDUM_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: customize incoming headers
COGDEX_SECRET_HEADER=x-cogdex-secret
COGDEX_PAGE_TYPE_HEADER=x-cogdex-page-type
```

Set the same variables in Vercel.

---

## Webhook API

**Endpoint:** `POST /api/cogdex/webhook`

**Headers:**

| Header | Value | Purpose |
|---|---|---|
| `x-cogdex-secret` | your secret | authentication |
| `x-cogdex-page-type` | `CHAT USER` / `CHAT RESP` / `MEMO EXPO` / `MEMO RESP` / `CHAT EXPO` / `CHAT CMNT` / `SYST LINK` / `MEMO UPDT` / `REPO SNAP` | action type |

**Body:** Notion sends page details automatically:
```json
{
  "source": { "automation_id": "...", "user_id": "...", "action_id": "..." },
  "data": {
    "object": "page",
    "id": "<Page ID>",
    "properties": {}
  }
}
```

---

## Deployment & Dev

```bash
# Verify build
pnpm build

# Deploy to Vercel
pnpm dlx vercel

# Run local dev server
pnpm dev
```
