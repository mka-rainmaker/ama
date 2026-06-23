# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's [**Report a vulnerability**](https://github.com/mka-rainmaker/ama/security/advisories/new)
form (the repo's *Security → Advisories* tab). We aim to acknowledge within a few days and will
coordinate a fix and disclosure with you.

## Scope

Ama is **local-first**: it reads local source and serves a graph to a locally-connected MCP client,
and makes no network calls of its own. The most relevant concerns are therefore around parsing
untrusted code, the MCP/stdio surface, and the install/bundle tooling — reports in those areas are
especially welcome.

## Supported versions

The latest released `0.x` version receives fixes; older versions are not maintained.
