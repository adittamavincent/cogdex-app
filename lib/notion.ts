import { Client } from "@notionhq/client";

export const notion = new Client({
  auth: process.env.NOTION_TOKEN!,
  notionVersion: "2026-03-11",
});
