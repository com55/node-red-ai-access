# Changelog

All notable changes to Node-RED AI Access will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Node-RED plugin scaffold (`ai-access.cjs` / `dist/plugin.cjs`) with `GET /mcp`
  admin page and `GET /mcp/api/v1/status`.
- `aiAccess` settings hook (`allowWithoutAdminAuth` and reserved fields for
  later link TTL, max links, and deployment type).
- Optional `node-red` peerDependency (`>=4.0.0`); standalone MCP server kept.
- Flow runtime adapter (`RedAdapter` via `RED.runtime`, `HttpAdapter` Admin API
  fallback, factory selection) with rev-checked `updateFlow` (default deployment
  type `nodes`).

## [0.1.0] - 2026-10-15

### Added

- Initial independent release of **Node-RED AI Access**
  (`@com55/node-red-ai-access`), derived from
  [ziv-daniel/node-red-mcp](https://github.com/ziv-daniel/node-red-mcp).
- Package metadata, Docker image names, documentation, and CI retargeted to
  `com55/node-red-ai-access`.
- GitHub Actions CI runs on `ubuntu-latest` for all events.

[0.1.0]: https://github.com/com55/node-red-ai-access/releases/tag/v0.1.0
