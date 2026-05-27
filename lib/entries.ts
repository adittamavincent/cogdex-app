import { notion } from "./notion";
import { PageType } from "./types";

const ENTRIES_DB_ID = process.env.NOTION_ENTRIES_DB_ID!;

// Page body templates per Type
const TEMPLATES: Record<PageType, string> = {
  User: "## Intent\n\n\n## Brain Dump\n\n",
  Response: "## LLM Response\n\n",
  Agreement: "## Decisions\n\n\n## Definitions\n\n\n## Open Questions\n\n",
  Checkpoint: "## Current State\n\n\n## Stable Context\n\n",
  Attachment: "## Source\n\n\n## Notes\n\n",
  Compile: "", // filled by compile logic
};

// Read Continue Branch flag from a Thought Management page
export async function getContinueBranch(thoughtId: string): Promise<boolean> {
  const page = await notion.pages.retrieve({ page_id: thoughtId });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any;
  if (!p.properties) {
    console.error("[Cogdex] No properties found on Thought Management page response:", p);
    return false;
  }

  // Find key case-insensitively and stripping whitespace
  const targetKey = "continuebranch";
  const matchedKey = Object.keys(p.properties).find(
    (k) => k.toLowerCase().replace(/\s+/g, "") === targetKey
  );

  if (!matchedKey) {
    console.warn(
      `[Cogdex] "Continue Branch" property not found on Thought Management page. Available properties:`,
      Object.keys(p.properties)
    );
    return false;
  }

  const isChecked = p.properties[matchedKey]?.checkbox ?? false;
  console.log(`[Cogdex] Found property "${matchedKey}", value is:`, isChecked);
  return isChecked;
}


// Returns the entry row with the highest Number for this project (excluding Compile)
export async function getLatestEntry(thoughtId: string): Promise<any | null> {
  const response = await notion.dataSources.query({
    data_source_id: ENTRIES_DB_ID,
    filter: {
      and: [
        { property: "Thought Management", relation: { contains: thoughtId } },
        { property: "Type", select: { does_not_equal: "Compile" } },
      ],
    },
  });

  if (response.results.length === 0) return null;

  return response.results.reduce((latest: any, current: any) => {
    const ln = latest.properties?.Number?.number ?? 0;
    const cn = current.properties?.Number?.number ?? 0;
    return cn > ln ? current : latest;
  }, response.results[0]);
}

// Returns max(Number) across non-Compile entries for this project
export async function getMaxNumber(thoughtId: string): Promise<number> {
  const response = await notion.dataSources.query({
    data_source_id: ENTRIES_DB_ID,
    filter: {
      and: [
        { property: "Thought Management", relation: { contains: thoughtId } },
        { property: "Type", select: { does_not_equal: "Compile" } },
      ],
    },
  });

  let max = 0;
  for (const page of response.results) {
    if (page.object !== "page") continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = page as any;
    const num = p.properties?.Number?.number ?? 0;
    if (num > max) max = num;
  }
  return max;
}

// Returns the number to assign to a new entry
// continueBranch = true  → reuse max (branch from same position)
// continueBranch = false → max + 1 (standard increment)
export async function resolveNumber(
  thoughtId: string,
  continueBranch: boolean
): Promise<number> {
  const max = await getMaxNumber(thoughtId);
  if (max === 0) return 1; // first entry always gets 1 regardless of branch flag
  return continueBranch ? max : max + 1;
}

export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
}): Promise<string> {
  const { thoughtId, pageType } = params;

  const isCompile = pageType === "Compile";

  // --- Continue Branch logic ---
  let inheritedTitle = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let inheritedIcon: any = undefined;
  let continueBranch = false;

  if (!isCompile) {
    continueBranch = await getContinueBranch(thoughtId);
    console.log(`[Cogdex] continueBranch resolved from database:`, continueBranch);

    if (continueBranch) {
      const latest = await getLatestEntry(thoughtId);
      if (latest) {
        // Copy title
        inheritedTitle =
          latest.properties?.Title?.title?.[0]?.plain_text ?? "";

        // Copy icon (emoji or external URL)
        if (latest.icon) {
          inheritedIcon = latest.icon; // pass through as-is to pages.create
        }
        console.log(`[Cogdex] Inheriting from latest entry: title="${inheritedTitle}", icon=`, inheritedIcon);
      } else {
        console.log(`[Cogdex] No latest entry found to inherit from.`);
      }
    }
  }

  // --- Number resolution ---
  const number = isCompile ? null : await resolveNumber(thoughtId, continueBranch);
  console.log(`[Cogdex] Resolved number to assign:`, number);


  // --- Build properties ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const properties: any = {
    Title: {
      title: [{ text: { content: inheritedTitle } }],
    },
    Type: { select: { name: pageType } },
    Include: { checkbox: true },
    "Thought Management": { relation: [{ id: thoughtId }] },
  };

  if (number !== null) {
    properties.Number = { number };
  }

  // --- Build pages.create payload ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const createPayload: any = {
    parent: { data_source_id: ENTRIES_DB_ID },
    properties,
    children:
      !isCompile ? markdownToNotionBlocks(TEMPLATES[pageType]) : [],
  };

  if (inheritedIcon) {
    createPayload.icon = inheritedIcon;
  }

  const page = await notion.pages.create(createPayload);
  return page.id;
}


// Minimal markdown-to-Notion-blocks converter for templates.
// Only handles headings (##) and paragraphs — intentionally minimal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function markdownToNotionBlocks(md: string): any[] {
  const lines = md.split("\n");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];

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
