// ==========================================================================
// Types inlined from @zypher/agent and @zypher/http
// Copied here (shadcn-style) to avoid Deno-style specifier issues in Vite.
// ==========================================================================

// --- Content blocks (from @zypher/agent/message.ts) ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface Base64ImageSource {
  type: "base64";
  data: string;
  mediaType: string;
}

export interface UrlImageSource {
  type: "url";
  url: string;
  mediaType: string;
}

export interface ImageBlock {
  type: "image";
  source: Base64ImageSource | UrlImageSource;
}

export interface ToolUseBlock {
  type: "tool_use";
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  name: string;
  input: unknown;
  success: boolean;
  content: (TextBlock | ImageBlock)[];
}

export interface FileAttachment {
  type: "file_attachment";
  fileId: string;
  mimeType: string;
}

export interface ThinkingBlock {
  type: "thinking";
  signature: string;
  thinking: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | FileAttachment
  | ThinkingBlock;

// --- Messages (from @zypher/agent/message.ts, llm/model_provider.ts) ---

export interface Message {
  content: ContentBlock[];
  role: "user" | "assistant";
  timestamp: Date;
  checkpointId?: string;
  checkpoint?: {
    id: string;
    name: string;
    timestamp: string;
  };
}

export interface TokenUsage {
  input: {
    total: number;
    cacheCreation?: number;
    cacheRead?: number;
  };
  output: {
    total: number;
    thinking?: number;
  };
  total: number;
}

export interface FinalMessage extends Message {
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";
  usage?: TokenUsage;
}

// --- MCP types (from @zypher/agent/mcp/) ---

export type McpClientStatus =
  | "disconnected"
  | { connecting: "initializing" | "awaitingOAuth" }
  | { connected: "initial" | "toolDiscovered" }
  | "disconnecting"
  | "disconnectingDueToError"
  | "error"
  | "aborting"
  | "disposed";

export type McpServerSource =
  | { type: "registry"; packageIdentifier: string }
  | { type: "direct" };

export interface McpCommandConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerEndpoint = {
  id: string;
  displayName?: string;
} & (
  | { type: "command"; command: McpCommandConfig }
  | { type: "remote"; remote: McpRemoteConfig }
);

// --- Task events (from @zypher/agent/task_events.ts) ---

export interface TaskTextEvent {
  type: "text";
  content: string;
}

export interface TaskMessageEvent {
  type: "message";
  message: Message | FinalMessage;
}

export interface TaskHistoryChangedEvent {
  type: "history_changed";
}

export interface TaskToolUseEvent {
  type: "tool_use";
  toolUseId: string;
  toolName: string;
}

export interface TaskToolUseInputEvent {
  type: "tool_use_input";
  toolUseId: string;
  toolName: string;
  partialInput: string;
}

export interface TaskToolUsePendingApprovalEvent {
  type: "tool_use_pending_approval";
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface TaskToolUseRejectedEvent {
  type: "tool_use_rejected";
  toolUseId: string;
  toolName: string;
  reason: string;
}

export interface TaskToolUseApprovedEvent {
  type: "tool_use_approved";
  toolUseId: string;
  toolName: string;
}

export interface TaskToolUseResultEvent {
  type: "tool_use_result";
  toolUseId: string;
  toolName: string;
  input: unknown;
  result: unknown;
}

export interface TaskToolUseErrorEvent {
  type: "tool_use_error";
  toolUseId: string;
  toolName: string;
  input: unknown;
  error: unknown;
}

export interface TaskToolUseCancelledEvent {
  type: "tool_use_cancelled";
  toolUseId: string;
  toolName: string;
  input: unknown;
}

export interface TaskInterceptorUseEvent {
  type: "interceptor_use";
  interceptorName: string;
}

export interface TaskInterceptorResultEvent {
  type: "interceptor_result";
  interceptorName: string;
  decision: "continue" | "complete";
}

export interface TaskInterceptorErrorEvent {
  type: "interceptor_error";
  interceptorName: string;
  error: unknown;
}

export interface TaskCancelledEvent {
  type: "cancelled";
  reason: "user" | "timeout";
}

export interface TaskUsageEvent {
  type: "usage";
  usage: TokenUsage;
  cumulativeUsage: TokenUsage;
}

export interface TaskCompletedEvent {
  type: "completed";
  totalUsage?: TokenUsage;
}

export type TaskEvent =
  | TaskTextEvent
  | TaskMessageEvent
  | TaskHistoryChangedEvent
  | TaskToolUseEvent
  | TaskToolUseInputEvent
  | TaskToolUsePendingApprovalEvent
  | TaskToolUseRejectedEvent
  | TaskToolUseApprovedEvent
  | TaskToolUseResultEvent
  | TaskToolUseErrorEvent
  | TaskToolUseCancelledEvent
  | TaskInterceptorUseEvent
  | TaskInterceptorResultEvent
  | TaskInterceptorErrorEvent
  | TaskCancelledEvent
  | TaskUsageEvent
  | TaskCompletedEvent;

// --- HTTP types (from @zypher/http) ---

export interface HeartbeatEvent {
  type: "heartbeat";
  timestamp: number;
}

export interface TaskErrorEvent {
  type: "error";
  name?: string;
  message?: string;
  stack?: string;
  [key: string]: unknown;
}

/** An HTTP task event with a unique event ID (serialized as a string over the wire). */
export type HttpTaskEvent = (TaskEvent | HeartbeatEvent | TaskErrorEvent) & {
  eventId: string;
};

/** Event ID — a class on the server, but arrives as a plain string over WebSocket. */
export type HttpTaskEventId = string;

export type TaskWebSocketClientMessage =
  | { action: "startTask"; task: string; fileAttachments?: string[] }
  | { action: "resumeTask"; lastEventId?: string }
  | { action: "cancelTask" }
  | { action: "approveTool"; approved: boolean };

export type TaskWebSocketServerMessage = HttpTaskEvent;

export type TaskWebSocketMessage =
  | TaskWebSocketClientMessage
  | TaskWebSocketServerMessage;

// --- MCP WebSocket events (from @zypher/http/schema.ts) ---

export type McpWebSocketEvent =
  | {
      type: "initial_state";
      servers: Array<{
        serverId: string;
        server: McpServerEndpoint;
        source: McpServerSource;
        status: McpClientStatus;
        enabled: boolean;
        pendingOAuthUrl?: string;
      }>;
    }
  | {
      type: "server_added";
      serverId: string;
      server: McpServerEndpoint;
      source: McpServerSource;
    }
  | {
      type: "server_updated";
      serverId: string;
      updates: { server?: McpServerEndpoint; enabled?: boolean };
    }
  | {
      type: "server_removed";
      serverId: string;
    }
  | {
      type: "client_status_changed";
      serverId: string;
      status: McpClientStatus;
      pendingOAuthUrl?: string;
    }
  | {
      type: "error";
      [key: string]: unknown;
    };
