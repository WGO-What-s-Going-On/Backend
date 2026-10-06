export interface PushMessage {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  targetId?: string | null;
  actionPath?: string | null;
}

export interface PushResult {
  attempted: number;
  succeeded: number;
  failed: number;
  invalidTokens: string[];
}

export const PUSH_SENDER = Symbol('PUSH_SENDER');

export interface PushSender {
  send(message: PushMessage): Promise<PushResult>;
}
