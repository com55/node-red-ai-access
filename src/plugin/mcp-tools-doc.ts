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

/**
 * Human type for a JSON Schema property: handles `type` arrays, `anyOf`/`oneOf`
 * unions, `enum`s, and arrays (`string[]`). Falls back to `any`.
 */
export function schemaTypeText(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const s = schema as Record<string, unknown>;
  const union = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null) as
    unknown[] | null;
  if (union) {
    return [...new Set(union.map(schemaTypeText))].join(' | ');
  }
  if (Array.isArray(s.enum)) {
    return s.enum.map(v => JSON.stringify(v)).join(' | ');
  }
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.type)) {
    return s.type
      .map(t => (t === 'array' ? `${schemaTypeText(s.items)}[]` : String(t)))
      .join(' | ');
  }
  if (s.type === 'array') {
    const item = schemaTypeText(s.items);
    return item.includes(' | ') ? `(${item})[]` : `${item}[]`;
  }
  return typeof s.type === 'string' ? s.type : 'any';
}

/** Escape a Markdown table cell: backslashes first, then pipes. */
function escapeTableCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
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
      const type = escapeTableCell(schemaTypeText(prop));
      const desc = escapeTableCell(String(prop.description ?? ''));
      lines.push(
        `| \`${key}\` | ${required.has(key) ? 'yes' : 'no'} | ${type} | ${desc.length > 0 ? desc : '—'} |`
      );
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}
