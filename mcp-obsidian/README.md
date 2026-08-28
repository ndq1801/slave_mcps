# mcp-obsidian

MCP **stdio** server for an **Obsidian vault**. It treats the vault as a plain
folder of markdown note files and exposes tools to **list, read, search, create,
append and update** notes.

The vault location is **config-driven** (`OBSIDIAN_VAULT_PATH`), so the exact
same server works for any agent and any machine: point the env var at whichever
vault folder is reachable from that host (a local folder, a cloud mount, a
synced directory, ...). Nothing about the specific environment is hardcoded.

Credentials are never needed here — the vault is just files.

## Tools

| Tool | Purpose |
|---|---|
| `get_vault_info` | Resolved vault root path, whether it exists, note count. Call first to confirm wiring |
| `list_notes` | List markdown notes (optionally in a subfolder), returns vault-relative paths |
| `get_note` | Read a note's full markdown content |
| `search_notes` | Search note contents by keyword, returns matching paths + snippets |
| `create_note` | Create a new note (creates parent folders; refuses to overwrite unless `overwrite=true`) |
| `append_note` | Append content to an existing note |
| `update_note` | Replace the full content of an existing note |

## Environment

| Variable | Description |
|---|---|
| `OBSIDIAN_VAULT_PATH` | Absolute path to the Obsidian vault folder. Required (fallback: `./vault` next to this folder). |

## Setup & run

```bash
npm install
copy .env.example .env   # then set OBSIDIAN_VAULT_PATH (never commit .env)
node index.js            # speaks JSON-RPC over stdio; spawn it from an MCP client
```

## Client configuration

```json
{
  "mcp": {
    "obsidian": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcp-obsidian/index.js"],
      "environment": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

The server loads `.env` from its own folder, so clients without env support
only need the `.env` file. All paths are resolved **relative to the vault
root** and any path that would escape the vault is rejected.

## Behavior notes

- **Path safety**: every note path is resolved against the vault root; anything
  that would traverse outside (e.g. `..`) is rejected.
- **Generality**: the server never hardcodes a user, environment or
  location — it only reads `OBSIDIAN_VAULT_PATH`.
- **Frontmatter**: not auto-managed. Include frontmatter in the `content`
  argument when creating a note if you want it.
