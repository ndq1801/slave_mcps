import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import path from "path";
import { promises as fs, realpathSync } from "fs";

// Load .env from this server's own directory (works no matter what cwd the
// client spawns the process in). Values already present in the real
// environment (e.g. set via opencode.json "environment") take precedence.
dotenv.config({ path: path.join(import.meta.dirname, ".env") });

// Vault root comes entirely from config (no hardcoding), so the same server
// works for any agent / any machine: point OBSIDIAN_VAULT_PATH at the vault
// folder that is reachable from this host (local folder, cloud mount, ...).
const DEFAULT_VAULT = path.join(import.meta.dirname, "vault");
const vaultRoot = path.resolve(process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT);

const server = new Server(
  { name: "mcp-obsidian", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---------- Path safety ----------
// Every operation must stay inside the vault root; reject anything that would
// traverse outside it (e.g. "..", absolute paths, or symlinks pointing out).
function resolveVaultPath(rel) {
  const target = path.resolve(vaultRoot, rel || ".");
  if (target !== vaultRoot && !target.startsWith(vaultRoot + path.sep)) {
    throw new Error(`Path escapes the vault root: ${rel}`);
  }
  // Symlink check: only meaningful once the vault exists (a vault that has not
  // been created yet cannot host a symlink). Resolve the closest existing
  // ancestor of the target and confirm it still lives under the real vault
  // root — this blocks vault symlinks pointing outside while still allowing
  // writes to not-yet-existing notes.
  let vaultReal;
  try {
    vaultReal = realpathSync(vaultRoot);
  } catch {
    return target; // vault not created yet; lexical check above already passed
  }
  let ancestor = target;
  let ancestorReal = null;
  while (true) {
    try {
      ancestorReal = realpathSync(ancestor);
      break;
    } catch {
      if (ancestor === path.dirname(ancestor)) break;
      ancestor = path.dirname(ancestor);
    }
  }
  if (ancestorReal === null) return target;
  if (ancestorReal !== vaultReal && !ancestorReal.startsWith(vaultReal + path.sep)) {
    throw new Error(`Path escapes the vault root via symlink: ${rel}`);
  }
  return target;
}

function withMd(p) {
  return p.toLowerCase().endsWith(".md") ? p : `${p}.md`;
}

// ---------- File helpers ----------

async function vaultExists() {
  try {
    const st = await fs.stat(vaultRoot);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function collectMarkdown(absDir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // skip hidden/system dirs & files (.git, .obsidian, ...)
    const full = path.join(absDir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectMarkdown(full)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function toRel(abs) {
  return path.relative(vaultRoot, abs);
}

// Write atomically (temp file + rename) so a crash mid-write never leaves a
// corrupted/truncated note behind.
async function atomicWrite(abs, content) {
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, abs);
}

// ---------- Tool implementations ----------

async function getVaultInfo() {
  const exists = await vaultExists();
  const notes = exists ? await collectMarkdown(vaultRoot) : [];
  return {
    vaultRoot,
    exists,
    noteCount: notes.length,
  };
}

async function listNotes(args) {
  const relDir = (args.path || "").trim();
  const absDir = resolveVaultPath(relDir);
  const files = await collectMarkdown(absDir);
  const paths = files.map(toRel).filter((r) => !r.startsWith("..")).sort();
  return { total: paths.length, paths };
}

async function getNote(args) {
  const rel = withMd((args.path || "").trim());
  const abs = resolveVaultPath(rel);
  let content;
  try {
    content = await fs.readFile(abs, "utf8");
  } catch {
    throw new Error(`Note not found: ${rel}`);
  }
  return { path: toRel(abs), content };
}

function snippet(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text.slice(0, 200);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 120);
  return (start > 0 ? "..." : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "..." : "");
}

async function searchNotes(args) {
  const query = (args.query || "").trim();
  if (!query) throw new Error("query is required");
  const relDir = (args.path || "").trim();
  const absDir = resolveVaultPath(relDir);
  const maxResults = Math.max(1, Math.min(args.maxResults || 20, 100));
  const files = await collectMarkdown(absDir);
  const matches = [];
  const trimmed = [];
  for (const f of files) {
    try {
      const text = await fs.readFile(f, "utf8");
      if (text.toLowerCase().includes(query.toLowerCase())) {
        matches.push({ path: toRel(f), snippet: snippet(text, query) });
        if (trimmed.length < maxResults) trimmed.push(matches[matches.length - 1]);
      }
    } catch {
      // skip unreadable files
    }
  }
  return { query, total: matches.length, truncated: matches.length > maxResults, matches: trimmed };
}

async function ensureVault() {
  await fs.mkdir(vaultRoot, { recursive: true });
}

async function createNote(args) {
  const rel = withMd((args.path || "").trim());
  if (!rel || rel.endsWith("/.md")) throw new Error("a note path is required");
  const abs = resolveVaultPath(rel);
  if (!(await vaultExists())) await ensureVault();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.access(abs);
    if (!args.overwrite) throw new Error(`Note already exists: ${rel} (use overwrite=true to replace)`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // not the access() ENOENT
  }
  await atomicWrite(abs, args.content ?? "");
  return { path: toRel(abs), createdOrOverwritten: true };
}

async function appendNote(args) {
  const rel = withMd((args.path || "").trim());
  const abs = resolveVaultPath(rel);
  let existing;
  try {
    existing = await fs.readFile(abs, "utf8");
  } catch {
    throw new Error(`Note not found: ${rel}`);
  }
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await atomicWrite(abs, existing + sep + (args.content ?? ""));
  return { path: toRel(abs), appended: true };
}

async function updateNote(args) {
  const rel = withMd((args.path || "").trim());
  const abs = resolveVaultPath(rel);
  try {
    await fs.access(abs);
  } catch {
    throw new Error(`Note not found: ${rel}`);
  }
  await atomicWrite(abs, args.content ?? "");
  return { path: toRel(abs), updated: true };
}

async function deleteNote(args) {
  const rel = withMd((args.path || "").trim());
  const abs = resolveVaultPath(rel);
  try {
    await fs.unlink(abs);
  } catch {
    throw new Error(`Note not found: ${rel}`);
  }
  return { path: toRel(abs), deleted: true };
}

// ---------- Tool declarations ----------

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_vault_info",
        description:
          "Returns the Obsidian vault configuration: the resolved vault root path, whether it exists, and the number of markdown notes. Call this FIRST to confirm the server is wired to the right vault before searching or editing. Does not expose any credentials.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "list_notes",
        description:
          "Lists markdown notes (.md) under the vault, optionally scoped to a subfolder. Returns { total, paths } with vault-relative paths only (no content). Use to discover which notes exist before reading or editing. Set 'path' to a subfolder (e.g. 'Projects') to scope; omit to list the whole vault.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional vault-relative subfolder, e.g. 'Projects'." },
          },
          required: [],
        },
      },
      {
        name: "get_note",
        description:
          "Reads a single note's full markdown content. 'path' is vault-relative (e.g. 'Projects/TSUKASHIA.md'); .md is appended if omitted. Use to read a note's content or to answer questions from it. Does not create or edit; rejects paths outside the vault.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault-relative note path, e.g. 'Projects/TSUKASHIA.md'." },
          },
          required: ["path"],
        },
      },
      {
        name: "search_notes",
        description:
          "Searches note contents for a keyword (case-insensitive substring). Returns each matching note's vault-relative path and a short snippet around the match. Use to find information across the vault without reading every note. Optional 'path' scopes the search to a subfolder; optional 'maxResults' caps the snippets returned (default 20, max 100) — check 'total'/'truncated' for the full match count.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Keyword to search for (case-insensitive)." },
            path: { type: "string", description: "Optional vault-relative subfolder to scope the search." },
            maxResults: { type: "number", description: "Max matching notes to return snippets for (default 20, max 100)." },
          },
          required: ["query"],
        },
      },
      {
        name: "create_note",
        description:
          "Creates a new markdown note at a vault-relative path, creating parent folders as needed. Appends '.md' if the path lacks it. Fails if the note already exists unless overwrite=true. Use to persist new notes (meeting notes, project notes, journal entries). Put any frontmatter/content in 'content'.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault-relative path for the note, e.g. 'Projects/ABC.md'." },
            content: { type: "string", description: "Full markdown content for the note." },
            overwrite: { type: "boolean", description: "Replace the note if it already exists (default false)." },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "append_note",
        description:
          "Appends content to the end of an existing note. Fails if the note does not exist (use create_note instead). Use to add to a note without rewriting the whole file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault-relative note path." },
            content: { type: "string", description: "Markdown content to append." },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "update_note",
        description:
          "Replaces the entire content of an existing note. Fails if the note does not exist (use create_note instead). Use to rewrite a note fully; prefer append_note or get_note for smaller edits.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault-relative note path." },
            content: { type: "string", description: "New full markdown content." },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "delete_note",
        description:
          "Deletes a note by its vault-relative path. Fails if the note does not exist. This is destructive and irreversible — confirm the path before deleting.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault-relative note path to delete, e.g. 'Projects/Unused.md'." },
          },
          required: ["path"],
        },
      },
    ],
  };
});

// ---------- Tool dispatch ----------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case "get_vault_info":
        result = await getVaultInfo();
        break;
      case "list_notes":
        result = await listNotes(args);
        break;
      case "get_note":
        result = await getNote(args);
        break;
      case "search_notes":
        result = await searchNotes(args);
        break;
      case "create_note":
        result = await createNote(args);
        break;
      case "append_note":
        result = await appendNote(args);
        break;
      case "update_note":
        result = await updateNote(args);
        break;
      case "delete_note":
        result = await deleteNote(args);
        break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `[ERROR] ${error.message}` }], isError: true };
  }
});

// ---------- Start ----------

const transport = new StdioServerTransport();
await server.connect(transport);
