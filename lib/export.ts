import { notion } from "./notion";
import { createEntry, resolveDataSourceId } from "./entries";
import type { BlockObjectRequest } from "@notionhq/client";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;
const CANVAS_DB_ID = process.env.NOTION_CANVAS_DB_ID!;

interface NotionBlock {
  type: string;
  has_children?: boolean;
  id: string;
  [key: string]: unknown;
}

interface NotionRichText {
  type?: string;
  plain_text?: string;
  mention?: {
    type?: string;
    page?: { id: string };
  };
}

interface NotionPage {
  id: string;
  created_time: string;
  properties?: Record<string, {
    checkbox?: boolean;
    number?: number | null;
    title?: Array<{ plain_text?: string }>;
    select?: { name?: string } | null;
    relation?: Array<{ id: string }>;
    Name?: { title?: Array<{ plain_text?: string }> };
    Priority?: { number?: number };
    Title?: { title?: Array<{ plain_text?: string }> };
    Type?: { select?: { name?: string } };
  }>;
}



// Read all text content from a Notion page (recursive blocks → plain text)
export async function readPageContent(pageId: string): Promise<string> {
  // SDK v5: blocks.children.list is unchanged
  const blocks = await notion.blocks.children.list({ block_id: pageId });
  const lines: string[] = [];

  for (const block of blocks.results as unknown as NotionBlock[]) {
    const type = block.type;
    const data = block[type] as { rich_text?: NotionRichText[] } | undefined;

    if (!data) continue;

    const richText = data.rich_text ?? [];
    let text = "";
    
    for (const t of richText) {
      if (t.type === "mention" && t.mention?.type === "page" && t.mention.page?.id) {
        const plainText = t.plain_text ?? "";
        const tAttr = plainText.replace(/"/g, '&quot;');
        text += `<mention title="${tAttr}" />`;
      } else {
        text += t.plain_text ?? "";
      }
    }

    if (type === "heading_1") lines.push(`# ${text}`);
    else if (type === "heading_2") lines.push(`## ${text}`);
    else if (type === "heading_3") lines.push(`### ${text}`);
    else if (type === "bulleted_list_item") lines.push(`- ${text}`);
    else if (type === "numbered_list_item") lines.push(`1. ${text}`);
    else if (type === "code") {
      const isDiff = (data as any)?.language === "diff" || text.startsWith("diff --git") || text.includes("diff --git");
      if (!isDiff) lines.push(`\`\`\`\n${text}\n\`\`\``);
    }
    else if (type === "quote") lines.push(`> ${text}`);
    else if (type === "divider") lines.push(`---`);
    else if (text) lines.push(text);

    // Recurse into children if present
    if (block.has_children) {
      const childContent = await readPageContent(block.id);
      if (childContent) lines.push(childContent);
    }
  }

  return lines.join("\n");
}

// Fetch all Include=true entries for a project, excluding Compile
// SDK v5: notion.dataSources.query({ data_source_id })
async function getIncludedEntries(thoughtId: string) {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      and: [
        { property: "Project", relation: { contains: thoughtId } },
        { property: "Include", checkbox: { equals: true } },
        { property: "Type", select: { does_not_equal: "REG EXP" } },
        { property: "Type", select: { does_not_equal: "CNV EXP" } },
      ],
    },
  });

  const entries = response.results as unknown as NotionPage[];

  // Sort alphanumerically by Title/Name
  return entries.sort((a, b) => {
    const titleA = a.properties?.Name?.title?.[0]?.plain_text ?? a.properties?.Title?.title?.[0]?.plain_text ?? "";
    const titleB = b.properties?.Name?.title?.[0]?.plain_text ?? b.properties?.Title?.title?.[0]?.plain_text ?? "";
    return titleA.localeCompare(titleB, undefined, { numeric: true });
  });
}

// Fetch all Include=true system prompts, sorted by Priority
// SDK v5: notion.dataSources.query({ data_source_id })
async function getIncludedSystemPrompts() {
  const sysPromptDbId = await resolveDataSourceId(SYSTEM_PROMPT_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: sysPromptDbId,
    filter: { property: "Include", checkbox: { equals: true } },
    sorts: [{ property: "Priority", direction: "ascending" }],
  });
  return response.results as unknown as NotionPage[];
}

async function getLatestCanvas(thoughtId: string): Promise<NotionPage | null> {
  if (!CANVAS_DB_ID) return null;
  const canvasDbIdResolved = await resolveDataSourceId(CANVAS_DB_ID);
  try {
    const response = await notion.dataSources.query({
      data_source_id: canvasDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: thoughtId }
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1
    });
    if (response.results.length === 0) return null;
    return response.results[0] as unknown as NotionPage;
  } catch (err: any) {
    if (err.code === "object_not_found") {
      console.warn("Canvas DB not found or not shared with integration. Skipping Canvas export.");
      return null;
    }
    throw err;
  }
}

