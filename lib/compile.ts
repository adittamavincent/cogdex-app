import { notion } from "./notion";
import { createEntry } from "./entries";

const ENTRIES_DB_ID = process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;

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

  for (const block of blocks.results as any[]) {
    const type = block.type as string;
    const data = block[type];

    if (!data) continue;

    const richText = data.rich_text ?? [];
    const text = richText.map((t: any) => t.plain_text ?? "").join("");

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
    data_source_id: ENTRIES_DB_ID,
    filter: {
      and: [
        { property: "Thought Management", relation: { contains: thoughtId } },
        { property: "Include", checkbox: { equals: true } },
        { property: "Type", select: { does_not_equal: "Compile" } },
      ],
    },
  });

  const entries = response.results as any[];

  // Sort: entries with Number first (ascending), then null-Number by created_time
  return entries.sort((a, b) => {
    const na: number | null = a.properties?.Number?.number ?? null;
    const nb: number | null = b.properties?.Number?.number ?? null;
    if (na !== null && nb !== null) return na - nb;
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
  return response.results as any[];
}

// Build the full XML context string
async function buildXML(thoughtId: string): Promise<string> {
  const [entries, prompts] = await Promise.all([
    getIncludedEntries(thoughtId),
    getIncludedSystemPrompts(),
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
    for (const p of prompts) {
      const name = p.properties?.Name?.title?.[0]?.plain_text ?? "Unnamed";
      const priority = p.properties?.Priority?.number ?? 0;
      const content = await readPageContent(p.id);
      lines.push(`  <prompt name="${name}" priority="${priority}">`);
      lines.push(content);
      lines.push(`  </prompt>`);
    }
    lines.push("</system_prompts>");
  }

  lines.push("");
  lines.push("<context>");
  for (const entry of entries) {
    const number = entry.properties?.Number?.number ?? "?";
    const type = entry.properties?.Type?.select?.name ?? "Unknown";
    const title = entry.properties?.Title?.title?.[0]?.plain_text ?? "";
    const content = await readPageContent(entry.id);
    lines.push(`  <entry number="${number}" type="${type}" title="${title}">`);
    lines.push(content);
    lines.push(`  </entry>`);
  }
  lines.push("</context>");
  lines.push("");
  lines.push("</cogdex>");

  return lines.join("\n");
}

// Convert plain XML string into Notion paragraph blocks
function xmlToNotionBlocks(xml: string): any[] {
  return xml.split("\n").map((line) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: line } }],
    },
  }));
}

export async function compileAndCreate(thoughtId: string): Promise<void> {
  const xml = await buildXML(thoughtId);

  // Create the Compile entry page (Number = null)
  const pageId = await createEntry({ thoughtId, pageType: "Compile" });

  // Write XML as paragraph blocks to the new page.
  // Notion has a 100-blocks-per-append limit — chunk to stay within it.
  const blocks = xmlToNotionBlocks(xml);
  const CHUNK = 100;
  for (let i = 0; i < blocks.length; i += CHUNK) {
    // SDK v5: blocks.children.append is unchanged
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + CHUNK),
    });
  }
}
