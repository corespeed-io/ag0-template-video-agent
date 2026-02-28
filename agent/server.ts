/**
 * Deno + Hono agent server for the video editing AI agent.
 * Run with: deno run --allow-all agent/server.ts
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import Anthropic from "@anthropic-ai/sdk";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import { ensureDir } from "https://deno.land/std@0.224.0/fs/mod.ts";

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
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    })
  );

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Chat endpoint — SSE stream
  app.post("/chat", async (c) => {
    const body = await c.req.json<{
      messages: Anthropic.MessageParam[];
    }>();

    const { messages } = body;

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        function send(data: Record<string, unknown>) {
          const line = `data: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }

        try {
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
              } else if (block.type === "tool_use") {
                send({
                  type: "tool_use",
                  id: block.id,
                  name: block.name,
                  input: block.input,
                });
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
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  POST http://localhost:${PORT}/chat\n`);

  Deno.serve({ port: PORT }, app.fetch);
}

main().catch(console.error);
