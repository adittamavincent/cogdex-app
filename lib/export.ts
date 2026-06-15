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
      else lines.push(text);
    }
    else if (type === "quote") lines.push(`> ${text}`);
    else if (type === "divider") lines.push(`---`);
    else if (type === "table") {
      const tableRows = await notion.blocks.children.list({ block_id: block.id });
      const rowStrings = tableRows.results.map((rowBlock: any) => {
        const cells = rowBlock.table_row?.cells || [];
        const cellStrings = cells.map((cell: any) => {
          return cell.map((t: any) => t.plain_text).join("");
        });
        return `| ${cellStrings.join(" | ")} |`;
      });
      if (rowStrings.length > 0) {
        if ((data as any).has_column_header) {
          const colCount = (tableRows.results[0] as any).table_row?.cells?.length || 0;
          const separator = `| ${Array(colCount).fill("---").join(" | ")} |`;
          lines.push([rowStrings[0], separator, ...rowStrings.slice(1)].join("\n"));
        } else {
          lines.push(rowStrings.join("\n"));
        }
      }
    }
    else if (text) lines.push(text);

    // Recurse into children if present
    if (block.has_children && type !== "table") {
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

function getDefaultProtocol(isCanvasExport: boolean, hasCanvas: boolean): string {
  const commonHeader = `# Cogdex Operational Protocol

This prompt establishes the protocol between the LLM and the Notion-based Cogdex workspace.
The LLM must read the compiled \`<cogdex>\` XML structure and generate strictly paste-ready, rich-markdown content as the next Notion entry body.

## Context & Chronology Rules
1. Process \`<protocol>\` first, then \`<context>\` entries in chronological order.
2. The last \`<entry type="REG USR">\` is the current goal.
3. Earlier entries are immutable history. Do not recreate them.
4. If context is incomplete/ambiguous, state the gap explicitly.
`;

  if (isCanvasExport) {
    if (hasCanvas) {
      return `${commonHeader}
## Canvas Output Mode (Git Diff Required)
A previous Canvas exists. You MUST output a unified git diff representing the changes to apply to the existing Canvas.

### Strictly Paste-Ready Unified Diff Contract
- **Fenced Code Block ONLY**: The diff MUST be wrapped in a code block with the \`diff\` language tag:
  \`\`\`diff
  @@ -1,5 +1,7 @@
   unchanged line
  -removed line
  +added line
  +new line
  \`\`\`
- **Unified Diff Format**: Use \`-\` for removed, \`+\` for added, \` \` (space) for unchanged context lines.
- **Context Lines**: Include at least 3 lines of unchanged context before/after each change.
- **Accuracy**: The \`-\` lines must exactly match the content of the corresponding lines in the latest Canvas entry.
- **Scope**: Include only changed regions.
- **No Full Document**: Do NOT output the full canvas document. Output ONLY the diff code block.

### Canvas Content Rules
Include: agreed decisions, constraints, architecture, schemas, glossaries, key algorithms, scope/plan.
Do NOT include: conversation history, reasoning, drafts, or TODO lists.
`;
    } else {
      return `${commonHeader}
## Canvas Output Mode (Full Document Required)
No previous Canvas exists. You MUST output the full Canvas document.

### Strictly Paste-Ready Contract
- Output the complete Canvas content as plain markdown.
- Do NOT wrap it in a diff block or code block.
- Do NOT add \`+\` prefixes.
- This will be pasted directly into the blank Notion Canvas page.

### Canvas Content Rules
Include: agreed decisions, constraints, architecture, schemas, glossaries, key algorithms, scope/plan.
Do NOT include: conversation history, reasoning, drafts, or TODO lists.
`;
    }
  } else {
    return `${commonHeader}
## Default Output: Response Entry (REG RES)
Produce a regular response entry answering the user's intent.

### Strictly Paste-Ready Output Contract
- **No filler/pleasantries**: Never start with "Here is your response:", "Sure!", "Of course!", etc. Do not end with "Let me know if you have questions!".
- **No metadata headers**: Do not prepend filename headers, dates, or wrap the entire output in a triple-backtick block.
- **Raw markdown only**: Immediate paste-able into a Notion page body.

### Tone & Language
- **Style**: Senior peer explaining to a colleague. Direct, structured, practical.
- **Language**: Match the language of the latest \`REG USR\` entry exactly.
`;
  }
}

// Build the full XML context string and return the involved entry/prompt IDs
async function buildXML(thoughtId: string, isCanvasExport: boolean = false): Promise<{ xml: string; entryIds: string[]; promptIds: string[] }> {
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
  lines.push(getDefaultProtocol(isCanvasExport, latestCanvas !== null));
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
  const { xml, entryIds, promptIds } = await buildXML(thoughtId, isCanvasExport);

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
