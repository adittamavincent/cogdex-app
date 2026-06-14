export type PageType =
  | "REG USR"
  | "REG RES"
  | "CNV EXP"
  | "CNV RES"
  | "REG EXP"
  | "REG USR CMT"
  | "Relink Databases";

// Notion automation webhook — actual payload shape sent by Notion
// body.data.id is the page ID of the Thought Management row that triggered the button
export interface NotionAutomationPayload {
  source: {
    type: string;
    automation_id: string;
    action_id: string;
    event_id: string;
    user_id: string;
    attempt: number;
  };
  data: {
    object: string;
    id: string; // Thought Management page ID — used as thoughtId
    [key: string]: unknown;
  };
}
