# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report them privately via [GitHub private vulnerability reporting](https://github.com/cdotta/remote-mcp-starter/security/advisories/new)
(Security tab → "Report a vulnerability"). You'll get an acknowledgement within
a few days.

If the issue is in a dependency — Better Auth, the MCP TypeScript SDK, Prisma,
or Hono — please report it upstream to that project first.

## Scope

This repository is a starter template. The auth boundary, tenant isolation,
token handling, and logging discipline (see the security checklist in the
README) are in scope. Misconfigurations introduced by downstream forks —
disabling key hashing, running without HTTPS, opening sign-up on a private
instance — are not.
