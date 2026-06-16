import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";
import { readPageContent } from "./export";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;
const MEMORANDUM_DB_ID = process.env.NOTION_MEMORANDUM_DB_ID!;

const resolvedIds = new Map<string, string>();

export async function resolveDataSourceId(dbId: string): Promise<string> {
  if (!dbId) return dbId;
  if (resolvedIds.has(dbId)) return resolvedIds.get(dbId)!;
  try {
    const db = await notion.databases.retrieve({ database_id: dbId }) as any;
    if (db && db.data_sources && db.data_sources.length > 0) {
      const dsId = db.data_sources[0].id;
      resolvedIds.set(dbId, dsId);
      return dsId;
    }
  } catch (err) {
    // fallback
  }
  resolvedIds.set(dbId, dbId);
  return dbId;
}

interface NotionPage {
  id: string;
  properties?: Record<string, {
    checkbox?: boolean;
    number?: number | null;
    title?: Array<{ plain_text?: string }>;
    select?: { name?: string } | null;
    relation?: Array<{ id: string }>;
  }>;
  icon?: {
    type: "emoji" | "external" | "file";
    emoji?: string;
    external?: { url: string };
    file?: { url: string };
  } | null;
}

const EMOJIS = [
  "🌿", "🌸", "🍁", "🍄", "🌴", "🌵", "🌶️", "🍇", "🥑", "🍋",
  "⭐", "🔥", "⚡", "💧", "🌈", "🌊", "❄️", "🌀", "🔮", "💎",
  "🤖", "👾", "🚀", "🛸", "🦖", "🦊", "🐙", "🦉", "🦁", "🦄",
  "🎨", "🎭", "🎪", "🎸", "🎯", "🧩", "🎲", "🎬", "🎤", "🛹",
  "🧭", "🔭", "🕯️", "🔑", "🛡️", "🧬", "🧪", "⚙️", "🔋", "🔔"
];

// Page body templates per Type
const TEMPLATES: Record<PageType, string> = {
  "CHAT USER": "",
  "CHAT RESP": "",
  "MEMO EXPO": "",
  "MEMO RESP": "",
  "CHAT EXPO": "",
  "CHAT CMNT": "",
  "SYST LINK": "",
  "MEMO UPDT": "",
  "REPO SNAP": "",
};

export function findProperty(properties: Record<string, any>, name: string): any {
  const targetKey = name.toLowerCase().replace(/\s+/g, "");
  const matchedKey = Object.keys(properties).find(
    (k) => k.toLowerCase().replace(/\s+/g, "") === targetKey
  );
  return matchedKey ? properties[matchedKey] : null;
}

async function getNextEntryNumber(projectId: string, excludeEntryId?: string): Promise<number> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: { property: "Project", relation: { contains: projectId } },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 30,
  });

  for (const entry of response.results) {
    if (excludeEntryId && entry.id === excludeEntryId) {
      continue;
    }
    const nameProp = findProperty((entry as any).properties || {}, "Name");
    const title = nameProp?.title?.[0]?.plain_text?.trim() ?? "";
    if (/^\d+$/.test(title)) {
      const num = parseInt(title, 10);
      if (!isNaN(num)) {
        return num + 1;
      }
    }
  }

  return 1;
}

export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
  entriesReferencedIds?: string[];
  systemPromptsUsedIds?: string[];
}): Promise<{ pageId?: string; ignored?: boolean }> {
  const { thoughtId, pageType } = params;
  const isExport = pageType === "CHAT EXPO";

  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);

  const nextNumber = await getNextEntryNumber(thoughtId);

  const excludedFromInclude = new Set([
    "CHAT EXPO",
    "MEMO EXPO",
    "MEMO RESP",
    "REPO SNAP",
    "MEMO UPDT",
    "SYST LINK"
  ]);

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: String(nextNumber) } }] },
    Type: { select: { name: pageType } },
    Include: { checkbox: !excludedFromInclude.has(pageType) },
    Project: { relation: [{ id: thoughtId }] },
  };

  if (params.entriesReferencedIds && params.entriesReferencedIds.length > 0) {
    properties["Entries Referenced"] = {
      relation: params.entriesReferencedIds.map((id) => ({ id })),
    };
  }

  if (params.systemPromptsUsedIds && params.systemPromptsUsedIds.length > 0) {
    properties["System Prompt Used"] = {
      relation: params.systemPromptsUsedIds.map((id) => ({ id })),
    };
  }

  const blocksToAppend = (!isExport && pageType !== "MEMO EXPO") ? markdownToNotionBlocks(TEMPLATES[pageType]) : [];

  const createPayload: any = {
    parent: { data_source_id: entryDbId },
    properties,
    children: blocksToAppend,
  };

  const page = await notion.pages.create(createPayload);
  return { pageId: page.id, ignored: false };
}

export async function updateExistingEntryProperties(params: {
  entryId: string;
  projectId: string;
  pageType: PageType;
  entriesReferencedIds?: string[];
  systemPromptsUsedIds?: string[];
  pageObj?: any;
}): Promise<void> {
  const { entryId, projectId, pageType } = params;
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);

  const resolvedPageObj = (params.pageObj && params.pageObj.id === entryId)
    ? params.pageObj
    : (await notion.pages.retrieve({ page_id: entryId }));
  const currentNameProp = findProperty(resolvedPageObj.properties || {}, "Name");
  const currentName = currentNameProp?.title?.[0]?.plain_text ?? "";

  const excludedFromInclude = new Set([
    "CHAT EXPO",
    "MEMO EXPO",
    "MEMO RESP",
    "REPO SNAP",
    "MEMO UPDT",
    "SYST LINK"
  ]);

  const properties: Record<string, unknown> = {
    Type: { select: { name: pageType } },
    Include: { checkbox: !excludedFromInclude.has(pageType) },
  };

  if (!/^\d+$/.test(currentName.trim())) {
    const nextNumber = await getNextEntryNumber(projectId, entryId);
    properties.Name = { title: [{ text: { content: String(nextNumber) } }] };
  }

  if (params.entriesReferencedIds && params.entriesReferencedIds.length > 0) {
    properties["Entries Referenced"] = {
      relation: params.entriesReferencedIds.map((id) => ({ id })),
    };
  }

  if (params.systemPromptsUsedIds && params.systemPromptsUsedIds.length > 0) {
    properties["System Prompt Used"] = {
      relation: params.systemPromptsUsedIds.map((id) => ({ id })),
    };
  }

  await notion.pages.update({
    page_id: entryId,
    properties: properties as any,
  });
}

export async function findRecentEmptyEntry(projectId: string, pageType: PageType): Promise<string | undefined> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      and: [
        { property: "Project", relation: { contains: projectId } },
        { property: "Type", select: { equals: pageType } }
      ]
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1
  });

  if (response.results.length === 0) return undefined;

  const latestEntry = response.results[0] as any;
  const nameProp = findProperty(latestEntry.properties || {}, "Name");
  const latestName = nameProp?.title?.[0]?.plain_text ?? "";

  if (!/^\d+$/.test(latestName.trim())) {
    return latestEntry.id;
  }

  return undefined;
}

// Minimal markdown-to-Notion-blocks converter for templates.
// Only handles headings (##) and paragraphs — intentionally minimal.
function markdownToNotionBlocks(md: string): Record<string, unknown>[] {
  const lines = md.split("\n");
  const blocks: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: line.slice(3) } }],
        },
      });
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line } }],
        },
      });
    }
  }

  return blocks;
}

