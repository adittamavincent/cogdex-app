import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";
import { readPageContent } from "./export";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;
const CANVAS_DB_ID = process.env.NOTION_CANVAS_DB_ID!;

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
  "REG USR": "",
  "REG RES": "",
  "CNV EXP": "",
  "CNV RES": "",
  "REG EXP": "",
  "REG USR CMT": "",
  "Relink Databases": "",
  "CNV UPD": "",
};

function findProperty(properties: Record<string, any>, name: string): any {
  const targetKey = name.toLowerCase().replace(/\s+/g, "");
  const matchedKey = Object.keys(properties).find(
    (k) => k.toLowerCase().replace(/\s+/g, "") === targetKey
  );
  return matchedKey ? properties[matchedKey] : null;
}

export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
  entriesReferencedIds?: string[];
  systemPromptsUsedIds?: string[];
}): Promise<{ pageId?: string; ignored?: boolean }> {
  const { thoughtId, pageType } = params;
  const isExport = pageType === "REG EXP";

  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);

  const recentResponse = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: { property: "Project", relation: { contains: thoughtId } },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1,
  });

  let nextNumber = 1;
  if (recentResponse.results.length > 0) {
    const latestEntry = recentResponse.results[0];
    const nameProp = findProperty((latestEntry as any).properties || {}, "Name");
    const latestTitle = nameProp?.title?.[0]?.plain_text ?? "";
    const latestNum = parseInt(latestTitle, 10);
    if (!isNaN(latestNum)) {
      nextNumber = latestNum + 1;
    }
  }

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: String(nextNumber) } }] },
    Type: { select: { name: pageType } },
    Include: { checkbox: pageType !== "REG EXP" && pageType !== "CNV EXP" },
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

  const blocksToAppend = (!isExport && pageType !== "CNV EXP") ? markdownToNotionBlocks(TEMPLATES[pageType]) : [];

  const createPayload: any = {
    parent: { data_source_id: entryDbId },
    properties,
    children: blocksToAppend,
  };

  const page = await notion.pages.create(createPayload);
  return { pageId: page.id, ignored: false };
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

