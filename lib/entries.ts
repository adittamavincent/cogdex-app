import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";
import { readPageContent } from "./export";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;
const CANVAS_DB_ID = process.env.NOTION_CANVAS_DB_ID!;

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

  let entryCount = 0;
  let hasMore = true;
  let nextCursor: string | undefined = undefined;

  while (hasMore) {
    const res = await notion.dataSources.query({
      data_source_id: ENTRY_DB_ID,
      filter: { property: "Project", relation: { contains: thoughtId } },
      start_cursor: nextCursor,
    });
    entryCount += res.results.length;
    hasMore = res.has_more;
    nextCursor = res.next_cursor ?? undefined;
  }
  const nextNumber = entryCount + 1;

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
    parent: { data_source_id: ENTRY_DB_ID },
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

  if (!ORIGINAL_ENTRY_VIEW_ID || !ORIGINAL_SYSTEM_PROMPT_VIEW_ID) {
    throw new Error(
      "Missing required view ID environment variables: NOTION_ENTRY_VIEW_ID, NOTION_SYSTEM_PROMPT_VIEW_ID"
    );
  }

  debug(`Fetching original views: Entry=${ORIGINAL_ENTRY_VIEW_ID}, SystemPrompt=${ORIGINAL_SYSTEM_PROMPT_VIEW_ID}`);
  const [entryView, systemPromptView] = await Promise.all([
    notion.views.retrieve({ view_id: ORIGINAL_ENTRY_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_SYSTEM_PROMPT_VIEW_ID }),
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
    
    let configuration = originalView.configuration || undefined;
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

  debug("Creating cloned Entry database view");
  await createClonedView(entryView, ENTRY_DB_ID, projectFilterModifier);

  debug("Creating cloned System Prompt database view");
  await createClonedView(systemPromptView, SYSTEM_PROMPT_DB_ID);

  debug(`Successfully finished relinkDatabases for page ${thoughtId}`);
}

export function isDiff(content: string): boolean {
  if (/^@@\s+-\d+.*\+\d+.*@@/m.test(content)) {
    return true;
  }
  const lines = content.split("\n");
  let diffIndicators = 0;
  for (const line of lines) {
    if (line.startsWith("+") || line.startsWith("-")) {
      diffIndicators++;
    }
  }
  return diffIndicators > 0 || content.includes("--- ") || content.includes("+++ ");
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

  if (parentId === CANVAS_DB_ID) {
    debug(`Triggered page ${triggeredId} is a Canvas Entry`);
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
        data_source_id: CANVAS_DB_ID,
        filter: {
          property: "Project", relation: { contains: projectId }
        },
        sorts: [{ timestamp: "created_time", direction: "descending" }],
        page_size: 1
      });
    } catch (err: any) {
      if (err.code === "object_not_found") {
        throw new Error(`Canvas DB not found. Ensure the Canvas DB is shared with the integration.`);
      }
      throw err;
    }

    if (canvasPagesResponse.results.length === 0) {
      throw new Error(`No Canvas entry found for project ${projectId}.`);
    }
    canvasEntryId = canvasPagesResponse.results[0].id;
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
    data_source_id: CANVAS_DB_ID,
    filter: {
      property: "Project", relation: { contains: projectId }
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }]
  });

  const results = canvasPagesResponse.results;
  const currentIdx = results.findIndex(r => r.id === canvasEntryId);
  let previousCanvasId: string | null = null;
  if (currentIdx !== -1 && currentIdx + 1 < results.length) {
    previousCanvasId = results[currentIdx + 1].id;
  }

  let baseContent = "";
  if (previousCanvasId) {
    debug(`Found previous canvas: ${previousCanvasId}`);
    baseContent = await readPageContent(previousCanvasId);
  } else {
    debug(`No previous canvas found for project ${projectId}. Using empty content as base.`);
  }

  // 3. Apply git diff to get full text
  const patchedLines = applyPatch(baseContent, diffContent);
  const fullText = patchedLines.map(l => l.text).join("\n");
  const newBlocks = markdownToRichNotionBlocks(fullText);

  // 4. Delete all existing blocks EXCEPT the first code block, then append
  let hasMore = true;
  let startCursor: string | undefined = undefined;
  let isFirstPage = true;

  while (hasMore) {
    const listResponse = await notion.blocks.children.list({
      block_id: canvasEntryId,
      start_cursor: startCursor,
    });

    if (listResponse.results.length > 0) {
      // Keep the first block (which should be the diff code block), delete the rest
      const blocksToDelete = isFirstPage ? listResponse.results.slice(1) : listResponse.results;
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
  debug("Wiped clean previous appended blocks inside canvas page");

  // Clean read-only properties from Notion objects before appending
  const cleanBlocks = newBlocks.map(b => cleanBlock(b));

  const CHUNK = 100;
  for (let i = 0; i < cleanBlocks.length; i += CHUNK) {
    await notion.blocks.children.append({
      block_id: canvasEntryId,
      children: cleanBlocks.slice(i, i + CHUNK) as any,
    });
  }
  debug(`Finished appending full version back to canvas page ${canvasEntryId}`);

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

export async function handleUserComment(thoughtId: string) {
  debug(`Starting handleUserComment for thought: ${thoughtId}`);

  // 1. Get the 2 most recent entries for this project
  const recentResponse = await notion.dataSources.query({
    data_source_id: ENTRY_DB_ID,
    filter: {
      property: "Project",
      relation: { contains: thoughtId },
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 2,
  });

  if (recentResponse.results.length < 2) {
    debug("Not enough entries to copy comments from.");
    return;
  }

  const targetEntry = recentResponse.results[0]; // Newly created by automation
  const sourceEntry = recentResponse.results[1]; // Previous entry to scan

  debug(`Scanning source entry ${sourceEntry.id} for comments to attach to ${targetEntry.id}`);

  // Update properties
  try {
    let inheritedTitle = "";

    const nameProp = findProperty((sourceEntry as any).properties || {}, "Name");
    inheritedTitle = nameProp?.title?.[0]?.plain_text ?? "";

    const propertiesToUpdate: any = {
      "Entries Referenced": { relation: [{ id: sourceEntry.id }] },
      Name: { title: inheritedTitle ? [{ text: { content: inheritedTitle } }] : [] }
    };

    const updatePayload: any = {
      page_id: targetEntry.id,
      properties: propertiesToUpdate
    };

    await notion.pages.update(updatePayload);
    debug(`Updated targetEntry properties: EntriesReferenced=${sourceEntry.id}, Title=${inheritedTitle}`);
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

  // 3. For each block, fetch comments
  const newBlocks: any[] = [];
  for (const block of blocks) {
    try {
      const commentsRes = await notion.comments.list({ block_id: block.id });
      if (commentsRes.results.length > 0) {
        // Find text content
        let blockTextRichText = [];
        if (block[block.type] && block[block.type].rich_text) {
          blockTextRichText = sanitizeRichText(block[block.type].rich_text);
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