export async function handleSystemLink(thoughtId: string): Promise<void> {
  debug(`Starting handleSystemLink for page ${thoughtId}`);

  // 1. Fetch original view configurations to clone sorting/ordering/formatting
  const ORIGINAL_ENTRY_VIEW_ID = process.env.NOTION_ENTRY_VIEW_ID;
  const ORIGINAL_SYSTEM_PROMPT_VIEW_ID = process.env.NOTION_SYSTEM_PROMPT_VIEW_ID;
  const ORIGINAL_MEMORANDUM_VIEW_ID = process.env.NOTION_MEMORANDUM_VIEW_ID;

  if (!ORIGINAL_ENTRY_VIEW_ID || !ORIGINAL_SYSTEM_PROMPT_VIEW_ID || !ORIGINAL_MEMORANDUM_VIEW_ID) {
    throw new Error(
      "Missing required view ID environment variables: NOTION_ENTRY_VIEW_ID, NOTION_SYSTEM_PROMPT_VIEW_ID, NOTION_MEMORANDUM_VIEW_ID"
    );
  }

  debug(`Fetching original views: Entry=${ORIGINAL_ENTRY_VIEW_ID}, SystemPrompt=${ORIGINAL_SYSTEM_PROMPT_VIEW_ID}, Memorandum=${ORIGINAL_MEMORANDUM_VIEW_ID}`);
  const [entryView, systemPromptView, memorandumView] = await Promise.all([
    notion.views.retrieve({ view_id: ORIGINAL_ENTRY_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_SYSTEM_PROMPT_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_MEMORANDUM_VIEW_ID }),
  ]);

  // 2. Wipe clean all blocks inside the current page
  try {
    await (notion.pages.update as any)({
      page_id: thoughtId,
      erase_content: true
    });
  } catch (err) {
    warn("Failed to use erase_content, falling back to manual block deletion", err);
    let hasMore = true;
    let startCursor: string | undefined = undefined;

    while (hasMore) {
      const listResponse = await notion.blocks.children.list({
        block_id: thoughtId,
        start_cursor: startCursor,
      });

      if (listResponse.results.length > 0) {
        await Promise.all(
          listResponse.results.map((block) =>
            notion.blocks.delete({ block_id: block.id })
          )
        );
      }

      hasMore = listResponse.has_more;
      startCursor = listResponse.next_cursor ?? undefined;
    }
  }
  debug("Wiped clean all blocks inside project page");

  // 3. (Branch logic removed)

  // 4. Helper to create view cloned from original
  const createClonedView = async (
    originalView: any,
    fallbackDataSourceId: string,
    modifyFilter?: (filter: any) => any
  ) => {
    const dataSourceId = originalView.data_source_id || fallbackDataSourceId;
    const name = originalView.name || "View";
    const type = originalView.type || "table";
    const sorts = originalView.sorts || undefined;
    let configuration = originalView.configuration ? JSON.parse(JSON.stringify(originalView.configuration)) : undefined;
    let dbProperties: any = {};
    try {
      debug(`Retrieving actual schema for data source ${dataSourceId} to sanitize property configurations`);
      const db = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as any;
      dbProperties = db.properties || {};
      const validPropertyIds = new Set(
        Object.values(db.properties).flatMap((prop: any) => [
          prop.id,
          decodeURIComponent(prop.id),
          encodeURIComponent(prop.id),
        ])
      );
      validPropertyIds.add("title");

      if (configuration && configuration.properties && Array.isArray(configuration.properties)) {
        configuration.properties = configuration.properties.filter((p: any) => {
          if (!p.property_id) return false;
          const decoded = decodeURIComponent(p.property_id);
          const encoded = encodeURIComponent(p.property_id);
          return (
            validPropertyIds.has(p.property_id) ||
            validPropertyIds.has(decoded) ||
            validPropertyIds.has(encoded)
          );
        });
        debug(`Sanitized properties list: kept ${configuration.properties.length} valid properties`);
      }
    } catch (schemaErr) {
      warn(`Could not retrieve schema for data source ${dataSourceId} to sanitize configuration:`, schemaErr);
    }

    if (!configuration) {
      configuration = { properties: [] };
    }
    if (!configuration.properties || !Array.isArray(configuration.properties)) {
      configuration.properties = [];
    }

    if (fallbackDataSourceId === MEMORANDUM_DB_ID) {
      const repoUrlKey = Object.keys(dbProperties).find(
        (key) => key.toLowerCase().trim() === "repo url"
      );
      if (repoUrlKey) {
        const repoUrlId = dbProperties[repoUrlKey].id;
        const repoUrlProp = configuration.properties.find(
          (p: any) => p.property_id === repoUrlId || (p.property_name && p.property_name.toLowerCase().trim() === "repo url")
        );
        if (repoUrlProp) {
          repoUrlProp.visible = true;
        } else {
          configuration.properties.push({
            property_id: repoUrlId,
            property_name: repoUrlKey,
            visible: true,
            width: 200
          });
        }
      }
    }

    let titleProp = configuration.properties.find((p: any) => p.property_id === "title");
    if (!titleProp) {
      titleProp = {
        property_id: "title",
        property_name: "Name",
        visible: true,
        width: 100
      };
      configuration.properties.push(titleProp);
    }

    for (const prop of configuration.properties) {
      const propId = prop.property_id;
      const propName = (prop.property_name || "").trim();
      const propNameLower = propName.toLowerCase();

      if (fallbackDataSourceId === ENTRY_DB_ID) {
        if (propId === "title" || propNameLower === "name") {
          prop.width = 125;
          prop.visible = true;
        } else if (propNameLower === "type") {
          prop.width = 125;
        } else if (propNameLower === "created time") {
          prop.visible = false;
        } else if (propNameLower === "project") {
          prop.visible = false;
        } else if (propNameLower === "entries referenced") {
          prop.width = 100;
        } else if (propNameLower === "related back to entry") {
          prop.width = 100;
        } else if (propNameLower === "system prompt used") {
          prop.width = 100;
        } else if (propNameLower === "include") {
          prop.width = 32;
        }
      } else if (fallbackDataSourceId === MEMORANDUM_DB_ID) {
        if (propId === "title" || propNameLower === "name") {
          prop.width = 100;
        } else if (propNameLower === "project") {
          prop.visible = false;
        } else if (propNameLower === "repo url") {
          prop.visible = true;
        }
      } else if (fallbackDataSourceId === SYSTEM_PROMPT_DB_ID) {
        if (propId === "title" || propNameLower === "name") {
          prop.width = 150;
        } else if (propNameLower === "include") {
          prop.width = 32;
        } else if (propNameLower === "priority") {
          prop.width = 100;
        } else if (propNameLower === "created time") {
          prop.visible = false;
        }
      }
    }

    let filter = originalView.filter || undefined;
    if (modifyFilter) {
      filter = modifyFilter(filter);
    }

    await notion.views.create({
      data_source_id: dataSourceId,
      name,
      type,
      create_database: {
        parent: {
          type: "page_id",
          page_id: thoughtId,
        },
      },
      filter,
      sorts,
      configuration,
    } as any);
  };

  // Modifier to enforce scoping to current project
  const projectFilterModifier = (origFilter: any) => {
    const projectFilter = {
      property: "Project",
      relation: {
        contains: thoughtId,
      },
    };
    if (!origFilter) {
      return projectFilter;
    }
    return {
      and: [
        projectFilter,
        origFilter,
      ],
    };
  };

  // 5. Create the cloned views sequentially

  debug("Creating cloned Memorandum database view");
  await createClonedView(memorandumView, MEMORANDUM_DB_ID, projectFilterModifier);

  debug("Creating cloned Entry database view");
  await createClonedView(entryView, ENTRY_DB_ID, projectFilterModifier);

  debug("Creating cloned System Prompt database view");
  await createClonedView(systemPromptView, SYSTEM_PROMPT_DB_ID);

  debug(`Successfully finished handleSystemLink for page ${thoughtId}`);
}

export function isDiff(content: string): boolean {
  return /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(content);
}

interface Hunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  lines: string[];
}

export function unwrapCodeFences(text: string): string {
  let trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // 1. If the entire string is a code fence, unwrap it.
  const exactMatch = trimmed.match(/^`{3,}(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n`{3,}$/);
  if (exactMatch) {
    return exactMatch[1];
  }

  // 2. If there is conversational text but it contains a diff inside a code block, extract the diff.
  const partialMatch = trimmed.match(/`{3,}(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n`{3,}/);
  if (partialMatch && isDiff(partialMatch[1])) {
    return partialMatch[1];
  }

  // 3. Otherwise, return the original text (preserves full documents containing code blocks).
  return trimmed;
}

export function parseDiff(diffText: string): Hunk[] {
  const content = unwrapCodeFences(diffText);
  const lines = content.split(/\r?\n/);
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const line of lines) {
    const hunkHeaderMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkHeaderMatch) {
      if (currentHunk) {
        while (currentHunk.lines.length > 0 && currentHunk.lines[currentHunk.lines.length - 1].trim() === "") {
          currentHunk.lines.pop();
        }
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkHeaderMatch[1], 10),
        oldLength: hunkHeaderMatch[2] ? parseInt(hunkHeaderMatch[2], 10) : 1,
        newStart: parseInt(hunkHeaderMatch[3], 10),
        newLength: hunkHeaderMatch[4] ? parseInt(hunkHeaderMatch[4], 10) : 1,
        lines: [],
      };
    } else if (currentHunk) {
      if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "" || line.startsWith("\\")) {
        currentHunk.lines.push(line);
      } else {
        if (!line.startsWith("diff ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) {
          currentHunk.lines.push(" " + line);
        }
      }
    }
  }
  if (currentHunk) {
    while (currentHunk.lines.length > 0 && currentHunk.lines[currentHunk.lines.length - 1].trim() === "") {
      currentHunk.lines.pop();
    }
    hunks.push(currentHunk);
  }
  return hunks;
}

// Code fence lines — must be handled transparently when LLMs omit them from diff context.
// They are skipped when matching prose lines and re-emitted in the output unchanged.
export function isCodeFenceLine(trimmed: string): boolean {
  return /^`{3,}/.test(trimmed);
}

// Structural lines that require EXACT match when they appear in the diff context.
// These lines must not be fuzzy-normalized since their normalized form is ambiguous.
function isExactMatchStructural(trimmed: string): boolean {
  // Code fence: ``` or ```lang
  if (/^`{3,}/.test(trimmed)) return true;
  // Horizontal rule / front-matter divider (only pure --- *** ___ patterns)
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true;
  // Table separator row: | --- | --- |
  if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed)) return true;
  return false;
}

