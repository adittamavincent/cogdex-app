import { notion } from "./notion";
import { createEntry, resolveDataSourceId, unwrapCodeFences, isDiff, applyPatch, updateExistingEntryProperties } from "./entries";
import type { BlockObjectRequest } from "@notionhq/client";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;
const MEMORANDUM_DB_ID = process.env.NOTION_MEMORANDUM_DB_ID!;

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
      ],
    },
  });

  const rawEntries = response.results as unknown as NotionPage[];
  
  const excludedTypes = new Set([
    "CHAT EXPO",
    "MEMO EXPO",
    "MEMO RESP",
    "MEMO UPDT",
    "REPO SNAP",
    "SYST LINK"
  ]);

  const entries = rawEntries.filter((e) => {
    const type = e.properties?.Type?.select?.name;
    return type && !excludedTypes.has(type);
  });

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

async function getLatestMemorandum(thoughtId: string): Promise<NotionPage | null> {
  if (!MEMORANDUM_DB_ID) return null;
  const memorandumDbIdResolved = await resolveDataSourceId(MEMORANDUM_DB_ID);
  try {
    const response = await notion.dataSources.query({
      data_source_id: memorandumDbIdResolved,
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
      console.warn("Memorandum DB not found or not shared with integration. Skipping Memorandum export.");
      return null;
    }
    throw err;
  }
}

function getDefaultProtocol(isMemorandumExport: boolean, hasMemorandum: boolean): string {
  const commonHeader = `# Cogdex Operational Protocol

This prompt establishes the protocol between the LLM and the Notion-based Cogdex workspace.
The LLM must read the compiled \`<cogdex>\` XML structure and generate strictly paste-ready, rich-markdown content as the next Notion entry body.

## Context & Chronology Rules
1. Process \`<protocol>\` first, then \`<context>\` entries in chronological order.
2. The last \`<entry type="CHAT USER">\` is the current goal.
3. Earlier entries are immutable history. Do not recreate them.
4. If context is incomplete/ambiguous, state the gap explicitly.
`;

  if (isMemorandumExport) {
    if (hasMemorandum) {
      return `${commonHeader}
## Memorandum Output Mode (Git Diff Required)
A previous Memorandum exists. You MUST output a unified git diff representing the changes to apply to the existing Memorandum.

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
- **Accuracy**: The \`-\` lines must exactly match the content of the corresponding lines in the latest Memorandum entry.
- **Scope**: Include only changed regions.
- **No Full Document**: Do NOT output the full memorandum document. Output ONLY the diff code block.

### Memorandum Content Rules
Include: agreed decisions, constraints, architecture, schemas, glossaries, key algorithms, scope/plan.
Do NOT include: conversation history, reasoning, drafts, or TODO lists.
`;
    } else {
      return `${commonHeader}
## Memorandum Output Mode (Full Document or Git Diff)
If a Memorandum has ALREADY been created/defined in this chat session OR is present in the <context> below (e.g. as a MEMO RESP/MEMO EXPO entry), you MUST output a unified git diff representing the changes.
Otherwise (if this is the absolute first Memorandum initialization and no Memorandum exists in history/chat memory yet), you MUST output the full Memorandum document.

### Option A: Full Document (First Time Only)
- Output the complete Memorandum content as plain markdown.
- Do NOT wrap it in a diff block or code block.
- Do NOT add \`+\` prefixes.
- This will be pasted directly into the blank Notion Memorandum page.

### Option B: Git Diff (If Memorandum Already Exists in Memory/Context)
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
- **Accuracy**: The \`-\` lines must exactly match the content of the corresponding lines in the latest Memorandum entry.
- **Scope**: Include only changed regions.
- **No Full Document**: Do NOT output the full memorandum document. Output ONLY the diff code block.

### Memorandum Content Rules
Include: agreed decisions, constraints, architecture, schemas, glossaries, key algorithms, scope/plan.
Do NOT include: conversation history, reasoning, drafts, or TODO lists.
`;
    }
  } else {
    return `${commonHeader}
## Default Output: Response Entry (CHAT RESP)
Produce a regular response entry answering the user's intent.

### Strictly Paste-Ready Output Contract
- **No filler/pleasantries**: Never start with "Here is your response:", "Sure!", "Of course!", etc. Do not end with "Let me know if you have questions!".
- **No metadata headers**: Do not prepend filename headers, dates, or wrap the entire output in a triple-backtick block.
- **Raw markdown only**: Immediate paste-able into a Notion page body.

### Tone & Language
- **Style**: Senior peer explaining to a colleague. Direct, structured, practical.
- **Language**: Match the language of the latest \`CHAT USER\` entry exactly.
`;
  }
}

// Fetch the latest memorandum content, falling back to reconstructing from Entries DB if Memorandum DB doesn't have it.
async function getMemorandumContent(thoughtId: string, latestMemorandumPage: NotionPage | null): Promise<{ content: string; title: string } | null> {
  if (latestMemorandumPage) {
    try {
      const memorandumContent = await readPageContent(latestMemorandumPage.id);
      if (memorandumContent && memorandumContent.trim()) {
        const title = latestMemorandumPage.properties?.Name?.title?.[0]?.plain_text ?? latestMemorandumPage.properties?.Title?.title?.[0]?.plain_text ?? "Memorandum";
        return { content: memorandumContent.trim(), title };
      }
    } catch (err) {
      console.warn(`Failed to read memorandum page ${latestMemorandumPage.id}, falling back to Entries DB:`, err);
    }
  }

  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      property: "Project",
      relation: { contains: thoughtId }
    }
  });

  const memorandumEntries = (response.results as unknown as NotionPage[]).filter((entry) => {
    const type = entry.properties?.Type?.select?.name;
    return type === "MEMO RESP" || type === "MEMO EXPO" || type === "MEMO UPDT";
  });

  if (memorandumEntries.length === 0) {
    return null;
  }

  memorandumEntries.sort((a, b) => {
    const nameA = a.properties?.Name?.title?.[0]?.plain_text ?? a.properties?.Title?.title?.[0]?.plain_text ?? "";
    const nameB = b.properties?.Name?.title?.[0]?.plain_text ?? b.properties?.Title?.title?.[0]?.plain_text ?? "";
    const numA = parseInt(nameA.match(/\d+/)?.[0] ?? "0", 10);
    const numB = parseInt(nameB.match(/\d+/)?.[0] ?? "0", 10);
    return numA - numB;
  });

  let currentContent = "";
  let latestTitle = "Memorandum";

  for (const entry of memorandumEntries) {
    const name = entry.properties?.Name?.title?.[0]?.plain_text ?? entry.properties?.Title?.title?.[0]?.plain_text ?? "";
    if (name) latestTitle = name;

    const type = entry.properties?.Type?.select?.name;
    const content = await readPageContent(entry.id);

    if (type === "MEMO EXPO") {
      const match = content.match(/<entry\s+type="MEMO"[^>]*>([\s\S]*?)<\/entry>/);
      currentContent = match ? match[1].trim() : "";
    } else {
      const unwrapped = unwrapCodeFences(content);
      if (isDiff(unwrapped)) {
        const patchedLines = applyPatch(currentContent, unwrapped);
        currentContent = patchedLines.map(l => l.text).join("\n");
      } else {
        currentContent = unwrapped;
      }
    }
  }

  if (currentContent.trim()) {
    return { content: currentContent, title: latestTitle };
  }

  return null;
}

