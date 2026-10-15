/**
 * MCP tool definitions for the Node-RED AI Access server.
 * Kept separate from the server class so getAllToolDefinitions stays small.
 */

export const FLOW_SORT_KEYS = ['label', 'nodeCount', 'disabled'] as const;
export type FlowSortKey = (typeof FLOW_SORT_KEYS)[number];

/** Shared by `replace_flow` and its deprecated `update_flow` alias. */
export const REPLACE_FLOW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    flowId: { type: 'string', description: 'Flow ID to replace' },
    flowData: { type: 'object', description: 'Full replacement tab content' },
    validate: {
      type: 'boolean',
      description: 'If true, validate flowData for structural errors before replacing',
      default: false,
    },
  },
  required: ['flowId', 'flowData'],
} as const;

export const ALL_TOOL_DEFINITIONS = [
  // Core Flow Management Tools (Optimized)
  {
    name: 'get_flows',
    description:
      'Get Node-RED flows with flexible filtering (summary info by default, use includeDetails for full data). Supports pagination (limit/offset), sorting (label/nodeCount/disabled), and filtering by disabled state or label substring. Also returns the current Admin API v2 flow revision as a top-level `rev` field (alongside `data`) — pass that value as `expected_rev` to deploy_flow / deploy_nodes.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        includeDetails: {
          type: 'boolean',
          description: 'Include full flow details with nodes (default: false for token efficiency)',
          default: false,
        },
        types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Flow types to include (default: ["tab", "subflow"]). Options: "tab" (main flows), "subflow" (reusable subflows)',
          default: ['tab', 'subflow'],
        },
        limit: {
          type: 'number',
          description:
            'Maximum items to return (1-500). When set, response is wrapped in pagination envelope { items, total, limit, offset, hasMore }.',
          minimum: 1,
          maximum: 500,
        },
        offset: {
          type: 'number',
          description: 'Items to skip. When set, response is wrapped in pagination envelope.',
          minimum: 0,
        },
        sortBy: {
          type: 'string',
          enum: [...FLOW_SORT_KEYS],
          description: 'Sort key. Secondary sort by id keeps slice boundaries deterministic.',
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order (default: asc).',
          default: 'asc',
        },
        disabled: {
          type: 'boolean',
          description: 'Filter by disabled state (true = only disabled, false = only enabled).',
        },
        labelContains: {
          type: 'string',
          description: 'Case-insensitive substring filter on flow label.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_flow',
    description:
      'Get specific Node-RED flow by ID. Also returns the current Admin API v2 flow revision as a top-level `rev` field (alongside `data`) — pass that value as `expected_rev` to deploy_flow / deploy_nodes.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID to retrieve' },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'validate_flow',
    description:
      'Validate a Node-RED flow for structural errors: missing required node fields, duplicate node IDs, and wire references to non-existent nodes.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'ID of the flow to fetch and validate' },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'create_flow',
    description: 'Create a new Node-RED flow',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        flowData: {
          type: 'object',
          description: 'Flow configuration data',
          properties: {
            label: { type: 'string' },
            nodes: { type: 'array' },
            disabled: { type: 'boolean' },
          },
        },
        validate: {
          type: 'boolean',
          description: 'If true, validate flowData for structural errors before creating',
          default: false,
        },
      },
      required: ['flowData'],
    },
  },
  {
    name: 'replace_flow',
    description:
      'Replace an entire Node-RED tab via PUT /flow/:id. WARNING: replaces the whole tab, restarts all of its nodes, deletes any nodes omitted from flowData, and does not check the flow revision (rev) — concurrent editor changes can be overwritten. Prefer deploy_flow or deploy_nodes for revision-checked safe edits.',
    annotations: { readOnlyHint: false },
    inputSchema: REPLACE_FLOW_INPUT_SCHEMA,
  },
  {
    name: 'update_flow',
    description:
      'Deprecated alias for replace_flow (same PUT /flow/:id behavior). Will be removed in a future release — use replace_flow, or deploy_flow / deploy_nodes for revision-checked edits.',
    annotations: { readOnlyHint: false },
    inputSchema: REPLACE_FLOW_INPUT_SCHEMA,
  },
  {
    name: 'deploy_flow',
    description:
      "Safely replace one tab's contents using Admin API v2 optimistic concurrency. Requires expected_rev from a prior get_flows/get_flow. Only that tab object and nodes with z equal to the tab id are replaced; every other tab, subflow, and global config node is left untouched. WARNING: any existing node on this tab that is omitted from flowData.nodes/configs is deleted. Prefer this over replace_flow / update_flow. If expected_rev is stale (human edited in the editor, etc.), fails with HTTP 409 — re-read flows, re-apply your change, and retry with the new rev. Returns the new rev on success. Default deployment type is 'flows'; pass type 'nodes' for modified-nodes deploy.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Tab id to replace' },
        flowData: {
          type: 'object',
          description:
            'Full replacement tab content (same shape as replace_flow): label/disabled/info/env plus nodes (and optional configs). Omitted nodes on this tab are deleted.',
        },
        expected_rev: {
          type: 'string',
          description:
            'Flow revision from the prior get_flows/get_flow read. Posted as Admin API v2 `rev` for optimistic concurrency.',
        },
        type: {
          type: 'string',
          enum: ['flows', 'nodes'],
          description:
            "Node-RED-Deployment-Type for the POST (default: 'flows'). Use 'nodes' to restart only changed nodes.",
          default: 'flows',
        },
        validate: {
          type: 'boolean',
          description: 'If true, validate flowData for structural errors before deploying',
          default: false,
        },
      },
      required: ['flowId', 'flowData', 'expected_rev'],
    },
  },
  {
    name: 'deploy_nodes',
    description:
      "Add or update specific nodes and deploy ONLY those nodes — equivalent to the editor's 'Modified Nodes' button (Admin API v2, Node-RED-Deployment-Type: nodes). Requires expected_rev from a prior get_flows/get_flow. Every node not listed here is left untouched and does not restart. An existing node id is replaced in place; a new id is added to whichever tab its `z` field points to. If expected_rev is stale, fails with HTTP 409 — re-read flows, re-apply your change, and retry. Returns the new rev on success. Optional credentials uses the v2 top-level credentials object.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array',
          description:
            'Full node objects to add or replace by id (each needs at minimum id and type; flow nodes usually also need z and wires, plus type-specific properties). Inline node.credentials is also accepted.',
          items: { type: 'object' },
          minItems: 1,
        },
        expected_rev: {
          type: 'string',
          description:
            'Flow revision from the prior get_flows/get_flow read. Posted as Admin API v2 `rev` for optimistic concurrency.',
        },
        credentials: {
          type: 'object',
          description:
            'Optional Admin API v2 credentials object: either a map of node id → credential fields, or an encrypted blob with a `$` key. Omit to leave the runtime credential store unchanged for nodes without inline credentials.',
          additionalProperties: true,
        },
      },
      required: ['nodes', 'expected_rev'],
    },
  },
  {
    name: 'enable_flow',
    description: 'Enable a specific Node-RED flow',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID to enable' },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'disable_flow',
    description: 'Disable a specific Node-RED flow',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Flow ID to disable' },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'search_modules',
    description: 'Search for Node-RED palette modules online via npm registry',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for modules (e.g., "mqtt", "dashboard", "influxdb")',
        },
        category: {
          type: 'string',
          enum: ['all', 'contrib', 'dashboard'],
          description: 'Module category to search (default: all)',
          default: 'all',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 50,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'install_module',
    description: 'Install a Node-RED palette module via Node-RED palette management API',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        moduleName: {
          type: 'string',
          description: 'Name of the module to install (e.g., "node-red-contrib-ui-led")',
        },
        version: {
          type: 'string',
          description: 'Specific version to install (optional, defaults to latest)',
        },
      },
      required: ['moduleName'],
    },
  },
  {
    name: 'get_installed_modules',
    description:
      'Get list of currently installed Node-RED palette modules. Supports pagination (limit/offset) and a case-insensitive substring filter (query). When any of these is provided, response is wrapped in pagination envelope.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring filter on module name.',
        },
        limit: {
          type: 'number',
          description: 'Maximum items to return (1-500).',
          minimum: 1,
          maximum: 500,
        },
        offset: {
          type: 'number',
          description: 'Items to skip.',
          minimum: 0,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_context',
    description: 'Read Node-RED context variables (global or flow scope).',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'flow'],
          description: 'Context scope (default: "global")',
          default: 'global',
        },
        key: {
          type: 'string',
          description: 'Variable name to read. Omit to return all variables in this scope.',
        },
        flowId: {
          type: 'string',
          description: 'Flow tab ID (required when scope is "flow")',
        },
      },
      required: [],
    },
  },
  {
    name: 'set_context',
    description: 'Write a Node-RED context variable.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['global', 'flow'],
          description: 'Context scope (default: "global")',
          default: 'global',
        },
        key: {
          type: 'string',
          description: 'Variable name to write',
        },
        value: {
          description: 'Value to store (any JSON-serialisable type)',
        },
        flowId: {
          type: 'string',
          description: 'Flow tab ID (required when scope is "flow")',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'delete_context',
    description: 'Delete a Node-RED global context variable.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Variable name to delete',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'delete_flow',
    description:
      'Delete a Node-RED flow. Default is dry-run — shows what would be deleted without acting. To delete for real: set dryRun: false AND confirm: true.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: {
          type: 'string',
          description: 'ID of the flow to delete',
        },
        dryRun: {
          type: 'boolean',
          description: 'When true (default), returns flow details without deleting',
          default: true,
        },
        confirm: {
          type: 'boolean',
          description:
            'Must be true when dryRun is false — explicit confirmation of destructive action',
        },
      },
      required: ['flowId'],
    },
  },
  {
    name: 'search_flows',
    description:
      'Search for nodes in Node-RED flows by type, name, or property value. At least one search parameter is required. Supports pagination (limit/offset replaces the internal 10-cap), node type prefix filter, and flow exclusion list.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Substring match on node type (case-insensitive, e.g. "function", "mqtt")',
        },
        query: {
          type: 'string',
          description:
            'Substring match on node name or any string property value (case-insensitive)',
        },
        flowId: {
          type: 'string',
          description: 'Restrict search to a specific flow ID',
        },
        nodeTypePrefix: {
          type: 'string',
          description: 'Case-insensitive prefix match on node type — useful for namespaced types.',
        },
        excludeFlowIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude these flow IDs from the search.',
        },
        limit: {
          type: 'number',
          description:
            'Maximum matches to return (1-500). When set, replaces the default 10-cap and wraps response in pagination envelope.',
          minimum: 1,
          maximum: 500,
        },
        offset: {
          type: 'number',
          description: 'Matches to skip. When set, response is wrapped in pagination envelope.',
          minimum: 0,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_flow_state',
    description:
      'Get the runtime state of Node-RED flows (running or stopped). Supports pagination over the per-flow array via limit/offset.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description:
            'Maximum flows to return (1-500). When set, response is wrapped in pagination envelope (state remains at top level).',
          minimum: 1,
          maximum: 500,
        },
        offset: {
          type: 'number',
          description: 'Flows to skip.',
          minimum: 0,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_settings',
    description: 'Get Node-RED runtime settings (HTTP root paths, logging configuration, etc.)',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_runtime_info',
    description:
      'Get Node-RED runtime information: version, runtime/flow state, per-type node counts, installed modules, memory usage, and Node.js/OS details',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_node_errors',
    description:
      'Check Node-RED for nodes that are in an error state (red status) after deployment. Connects to the Node-RED event bus, collects retained node statuses, and returns any nodes with active errors or warnings. Use after create_flow, replace_flow, or deploy_flow to catch nodes with missing required configuration.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        includeWarnings: {
          type: 'boolean',
          description: 'Also return nodes with yellow (warning) status (default: false)',
          default: false,
        },
        timeoutMs: {
          type: 'number',
          description:
            'How long to collect statuses from the event bus in milliseconds (default: 2000, max: 30000)',
          default: 2000,
          minimum: 100,
          maximum: 30000,
        },
      },
      required: [],
    },
  },
  {
    name: 'semantic_search_flows',
    description:
      'Search Node-RED flows and nodes using semantic similarity (BM25 by default; set EMBEDDING_API_URL for vector search). Returns ranked results with scores.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language search query',
        },
        topK: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
          default: 10,
          minimum: 1,
          maximum: 100,
        },
        scope: {
          type: 'string',
          enum: ['flows', 'nodes', 'all'],
          description: 'Restrict search to flow-level docs, node-level docs, or all (default: all)',
          default: 'all',
        },
        refresh: {
          type: 'boolean',
          description: 'Force re-index from Node-RED before searching (default: false)',
          default: false,
        },
      },
      required: [],
    },
  },
];
