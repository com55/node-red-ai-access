# Development

```bash
yarn install
yarn build
yarn test
yarn quality
```

Regenerate the MCP tools doc after tool changes: `yarn generate:mcp-tools`.
Regenerate the error reference with `yarn generate:errors`. Verify that the
generated references are current with `yarn check:mcp-tools` and
`yarn check:errors`.

See also: [Documentation index](./README.md) and [releasing](./releasing.md).