export async function relinkDatabases(thoughtId: string): Promise<void> {
  debug(`Starting relinkDatabases for page ${thoughtId}`);

  // 1. Fetch original view configurations to clone sorting/ordering/formatting
  const ORIGINAL_ENTRY_VIEW_ID = process.env.NOTION_ENTRY_VIEW_ID;
  const ORIGINAL_SYSTEM_PROMPT_VIEW_ID = process.env.NOTION_SYSTEM_PROMPT_VIEW_ID;
  const ORIGINAL_CANVAS_VIEW_ID = process.env.NOTION_CANVAS_VIEW_ID;

  if (!ORIGINAL_ENTRY_VIEW_ID || !ORIGINAL_SYSTEM_PROMPT_VIEW_ID || !ORIGINAL_CANVAS_VIEW_ID) {
    throw new Error(
      "Missing required view ID environment variables: NOTION_ENTRY_VIEW_ID, NOTION_SYSTEM_PROMPT_VIEW_ID, NOTION_CANVAS_VIEW_ID"
    );
  }

  debug(`Fetching original views: Entry=${ORIGINAL_ENTRY_VIEW_ID}, SystemPrompt=${ORIGINAL_SYSTEM_PROMPT_VIEW_ID}, Canvas=${ORIGINAL_CANVAS_VIEW_ID}`);
  const [entryView, systemPromptView, canvasView] = await Promise.all([
    notion.views.retrieve({ view_id: ORIGINAL_ENTRY_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_SYSTEM_PROMPT_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_CANVAS_VIEW_ID }),
  ]);

  // 2. Wipe clean all blocks inside the current page
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
    try {
      debug(`Retrieving actual schema for data source ${dataSourceId} to sanitize property configurations`);
      const db = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as any;
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

    const isEntryOrCanvas = dataSourceId === ENTRY_DB_ID || dataSourceId === CANVAS_DB_ID || fallbackDataSourceId === ENTRY_DB_ID || fallbackDataSourceId === CANVAS_DB_ID;
    if (isEntryOrCanvas) {
      if (!configuration) {
        configuration = { properties: [] };
      }
      if (!configuration.properties || !Array.isArray(configuration.properties)) {
        configuration.properties = [];
      }
      const titleProp = configuration.properties.find((p: any) => p.property_id === "title");
      if (titleProp) {
        titleProp.width = 100;
      } else {
        configuration.properties.push({
          property_id: "title",
          visible: true,
          width: 100
        });
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

  debug("Creating cloned Canvas database view");
  await createClonedView(canvasView, CANVAS_DB_ID, projectFilterModifier);

  debug("Creating cloned Entry database view");
  await createClonedView(entryView, ENTRY_DB_ID, projectFilterModifier);

  debug("Creating cloned System Prompt database view");
  await createClonedView(systemPromptView, SYSTEM_PROMPT_DB_ID);

  debug(`Successfully finished relinkDatabases for page ${thoughtId}`);
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
  const match = trimmed.match(/`{3,}(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n`{3,}/);
  if (match) {
    return match[1];
  }
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

function matchLines(baseLines: Array<{ text: string, type: "normal" | "added" }>, startIdx: number, searchLines: string[]): boolean {
  for (let i = 0; i < searchLines.length; i++) {
    if (baseLines[startIdx + i].text.trim() !== searchLines[i].trim()) {
      return false;
    }
  }
  return true;
}

export function applyPatch(baseText: string, patchText: string): Array<{ text: string, type: "normal" | "added" }> {
  const hunks = parseDiff(patchText);
  const baseLines: Array<{ text: string, type: "normal" | "added" }> = baseText.split(/\r?\n/).map(t => ({ text: t, type: "normal" as const }));
  if (hunks.length === 0) {
    return baseLines;
  }

  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sortedHunks) {
    const searchLines: string[] = [];
    const replaceLines: { text: string, type: "normal" | "added" }[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        searchLines.push(line.slice(1));
      } else if (line.startsWith("+")) {
        replaceLines.push({ text: line.slice(1), type: "added" as const });
      } else if (line.startsWith(" ")) {
        searchLines.push(line.slice(1));
        replaceLines.push({ text: line.slice(1), type: "normal" as const });
      } else if (line.startsWith("\\")) {
        // Ignore
      } else {
        searchLines.push(line);
        replaceLines.push({ text: line, type: "normal" as const });
      }
    }

    const hintIndex = Math.max(0, hunk.oldStart - 1);
    let foundIndex = -1;
    const maxOffset = Math.max(baseLines.length, 100);

    for (let offset = 0; offset < maxOffset; offset++) {
      const idxForward = hintIndex + offset;
      if (idxForward + searchLines.length <= baseLines.length) {
        if (matchLines(baseLines, idxForward, searchLines)) {
          foundIndex = idxForward;
          break;
        }
      }
      const idxBackward = hintIndex - offset;
      if (offset > 0 && idxBackward >= 0 && idxBackward + searchLines.length <= baseLines.length) {
        if (matchLines(baseLines, idxBackward, searchLines)) {
          foundIndex = idxBackward;
          break;
        }
      }
    }

    if (foundIndex === -1) {
      let startTrim = 0;
      while (startTrim < searchLines.length && hunk.lines[startTrim]?.startsWith(" ")) {
        startTrim++;
      }
      let endTrim = 0;
      while (endTrim < searchLines.length && hunk.lines[hunk.lines.length - 1 - endTrim]?.startsWith(" ")) {
        endTrim++;
      }

      const trimmedSearch = searchLines.slice(startTrim, searchLines.length - endTrim);
      const trimmedReplace = replaceLines.slice(startTrim, replaceLines.length - endTrim);

      if (trimmedSearch.length > 0) {
        for (let offset = 0; offset < maxOffset; offset++) {
          const idxForward = hintIndex + offset;
          if (idxForward + trimmedSearch.length <= baseLines.length) {
            if (matchLines(baseLines, idxForward, trimmedSearch)) {
              foundIndex = idxForward - startTrim;
              break;
            }
          }
          const idxBackward = hintIndex - offset;
          if (offset > 0 && idxBackward >= 0 && idxBackward + trimmedSearch.length <= baseLines.length) {
            if (matchLines(baseLines, idxBackward, trimmedSearch)) {
              foundIndex = idxBackward - startTrim;
              break;
            }
          }
        }
      }
    }

    if (foundIndex !== -1) {
      baseLines.splice(foundIndex, searchLines.length, ...replaceLines);
    } else {
      if (baseText.trim() === "") {
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

  const regex = /(\*\*(.*?)\*\*)|(\*(.*?)\*)|(~~(.*?)~~)|(`(.*?)`)|(?:\[(.*?)\]\((.*?)\))/g;
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
      tokens.push({ text: match[6], type: "strikethrough" });
    } else if (match[7] !== undefined) {
      tokens.push({ text: match[8], type: "code" });
    } else if (match[9] !== undefined && match[10] !== undefined) {
      tokens.push({ text: match[9], url: match[10], type: "link" });
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
      const level = Math.min(headingMatch[1].length, 3);
      const type = `heading_${level}` as "heading_1" | "heading_2" | "heading_3";
      blocks.push({
        object: "block",
        type,
        [type]: {
          rich_text: splitTextIntoRichText(headingMatch[2], line.type === "added"),
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

export async function handleCanvasUpdate(triggeredId: string): Promise<void> {
  debug(`Starting handleCanvasUpdate for ID: ${triggeredId}`);

  // Retrieve the page from Notion
  const pageObj = await notion.pages.retrieve({ page_id: triggeredId }) as any;
  if (!pageObj) {
    throw new Error(`Page with ID ${triggeredId} not found.`);
  }

  let canvasEntryId = "";
  let projectId = "";

  const parentId = pageObj.parent.database_id || pageObj.parent.data_source_id;
  const canvasDbIdResolved = await resolveDataSourceId(CANVAS_DB_ID);
  const entryDbIdResolved = await resolveDataSourceId(ENTRY_DB_ID);

  if (
    parentId === CANVAS_DB_ID ||
    parentId === canvasDbIdResolved ||
    parentId === ENTRY_DB_ID ||
    parentId === entryDbIdResolved
  ) {
    debug(`Triggered page ${triggeredId} is a Canvas/Entries Entry`);
    canvasEntryId = triggeredId;
    const projectProp = findProperty(pageObj.properties || {}, "Project");
    projectId = projectProp?.relation?.[0]?.id;
    if (!projectId) {
      throw new Error(`Canvas Entry ${triggeredId} is not linked to any Project.`);
    }
  } else {
    debug(`Triggered page ${triggeredId} is a Project page, searching for latest Canvas Entry`);
    projectId = triggeredId;
    let canvasPagesResponse;
    try {
      canvasPagesResponse = await notion.dataSources.query({
        data_source_id: entryDbIdResolved,
        filter: {
          property: "Project", relation: { contains: projectId }
        },
        sorts: [{ timestamp: "created_time", direction: "descending" }]
      });
    } catch (err: any) {
      if (err.code === "object_not_found") {
        throw new Error(`Entries DB not found. Ensure the Entries DB is shared with the integration.`);
      }
      throw err;
    }

    const canvasEntries = canvasPagesResponse.results.filter((entry: any) => {
      const type = findProperty(entry.properties || {}, "Type")?.select?.name;
      return type === "CNV RES" || type === "CNV EXP";
    });

    if (canvasEntries.length === 0) {
      throw new Error(`No Canvas entry found for project ${projectId}.`);
    }
    canvasEntryId = canvasEntries[0].id;
  }

  // 1. Read diff content from target canvas page
  let diffContent = await readPageContent(canvasEntryId);
  debug(`Read diff content from canvas ${canvasEntryId} (length: ${diffContent.length})`);

  diffContent = unwrapCodeFences(diffContent);

  if (!isDiff(diffContent)) {
    debug(`Content is not a git diff. Skipping merge update.`);
    return;
  }

  // 2. Find previous canvas page in this project
  const canvasPagesResponse = await notion.dataSources.query({
    data_source_id: entryDbIdResolved,
    filter: {
      property: "Project", relation: { contains: projectId }
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }]
  });

  const results = canvasPagesResponse.results.filter((entry: any) => {
    const type = findProperty(entry.properties || {}, "Type")?.select?.name;
    return type === "CNV RES" || type === "CNV EXP";
  });

  const currentIdx = results.findIndex(r => r.id === canvasEntryId);
  let previousCanvasId: string | null = null;
  if (currentIdx !== -1 && currentIdx + 1 < results.length) {
    previousCanvasId = results[currentIdx + 1].id;
  }

  let baseContent = "";
  if (previousCanvasId) {
    debug(`Found previous canvas: ${previousCanvasId}`);
    const prevEntry = results.find(r => r.id === previousCanvasId);
    const prevType = findProperty((prevEntry as any)?.properties || {}, "Type")?.select?.name;
    const rawBase = await readPageContent(previousCanvasId);

    if (prevType === "CNV EXP") {
      const match = rawBase.match(/<entry\s+type="CNV EXP"[^>]*>([\s\S]*?)<\/entry>/);
      baseContent = match ? match[1].trim() : "";
    } else {
      baseContent = unwrapCodeFences(rawBase);
    }
  } else {
    debug(`No previous canvas found for project ${projectId}. Using empty content as base.`);
  }

  // 3. Apply git diff to get full text
  const patchedLines = applyPatch(baseContent, diffContent);
  const fullText = patchedLines.map(l => l.text).join("\n");

  // 4. Update blocks based on diff only (avoiding full wipe)
  const forceWipe = results.length <= 1;
  await updatePageBlocks(canvasEntryId, fullText, true, forceWipe);
  debug(`Finished updating canvas page ${canvasEntryId} (forceWipe: ${forceWipe})`);

  // 5. Toggle off Include for other canvases, and toggle on for current canvas
  await Promise.all(
    results.map(async (r) => {
      const isCurrent = r.id === canvasEntryId;
      const currentInclude = findProperty((r as any).properties || {}, "Include")?.checkbox;
      const targetInclude = isCurrent;
      if (currentInclude !== targetInclude) {
        debug(`Setting Include to ${targetInclude} for canvas entry ${r.id}`);
        await notion.pages.update({
          page_id: r.id,
          properties: {
            Include: { checkbox: targetInclude }
          }
        });
      }
    })
  );
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
      pageType: "REG USR CMT",
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

    if (!finalTitle) {
      const nameProp = findProperty((sourceEntry as any).properties || {}, "Name");
      const inheritedTitle = nameProp?.title?.[0]?.plain_text ?? "";
      const sourceNum = parseInt(inheritedTitle, 10);
      if (!isNaN(sourceNum)) {
        finalTitle = String(sourceNum + 1);
      } else {
        finalTitle = inheritedTitle;
      }
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

  // Fetch all blocks from the canvas page (if exists)
  const canvasBlocks: any[] = [];
  let canvasPageId = "";
  try {
    const canvasDbIdResolved = await resolveDataSourceId(CANVAS_DB_ID);
    const canvasPagesResponse = await notion.dataSources.query({
      data_source_id: canvasDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: projectId }
      }
    });

    if (canvasPagesResponse.results.length > 0) {
      canvasPageId = canvasPagesResponse.results[0].id;
      let canvasHasMore = true;
      let canvasStartCursor: string | undefined;
      while (canvasHasMore) {
        const listResponse = await notion.blocks.children.list({
          block_id: canvasPageId,
          start_cursor: canvasStartCursor,
        });
        canvasBlocks.push(...listResponse.results);
        canvasHasMore = listResponse.has_more;
        canvasStartCursor = listResponse.next_cursor ?? undefined;
      }
    }
  } catch (err) {
    warn("Failed to retrieve canvas page blocks for comments copy:", err);
  }

    // 3. For each block/page, fetch comments
  const newBlocks: any[] = [];
  const itemsToScan: Array<{ id: string; type: string; raw?: any }> = [
    ...blocks.map(b => ({ id: b.id, type: b.type, raw: b })),
    ...canvasBlocks.map(b => ({ id: b.id, type: b.type, raw: b })),
    { id: sourceEntry.id, type: "page" },
    ...(canvasPageId ? [{ id: canvasPageId, type: "page" }] : [])
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

export async function handleCNVUPD(thoughtId: string): Promise<void> {
  debug(`Starting handleCNVUPD for Project ID: ${thoughtId}`);

  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const canvasDbIdResolved = await resolveDataSourceId(CANVAS_DB_ID);

  // 1. Gather all entries of type "CNV RES" and "CNV EXP" for the project
  const entriesResponse = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      property: "Project",
      relation: { contains: thoughtId }
    }
  });

  const canvasEntries = entriesResponse.results.filter((entry: any) => {
    const type = findProperty(entry.properties || {}, "Type")?.select?.name;
    return type === "CNV RES" || type === "CNV EXP";
  });

  // Sort them chronologically by their Name (converted to integer or alphanumerically)
  canvasEntries.sort((a: any, b: any) => {
    const nameA = findProperty(a.properties || {}, "Name")?.title?.[0]?.plain_text || "";
    const nameB = findProperty(b.properties || {}, "Name")?.title?.[0]?.plain_text || "";
    const numA = parseInt(nameA, 10);
    const numB = parseInt(nameB, 10);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    return nameA.localeCompare(nameB, undefined, { numeric: true });
  });

  debug(`Found ${canvasEntries.length} canvas entries to process`);

  // 2. Apply git diffs sequentially
  let currentContent = "";
  let latestEntryNumber = "";

  for (const entry of canvasEntries) {
    const nameProp = findProperty((entry as any).properties || {}, "Name");
    const entryNum = nameProp?.title?.[0]?.plain_text ?? "";
    if (entryNum) {
      latestEntryNumber = entryNum;
    }

    const type = findProperty((entry as any).properties || {}, "Type")?.select?.name;
    const content = await readPageContent(entry.id);

    if (type === "CNV EXP") {
      const match = content.match(/<entry\s+type="CNV EXP"[^>]*>([\s\S]*?)<\/entry>/);
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

  // 3. Find existing canvas page in Canvas DB for this project
  const canvasPagesResponse = await notion.dataSources.query({
    data_source_id: canvasDbIdResolved,
    filter: {
      property: "Project", relation: { contains: thoughtId }
    }
  });

  let canvasPageId = "";
  const results = canvasPagesResponse.results;

  if (results.length > 0) {
    canvasPageId = results[0].id;
    debug(`Using existing canvas page ${canvasPageId}`);

    // Update title/Name to the chronological number from entries
    await notion.pages.update({
      page_id: canvasPageId,
      properties: {
        Name: { title: [{ text: { content: latestEntryNumber || "1" } }] }
      }
    });

    // Enforce "only allow 1 canvas only" by archiving other duplicate canvas pages
    if (results.length > 1) {
      debug(`Archiving ${results.length - 1} duplicate canvas pages`);
      await Promise.all(
        results.slice(1).map(r => notion.pages.update({ page_id: r.id, archived: true }))
      );
    }
  } else {
    debug(`Creating new canvas page in Canvas DB`);
    const canvasPage = await notion.pages.create({
      parent: { data_source_id: canvasDbIdResolved },
      properties: {
        Name: { title: [{ text: { content: latestEntryNumber || "1" } }] },
        Project: { relation: [{ id: thoughtId }] }
      }
    });
    canvasPageId = canvasPage.id;
  }

  // 4. Link Project to Canvas
  try {
    await notion.pages.update({
      page_id: thoughtId,
      properties: {
        Canvas: { relation: [{ id: canvasPageId }] }
      }
    });
  } catch (err) {
    warn(`Failed to link Project to Canvas:`, err);
  }

  // 5. Update content inside canvas page based on diff only
  const forceWipe = canvasEntries.length <= 1;
  await updatePageBlocks(canvasPageId, currentContent, false, forceWipe);
  debug(`Finished updating canvas page ${canvasPageId} with latest content (forceWipe: ${forceWipe})`);
}

function getRichTextPlain(rt: any[]): string {
  return rt?.map((t: any) => t.plain_text).join("") ?? "";
}

function serializeBlockToMarkdown(block: any, childBlocksMap: Map<string, any[]>): string {
  const type = block.type;
  const data = block[type];
  if (!data) return "";

  switch (type) {
    case "heading_1":
      return `# ${getRichTextPlain(data.rich_text)}`;
    case "heading_2":
      return `## ${getRichTextPlain(data.rich_text)}`;
    case "heading_3":
      return `### ${getRichTextPlain(data.rich_text)}`;
    case "bulleted_list_item":
      return `- ${getRichTextPlain(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${getRichTextPlain(data.rich_text)}`;
    case "quote":
      return `> ${getRichTextPlain(data.rich_text)}`;
    case "divider":
      return `---`;
    case "paragraph":
      return getRichTextPlain(data.rich_text);
    case "code":
      return `\`\`\`\n${getRichTextPlain(data.rich_text)}\n\`\`\``;
    case "table": {
      const rows = childBlocksMap.get(block.id) || data.children || [];
      const rowStrings = rows.map((row: any) => {
        const cells = row.table_row?.cells || [];
        const cellStrings = cells.map((cell: any) => getRichTextPlain(cell));
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

export async function updatePageBlocks(
  pageId: string,
  newMarkdown: string,
  keepFirstBlock: boolean = false,
  forceWipe: boolean = false
): Promise<void> {
  if (forceWipe) {
    debug(`forceWipe is true for ${pageId}, performing full clean & insert`);
    let hasMore = true;
    let startCursor: string | undefined = undefined;
    let isFirstPage = true;

    while (hasMore) {
      const listResponse = await notion.blocks.children.list({
        block_id: pageId,
        start_cursor: startCursor,
      });

      if (listResponse.results.length > 0) {
        const blocksToDelete = (keepFirstBlock && isFirstPage)
          ? listResponse.results.slice(1)
          : listResponse.results;
        await Promise.all(
          blocksToDelete.map((block) =>
            notion.blocks.delete({ block_id: block.id })
          )
        );
      }

      isFirstPage = false;
      hasMore = listResponse.has_more;
      startCursor = listResponse.next_cursor ?? undefined;
    }

    let newBlocks = markdownToRichNotionBlocks(newMarkdown);
    newBlocks = newBlocks.map(b => cleanBlock(b));
    const CHUNK = 100;
    for (let i = 0; i < newBlocks.length; i += CHUNK) {
      await notion.blocks.children.append({
        block_id: pageId,
        children: newBlocks.slice(i, i + CHUNK) as any,
      });
    }
    return;
  }

  const existingBlocks: any[] = [];
  let hasMore = true;
  let startCursor: string | undefined = undefined;
  while (hasMore) {
    const listResponse = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: startCursor,
    });
    existingBlocks.push(...listResponse.results);
    hasMore = listResponse.has_more;
    startCursor = listResponse.next_cursor ?? undefined;
  }

  const childBlocksMap = new Map<string, any[]>();
  for (const block of existingBlocks) {
    if (block.type === "table" && block.has_children) {
      const childrenRes = await notion.blocks.children.list({ block_id: block.id });
      childBlocksMap.set(block.id, childrenRes.results);
    }
  }

  let oldBlocksToSync = existingBlocks;
  let firstBlockToKeep: any = null;
  if (keepFirstBlock && existingBlocks.length > 0) {
    firstBlockToKeep = existingBlocks[0];
    oldBlocksToSync = existingBlocks.slice(1);
  }

  let newBlocks = markdownToRichNotionBlocks(newMarkdown);
  newBlocks = newBlocks.map(b => cleanBlock(b));

  const oldSerialized = oldBlocksToSync.map(b => ({
    id: b.id,
    type: b.type,
    md: serializeBlockToMarkdown(b, childBlocksMap),
    raw: b,
  }));

  const newSerialized = newBlocks.map(b => ({
    type: b.type,
    md: serializeBlockToMarkdown(b, new Map()),
    raw: b,
  }));

  const diff = diffBlocks(oldSerialized, newSerialized);

  const ops: ({ type: "delete"; id: string } | { type: "insert"; blocks: any[]; afterId?: string })[] = [];
  
  let currentInsertRun: any[] = [];
  let lastKnownId: string | undefined = undefined;
  if (keepFirstBlock && firstBlockToKeep) {
    lastKnownId = firstBlockToKeep.id;
  }

  for (const step of diff) {
    if (step.action === "keep") {
      if (currentInsertRun.length > 0) {
        ops.push({ type: "insert", blocks: currentInsertRun, afterId: lastKnownId });
        currentInsertRun = [];
      }
      lastKnownId = oldSerialized[step.oldIdx!].id;
    } else if (step.action === "delete") {
      if (currentInsertRun.length > 0) {
        ops.push({ type: "insert", blocks: currentInsertRun, afterId: lastKnownId });
        currentInsertRun = [];
      }
      ops.push({ type: "delete", id: oldSerialized[step.oldIdx!].id });
    } else if (step.action === "insert") {
      currentInsertRun.push(newSerialized[step.newIdx!].raw);
    }
  }
  if (currentInsertRun.length > 0) {
    ops.push({ type: "insert", blocks: currentInsertRun, afterId: lastKnownId });
  }

  // Execute operations sequentially in batches
  for (const op of ops) {
    if (op.type === "delete") {
      try {
        await notion.blocks.delete({ block_id: op.id });
      } catch (err) {
        warn(`Failed to delete block ${op.id}:`, err);
      }
    } else if (op.type === "insert") {
      try {
        if (op.afterId) {
          const CHUNK = 100;
          let currentAfterId = op.afterId;
          for (let k = 0; k < op.blocks.length; k += CHUNK) {
            const chunkBlocks = op.blocks.slice(k, k + CHUNK);
            const res = await notion.blocks.children.append({
              block_id: pageId,
              children: chunkBlocks as any,
              after: currentAfterId,
            });
            if (res.results && res.results.length > 0) {
              currentAfterId = res.results[res.results.length - 1].id;
            }
          }
        } else {
          // Prepend at index 0 (swap with first existing block if present)
          if (oldSerialized.length > 0) {
            const firstOldBlock = oldSerialized[0];
            const firstNewBlock = op.blocks[0];
            const blockType = firstNewBlock.type;
            
            await notion.blocks.update({
              block_id: firstOldBlock.id,
              [blockType]: firstNewBlock[blockType],
            } as any);

            const remainingNewBlocks = op.blocks.slice(1);
            const restoreOldBlock = cleanBlock(firstOldBlock.raw);

            const CHUNK = 100;
            const prependedBlocks = [...remainingNewBlocks, restoreOldBlock];
            let currentAfterId = firstOldBlock.id;
            for (let k = 0; k < prependedBlocks.length; k += CHUNK) {
              const chunkBlocks = prependedBlocks.slice(k, k + CHUNK);
              const res = await notion.blocks.children.append({
                block_id: pageId,
                children: chunkBlocks as any,
                after: currentAfterId,
              });
              if (res.results && res.results.length > 0) {
                currentAfterId = res.results[res.results.length - 1].id;
              }
            }
          } else {
            const CHUNK = 100;
            for (let k = 0; k < op.blocks.length; k += CHUNK) {
              const chunkBlocks = op.blocks.slice(k, k + CHUNK);
              await notion.blocks.children.append({
                block_id: pageId,
                children: chunkBlocks as any,
              });
            }
          }
        }
      } catch (err) {
        warn(`Failed to execute insert operation:`, err);
      }
    }
  }
}

