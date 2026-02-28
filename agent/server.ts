/**
 * Deno + Hono agent server for the video editing AI agent.
 * Run with: deno run --allow-all agent/server.ts
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import Anthropic from "@anthropic-ai/sdk";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";
import { Database } from "@db/sqlite";

const PORT = 8080;
const PROJECT_ROOT = path.join(path.fromFileUrl(import.meta.url), "..", "..");
// Submodule is at agent/skills/remotion (the remotion-dev/skills repo),
// and the actual content lives at skills/remotion/ inside that repo.
const SKILLS_DIR = path.join(PROJECT_ROOT, "agent", "skills", "remotion", "skills", "remotion");

// Load skills at startup
async function loadSkills(): Promise<string> {
  const parts: string[] = [];

  try {
    const skillMd = await Deno.readTextFile(path.join(SKILLS_DIR, "SKILL.md"));
    parts.push("## Remotion SKILL.md\n\n" + skillMd);
  } catch {
    console.warn("Warning: SKILL.md not found. Run `bun run skills:sync` first.");
  }

  try {
    const rulesDir = path.join(SKILLS_DIR, "rules");
    for await (const entry of Deno.readDir(rulesDir)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        const content = await Deno.readTextFile(path.join(rulesDir, entry.name));
        parts.push(`## Rule: ${entry.name}\n\n${content}`);
      }
    }
  } catch {
    console.warn("Warning: rules/ directory not found. Run `bun run skills:sync` first.");
  }

  return parts.join("\n\n---\n\n");
}

// Tool implementations
async function readFile(filePath: string): Promise<string> {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(PROJECT_ROOT, filePath);
  return await Deno.readTextFile(absPath);
}

async function writeFile(filePath: string, content: string): Promise<string> {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(PROJECT_ROOT, filePath);
  await ensureDir(path.dirname(absPath));
  await Deno.writeTextFile(absPath, content);
  return `File written successfully: ${filePath}`;
}

async function listDirectory(dirPath: string): Promise<string> {
  const absPath = path.isAbsolute(dirPath)
    ? dirPath
    : path.join(PROJECT_ROOT, dirPath);

  const lines: string[] = [];

  async function walk(dir: string, indent: string): Promise<void> {
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        lines.push(`${indent}${entry.isDirectory ? "📁" : "📄"} ${entry.name}`);
        if (entry.isDirectory) {
          await walk(path.join(dir, entry.name), indent + "  ");
        }
      }
    } catch (e) {
      lines.push(`${indent}[Error reading directory: ${e}]`);
    }
  }

  await walk(absPath, "");
  return lines.join("\n") || "(empty directory)";
}

async function runCommand(command: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const parts = command.split(/\s+/);
    const cmd = new Deno.Command(parts[0]!, {
      args: parts.slice(1),
      cwd: PROJECT_ROOT,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });

    const { stdout, stderr, code } = await cmd.output();
    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    return [
      `Exit code: ${code}`,
      stdoutText && `--- stdout ---\n${stdoutText}`,
      stderrText && `--- stderr ---\n${stderrText}`,
    ]
      .filter(Boolean)
      .join("\n");
  } finally {
    clearTimeout(timeout);
  }
}

// Tool definitions for Claude
const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Path can be relative to the project root or absolute.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to project root or absolute path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates directories as needed. Path can be relative to the project root or absolute.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to project root or absolute path",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_directory",
    description:
      "List the contents of a directory as a file tree. Path can be relative to project root.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to project root or absolute path",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the project root directory. Returns stdout and stderr. Timeout: 30 seconds.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "Shell command to run",
        },
      },
      required: ["command"],
    },
  },
];

// Execute a tool call
async function executeTool(
  name: string,
  input: Record<string, string>
): Promise<string> {
  switch (name) {
    case "read_file":
      return await readFile(input.path!);
    case "write_file":
      return await writeFile(input.path!, input.content!);
    case "list_directory":
      return await listDirectory(input.path!);
    case "run_command":
      return await runCommand(input.command!);
    default:
      return `Unknown tool: ${name}`;
  }
}

// Main server
async function main() {
  // Setup SQLite DB
  const DATA_DIR = path.join(PROJECT_ROOT, "data");
  await ensureDir(DATA_DIR);
  const db = new Database(path.join(DATA_DIR, "chats.db"));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
    CREATE TABLE IF NOT EXISTS history (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      data TEXT NOT NULL
    );
  `);

  function saveMessage(chatId: string, msg: Record<string, unknown>) {
    db.prepare("INSERT INTO messages (id, chat_id, data, created_at) VALUES (?, ?, ?, ?)")
      .run(crypto.randomUUID(), chatId, JSON.stringify(msg), new Date().toISOString());
  }

  function saveHistory(chatId: string, history: Anthropic.MessageParam[]) {
    db.prepare("INSERT OR REPLACE INTO history (chat_id, data) VALUES (?, ?)")
      .run(chatId, JSON.stringify(history));
  }

  function touchChat(chatId: string) {
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), chatId);
  }

  console.log("Loading Remotion skills...");
  const skillsContent = await loadSkills();
  const skillsLoaded = skillsContent.length > 0;
  console.log(
    skillsLoaded
      ? `Skills loaded (${skillsContent.length} chars)`
      : "No skills loaded"
  );

  const SYSTEM_PROMPT = `You are a Remotion video editing agent. You help users edit video compositions in the project. You can read files, write files, list directories, and run commands.

When a user asks to change the video, read the relevant source file first, then make targeted edits to the TypeScript/TSX files in src/.

The project uses Remotion (a React-based video framework). The main entry point is src/index.tsx and compositions are defined in src/Root.tsx.

${skillsLoaded ? `=== Remotion Skills ===\n\n${skillsContent}` : ""}`.trim();

  const client = new Anthropic();
  const app = new Hono();

  // CORS for local dev
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    })
  );

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // List all chats
  app.get("/chats", (c) => {
    const chats = db
      .prepare("SELECT * FROM chats ORDER BY updated_at DESC")
      .all<{ id: string; title: string; created_at: string; updated_at: string }>();
    return c.json({ chats });
  });

  // Create a new chat
  app.post("/chats", async (c) => {
    const { title } = await c.req.json<{ title: string }>();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, title || "New Chat", now, now);
    return c.json({ chat: { id, title: title || "New Chat", created_at: now, updated_at: now } }, 201);
  });

  // Get messages + history for a chat
  app.get("/chats/:id", (c) => {
    const chatId = c.req.param("id");
    const msgs = db
      .prepare("SELECT data FROM messages WHERE chat_id = ? ORDER BY created_at")
      .all<{ data: string }>(chatId);
    const histRow = db
      .prepare("SELECT data FROM history WHERE chat_id = ?")
      .get<{ data: string }>(chatId);
    return c.json({
      messages: msgs.map((r) => JSON.parse(r.data)),
      history: histRow ? JSON.parse(histRow.data) : [],
    });
  });

  // Delete a chat (cascades to messages + history)
  app.delete("/chats/:id", (c) => {
    const chatId = c.req.param("id");
    db.prepare("DELETE FROM chats WHERE id = ?").run(chatId);
    return c.json({ ok: true });
  });

  // Update chat title
  app.patch("/chats/:id/title", async (c) => {
    const chatId = c.req.param("id");
    const { title } = await c.req.json<{ title: string }>();
    db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, new Date().toISOString(), chatId);
    return c.json({ ok: true });
  });

  // Chat endpoint — SSE stream
  app.post("/chat", async (c) => {
    const body = await c.req.json<{
      chatId: string;
      messages: Anthropic.MessageParam[];
    }>();

    const { chatId, messages } = body;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function send(data: Record<string, unknown>) {
          const line = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }

        try {
          // Save the new user message (last item in the incoming history)
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === "user" && typeof lastMsg.content === "string") {
            saveMessage(chatId, { role: "user", type: "text", text: lastMsg.content });
          }

          // Mutable copy to accumulate messages through tool loops
          const conversationMessages: Anthropic.MessageParam[] = [...messages];

          // Agent loop
          while (true) {
            const response = await client.messages.create({
              model: "claude-sonnet-4-6",
              max_tokens: 8096,
              system: SYSTEM_PROMPT,
              messages: conversationMessages,
              tools: TOOLS,
            });

            let hasText = false;

            // Stream content blocks
            for (const block of response.content) {
              if (block.type === "text") {
                hasText = true;
                send({ type: "text", text: block.text });
                saveMessage(chatId, { role: "assistant", type: "text", text: block.text });
              } else if (block.type === "tool_use") {
                send({
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
                saveMessage(chatId, { role: "assistant", type: "tool_use", id: block.id, name: block.name, input: block.input });
              }
            }

            // If stop_reason is end_turn with no tool use, we're done
            if (
              response.stop_reason === "end_turn" &&
              !response.content.some((b) => b.type === "tool_use")
            ) {
              break;
            }

            // If stop_reason is tool_use, execute tools and continue
            if (response.stop_reason === "tool_use") {
              // Add assistant message to conversation
              conversationMessages.push({
                role: "assistant",
                content: response.content,
              });

              // Execute all tool calls
              const toolResults: Anthropic.ToolResultBlockParam[] = [];

              for (const block of response.content) {
                if (block.type === "tool_use") {
                  let output: string;
                  try {
                    output = await executeTool(
                      block.name,
                      block.input as Record<string, string>
                    );
                  } catch (err) {
                    output = `Error: ${err instanceof Error ? err.message : String(err)}`;
                  }

                  send({
                    type: "tool_result",
                    id: block.id,
                    name: block.name,
                    output,
                  });
                  saveMessage(chatId, { role: "assistant", type: "tool_result", id: block.id, name: block.name, output });

                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: block.id,
                    content: output,
                  });
                }
              }

              // Add tool results to conversation
              conversationMessages.push({
                role: "user",
                content: toolResults,
              });

              // Continue the loop
              continue;
            }

            // Any other stop reason or no text — break
            if (!hasText) {
              break;
            }
            break;
          }

          saveHistory(chatId, conversationMessages);
          touchChat(chatId);
          send({ type: "done" });
        } catch (err) {
          console.error("Agent error:", err);
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

  console.log(`\nAgent server running on http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log(`  GET    http://localhost:${PORT}/health`);
  console.log(`  GET    http://localhost:${PORT}/chats`);
  console.log(`  POST   http://localhost:${PORT}/chats`);
  console.log(`  GET    http://localhost:${PORT}/chats/:id`);
  console.log(`  DELETE http://localhost:${PORT}/chats/:id`);
  console.log(`  POST   http://localhost:${PORT}/chat\n`);

  Deno.serve({ port: PORT }, app.fetch);
}

main().catch(console.error);
