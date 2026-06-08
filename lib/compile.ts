import { notion } from "./notion";
import { createEntry } from "./entries";
import type { BlockObjectRequest } from "@notionhq/client";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;

interface NotionBlock {
  type: string;
  has_children?: boolean;
  id: string;
  [key: string]: unknown;
}

interface NotionRichText {
  plain_text?: string;
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

// The 00-info protocol block — hardcoded, always prepended
const PROTOCOL = `
# Cogdex LLM Protocol

## Purpose
This file is the handshake between Cogdex and the LLM.
Each <entry> below is a structured context file with a type and chronological number.
Types: User (intent/question), Response (LLM reply), Agreement (stable decisions),
Checkpoint (global source of truth), Attachment (external reference).

## Rules
1. Read entries in ascending number order.
2. The latest User entry controls the requested output.
3. Earlier entries are context — do not restart from zero.
4. Match the language of the latest User entry.
5. Write like a senior explaining to a competent peer: direct, structured, practical.
`.trim();

// Read all text content from a Notion page (recursive blocks → plain text)
async function readPageContent(pageId: string): Promise<string> {
  // SDK v5: blocks.children.list is unchanged
  const blocks = await notion.blocks.children.list({ block_id: pageId });
  const lines: string[] = [];

  for (const block of blocks.results as unknown as NotionBlock[]) {
    const type = block.type;
    const data = block[type] as { rich_text?: NotionRichText[] } | undefined;

    if (!data) continue;

    const richText = data.rich_text ?? [];
    const text = richText.map((t) => t.plain_text ?? "").join("");

    if (type === "heading_1") lines.push(`# ${text}`);
    else if (type === "heading_2") lines.push(`## ${text}`);
    else if (type === "heading_3") lines.push(`### ${text}`);
    else if (type === "bulleted_list_item") lines.push(`- ${text}`);
    else if (type === "numbered_list_item") lines.push(`1. ${text}`);
    else if (type === "code") lines.push(`\`\`\`\n${text}\n\`\`\``);
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
        { property: "Type", select: { does_not_equal: "Compile" } },
      ],
    },
  });

  const entries = response.results as unknown as NotionPage[];

  // Sort: entries with Number first (ascending), then null-Number by created_time
  return entries.sort((a, b) => {
    const na: number | null = a.properties?.Number?.number ?? null;
    const nb: number | null = b.properties?.Number?.number ?? null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na - nb;
      // Same number → sort by created_time (branch ordering)
      return new Date(a.created_time).getTime() - new Date(b.created_time).getTime();
    }
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return (
      new Date(a.created_time).getTime() - new Date(b.created_time).getTime()
    );
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

// Build the full XML context string
async function buildXML(thoughtId: string): Promise<string> {
  const [entries, prompts] = await Promise.all([
    getIncludedEntries(thoughtId),
    getIncludedSystemPrompts(),
  ]);

  // Fetch all prompt and entry page contents concurrently to avoid sequential round-trip API delays
  const [promptContents, entryContents] = await Promise.all([
    Promise.all(prompts.map((p) => readPageContent(p.id))),
    Promise.all(entries.map((entry) => readPageContent(entry.id))),
  ]);

  const lines: string[] = [];
  lines.push("<cogdex>");
  lines.push("");
  lines.push("<protocol>");
  lines.push(PROTOCOL);
  lines.push("</protocol>");

  if (prompts.length > 0) {
    lines.push("");
    lines.push("<system_prompts>");
    for (let i = 0; i < prompts.length; i++) {
      const p = prompts[i];
      const name = p.properties?.Name?.title?.[0]?.plain_text ?? "Unnamed";
      const priority = p.properties?.Priority?.number ?? 0;
      const content = promptContents[i];
      lines.push(`  <prompt name="${name}" priority="${priority}">`);
      lines.push(content);
      lines.push(`  </prompt>`);
    }
    lines.push("</system_prompts>");
  }

  lines.push("");
  lines.push("<context>");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const number = entry.properties?.Number?.number ?? "?";
    const type = entry.properties?.Type?.select?.name ?? "Unknown";
    const title = entry.properties?.Name?.title?.[0]?.plain_text ?? entry.properties?.Title?.title?.[0]?.plain_text ?? "";
    const content = entryContents[i];
    lines.push(`  <entry number="${number}" type="${type}" title="${title}">`);
    lines.push(content);
    lines.push(`  </entry>`);
  }
  lines.push("</context>");
  lines.push("");
  lines.push("</cogdex>");

  return lines.join("\n");
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

export async function compileAndCreate(thoughtId: string): Promise<void> {
  const xml = await buildXML(thoughtId);

  // Create the Compile entry page (Number = null)
  const { pageId } = await createEntry({ thoughtId, pageType: "Compile" });

  // Write XML as paragraph blocks to the new page.
  // Notion has a 100-blocks-per-append limit — chunk to stay within it.
  const blocks = xmlToNotionBlocks(xml);
  const CHUNK = 100;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    // SDK v5: blocks.children.append is unchanged
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + CHUNK) as BlockObjectRequest[],
    });
  }
}
