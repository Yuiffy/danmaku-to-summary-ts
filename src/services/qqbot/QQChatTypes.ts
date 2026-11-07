export interface QQChatMessage {
  version: 1;
  id: string;
  appId: string;
  conversation: string;
  user: string;
  senderName?: string;
  text: string;
  createdAt: number;
}