export function normalizeText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^#{1,6}\s+/, "")  // strip heading markers (## Repository → repository)
    .replace(/[*_~`]/g, "")    // remove bold, italic, strikethrough, inline code
    .replace(/^[-*+]\s+/, "")   // remove bullet markers
    .replace(/^\d+\.\s+/, "")   // remove numbered list prefix
    .replace(/\s+/g, " ");      // collapse spaces
}

// ── Structural Block Parser ─────────────────────────────────────────────────
// Parses markdown into structural blocks where tables and code blocks are
// atomic units. This prevents line-based diffing from fragmenting tables
// and code blocks across block boundaries.

interface StructuralBlock {
  kind: "heading" | "paragraph" | "table" | "code" | "divider" | "blank";
  content: string;       // raw markdown content (full table, full code block, etc.)
  startLine: number;     // 0-indexed start line in the original markdown
  endLine: number;       // 0-indexed exclusive end line
  headingLevel?: number; // 1-6 for heading blocks
}

/**
 * Parse markdown into structural blocks. Tables and code blocks are treated
 * as atomic units — all their lines belong to a single block.
 */
function parseStructuralBlocks(markdown: string): StructuralBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: StructuralBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line
    if (trimmed === "") {
      blocks.push({ kind: "blank", content: "", startLine: i, endLine: i + 1 });
      i++;
      continue;
    }

    // Code block (fenced)
    const codeStartMatch = trimmed.match(/^(`{3,})(.*)$/);
    if (codeStartMatch) {
      const fence = codeStartMatch[1];
      const fenceLen = fence.length;
      const startLine = i;
      i++; // skip opening fence
      while (i < lines.length) {
        const closeMatch = lines[i].trim().match(/^(`{3,})/);
        if (closeMatch && closeMatch[1].length >= fenceLen) {
          i++; // skip closing fence
          break;
        }
        i++;
      }
      blocks.push({
        kind: "code",
        content: lines.slice(startLine, i).join("\n"),
        startLine,
        endLine: i,
      });
      continue;
    }

    // Table (line starting and ending with |)
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const startLine = i;
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        i++;
      }
      blocks.push({
        kind: "table",
        content: lines.slice(startLine, i).join("\n"),
        startLine,
        endLine: i,
      });
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        content: line,
        startLine: i,
        endLine: i + 1,
        headingLevel: headingMatch[1].length,
      });
      i++;
      continue;
    }

    // Divider
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "divider", content: line, startLine: i, endLine: i + 1 });
      i++;
      continue;
    }

    // Regular paragraph / list / quote / etc.
    blocks.push({ kind: "paragraph", content: line, startLine: i, endLine: i + 1 });
    i++;
  }

  return blocks;
}

/**
 * Convert structural blocks back to text lines with type annotations.
 * Tables and code blocks emit their full content as a single logical unit
 * (but still as individual lines for the output format).
 */
function buildBlockLines(blocks: StructuralBlock[]): Array<{ text: string, type: "normal" | "added" }> {
  const result: Array<{ text: string, type: "normal" | "added" }> = [];
  for (const block of blocks) {
    const blockLines = block.content.split(/\r?\n/);
    for (const line of blockLines) {
      result.push({ text: line, type: "normal" });
    }
  }
  return result;
}

function superNormalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function matchLinesRelaxed(
  baseLines: Array<{ text: string, type: "normal" | "added" }>,
  baseIdx: number,
  searchLines: string[]
): { matchedLength: number, mapping: number[], mappingCounts: number[] } | null {
  let b = baseIdx;
  let s = 0;
  const mapping: number[] = new Array(searchLines.length).fill(-1);
  const mappingCounts: number[] = new Array(searchLines.length).fill(0);

  while (s < searchLines.length) {
    const sLine = searchLines[s].trim();

    if (sLine === "") {
      // Blank search line: advance past a single blank base line if present.
      // Never skip past non-blank base lines.
      if (b < baseLines.length && baseLines[b].text.trim() === "") {
        b++;
      }
      s++;
      continue;
    }

    // For structural search lines that require exact match (fences, dividers,
    // table separators): skip blank base lines, then require exact trimmed match.
    if (isExactMatchStructural(sLine)) {
      while (b < baseLines.length && baseLines[b].text.trim() === "") {
        b++;
      }
      if (b >= baseLines.length) return null;
      const bLine = baseLines[b].text.trim();
      if (bLine !== sLine) return null;
      mapping[s] = b;
      mappingCounts[s] = 1;
      b++;
      s++;
      continue;
    }

    // For normal prose lines: skip blank base lines, code fence lines, AND
    // horizontal divider lines (---) that LLMs frequently omit from diff context.
    // Also skip heading lines (e.g. ## Repository) if they don't match the current search line.
    // These skipped base lines are preserved in the output via the reconstruction loop.
    while (b < baseLines.length) {
      const bTrimmed = baseLines[b].text.trim();
      if (bTrimmed === "" || isCodeFenceLine(bTrimmed) || /^(-{3,}|\*{3,}|_{3,})$/.test(bTrimmed)) {
        b++;
      } else if (/^#{1,6}\s+/.test(bTrimmed)) {
        if (normalizeText(bTrimmed) !== normalizeText(sLine)) {
          b++;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (b >= baseLines.length) {
      return null;
    }

    const bLine = baseLines[b].text.trim();
    if (normalizeText(bLine) === normalizeText(sLine)) {
      mapping[s] = b;
      mappingCounts[s] = 1;
      b++;
      s++;
      continue;
    }

    // Try concatenation match for squashed lines (e.g. flattened tables)
    const normS = superNormalize(sLine);
    if (normS.length > 0) {
      let tempB = b;
      let concatenatedNorm = "";
      let matchedCount = 0;
      let found = false;

      for (let count = 1; count <= 15; count++) {
        if (tempB >= baseLines.length) break;
        const bText = baseLines[tempB].text.trim();
        concatenatedNorm += superNormalize(bText);
        tempB++;

        if (concatenatedNorm === normS) {
          matchedCount = count;
          found = true;
          break;
        }
        if (concatenatedNorm.length > normS.length) {
          break;
        }
      }

      if (found && matchedCount > 0) {
        mapping[s] = b;
        mappingCounts[s] = matchedCount;
        b += matchedCount;
        s++;
        continue;
      }
    }

    return null;
  }

  return { matchedLength: b - baseIdx, mapping, mappingCounts };
}

export function applyPatch(baseText: string, patchText: string): Array<{ text: string, type: "normal" | "added" }> {
  const hunks = parseDiff(patchText);
  let workingText = baseText;
  const baseLines: Array<{ text: string, type: "normal" | "added" }> = workingText.split(/\r?\n/).map(t => ({ text: t, type: "normal" as const }));
  if (hunks.length === 0) {
    return baseLines;
  }

  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sortedHunks) {
    const searchLines: string[] = [];
    interface Op { type: "normal" | "added" | "removed", text: string, searchIdx?: number }
    const ops: Op[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        searchLines.push(line.slice(1));
        ops.push({ type: "removed", text: line.slice(1), searchIdx: searchLines.length - 1 });
      } else if (line.startsWith("+")) {
        ops.push({ type: "added", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        searchLines.push(line.slice(1));
        ops.push({ type: "normal", text: line.slice(1), searchIdx: searchLines.length - 1 });
      } else if (line.startsWith("\\")) {
        // Ignore
      } else {
        searchLines.push(line);
        ops.push({ type: "normal", text: line, searchIdx: searchLines.length - 1 });
      }
    }

    // ── Table-aware matching ─────────────────────────────────────────────
    // When diff context lines include table rows (| cell | cell |), the
    // line-based matcher can fail because table structure may shift. Detect
    // table-heavy hunks and replace entire table blocks atomically.
    const contextLines = hunk.lines.filter(l => l.startsWith(" "));
    const tableContextLines = contextLines.filter(l => l.trim().startsWith("|") && l.trim().endsWith("|"));
    const isTableHunk = contextLines.length > 0 &&
      tableContextLines.length >= 2 &&
      tableContextLines.length / contextLines.length > 0.3;

    if (isTableHunk) {
      const blocks = parseStructuralBlocks(workingText);
      const tableBlocks = blocks.filter(b => b.kind === "table");

      // Extract cell content from context lines for matching
      const ctxCells = tableContextLines.map(l => {
        const content = l.trim();
        return content.split("|").slice(1, -1).map(c => normalizeText(c.trim()));
      });

      // Find matching table block
      let matchedTable: StructuralBlock | null = null;
      for (const tb of tableBlocks) {
        const tbLines = tb.content.split("\n");
        const tbCellLines = tbLines.filter(l => {
          const t = l.trim();
          return t.startsWith("|") && t.endsWith("|") &&
            !/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
        });
        const tbCellContents = tbCellLines.map(l =>
          l.trim().split("|").slice(1, -1).map(c => normalizeText(c.trim()))
        );

        let matchCount = 0;
        for (const ctxRow of ctxCells) {
          for (const tbRow of tbCellContents) {
            if (ctxRow.length === tbRow.length && ctxRow.every((c, i) => c === tbRow[i])) {
              matchCount++;
              break;
            }
          }
        }
        if (matchCount >= Math.ceil(ctxCells.length * 0.5)) {
          matchedTable = tb;
          break;
        }
      }

      if (matchedTable) {
        // Replace entire table: keep context rows before, apply changes, keep context rows after
        const baseLinesArr = workingText.split("\n");
        const beforeLines = baseLinesArr.slice(0, matchedTable.startLine);
        const afterLines = baseLinesArr.slice(matchedTable.endLine);

        // Build new table from diff: context lines before removals, added lines, context after
        const contextBefore: string[] = [];
        const removed: string[] = [];
        const added: string[] = [];
        const contextAfter: string[] = [];
        let phase: "before" | "remove" | "add" | "after" = "before";

        for (const line of hunk.lines) {
          const content = line.startsWith(" ") ? line.slice(1) : line.startsWith("-") || line.startsWith("+") ? line.slice(1) : line;
          const isTableLine = content.trim().startsWith("|") && content.trim().endsWith("|");

          if (line.startsWith("-")) {
            phase = "remove";
            removed.push(content);
          } else if (line.startsWith("+")) {
            phase = "add";
            added.push(content);
          } else if (line.startsWith(" ") || (!line.startsWith("@") && !line.startsWith("\\") && !line.startsWith("diff") && !line.startsWith("---") && !line.startsWith("+++"))) {
            if (phase === "remove" || phase === "add") {
              phase = "after";
            }
            if (phase === "before" && isTableLine) contextBefore.push(content);
            else if (phase === "after" && isTableLine) contextAfter.push(content);
            else if (!isTableLine) {
              if (phase === "before") contextBefore.push(content);
              else contextAfter.push(content);
            }
          }
        }

        const newTableLines = [...contextBefore, ...added, ...contextAfter];
        const newTableContent = newTableLines.join("\n");
        const newTableLinesArr = newTableContent.split("\n").filter(l => l.trim());

        const result = [...beforeLines, ...newTableLinesArr, ...afterLines];
        // Update workingText for subsequent hunks (line numbers shift)
        workingText = result.join("\n");
        baseLines.length = 0;
        baseLines.push(...result.map(t => ({ text: t, type: "normal" as const })));
        continue;
      }
      // No matching table found — fall through to line-level matching
    }

    // ── Standard line-level matching ─────────────────────────────────────
    const hintIndex = Math.max(0, hunk.oldStart - 1);
    let foundIndex = -1;
    let matchedLength = 0;
    let foundMapping: number[] | null = null;
    let foundMappingCounts: number[] | null = null;
    const maxOffset = Math.max(baseLines.length, 100);

    for (let offset = 0; offset < maxOffset; offset++) {
      const idxForward = hintIndex + offset;
      if (idxForward < baseLines.length) {
        const matchResult = matchLinesRelaxed(baseLines, idxForward, searchLines);
        if (matchResult) {
          foundIndex = idxForward;
          matchedLength = matchResult.matchedLength;
          foundMapping = matchResult.mapping;
          foundMappingCounts = matchResult.mappingCounts;
          break;
        }
      }
      const idxBackward = hintIndex - offset;
      if (offset > 0 && idxBackward >= 0) {
        const matchResult = matchLinesRelaxed(baseLines, idxBackward, searchLines);
        if (matchResult) {
          foundIndex = idxBackward;
          matchedLength = matchResult.matchedLength;
          foundMapping = matchResult.mapping;
          foundMappingCounts = matchResult.mappingCounts;
          break;
        }
      }
    }

    if (foundIndex === -1) {
      let startTrim = 0;
      while (startTrim < searchLines.length && ops.find(o => o.searchIdx === startTrim)?.type === "normal" && searchLines[startTrim].trim() === "") {
        startTrim++;
      }
      let endTrim = 0;
      while (endTrim < searchLines.length && ops.find(o => o.searchIdx === searchLines.length - 1 - endTrim)?.type === "normal" && searchLines[searchLines.length - 1 - endTrim].trim() === "") {
        endTrim++;
      }

      const trimmedSearch = searchLines.slice(startTrim, searchLines.length - endTrim);

      if (trimmedSearch.length > 0) {
        for (let offset = 0; offset < maxOffset; offset++) {
          const idxForward = hintIndex + offset;
          if (idxForward < baseLines.length) {
            const matchResult = matchLinesRelaxed(baseLines, idxForward, trimmedSearch);
            if (matchResult) {
              foundIndex = idxForward;
              matchedLength = matchResult.matchedLength;
              foundMapping = new Array(searchLines.length).fill(-1);
              foundMappingCounts = new Array(searchLines.length).fill(0);
              for (let i = 0; i < matchResult.mapping.length; i++) {
                foundMapping[startTrim + i] = matchResult.mapping[i];
                foundMappingCounts[startTrim + i] = matchResult.mappingCounts[i];
              }
              break;
            }
          }
          const idxBackward = hintIndex - offset;
          if (offset > 0 && idxBackward >= 0) {
            const matchResult = matchLinesRelaxed(baseLines, idxBackward, trimmedSearch);
            if (matchResult) {
              foundIndex = idxBackward;
              matchedLength = matchResult.matchedLength;
              foundMapping = new Array(searchLines.length).fill(-1);
              foundMappingCounts = new Array(searchLines.length).fill(0);
              for (let i = 0; i < matchResult.mapping.length; i++) {
                foundMapping[startTrim + i] = matchResult.mapping[i];
                foundMappingCounts[startTrim + i] = matchResult.mappingCounts[i];
              }
              break;
            }
          }
        }
      }
    }

    // Fallback: Flattened Relaxed Matching
    if (foundIndex === -1) {
      const searchFlat = superNormalize(searchLines.join(""));

      if (searchFlat.length > 10) {
        for (let start = 0; start < baseLines.length; start++) {
          let currentFlat = "";
          let end = start;

          while (end < baseLines.length && currentFlat.length < searchFlat.length) {
            currentFlat += superNormalize(baseLines[end].text);
            end++;
          }

          if (currentFlat === searchFlat) {
            foundIndex = start;
            matchedLength = end - start;
            break;
          }
        }
      }
    }

    if (foundIndex !== -1) {
      if (foundMapping) {
        const newLines: { text: string, type: "normal" | "added" }[] = [];
        let b = foundIndex;

        for (const op of ops) {
          if (op.type === "added") {
            newLines.push({ text: op.text, type: "added" });
          } else {
            const mappedB = op.searchIdx !== undefined ? foundMapping[op.searchIdx] : -1;
            if (mappedB !== -1) {
              while (b < mappedB) {
                newLines.push(baseLines[b]);
                b++;
              }
              const count = (op.searchIdx !== undefined && foundMappingCounts) ? foundMappingCounts[op.searchIdx] : 1;
              if (op.type === "normal") {
                for (let i = 0; i < count; i++) {
                  newLines.push(baseLines[b + i]);
                }
              }
              b += count;
            }
          }
        }
        while (b < foundIndex + matchedLength) {
          newLines.push(baseLines[b]);
          b++;
        }
        baseLines.splice(foundIndex, matchedLength, ...newLines);
      } else {
        const replaceLines: { text: string, type: "normal" | "added" }[] = [];
        for (const op of ops) {
          if (op.type === "added" || op.type === "normal") {
            replaceLines.push({ text: op.text, type: op.type });
          }
        }
        baseLines.splice(foundIndex, matchedLength, ...replaceLines);
      }
    } else {
      if (workingText.trim() === "") {
        const replaceLines: { text: string, type: "normal" | "added" }[] = [];
        for (const op of ops) {
          if (op.type === "added" || op.type === "normal") {
            replaceLines.push({ text: op.text, type: op.type });
          }
        }
        return replaceLines;
      }
      warn(`Could not apply hunk starting at line ${hunk.oldStart}`);
    }
  }

  return baseLines;
}

const VALID_NOTION_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "cpp", "csharp", "css",
  "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran", "fsharp", "gherkin",
  "glsl", "go", "graphql", "groovy", "haskell", "html", "java", "javascript", "json", "julia",
  "kotlin", "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown", "markup",
  "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
  "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala",
  "scheme", "scss", "shell", "sql", "swift", "typescript", "vb.net", "verilog", "vhdl",
  "visual basic", "webassembly", "xml", "yaml"
]);

function getNotionLanguage(lang: string): string {
  const cleaned = lang.trim().toLowerCase();
  if (cleaned === "js") return "javascript";
  if (cleaned === "ts") return "typescript";
  if (cleaned === "sh") return "shell";
  if (cleaned === "py") return "python";
  if (VALID_NOTION_LANGUAGES.has(cleaned)) {
    return cleaned;
  }
  return "plain text";
}

function chunkTextIntoRichText(text: string, isAdded: boolean = false): Record<string, unknown>[] {
  const richText: Record<string, unknown>[] = [];
  let remaining = text;
  if (!remaining) return [];
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, 1900);
    const annotation: Record<string, unknown> = {};
    if (isAdded) {
      annotation.annotations = { color: "green" };
    }
    richText.push({
      type: "text",
      text: {
        content: chunk,
      },
      ...annotation,
    });
    remaining = remaining.slice(1900);
  }
  return richText;
}

function splitTextIntoRichText(text: string, isAdded: boolean = false): Record<string, unknown>[] {
  const tokens = [];
  let remaining = text;
  if (!remaining) return [];

  const regex = /(\*\*(.*?)\*\*)|(?<!\w)(_([^_]+)_(?!\w))|(\*(.*?)\*)|(~~(.*?)~~)|(`([^`]+)`)|(?:\[(.*?)\]\((.*?)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, match.index), type: "text" });
    }

    if (match[1] !== undefined) {
      tokens.push({ text: match[2], type: "bold" });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[4], type: "italic" });
    } else if (match[5] !== undefined) {
      tokens.push({ text: match[6], type: "italic" });
    } else if (match[7] !== undefined) {
      tokens.push({ text: match[8], type: "strikethrough" });
    } else if (match[9] !== undefined) {
      tokens.push({ text: match[10], type: "code" });
    } else if (match[11] !== undefined && match[12] !== undefined) {
      tokens.push({ text: match[11], url: match[12], type: "link" });
    } else {
      tokens.push({ text: match[0], type: "text" });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), type: "text" });
  }

  const richText: Record<string, unknown>[] = [];
  
  for (const token of tokens) {
    if (!token.text && token.type !== "link") continue;
    
    let remainingText = token.text || "link";

    while (remainingText.length > 0) {
      const chunk = remainingText.slice(0, 1900);
      remainingText = remainingText.slice(1900);
      
      const annotations: any = {};
      if (isAdded) annotations.color = "green";
      
      if (token.type === "bold") annotations.bold = true;
      else if (token.type === "italic") annotations.italic = true;
      else if (token.type === "strikethrough") annotations.strikethrough = true;
      else if (token.type === "code") annotations.code = true;

      const rtObj: any = {
        type: "text",
        text: {
          content: chunk
        }
      };

      if (token.type === "link" && token.url) {
        let validUrl = token.url.trim();
        if (!validUrl.startsWith("http://") && !validUrl.startsWith("https://")) {
            validUrl = "https://" + validUrl;
        }
        rtObj.text.link = { url: validUrl.slice(0, 1000) };
      }

      if (Object.keys(annotations).length > 0) {
        rtObj.annotations = annotations;
      }

      richText.push(rtObj);
    }
  }

  return richText;
}

