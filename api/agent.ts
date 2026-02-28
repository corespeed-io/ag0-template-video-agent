import { Hono } from "hono";
// Zypher Agent SDK
// Documentation: https://docs.corespeed.io/zypher
// API reference:
//   @zypher/agent — https://jsr.io/@zypher/agent/doc
//   @zypher/http  — https://jsr.io/@zypher/http/doc
//   Or run: `deno doc jsr:@zypher/agent` / `deno doc jsr:@zypher/http`
import {
  cloudflareGateway,
  createZypherAgent,
  getSystemPrompt,
} from "@zypher/agent";
import { getRequiredEnv } from "@zypher/utils/env";
import { createZypherHandler } from "@zypher/http";
import { buildAgentInfo } from "@ag0/agent-info";
import { join } from "@std/path";

// =============================================================================
// TOOL IMPORTS
// =============================================================================
// Built-in tools: Zypher provides common tools for file system and terminal access
// - createFileSystemTools(): Returns tools for read_file, list_dir, edit_file,
//   undo_file, grep_search, file_search, copy_file, delete_file
// - RunTerminalCmdTool: Execute shell commands
import { createFileSystemTools, RunTerminalCmdTool } from "@zypher/agent/tools";

// =============================================================================
// REMOTION SKILLS LOADER
// =============================================================================

async function loadRemotionSkills(): Promise<string> {
  const skillsBase = "./agent/skills/remotion/skills/remotion";
  let skills = "";

  try {
    const skillMd = await Deno.readTextFile(join(skillsBase, "SKILL.md"));
    skills += skillMd + "\n\n";
  } catch {
    // Skills not available
  }

  try {
    const rulesDir = join(skillsBase, "rules");
    for await (const entry of Deno.readDir(rulesDir)) {
      if (entry.isFile && entry.name.endsWith(".md")) {
        const content = await Deno.readTextFile(join(rulesDir, entry.name));
        skills += `## ${entry.name}\n\n${content}\n\n`;
      }
    }
  } catch {
    // Rules not available
  }

  return skills;
}

export async function createZypherAgentRouter(): Promise<Hono> {
  const remotionSkills = await loadRemotionSkills();

  const agent = await createZypherAgent({
    // Base directory for file operations (e.g., ReadTool, WriteTool)
    workingDirectory: "./",

    // Model provider — uses Cloudflare AI Gateway (supports OpenAI, Anthropic,
    // and other providers via a unified compatibility API).
    // Environment variables provided automatically in the sandbox:
    //   AI_GATEWAY_BASE_URL – Cloudflare AI Gateway endpoint
    //   AI_GATEWAY_API_TOKEN – Authentication token for the gateway
    // Model ID must be in "provider/model-name" format, e.g.:
    //   "anthropic/claude-sonnet-4-5-20250929"
    //   "openai/gpt-4o"
    model: cloudflareGateway("anthropic/claude-sonnet-4-5-20250929", {
      gatewayBaseUrl: getRequiredEnv("AI_GATEWAY_BASE_URL"),
      apiToken: getRequiredEnv("AI_GATEWAY_API_TOKEN"),
      headers: {
        "User-Agent": "AG0-ZypherAgent/1.0",
      },
    }),

    // Initial messages to restore conversation context
    // initialMessages: [],

    // Agent configuration
    config: {
      skills: {
        projectSkillsDir: "skills",
      },
    },

    // Override default behaviors with custom implementations
    overrides: {
      // Load Remotion skills as custom instructions.
      // IMPORTANT: Always use getSystemPrompt() from @zypher/agent — it
      // includes the base Zypher system prompt required for advanced agent
      // capabilities (e.g., agent skills, programmatic tool calling).
      systemPromptLoader: async () => {
        return await getSystemPrompt(Deno.cwd(), {
          customInstructions: remotionSkills
            ? `# Remotion Video Skills\n\n${remotionSkills}`
            : undefined,
        });
      },
    },

    // Tools give the agent capabilities to perform actions
    tools: [
      // Built-in file system tools (read, write, edit, search files)
      ...createFileSystemTools(),

      // Built-in terminal command execution (for running Remotion renders, etc.)
      RunTerminalCmdTool,
    ],

    // MCP (Model Context Protocol) servers provide external integrations
    mcpServers: [
      // Example: Command-based MCP server (spawns a local process)
      // {
      //   id: "sequential-thinking",
      //   type: "command",
      //   command: {
      //     command: "npx",
      //     args: [
      //       "-y",
      //       "@modelcontextprotocol/server-sequential-thinking",
      //     ],
      //   },
      // },
    ],
  });

  return createZypherHandler({
    agent,
  })
    // AG0 Dashboard contract: the dashboard shows the agent canvas tab
    // only when GET /api/agent/info returns an AgentInfo object.
    // Update the name and description to match your agent.
    .get("/info", async (c) => {
      const info = await buildAgentInfo(agent, {
        name: "Video Agent",
        description:
          "AI agent for creating and editing Remotion video compositions",
      });
      return c.json(info);
    });
}
