/**
 * Format MCP tools/list results into docs/mcp-tools.md.
 * Used by the generate/check script and tests so the doc stays in sync
 * with the live tool schemas.
 */

export interface McpToolSchemaProperty {
  type?: string | string[];
  description?: string;
  [key: string]: unknown;
}

export interface McpToolListItem {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, McpToolSchemaProperty>;
    required?: string[];
    [key: string]: unknown;
  };
}

export function formatMcpToolsMarkdown(tools: McpToolListItem[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [
    '# MCP tools reference',
    '',
    'Generated from the live `tools/list` schemas on `POST /mcp/rpc`.',
    'Do not edit by hand — run `yarn generate:mcp-tools` after changing MCP tools.',
    '',
    `Tools: **${sorted.length}**`,
    '',
  ];

  for (const tool of sorted) {
    lines.push(`## \`${tool.name}\``, '');
    const toolDesc = tool.description?.trim() ?? '';
    lines.push(toolDesc.length > 0 ? toolDesc : '_No description._', '');
    const props = tool.inputSchema?.properties ?? {};
    const required = new Set(tool.inputSchema?.required ?? []);
    const keys = Object.keys(props).sort();
    if (keys.length === 0) {
      lines.push('_No input parameters._', '');
      continue;
    }
    lines.push('| Parameter | Required | Type | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const key of keys) {
      const prop = props[key] ?? {};
      const type = Array.isArray(prop.type)
        ? prop.type.join(' | ')
        : String(prop.type ?? 'unknown');
      const desc = String(prop.description ?? '').replace(/\|/g, '\\|');
      lines.push(
        `| \`${key}\` | ${required.has(key) ? 'yes' : 'no'} | ${type} | ${desc.length > 0 ? desc : '—'} |`
      );
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