function buildRichTextForCodeBlock(codeBlockLines: Array<{ text: string, type: "normal" | "added" }>): Record<string, unknown>[] {
  const richText: Record<string, unknown>[] = [];
  if (codeBlockLines.length === 0) return [];

  let currentType = codeBlockLines[0].type;
  let currentGroup: string[] = [];

  for (let idx = 0; idx < codeBlockLines.length; idx++) {
    const item = codeBlockLines[idx];
    const suffix = idx === codeBlockLines.length - 1 ? "" : "\n";
    
    if (item.type !== currentType) {
      richText.push(...chunkTextIntoRichText(currentGroup.join(""), currentType === "added"));
      currentType = item.type;
      currentGroup = [item.text + suffix];
    } else {
      currentGroup.push(item.text + suffix);
    }
  }
  if (currentGroup.length > 0) {
    richText.push(...chunkTextIntoRichText(currentGroup.join(""), currentType === "added"));
  }

  return richText;
}

function buildTableBlock(lines: Array<{ text: string, type: "normal" | "added" }>): Record<string, unknown> {
  const rows = lines.map(l => {
    const cells = l.text.trim().split("|").slice(1, -1).map(c => c.trim());
    return { cells, type: l.type };
  });

  let hasHeader = false;
  let dataRows = rows;
  
  if (rows.length >= 2) {
    const isSeparator = rows[1].cells.every(c => c.replace(/-/g, "").trim() === "");
    if (isSeparator) {
      hasHeader = true;
      dataRows = [rows[0], ...rows.slice(2)];
    }
  }

  if (dataRows.length > 100) {
    dataRows = dataRows.slice(0, 100);
  }

  const tableWidth = Math.max(...dataRows.map(r => r.cells.length), 1);

  const tableRows = dataRows.map(row => {
    let cells = row.cells;
    if (cells.length < tableWidth) {
      cells = [...cells, ...Array(tableWidth - cells.length).fill("")];
    } else if (cells.length > tableWidth) {
      cells = cells.slice(0, tableWidth);
    }

    return {
      type: "table_row",
      table_row: {
        cells: cells.map(c => splitTextIntoRichText(c, row.type === "added"))
      }
    };
  });

  return {
    object: "block",
    type: "table",
    table: {
      table_width: tableWidth,
      has_column_header: hasHeader,
      has_row_header: false,
      children: tableRows
    }
  };
}