async function getLatestRepoSnap(thoughtId: string): Promise<string | null> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      and: [
        { property: "Project", relation: { contains: thoughtId } },
        { property: "Type", select: { equals: "REPO SNAP" } },
        { property: "Include", checkbox: { equals: true } }
      ]
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1
  });
  if (response.results.length === 0) return null;
  const pageId = (response.results[0] as NotionPage).id;
  return await readPageContent(pageId);
}

// Build the full XML context string and return the involved entry/prompt IDs
async function buildXML(thoughtId: string, isMemorandumExport: boolean = false): Promise<{ xml: string; entryIds: string[]; promptIds: string[] }> {
  const [entries, prompts, latestMemorandum, latestRepoSnap] = await Promise.all([
    getIncludedEntries(thoughtId),
    getIncludedSystemPrompts(),
    getLatestMemorandum(thoughtId),
    getLatestRepoSnap(thoughtId),
  ]);

  // Fetch all prompt and entry page contents concurrently to avoid sequential round-trip API delays
  const [promptContents, entryContents, memorandumContentObj] = await Promise.all([
    Promise.all(prompts.map((p) => readPageContent(p.id))),
    Promise.all(entries.map((entry) => readPageContent(entry.id))),
    getMemorandumContent(thoughtId, latestMemorandum),
  ]);

  const lines: string[] = [];
  lines.push("<cogdex>");
  lines.push("");
  lines.push("<protocol>");
  const hasMemorandum = (latestMemorandum !== null) || (memorandumContentObj !== null) || entries.some((e) => e.properties?.Type?.select?.name === "MEMO RESP");
  lines.push(getDefaultProtocol(isMemorandumExport, hasMemorandum));
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

  if (memorandumContentObj) {
    const tAttr = memorandumContentObj.title.replace(/"/g, '&quot;');
    lines.push(`  <entry type="MEMO" title="${tAttr}">`);
    lines.push(memorandumContentObj.content);
    lines.push(`  </entry>`);
  }
  lines.push("</context>");

  if (latestRepoSnap) {
    lines.push("");
    lines.push("<codebase>");
    lines.push(latestRepoSnap);
    lines.push("</codebase>");
  }

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

export async function exportAndCreate(
  thoughtId: string,
  isMemorandumExport: boolean = false,
  existingEntryId?: string
): Promise<void> {
  const { xml, entryIds, promptIds } = await buildXML(thoughtId, isMemorandumExport);

  // Prepend <memorandum> if needed
  const finalXml = isMemorandumExport ? `<memorandum>\n\n${xml}` : xml;

  let pageId = existingEntryId;
  if (pageId) {
    await updateExistingEntryProperties({
      entryId: pageId,
      projectId: thoughtId,
      pageType: isMemorandumExport ? "MEMO EXPO" : "CHAT EXPO",
      entriesReferencedIds: entryIds,
      systemPromptsUsedIds: promptIds,
    });
  } else {
    // Create the Export entry page
    const res = await createEntry({
      thoughtId,
      pageType: isMemorandumExport ? "MEMO EXPO" : "CHAT EXPO",
      entriesReferencedIds: entryIds,
      systemPromptsUsedIds: promptIds,
    });
    pageId = res.pageId;
  }

  if (pageId) {
    // Write XML as paragraph blocks to the new page.
    // Notion has a 100-blocks-per-append limit — chunk to stay within it.
    const blocks = xmlToNotionBlocks(finalXml);
    const CHUNK = 100;
    for (let i = 0; i < blocks.length; i += CHUNK) {
      // SDK v5: blocks.children.append is unchanged
      await notion.blocks.children.append({
        block_id: pageId,
        children: blocks.slice(i, i + CHUNK) as BlockObjectRequest[],
      });
    }
  }
}
