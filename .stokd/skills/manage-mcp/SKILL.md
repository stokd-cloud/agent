---
name: manage-mcp
description: >
  Add or remove an MCP server across every configured Stokd provider. Use for
  requests such as "add this MCP everywhere", "remove this MCP", `/manage-mcp`,
  or `$manage-mcp`.
---

# Manage MCP

Use Stokd's provider fan-out. Never register the MCP only in the current
agent.

## Procedure

1. Resolve the server name and exactly one transport:
   - stdio: command, arguments, and optional `KEY=VALUE` environment entries
   - HTTP/SSE: URL and optional headers
2. Run a dry preview without exposing secret values:
   - stdio: `stokd mcp add <name> --dry-run [--env KEY=VALUE] -- <command> [args...]`
   - remote: `stokd mcp add <name> --dry-run --transport <http|sse> --url <url> [--header KEY=VALUE]`
3. Review every configured provider outcome. Resolve failures before applying.
4. Repeat the same command without `--dry-run`.
5. Remove with `stokd mcp remove <name> --dry-run`, then
   `stokd mcp remove <name>` after confirming the target.

Stokd owns provider aliases, native user-scope command syntax, secret
redaction, unsupported-provider reporting, and aggregate exit status.