export function markdownToRichNotionBlocks(linesInput: string | Array<{ text: string, type: "normal" | "added" }>): Record<string, unknown>[] {
  const lines = typeof linesInput === "string"
    ? linesInput.split(/\r?\n/).map(t => ({ text: t, type: "normal" as const }))
    : linesInput;
  const blocks: Record<string, unknown>[] = [];
  
  let inCodeBlock = false;
  let codeBlockLines: Array<{ text: string, type: "normal" | "added" }> = [];
  let codeLanguage = "plain text";
  let codeFenceLength = 3;

  let inTable = false;
  let tableLines: Array<{ text: string, type: "normal" | "added" }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inCodeBlock) {
      const fenceMatch = line.text.match(/^(`{3,})/);
      if (fenceMatch && fenceMatch[1].length >= codeFenceLength) {
        blocks.push({
          object: "block",
          type: "code",
          code: {
            rich_text: buildRichTextForCodeBlock(codeBlockLines),
            language: codeLanguage,
          },
        });
        inCodeBlock = false;
        codeBlockLines = [];
      } else {
        codeBlockLines.push(line);
      }
      continue;
    }

    const codeStartMatch = line.text.match(/^(`{3,})(.*)$/);
    if (codeStartMatch) {
      if (inTable) {
        blocks.push(buildTableBlock(tableLines));
        inTable = false;
        tableLines = [];
      }
      inCodeBlock = true;
      codeFenceLength = codeStartMatch[1].length;
      codeLanguage = getNotionLanguage(codeStartMatch[2]);
      continue;
    }

    const trimmedText = line.text.trim();
    const isTableLine = trimmedText.startsWith("|") && trimmedText.endsWith("|");

    if (inTable) {
      if (isTableLine) {
        tableLines.push(line);
        continue;
      } else {
        blocks.push(buildTableBlock(tableLines));
        inTable = false;
        tableLines = [];
      }
    } else if (isTableLine) {
      inTable = true;
      tableLines.push(line);
      continue;
    }

    if (trimmedText === "") {
      continue;
    }

    if (line.text === "---" || line.text === "***" || line.text === "___") {
      blocks.push({
        object: "block",
        type: "divider",
        divider: {},
      });
      continue;
    }

    const headingMatch = line.text.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6);
      const type = `heading_${level}` as "heading_1" | "heading_2" | "heading_3" | "heading_4" | "heading_5" | "heading_6";
      blocks.push({
        object: "block",
        type,
        [type]: {
          rich_text: splitTextIntoRichText(headingMatch[2], line.type === "added"),
        },
      });
      continue;
    }

    const todoMatch = line.text.match(/^\s*[-*+]\s+\[([ xX])\](?:\s+(.*))?$/);
    if (todoMatch) {
      const checked = todoMatch[1].toLowerCase() === "x";
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: splitTextIntoRichText(todoMatch[2] || "", line.type === "added"),
          checked,
        },
      });
      continue;
    }

    const bulletMatch = line.text.match(/^\s*[-*+]\s+(.*)$/);
    if (bulletMatch) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: splitTextIntoRichText(bulletMatch[1], line.type === "added"),
        },
      });
      continue;
    }

    const numberMatch = line.text.match(/^\s*\d+\.\s+(.*)$/);
    if (numberMatch) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: splitTextIntoRichText(numberMatch[1], line.type === "added"),
        },
      });
      continue;
    }

    const quoteMatch = line.text.match(/^\s*>\s*(.*)$/);
    if (quoteMatch) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: {
          rich_text: splitTextIntoRichText(quoteMatch[1], line.type === "added"),
        },
      });
      continue;
    }

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: splitTextIntoRichText(line.text, line.type === "added"),
      },
    });
  }

  if (inTable) {
    blocks.push(buildTableBlock(tableLines));
  }

  if (inCodeBlock) {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        rich_text: buildRichTextForCodeBlock(codeBlockLines),
        language: codeLanguage,
      },
    });
  }

  return blocks;
}