const DEFAULT_PROTOCOL = `# Cogdex Default System Prompt

## Purpose

This prompt establishes the operational protocol between the LLM and the Notion-based Cogdex workspace. Your job is to read the compiled \`<cogdex>\` XML structure, understand the project's full context, and generate strictly paste-ready, rich-markdown content as the next Notion entry body.

---

## How the Compiled XML Is Built

The \`<cogdex>\` block is machine-generated by the Cogdex App backend. It has two layers:

\`\`\`
<cogdex>

<protocol>
  [All included System Prompt pages, sorted by Priority ascending, concatenated]
</protocol>

<context>
  <entry type="[Type]" title="[Title]">
    [Page body content]
  </entry>
  ...
</context>

</cogdex>
\`\`\`

### \`<protocol>\`
All system prompt pages where \`Include = true\`, sorted by \`Priority\` (ascending). This includes the default protocol. Lower Priority number = read first.

### \`<context>\`
All entry pages where \`Include = true\`, sorted **chronologically ascending** by \`created_time\`. Entries are **not numbered** — order is strictly by creation timestamp. Each \`<entry>\` has two attributes:

| Attribute | Source |
|---|---|
| \`type\` | The \`Type\` select property of the entry row |
| \`title\` | The \`Name\` property of the entry row |

### Entry Types

| Type | Description |
|---|---|
| \`REG USR\` | The user's input, question, or directive for this turn |
| \`REG RES\` | The LLM's answer or output for a User entry |
| \`REG USR CMT\` | A user comment copying feedback from a previous entry |
| \`CNV EXP\` | A persistent, versioned reference document. Multiple Canvas entries can exist, ordered chronologically. The latest Canvas is the most current version. |
| \`REG EXP\` | Machine-generated XML snapshot — never included in context (filtered out) |

---

## Context & Chronology Rules

1. **Read order**: Process \`<protocol>\` first, then \`<context>\` entries in document order (already chronological).
2. **Latest \`REG USR\` entry = current goal**: The last \`<entry type="REG USR">\` in context controls the primary task. If the user appended a direct message after the XML block, that takes precedence.
3. **No reset**: All earlier entries are immutable history. Do not rehash them. Build on top.
4. **No fabrication**: If context is incomplete or ambiguous, state the gap explicitly instead of filling it with assumptions.
5. **Canvas versioning**: Canvas entries are versioned. The **last** \`<entry type="CNV EXP">\` in context is the current ground truth. All earlier Canvas entries are historical snapshots — do not treat them as current.

---

## Default Output: Response Entry

If the XML does NOT start with \`<canvas>\` (meaning it is a regular export), produce a **REG RES** entry.

- Directly answer the user's intent using all relevant context.
- State assumptions clearly where they exist.
- Preserve uncertainty — never fill gaps with confident fabrication.
- If ambiguity is resolvable, choose the most logical path and state your choice. If it blocks progress, formulate structured questions inside the response body.

---

## Strictly Paste-Ready Output Contract

- **No filler openers**: Never start with "Here is your response:", "Sure!", "Of course!", or any meta-commentary.
- **No metadata headers**: Do not prepend filename headers, dates, or wrap the entire output in a triple-backtick code block.
- **No closing pleasantries**: Do not end with "Let me know if you have questions!" or similar.
- **Raw markdown only**: Output must be immediately paste-able into the body of a new Notion entry page.

---

## Canvas Output Mode

If the XML starts with \`<canvas>\` (meaning it is a canvas export), you are in Canvas Mode. Your job is to output a new version of the Canvas.

### Determining the Output Format — Check First

**Before writing anything**, scan \`<context>\` for any \`<entry type="CNV EXP">\` or \`<entry type="CNV RES">\` entry.

| Situation | Correct output |
|---|---|
| **No \`<entry type="CNV EXP">\` or \`<entry type="CNV RES">\` found** | Output the **full Canvas document** — plain markdown, no diff, no code fence wrapper |
| **At least one \`<entry type="CNV EXP">\` or \`<entry type="CNV RES">\` exists** | Output a **git diff only** — never the full document |

> **This check is mandatory and non-negotiable.** If you output a diff when there is no previous Canvas, the backend has nothing to patch against and the operation will fail.

### Rules When No Previous Canvas Exists → Full Document Output

- Write the complete Canvas content as plain markdown.
- Do **not** wrap it in a diff code block.
- Do **not** add \`+\` prefixes to lines.
- This full document will be pasted directly into the blank Notion Canvas page.

### Rules When a Previous Canvas Exists → Git Diff Output

- **ALWAYS output a git diff**, never the full document.
- The diff **MUST** be wrapped in a fenced code block with the \`diff\` language tag:
  \`\`\`diff
  @@ -1,5 +1,7 @@
   unchanged line
  -removed line
  +added line
  +new line
  \`\`\`
- Use **standard unified diff format** (\`-\` for removed, \`+\` for added, \` \` space for context). Do NOT use any other format.
- **Context lines**: Include at least 3 lines of unchanged context before and after each changed region so the patch applicator can locate the correct position.
- **Accuracy**: The \`-\` lines must **exactly match** the content of the corresponding lines in the latest Canvas entry.
- **Scope**: Only include hunks for sections you are actually changing. Do not output a full-file replacement diff unless almost everything changed.
- **Never mix formats**: Do not include both full document content and a diff in the same response.

### What to put in the Canvas

Canvas is the project's persistent reference document. It is **not** a conversation log. Include only:

- Agreed decisions and constraints
- Architecture diagrams or schemas
- Glossaries and definitions
- Key algorithms or data structures
- Current implementation plan or scope

Do **not** include: conversation history, reasoning steps, intermediate drafts, or TODO lists.

---

## Tone & Language

- **Style**: Senior peer explaining to a competent colleague. Direct, structured, practical. Zero motivational fluff.
- **Language**: Match the language of the latest \`REG USR\` entry exactly. If Indonesian → Indonesian. If English → English. If mixed → follow the dominant language of that entry.`;

