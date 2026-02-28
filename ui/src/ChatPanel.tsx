import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

interface TextMessage {
  role: "user" | "assistant";
  type: "text";
  text: string;
}

interface ToolUseMessage {
  role: "assistant";
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultMessage {
  role: "assistant";
  type: "tool_result";
  id: string;
  name: string;
  output: string;
}

type ChatMessage = TextMessage | ToolUseMessage | ToolResultMessage;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

interface AnthropicContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface Chat {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export default function ChatPanel() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [anthropicHistory, setAnthropicHistory] = useState<AnthropicMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load chats on mount, auto-select most recent
  useEffect(() => {
    fetch("/api/chats")
      .then((r) => r.json())
      .then(({ chats: list }: { chats: Chat[] }) => {
        setChats(list);
        if (list.length > 0) loadChat(list[0].id);
      })
      .catch(() => {});
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const loadChat = useCallback(async (chatId: string) => {
    setActiveChatId(chatId);
    setMessages([]);
    setAnthropicHistory([]);
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      const { messages: saved, history } = await res.json();
      setMessages(saved);
      setAnthropicHistory(history);
    } catch {}
  }, []);

  const newChat = useCallback(() => {
    // Just clear state — chat row is created on first message send
    setActiveChatId(null);
    setMessages([]);
    setAnthropicHistory([]);
    setInput("");
    textareaRef.current?.focus();
  }, []);

  const deleteChat = useCallback(
    async (chatId: string, e: MouseEvent) => {
      e.stopPropagation();
      await fetch(`/api/chats/${chatId}`, { method: "DELETE" });
      setChats((prev) => prev.filter((c) => c.id !== chatId));
      if (activeChatId === chatId) {
        setActiveChatId(null);
        setMessages([]);
        setAnthropicHistory([]);
      }
    },
    [activeChatId]
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");

    // Create a chat session if none is active
    let chatId = activeChatId;
    if (!chatId) {
      try {
        const res = await fetch("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: text.slice(0, 50) }),
        });
        const { chat } = await res.json();
        chatId = chat.id;
        setActiveChatId(chatId);
        setChats((prev) => [chat, ...prev]);
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", type: "text", text: `Failed to create chat: ${err}` },
        ]);
        return;
      }
    }

    const userMsg: TextMessage = { role: "user", type: "text", text };
    setMessages((prev) => [...prev, userMsg]);

    const newHistory: AnthropicMessage[] = [
      ...anthropicHistory,
      { role: "user", content: text },
    ];

    setIsStreaming(true);