const READ_ONLY_KEYS = [
  "id",
  "parent",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "has_children",
  "archived",
  "in_trash"
];

function cleanBlock(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(cleanBlock);
  } else if (obj !== null && typeof obj === 'object') {
    const newObj: any = {};
    for (const key of Object.keys(obj)) {
      if (READ_ONLY_KEYS.includes(key)) {
        continue;
      }
      const val = obj[key];
      if (val !== null && val !== undefined) {
        newObj[key] = cleanBlock(val);
      }
    }
    return newObj;
  }
  return obj;
}



function sanitizeRichText(richTexts: any[]): any[] {
  if (!richTexts) return [];
  const result: any[] = [];
  for (const rt of richTexts) {
    if (rt.text && rt.text.content && rt.text.content.length > 1900) {
      let content = rt.text.content;
      while (content.length > 0) {
        result.push({
          ...rt,
          text: {
            ...rt.text,
            content: content.slice(0, 1900)
          }
        });
        content = content.slice(1900);
      }
    } else {
      result.push(rt);
    }
  }
  return result;
}

async function getBranchDbId(thoughtId: string): Promise<string> {
  let resolvedBranchDbId = process.env.NOTION_BRANCH_DB_ID;
  if (resolvedBranchDbId) return resolvedBranchDbId;

  try {
    const projectPage = await notion.pages.retrieve({ page_id: thoughtId }) as any;
    if (projectPage && projectPage.parent) {
      let projectDbId = "";
      if (projectPage.parent.type === "database_id") {
        projectDbId = projectPage.parent.database_id;
      } else if (projectPage.parent.type === "data_source_id") {
        projectDbId = projectPage.parent.data_source_id;
      }
      
      if (projectDbId) {
        const db = await notion.databases.retrieve({ database_id: projectDbId }) as any;
        const branchProp = findProperty(db.properties, "Branch");
        if (branchProp && branchProp.type === "relation" && branchProp.relation) {
          const dbId = branchProp.relation.database_id || branchProp.relation.data_source_id;
          if (dbId) return dbId;
        }
      }
    }
  } catch {}
  
  throw new Error("Could not resolve Branch Database ID");
}

async function getBranchesForProject(projectId: string, branchDbId: string) {
  const response = await notion.dataSources.query({
    data_source_id: branchDbId,
    filter: {
      property: "Project",
      relation: { contains: projectId },
    },
    sorts: [
      {
        timestamp: "created_time",
        direction: "descending",
      },
    ],
  });
  return response.results as unknown as NotionPage[];
}

export async function handleUserComment(triggeredId: string) {
  debug(`Starting handleUserComment for ID: ${triggeredId}`);

  const entryDbIdResolved = await resolveDataSourceId(ENTRY_DB_ID);

  const pageObj = await notion.pages.retrieve({ page_id: triggeredId }) as any;
  const parentId = pageObj?.parent?.database_id || pageObj?.parent?.data_source_id;

  let projectId = "";
  let targetEntry: any = null;
  let sourceEntry: any = null;

  if (parentId === ENTRY_DB_ID || parentId === entryDbIdResolved) {
    targetEntry = pageObj;
    projectId = findProperty(pageObj.properties || {}, "Project")?.relation?.[0]?.id;
    if (!projectId) {
      throw new Error(`Entry ${triggeredId} is not linked to any Project.`);
    }

    const recentResponse = await notion.dataSources.query({
      data_source_id: entryDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: projectId },
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    });

    const results = recentResponse.results;
    const targetIdx = results.findIndex((r: any) => r.id === triggeredId);
    if (targetIdx !== -1 && targetIdx + 1 < results.length) {
      sourceEntry = results[targetIdx + 1];
    } else if (targetIdx === -1 && results.length > 0) {
      sourceEntry = results.find((r: any) => r.id !== triggeredId);
    }
  } else {
    projectId = triggeredId;

    const recentResponse = await notion.dataSources.query({
      data_source_id: entryDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: projectId },
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1,
    });

    if (recentResponse.results.length > 0) {
      sourceEntry = recentResponse.results[0];
    }

    const createResult = await createEntry({
      thoughtId: projectId,
      pageType: "CHAT CMNT",
    });

    if (createResult.pageId) {
      targetEntry = await notion.pages.retrieve({ page_id: createResult.pageId });
    }
  }

  if (!targetEntry || !sourceEntry) {
    debug("Missing target or source entry. Cannot copy comments.");
    return;
  }

  debug(`Scanning source entry ${sourceEntry.id} for comments to attach to ${targetEntry.id}`);

  // Update properties
  try {
    let finalTitle = findProperty((targetEntry as any).properties || {}, "Name")?.title?.[0]?.plain_text ?? "";

    if (!finalTitle || !/^\d+$/.test(finalTitle.trim())) {
      const nextNumber = await getNextEntryNumber(projectId, targetEntry.id);
      finalTitle = String(nextNumber);
    }

    const propertiesToUpdate: any = {
      "Entries Referenced": { relation: [{ id: sourceEntry.id }] },
    };

    if (finalTitle) {
      propertiesToUpdate.Name = { title: [{ text: { content: finalTitle } }] };
    }

    const updatePayload: any = {
      page_id: targetEntry.id,
      properties: propertiesToUpdate
    };

    await notion.pages.update(updatePayload);
    debug(`Updated targetEntry properties: EntriesReferenced=${sourceEntry.id}, Title=${finalTitle}`);
  } catch (err) {
    warn(`Failed to update targetEntry properties:`, err);
  }

    // 2. Fetch all blocks from sourceEntry
  const blocks: any[] = [];
  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    const listResponse = await notion.blocks.children.list({
      block_id: sourceEntry.id,
      start_cursor: startCursor,
    });
    blocks.push(...listResponse.results);
    hasMore = listResponse.has_more;
    startCursor = listResponse.next_cursor ?? undefined;
  }

  // Fetch all blocks from the memorandum page (if exists)
  const memorandumBlocks: any[] = [];
  let memorandumPageId = "";
  try {
    const memorandumDbIdResolved = await resolveDataSourceId(MEMORANDUM_DB_ID);
    const memorandumPagesResponse = await notion.dataSources.query({
      data_source_id: memorandumDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: projectId }
      }
    });

    if (memorandumPagesResponse.results.length > 0) {
      memorandumPageId = memorandumPagesResponse.results[0].id;
      let memorandumHasMore = true;
      let memorandumStartCursor: string | undefined;
      while (memorandumHasMore) {
        const listResponse = await notion.blocks.children.list({
          block_id: memorandumPageId,
          start_cursor: memorandumStartCursor,
        });
        memorandumBlocks.push(...listResponse.results);
        memorandumHasMore = listResponse.has_more;
        memorandumStartCursor = listResponse.next_cursor ?? undefined;
      }
    }
  } catch (err) {
    warn("Failed to retrieve memorandum page blocks for comments copy:", err);
  }

    // 3. For each block/page, fetch comments
  const newBlocks: any[] = [];
  const itemsToScan: Array<{ id: string; type: string; raw?: any }> = [
    ...blocks.map(b => ({ id: b.id, type: b.type, raw: b })),
    ...memorandumBlocks.map(b => ({ id: b.id, type: b.type, raw: b })),
    { id: sourceEntry.id, type: "page" },
    ...(memorandumPageId ? [{ id: memorandumPageId, type: "page" }] : [])
  ];

  for (const item of itemsToScan) {
    try {
      const commentsRes = await notion.comments.list({ block_id: item.id });
      if (commentsRes.results.length > 0) {
        // Find text content
        let blockTextRichText = [];
        if (item.type !== "page" && item.raw && item.raw[item.type] && item.raw[item.type].rich_text) {
          blockTextRichText = sanitizeRichText(item.raw[item.type].rich_text);
        }

        if (blockTextRichText.length > 0) {
          newBlocks.push({
            object: "block",
            type: "quote",
            quote: { rich_text: blockTextRichText }
          });
        }

        // Add the comments
        for (const comment of commentsRes.results) {
           newBlocks.push({
             object: "block",
             type: "callout",
             callout: {
               rich_text: sanitizeRichText(comment.rich_text),
               icon: { type: "emoji", emoji: "💬" }
             }
           });
        }
      }
    } catch (err) {
      // no comments or error fetching
    }
  }

  // 4. Append newBlocks to targetEntry
  if (newBlocks.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < newBlocks.length; i += CHUNK) {
      await notion.blocks.children.append({
        block_id: targetEntry.id,
        children: newBlocks.slice(i, i + CHUNK) as any,
      });
    }
    debug(`Appended ${newBlocks.length} comment blocks to target entry.`);
  } else {
    debug("No comments found.");
    await notion.blocks.children.append({
      block_id: targetEntry.id,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: "No comments found on the previous entry." } }]
          }
        }
      ] as any
    });
  }
}