// Build the full XML context string and return the involved entry/prompt IDs
async function buildXML(thoughtId: string): Promise<{ xml: string; entryIds: string[]; promptIds: string[] }> {
  const [entries, prompts, latestCanvas] = await Promise.all([
    getIncludedEntries(thoughtId),
    getIncludedSystemPrompts(),
    getLatestCanvas(thoughtId),
  ]);



  // Fetch all prompt and entry page contents concurrently to avoid sequential round-trip API delays
  const [promptContents, entryContents, canvasContent] = await Promise.all([
    Promise.all(prompts.map((p) => readPageContent(p.id))),
    Promise.all(entries.map((entry) => readPageContent(entry.id))),
    latestCanvas ? readPageContent(latestCanvas.id) : Promise.resolve(null),
  ]);

  const lines: string[] = [];
  lines.push("<cogdex>");
  lines.push("");
  lines.push("<protocol>");
  lines.push(DEFAULT_PROTOCOL);
  if (promptContents.length > 0) {
    lines.push("");
    lines.push(promptContents.join("\n\n"));
  }
  lines.push("</protocol>");

  lines.push("");
  lines.push("<context>");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const type = entry.properties?.Type?.select?.name ?? "Unknown";
    const title = entry.properties?.Name?.title?.[0]?.plain_text ?? entry.properties?.Title?.title?.[0]?.plain_text ?? "";
    const content = entryContents[i];
    
    const tAttr = title.replace(/"/g, '&quot;');
    
    lines.push(`  <entry type="${type}" title="${tAttr}">`);
    lines.push(content);
    lines.push(`  </entry>`);
  }

  if (latestCanvas && canvasContent) {
    const title = latestCanvas.properties?.Name?.title?.[0]?.plain_text ?? "";
    const tAttr = title.replace(/"/g, '&quot;');
    lines.push(`  <entry type="CNV EXP" title="${tAttr}">`);
    lines.push(canvasContent);
    lines.push(`  </entry>`);
  }
  lines.push("</context>");

  lines.push("");
  lines.push("</cogdex>");

  return {
    xml: lines.join("\n"),
    entryIds: entries.map((e) => e.id),
    promptIds: prompts.map((p) => p.id),
  };
}

// Convert plain XML string into grouped Notion paragraph blocks.
// Instead of splitting line-by-line (which generates double-spacing in Markdown exports
// and takes hundreds of API requests), we group lines into paragraph blocks of up to 1900 characters.
function xmlToNotionBlocks(xml: string): Record<string, unknown>[] {
  const lines = xml.split("\n");
  const blocks: Record<string, unknown>[] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    // If adding this line would exceed the 1900 character safety limit, flush the current chunk first.
    if (currentLength + line.length + 1 > 1900) {
      if (currentChunk.length > 0) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: currentChunk.join("\n") } }],
          },
        });
        currentChunk = [];
        currentLength = 0;
      }
    }

    // If a single line is by itself longer than 1900 characters, chunk it to fit the 1900 limit.
    if (line.length > 1900) {
      let remaining = line;
      while (remaining.length > 0) {
        const piece = remaining.slice(0, 1900);
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: piece } }],
          },
        });
        remaining = remaining.slice(1900);
      }
    } else {
      currentChunk.push(line);
      currentLength += line.length + 1;
    }
  }

  if (currentChunk.length > 0) {
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: currentChunk.join("\n") } }],
      },
    });
  }

  return blocks;
}

export async function exportAndCreate(thoughtId: string, isCanvasExport: boolean = false): Promise<void> {
  const { xml, entryIds, promptIds } = await buildXML(thoughtId);

  // Prepend <canvas> if needed
  const finalXml = isCanvasExport ? `<canvas>\n\n${xml}` : xml;

  // Create the Export entry page
  const { pageId } = await createEntry({
    thoughtId,
    pageType: isCanvasExport ? "CNV EXP" : "REG EXP",
    entriesReferencedIds: entryIds,
    systemPromptsUsedIds: promptIds,
  });

  // Write XML as paragraph blocks to the new page.
  // Notion has a 100-blocks-per-append limit — chunk to stay within it.
  const blocks = xmlToNotionBlocks(finalXml);
  const CHUNK = 100;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    // SDK v5: blocks.children.append is unchanged
    await notion.blocks.children.append({
      block_id: pageId!,
      children: blocks.slice(i, i + CHUNK) as BlockObjectRequest[],
    });
  }
}