    const assistantContentBlocks: AnthropicContent[] = [];
    const toolResults: AnthropicContent[] = [];

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, messages: newHistory }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantTextIndex: number | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const json = line.slice(6).trim();
          if (!json) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(json);
          } catch {
            continue;
          }

          if (event.type === "text") {
            const chunk = event.text as string;
            if (assistantTextIndex === null) {
              setMessages((prev) => [
                ...prev,
                { role: "assistant", type: "text", text: chunk },
              ]);
              assistantTextIndex = assistantContentBlocks.length;
              assistantContentBlocks.push({ type: "text", text: chunk });
            } else {
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.type === "text" && last.role === "assistant") {
                  next[next.length - 1] = { ...last, text: last.text + chunk };
                }
                return next;
              });
              const block = assistantContentBlocks[assistantTextIndex];
              if (block?.type === "text") block.text = (block.text ?? "") + chunk;
            }
          } else if (event.type === "tool_use") {
            assistantTextIndex = null;
            const toolMsg: ToolUseMessage = {
              role: "assistant",
              type: "tool_use",
              id: event.id as string,
              name: event.name as string,
              input: event.input,
            };
            setMessages((prev) => [...prev, toolMsg]);
            assistantContentBlocks.push({
              type: "tool_use",
              id: event.id as string,
              name: event.name as string,
              input: event.input,
            });
          } else if (event.type === "tool_result") {
            const resultMsg: ToolResultMessage = {
              role: "assistant",
              type: "tool_result",
              id: event.id as string,
              name: event.name as string,
              output: event.output as string,
            };
            setMessages((prev) => [...prev, resultMsg]);
            toolResults.push({
              type: "tool_result",
              tool_use_id: event.id as string,
              content: event.output as string,
            });
          } else if (event.type === "done") {
            const updatedHistory: AnthropicMessage[] = [...newHistory];
            if (assistantContentBlocks.length > 0) {
              updatedHistory.push({ role: "assistant", content: assistantContentBlocks });
            }
            if (toolResults.length > 0) {
              updatedHistory.push({ role: "user", content: toolResults });
            }
            setAnthropicHistory(updatedHistory);
            // Move active chat to top of sidebar
            const now = new Date().toISOString();
            setChats((prev) => {
              const updated = prev.map((c) =>
                c.id === chatId ? { ...c, updated_at: now } : c
              );
              return updated.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
            });
          } else if (event.type === "error") {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", type: "text", text: `Error: ${event.message as string}` },
            ]);
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          type: "text",
          text: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setIsStreaming(false);
    }
  }, [input, isStreaming, anthropicHistory, activeChatId]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div style={{ display: "flex", height: "100%", fontFamily: "inherit" }}>
      {/* Sidebar */}
      <div
        style={{
          width: 180,
          flexShrink: 0,
          borderRight: "1px solid #2a2a2a",
          background: "#0d0d0d",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* New Chat button */}
        <button
          onClick={newChat}
          style={{
            margin: "10px 10px 6px",
            padding: "7px 10px",
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 6,
            color: "#e0e0e0",
            fontSize: 12,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "inherit",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 15, lineHeight: 1 }}>+</span> New Chat
        </button>

        {/* Chat list */}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {chats.length === 0 && (
            <div style={{ fontSize: 11, color: "#444", padding: "8px 12px" }}>
              No chats yet
            </div>
          )}
          {chats.map((chat) => (
            <div
              key={chat.id}
              onClick={() => loadChat(chat.id)}
              style={{
                padding: "7px 10px",
                cursor: "pointer",
                background: activeChatId === chat.id ? "#1e2a3a" : "transparent",
                borderLeft: `2px solid ${activeChatId === chat.id ? "#2563eb" : "transparent"}`,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: activeChatId === chat.id ? "#e0e0e0" : "#777",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {chat.title}
              </span>
              <button
                onClick={(e) => deleteChat(chat.id, e)}
                style={{
                  flexShrink: 0,
                  background: "none",
                  border: "none",
                  color: "#444",
                  cursor: "pointer",
                  fontSize: 15,
                  lineHeight: 1,
                  padding: "0 2px",
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Main chat area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #333",
            fontWeight: 600,
            fontSize: 14,
            color: "#e0e0e0",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 18 }}>🎬</span> Video Agent
        </div>

        {/* Message list */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "12px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {messages.length === 0 && (
            <div
              style={{
                color: "#555",
                fontSize: 13,
                textAlign: "center",
                marginTop: 40,
              }}
            >
              Ask the agent to edit your Remotion video...
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble key={i} msg={msg} />
          ))}

          {isStreaming && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 4,
              }}
            >
              <div style={{ fontSize: 11, color: "#666", paddingLeft: 4 }}>Agent</div>
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: "12px 12px 12px 2px",
                  background: "#222",
                  color: "#888",
                  fontSize: 13,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Spinner /> Thinking...
              </div>
            </div>
          )}
        </div>

        {/* Input area */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: "1px solid #333",
            display: "flex",
            gap: 8,
            alignItems: "flex-end",
            flexShrink: 0,
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask to edit the video... (Enter to send, Shift+Enter for newline)"
            disabled={isStreaming}
            rows={3}
            style={{
              flex: 1,
              resize: "none",
              background: "#222",
              border: "1px solid #444",
              borderRadius: 8,
              color: "#e0e0e0",
              padding: "8px 12px",
              fontSize: 13,
              lineHeight: 1.5,
              outline: "none",
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={sendMessage}
            disabled={isStreaming || !input.trim()}
            style={{
              padding: "8px 16px",
              background: isStreaming || !input.trim() ? "#333" : "#2563eb",
              color: isStreaming || !input.trim() ? "#666" : "#fff",
              border: "none",
              borderRadius: 8,
              cursor: isStreaming || !input.trim() ? "not-allowed" : "pointer",
              fontSize: 13,
              fontWeight: 600,
              transition: "background 0.15s",
              alignSelf: "flex-end",
              minHeight: 36,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.type === "text") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: msg.role === "user" ? "flex-end" : "flex-start",
          gap: 4,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: "#666",
            paddingLeft: msg.role === "user" ? 0 : 4,
            paddingRight: msg.role === "user" ? 4 : 0,
          }}
        >
          {msg.role === "user" ? "You" : "Agent"}
        </div>
        <div
          style={{
            maxWidth: "85%",
            padding: "8px 12px",
            borderRadius:
              msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
            background: msg.role === "user" ? "#2563eb" : "#222",
            color: "#e0e0e0",
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {msg.text}
        </div>
      </div>
    );
  }

  if (msg.type === "tool_use") {
    return (
      <div
        style={{
          background: "#1a2035",
          border: "1px solid #2a3a5c",
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 12,
        }}
      >
        <div style={{ color: "#60a5fa", fontWeight: 600, marginBottom: 4 }}>
          Tool: {msg.name}
        </div>
        <pre
          style={{
            color: "#94a3b8",
            margin: 0,
            overflowX: "auto",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {JSON.stringify(msg.input, null, 2)}
        </pre>
      </div>
    );
  }

  if (msg.type === "tool_result") {
    const lines = msg.output.split("\n");
    const preview =
      lines.length > 10
        ? lines.slice(0, 10).join("\n") + `\n... (${lines.length - 10} more lines)`
        : msg.output;

    return (
      <div
        style={{
          background: "#1a2a1a",
          border: "1px solid #2a4a2a",
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 12,
        }}
      >
        <div style={{ color: "#4ade80", fontWeight: 600, marginBottom: 4 }}>
          Result: {msg.name}
        </div>
        <pre
          style={{
            color: "#86efac",
            margin: 0,
            overflowX: "auto",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {preview}
        </pre>
      </div>
    );
  }

  return null;
}

function Spinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        border: "2px solid #555",
        borderTopColor: "#888",
        borderRadius: "50%",
        animation: "spin 0.6s linear infinite",
      }}
    />
  );
}