export async function handleMemoUpdate(thoughtId: string): Promise<void> {
  debug(`Starting handleMemoUpdate for Project ID: ${thoughtId}`);

  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const memorandumDbIdResolved = await resolveDataSourceId(MEMORANDUM_DB_ID);

  // 1. Gather all entries of type "MEMO RESP" and "MEMO EXPO" for the project
  const entriesResponse = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      property: "Project",
      relation: { contains: thoughtId }
    }
  });

  const memorandumEntries = entriesResponse.results.filter((entry: any) => {
    const type = findProperty(entry.properties || {}, "Type")?.select?.name;
    return type === "MEMO RESP" || type === "MEMO EXPO";
  });

  // Sort them chronologically by their Name (converted to integer or alphanumerically)
  memorandumEntries.sort((a: any, b: any) => {
    const nameA = findProperty(a.properties || {}, "Name")?.title?.[0]?.plain_text || "";
    const nameB = findProperty(b.properties || {}, "Name")?.title?.[0]?.plain_text || "";
    const matchA = nameA.match(/\d+/);
    const matchB = nameB.match(/\d+/);
    const numA = matchA ? parseInt(matchA[0], 10) : NaN;
    const numB = matchB ? parseInt(matchB[0], 10) : NaN;
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    return nameA.localeCompare(nameB, undefined, { numeric: true });
  });

  debug(`Found ${memorandumEntries.length} memorandum entries to process`);

  // 2. Apply git diffs sequentially
  let currentContent = "";
  let latestEntryNumber = "";

  const entryContents = await Promise.all(
    memorandumEntries.map((entry: any) => readPageContent(entry.id))
  );

  for (let i = 0; i < memorandumEntries.length; i++) {
    const entry = memorandumEntries[i];
    const nameProp = findProperty((entry as any).properties || {}, "Name");
    const entryNum = nameProp?.title?.[0]?.plain_text ?? "";
    if (entryNum) {
      latestEntryNumber = entryNum;
    }

    const type = findProperty((entry as any).properties || {}, "Type")?.select?.name;
    const content = entryContents[i];

    if (type === "MEMO EXPO") {
      const match = content.match(/<entry\s+type="MEMO"[^>]*>([\s\S]*?)<\/entry>/);
      if (match) {
        currentContent = match[1].trim();
      }
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

  // 3. Find existing memorandum page in Memorandum DB for this project
  const memorandumPagesResponse = await notion.dataSources.query({
    data_source_id: memorandumDbIdResolved,
    filter: {
      property: "Project", relation: { contains: thoughtId }
    }
  });

  let memorandumPageId = "";
  const results = memorandumPagesResponse.results;

  if (results.length > 0) {
    memorandumPageId = results[0].id;
    debug(`Using existing memorandum page ${memorandumPageId}`);

    // Update title/Name to the chronological number from entries
    await notion.pages.update({
      page_id: memorandumPageId,
      properties: {
        Name: { title: [{ text: { content: latestEntryNumber || "1" } }] }
      }
    });

    // Enforce "only allow 1 memorandum only" by archiving other duplicate memorandum pages
    if (results.length > 1) {
      debug(`Archiving ${results.length - 1} duplicate memorandum pages`);
      await Promise.all(
        results.slice(1).map(r => notion.pages.update({ page_id: r.id, in_trash: true }))
      );
    }
  } else {
    debug(`Creating new memorandum page in Memorandum DB`);
    const memorandumPage = await notion.pages.create({
      parent: { data_source_id: memorandumDbIdResolved },
      properties: {
        Name: { title: [{ text: { content: latestEntryNumber || "1" } }] },
        Project: { relation: [{ id: thoughtId }] }
      }
    });
    memorandumPageId = memorandumPage.id;
  }

  // 4. Link Project to Memorandum
  try {
    await notion.pages.update({
      page_id: thoughtId,
      properties: {
        Memorandum: { relation: [{ id: memorandumPageId }] }
      }
    });
  } catch (err) {
    warn(`Failed to link Project to Memorandum:`, err);
  }

  // 5. Rebuild memorandum page from the fully patched markdown.
  const forceWipe = true;
  await updatePageBlocks(memorandumPageId, currentContent, false, forceWipe);
  debug(`Finished updating memorandum page ${memorandumPageId} with latest content (forceWipe: ${forceWipe})`);
}

function getRichTextPlain(rt: any[]): string {
  return rt?.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("") ?? "";
}

function getRichTextMarkdown(rt: any[]): string {
  return rt?.map((t: any) => {
    let text = t.plain_text ?? t.text?.content ?? "";
    if (!text) return "";

    const annotations = t.annotations || {};
    if (annotations.code) {
      text = `\`${text}\``;
    } else {
      if (annotations.bold) text = `**${text}**`;
      if (annotations.italic) text = `_${text}_`;
      if (annotations.strikethrough) text = `~~${text}~~`;
    }

    const url = t.href ?? t.text?.link?.url;
    if (url) {
      text = `[${text}](${url})`;
    }

    return text;
  }).join("") ?? "";
}

function serializeBlockToMarkdown(block: any, childBlocksMap: Map<string, any[]>): string {
  const type = block.type;
  const data = block[type];
  if (!data) return "";

  switch (type) {
    case "heading_1":
      return `# ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_2":
      return `## ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_3":
      return `### ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_4":
      return `#### ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_5":
      return `##### ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_6":
      return `###### ${getRichTextMarkdown(data.rich_text)}`;
    case "bulleted_list_item":
      return `- ${getRichTextMarkdown(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${getRichTextMarkdown(data.rich_text)}`;
    case "quote":
      return `> ${getRichTextMarkdown(data.rich_text)}`;
    case "callout":
      return getRichTextMarkdown(data.rich_text);
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${getRichTextMarkdown(data.rich_text)}`;
    case "toggle":
      return getRichTextMarkdown(data.rich_text);
    case "divider":
      return `---`;
    case "paragraph":
      return getRichTextMarkdown(data.rich_text);
    case "code":
      return `\`\`\`\n${getRichTextPlain(data.rich_text)}\n\`\`\``;
    case "table": {
      const rows = childBlocksMap.get(block.id) || data.children || [];
      const rowStrings = rows.map((row: any) => {
        const cells = row.table_row?.cells || [];
        const cellStrings = cells.map((cell: any) => getRichTextMarkdown(cell));
        return `| ${cellStrings.join(" | ")} |`;
      });
      if (rowStrings.length === 0) return "";
      if (data.has_column_header) {
        const colCount = rows[0].table_row?.cells?.length || 0;
        const separator = `| ${Array(colCount).fill("---").join(" | ")} |`;
        return [rowStrings[0], separator, ...rowStrings.slice(1)].join("\n");
      }
      return rowStrings.join("\n");
    }
    default:
      return "";
  }
}

function areBlocksEqual(b1md: string, b2md: string): boolean {
  // Normalize whitespace: replace multiple spaces with a single space.
  // Normalize table separators: remove spaces around dashes in table separators.
  // Ignore list numbering differences by normalizing all numbers to "1."
  const norm = (s: string) => 
    s.trim()
     .replace(/\r\n/g, "\n")
     .replace(/^\d+\.\s+/gm, "1. ")
     .replace(/\s+/g, " ")
     .replace(/\|\s*-+\s*/g, "|---");
  return norm(b1md) === norm(b2md);
}

function diffBlocks(
  oldBlocks: { id?: string; md: string; raw: any }[],
  newBlocks: { md: string; raw: any }[]
): { action: "keep" | "delete" | "insert" | "update"; oldIdx?: number; newIdx?: number }[] {
  const m = oldBlocks.length;
  const n = newBlocks.length;
  
  const dp: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (areBlocksEqual(oldBlocks[i - 1].md, newBlocks[j - 1].md)) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  const diff: { action: "keep" | "delete" | "insert" | "update"; oldIdx?: number; newIdx?: number }[] = [];
  let i = m;
  let j = n;
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && areBlocksEqual(oldBlocks[i - 1].md, newBlocks[j - 1].md)) {
      diff.unshift({ action: "keep", oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ action: "insert", newIdx: j - 1 });
      j--;
    } else {
      diff.unshift({ action: "delete", oldIdx: i - 1 });
      i--;
    }
  }
  
  return diff;
}

async function fetchBlocksRecursive(blockId: string): Promise<any[]> {
  const blocks: any[] = [];
  let hasMore = true;
  let startCursor: string | undefined = undefined;
  while (hasMore) {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: startCursor,
    });
    blocks.push(...res.results);
    hasMore = res.has_more;
    startCursor = res.next_cursor ?? undefined;
  }

  for (const block of blocks) {
    if (block.has_children) {
      block.children = await fetchBlocksRecursive(block.id);
    }
  }

  return blocks;
}

const SYNCABLE_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "heading_5",
  "heading_6",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "callout",
  "code",
  "to_do",
  "toggle",
  "divider",
  "table"
]);

const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "heading_5",
  "heading_6",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "callout",
  "code",
  "to_do",
  "toggle"
]);

