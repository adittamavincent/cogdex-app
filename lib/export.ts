import { notion } from "./notion";
import { createEntry } from "./entries";
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
  const response = await notion.dataSources.query({
    data_source_id: ENTRY_DB_ID,
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
  const response = await notion.dataSources.query({
    data_source_id: SYSTEM_PROMPT_DB_ID,
    filter: { property: "Include", checkbox: { equals: true } },
    sorts: [{ property: "Priority", direction: "ascending" }],
  });
  return response.results as unknown as NotionPage[];
}

async function getLatestCanvas(thoughtId: string): Promise<NotionPage | null> {
  if (!CANVAS_DB_ID) return null;
  const response = await notion.dataSources.query({
    data_source_id: CANVAS_DB_ID,
    filter: {
      property: "Project",
      relation: { contains: thoughtId }
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1
  });
  if (response.results.length === 0) return null;
  return response.results[0] as unknown as NotionPage;
}

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
  lines.push(promptContents.join("\n\n"));
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
