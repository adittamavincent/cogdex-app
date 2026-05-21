export type PageType =
  | "User"
  | "Response"
  | "Agreement"
  | "Checkpoint"
  | "Attachment"
  | "Compile";

export type WebhookAction = "create" | "compile";

export interface CogdexWebhookPayload {
  action: WebhookAction;
  thoughtId: string; // Notion page ID of the Thought Management entry
  pageType?: PageType; // required when action = "create"
}