function flattenBlocks(
  blocks: any[],
  parentId: string,
  childBlocksMap: Map<string, any[]>
): any[] {
  const flat: any[] = [];

  for (const block of blocks) {
    if (block.children && block.children.length > 0) {
      childBlocksMap.set(block.id, block.children);
    }

    if (SYNCABLE_TYPES.has(block.type)) {
      flat.push({
        id: block.id,
        type: block.type,
        parentBlockId: parentId,
        raw: block,
      });
    }

    if (block.children && block.children.length > 0) {
      flat.push(...flattenBlocks(block.children, block.id, childBlocksMap));
    }
  }

  return flat;
}

export async function updatePageBlocks(
  pageId: string,
  newMarkdown: string,
  keepFirstBlock: boolean = false,
  forceWipe: boolean = false
): Promise<void> {
  debug(`Fetching existing blocks recursively for page ${pageId}`);
  const nestedBlocks = await fetchBlocksRecursive(pageId);

  const childBlocksMap = new Map<string, any[]>();
  const oldContentBlocks = flattenBlocks(nestedBlocks, pageId, childBlocksMap);

  let oldBlocksToSync = oldContentBlocks;
  let firstBlockToKeep: any = null;
  if (keepFirstBlock && oldContentBlocks.length > 0) {
    firstBlockToKeep = oldContentBlocks[0];
    oldBlocksToSync = oldContentBlocks.slice(1);
  }

  let newBlocks = markdownToRichNotionBlocks(newMarkdown);
  newBlocks = newBlocks.map(b => cleanBlock(b));

  const oldSerialized = oldBlocksToSync.map(b => ({
    id: b.id,
    type: b.type,
    parentBlockId: b.parentBlockId,
    md: serializeBlockToMarkdown(b.raw, childBlocksMap),
    raw: b.raw,
  }));

  const newSerialized = newBlocks.map(b => ({
    type: b.type as string,
    md: serializeBlockToMarkdown(b, new Map()),
    raw: b,
  }));

  const diff = diffBlocks(oldSerialized, newSerialized);

  // Pre-process diff steps to merge consecutive delete + insert of same type into update
  const processedSteps: any[] = [];
  let matchCount = 0;

  for (let idx = 0; idx < diff.length; idx++) {
    const current = diff[idx];
    const next = diff[idx + 1];

    if (current.action === "keep") matchCount++;

    if (
      current.action === "delete" &&
      next &&
      next.action === "insert"
    ) {
      const oldBlock = oldSerialized[current.oldIdx!];
      const newBlock = newSerialized[next.newIdx!];

      if (
        TEXT_BLOCK_TYPES.has(oldBlock.type) &&
        TEXT_BLOCK_TYPES.has(newBlock.type) &&
        oldBlock.type === newBlock.type
      ) {
        processedSteps.push({
          action: "update",
          oldIdx: current.oldIdx,
          newIdx: next.newIdx
        });
        matchCount++;
        idx++; // skip next insert
        continue;
      }
    }
    processedSteps.push(current);
  }

  const similarityRatio = matchCount / Math.max(oldSerialized.length, newSerialized.length, 1);
  const hasTableStructuralChange = diff.some((step) => {
    if (step.action === "keep") return false;
    const oldType = step.oldIdx !== undefined ? oldSerialized[step.oldIdx]?.type : undefined;
    const newType = step.newIdx !== undefined ? newSerialized[step.newIdx]?.type : undefined;
    return oldType === "table" || newType === "table";
  });
  const isCompletelyDifferent = similarityRatio < 0.3;
  
  if (forceWipe || hasTableStructuralChange || (isCompletelyDifferent && oldSerialized.length > 0)) {
    debug(`Wiping and replacing blocks. similarity=${similarityRatio.toFixed(2)}, forceWipe=${forceWipe}, tableStructuralChange=${hasTableStructuralChange}`);
    
    let manualWipeNeeded = true;
    if (!keepFirstBlock) {
      try {
        await (notion.pages.update as any)({
          page_id: pageId,
          erase_content: true
        });
        manualWipeNeeded = false;
      } catch (err) {
        warn(`Failed to use erase_content on page ${pageId}, falling back to manual deletion:`, err);
      }
    }

    if (manualWipeNeeded) {
      const topLevelBlocksToDelete = oldBlocksToSync.filter(b => b.parentBlockId === pageId);
      
      const CHUNK = 50;
      for (let i = 0; i < topLevelBlocksToDelete.length; i += CHUNK) {
        const chunk = topLevelBlocksToDelete.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map((block) => notion.blocks.delete({ block_id: block.id }).catch(err => warn(`Failed to delete block ${block.id}:`, err)))
        );
      }
    }

    for (let i = 0; i < newBlocks.length; i += 50) {
      await notion.blocks.children.append({
        block_id: pageId,
        children: newBlocks.slice(i, i + 50) as any,
      });
    }
    return;
  }

  const ops: ({ type: "delete"; id: string } | { type: "insert"; blocks: any[]; parentId: string; afterId?: string } | { type: "update"; id: string; oldType: string; newBlock: any })[] = [];
  
  let currentInsertRun: any[] = [];
  let lastKnownBlock: { id: string; parentBlockId: string } | null = null;
  if (keepFirstBlock && firstBlockToKeep) {
    lastKnownBlock = { id: firstBlockToKeep.id, parentBlockId: firstBlockToKeep.parentBlockId || pageId };
  }

  for (const step of processedSteps) {
    if (step.action === "keep") {
      if (currentInsertRun.length > 0) {
        const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
        ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
        currentInsertRun = [];
      }
      const kept = oldSerialized[step.oldIdx!];
      lastKnownBlock = { id: kept.id, parentBlockId: kept.parentBlockId || pageId };
    } else if (step.action === "update") {
      if (currentInsertRun.length > 0) {
        const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
        ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
        currentInsertRun = [];
      }
      const updated = oldSerialized[step.oldIdx!];
      ops.push({
        type: "update",
        id: updated.id,
        oldType: updated.type,
        newBlock: newSerialized[step.newIdx!].raw
      });
      lastKnownBlock = { id: updated.id, parentBlockId: updated.parentBlockId || pageId };
    } else if (step.action === "delete") {
      if (currentInsertRun.length > 0) {
        const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
        ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
        currentInsertRun = [];
      }
      ops.push({ type: "delete", id: oldSerialized[step.oldIdx!].id });
    } else if (step.action === "insert") {
      currentInsertRun.push(newSerialized[step.newIdx!].raw);
    }
  }
  if (currentInsertRun.length > 0) {
    const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
    ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
  }

  // Execute all inserts and updates first, then all deletes last, to prevent archived block errors
  const insertOps = ops.filter((op) => op.type === "insert") as any[];
  const updateOps = ops.filter((op) => op.type === "update") as any[];
  const deleteOps = ops.filter((op) => op.type === "delete") as any[];

  for (const op of insertOps) {
    try {
      const CHUNK = 100;
      let currentAfterId = op.afterId;
      for (let k = 0; k < op.blocks.length; k += CHUNK) {
        const chunkBlocks = op.blocks.slice(k, k + CHUNK);
        const payload: any = {
          block_id: op.parentId,
          children: chunkBlocks as any,
        };

        if (currentAfterId) {
          payload.position = {
            type: "after_block",
            after_block: { id: currentAfterId },
          };
        } else if (k === 0) {
          payload.position = {
            type: "start",
          };
        } else {
          payload.position = {
            type: "after_block",
            after_block: { id: currentAfterId },
          };
        }

        const res = await notion.blocks.children.append(payload);
        if (res.results && res.results.length > 0) {
          currentAfterId = res.results[res.results.length - 1].id;
        }
      }
    } catch (err) {
      warn(`Failed to execute insert operation:`, err);
    }
  }

  for (const op of updateOps) {
    try {
      const blockType = op.newBlock.type;
      const updateData: any = {
        rich_text: op.newBlock[blockType]?.rich_text || []
      };
      if (op.oldType === "code") {
        updateData.language = op.newBlock.code?.language || "plain text";
      }
      if (op.oldType === "to_do") {
        updateData.checked = op.newBlock.to_do?.checked ?? false;
      }
      await notion.blocks.update({
        block_id: op.id,
        [op.oldType]: updateData
      } as any);
    } catch (err) {
      warn(`Failed to update block ${op.id}:`, err);
    }
  }

  for (const op of deleteOps) {
    try {
      await notion.blocks.delete({ block_id: op.id });
    } catch (err) {
      warn(`Failed to delete block ${op.id}:`, err);
    }
  }
}

export async function setExclusiveInclude(projectId: string, entryType: string, activePageId: string): Promise<void> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      and: [
        { property: "Project", relation: { contains: projectId } },
        { property: "Type", select: { equals: entryType } }
      ]
    }
  });
  
  const entries = response.results as unknown as NotionPage[];
  
  for (const entry of entries) {
    const isTarget = entry.id === activePageId;
    await notion.pages.update({
      page_id: entry.id,
      properties: {
        Include: { checkbox: isTarget }
      }
    });
  }
}
