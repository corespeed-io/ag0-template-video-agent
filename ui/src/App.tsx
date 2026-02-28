import { Trash2Icon } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation.tsx";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message.tsx";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input.tsx";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.tsx";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { ContentBlock } from "@/lib/zypher-ui";
import {
  AgentProvider,
  type CompleteMessage,
  type CustomContentBlock,
  type StreamingMessage,
  TaskApiClient,
  useAgentContext,
} from "@/lib/zypher-ui";

const client = new TaskApiClient({
  baseUrl:
    import.meta.env.VITE_API_URL ??
    new URL("/api/agent", window.location.origin).toString(),
});

// Remotion Studio URL — set VITE_REMOTION_URL at build/dev time to enable the
// split-panel layout. Undefined in production (Railway) hides the right panel.
// Guard against iframe recursion: never show the panel when already embedded.
const remotionUrl =
  window.self === window.top
    ? (import.meta.env.VITE_REMOTION_URL as string | undefined)
    : undefined;

function App() {
  return (
    <AgentProvider client={client}>
      <div className="flex h-screen w-full overflow-hidden">
        {/* Left panel: Agent chat */}
        <div
          className={cn(
            "flex flex-col min-w-80",
            remotionUrl ? "w-[420px] border-r" : "flex-1",
          )}
        >
          <ChatUI />
        </div>

        {/* Right panel: Remotion Studio preview (dev/AG0 only) */}
        {remotionUrl && (
          <iframe
            src={remotionUrl}
            className="flex-1 border-none"
            title="Remotion Studio"
            allow="autoplay; fullscreen"
          />
        )}
      </div>
    </AgentProvider>
  );
}

function ChatUI() {
  const {
    messages,
    streamingMessages,
    isTaskRunning,
    isLoadingMessages,
    isClearingMessages,
    runTask,
    clearMessageHistory,
    cancelCurrentTask,
  } = useAgentContext();

  const handleSubmit = ({ text }: { text: string }) => {
    runTask(text);
  };

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <h1 className="font-semibold text-lg">Video Agent</h1>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => clearMessageHistory()}
          disabled={isClearingMessages || isTaskRunning}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </header>

      <Conversation>
        <ConversationContent>
          {isLoadingMessages && (
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-6" />
            </div>
          )}

          {messages.map((msg) => (
            <MessageBlock key={msg.id} message={msg} />
          ))}

          {streamingMessages.length > 0 && (
            <Message from="assistant">
              <MessageContent>
                {streamingMessages.map((sm) => (
                  <StreamingBlock key={sm.id} message={sm} />
                ))}
              </MessageContent>
            </Message>
          )}

          {isTaskRunning &&
            streamingMessages.length === 0 &&
            !isLoadingMessages && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Spinner className="size-4" />
                <span>Thinking...</span>
              </div>
            )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="p-4">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea disabled={isTaskRunning} />
          <PromptInputFooter>
            <div />
            <PromptInputSubmit
              status={isTaskRunning ? "streaming" : "ready"}
              onStop={cancelCurrentTask}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function MessageBlock({ message }: { message: CompleteMessage }) {
  // Hide user messages that have no visible content (e.g. pure image_url blocks)
  if (message.role === "user") {
    const hasVisible = message.content.some(
      (b) => b.type === "text" || b.type === "tool_result",
    );
    if (!hasVisible) return null;
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        {message.content.map((block, i) => (
          <ContentBlockRenderer key={i} block={block} />
        ))}
      </MessageContent>
    </Message>
  );
}

function ContentBlockRenderer({
  block,
}: {
  block: ContentBlock | CustomContentBlock;
}) {
  // Cast to ContentBlock for type narrowing in switch - unknown types fall through to default
  const b = block as ContentBlock;
  switch (b.type) {
    case "text":
      return b.text ? <MessageResponse>{b.text}</MessageResponse> : null;

    case "tool_use":
      return (
        <Tool>
          <ToolHeader
            type="dynamic-tool"
            toolName={b.name}
            state="input-available"
          />
          <ToolContent>
            <ToolInput input={b.input} />
          </ToolContent>
        </Tool>
      );

    case "tool_result": {
      const outputText = b.content
        .filter(
          (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
        )
        .map((c) => c.text)
        .join("\n");
      return (
        <Tool>
          <ToolHeader
            type="dynamic-tool"
            toolName={b.name}
            state={b.success ? "output-available" : "output-error"}
          />
          <ToolContent>
            <ToolInput input={b.input} />
            <ToolOutput
              output={b.success ? outputText : undefined}
              errorText={!b.success ? outputText : undefined}
            />
          </ToolContent>
        </Tool>
      );
    }

    case "thinking":
      return (
        <Reasoning>
          <ReasoningTrigger />
          <ReasoningContent>{b.thinking}</ReasoningContent>
        </Reasoning>
      );

    case "image": {
      const src =
        b.source.type === "url"
          ? b.source.url
          : `data:${b.source.mediaType};base64,${b.source.data}`;
      return <img src={src} alt="" className="max-w-full rounded-md" />;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Streaming message rendering
// ---------------------------------------------------------------------------

function StreamingBlock({ message }: { message: StreamingMessage }) {
  if (message.type === "streaming_text") {
    return <MessageResponse>{message.text}</MessageResponse>;
  }

  if (message.type === "streaming_tool_use") {
    let input: unknown;
    try {
      input = JSON.parse(message.partialInput);
    } catch {
      input = message.partialInput;
    }
    return (
      <Tool>
        <ToolHeader
          type="dynamic-tool"
          toolName={message.toolUseName}
          state="input-streaming"
        />
        <ToolContent>
          <ToolInput input={input} />
        </ToolContent>
      </Tool>
    );
  }

  return null;
}

export default App;
