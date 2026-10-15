/**
 * Main MCP Server implementation for Node-RED integration
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type {
  CallToolResult,
  ElicitRequestFormParams,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  CallToolRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { promptRegistry } from '../prompts/index.js';
import { createEmbeddingProvider } from '../services/embedding-provider.js';
import { NodeRedAPIClient } from '../services/nodered-api.js';
import { SemanticFlowIndex } from '../services/semantic-index.js';
import {
  McpServerConfig,
  McpToolResult,
  NodeRedFlowResource,
  NodeRedSystemResource,
} from '../types/mcp-extensions.js';
import type { NodeRedCredentials } from '../types/oauth.js';
import { isReadOnlyMode } from '../utils/auth.js';
import {
  AppError,
  NodeRedError,
  logDebug,
  safeStringify,
} from '../utils/error-handling.js';

import { ALL_TOOL_DEFINITIONS } from './mcp-tool-definitions.js';
import {
  asString,
  executeTool,
  type ToolArgs,
  type ToolExecContext,
} from './mcp-tool-exec.js';
import { SSEHandler } from './sse-handler.js';

const UPSTREAM_RESPONSE_LIMIT = 2000;

type ElicitContent = Record<string, string | number | boolean | string[]>;
type ElicitRequestedSchema = ElicitRequestFormParams['requestedSchema'];

/**
 * Truncate an upstream response body so a large flow dump or HTML login page
 * doesn't get echoed back to the client in full.
 */
function truncateUpstreamResponse(response: unknown): unknown {
  if (response === undefined || response === null) return undefined;

  const serialized =
    typeof response === 'string' ? response : (JSON.stringify(response) as string | undefined);
  if (serialized === undefined) return undefined;
  if (serialized.length <= UPSTREAM_RESPONSE_LIMIT) return response;

  return `${serialized.slice(0, UPSTREAM_RESPONSE_LIMIT)}… (truncated, ${serialized.length} bytes)`;
}

/**
 * Turn a thrown value into an error message plus structured detail.
 *
 * Tool failures used to collapse to `error.message` — or the literal string
 * "Unknown error" for anything that wasn't an `Error` — which left callers with
 * no way to tell a 403 from a 404 or a network failure.
 */
function describeToolFailure(
  toolName: string,
  error: unknown
): Pick<McpToolResult, 'error' | 'errorDetails'> {
  if (error instanceof NodeRedError) {
    return {
      error: error.message,
      errorDetails: {
        code: error.code,
        statusCode: error.statusCode,
        ...(error.nodeRedStatusCode !== undefined
          ? { upstreamStatus: error.nodeRedStatusCode }
          : {}),
        ...(error.nodeRedResponse !== undefined
          ? { upstreamResponse: truncateUpstreamResponse(error.nodeRedResponse) }
          : {}),
      },
    };
  }

  if (error instanceof AppError) {
    return {
      error: error.message,
      errorDetails: { code: error.code, statusCode: error.statusCode },
    };
  }

  if (error instanceof Error) {
    return {
      error: error.message || `${error.name} thrown with no message`,
      errorDetails: { code: error.name || 'INTERNAL_ERROR' },
    };
  }

  return {
    error: `Tool '${toolName}' threw a non-Error value: ${safeStringify(error)}`,
    errorDetails: { code: 'INTERNAL_ERROR' },
  };
}

const NODERED_RESOURCE_META: Record<string, { name: string; description: string }> = {
  flows: { name: 'Node-RED Flows', description: 'All flow tabs in the Node-RED instance' },
  subflows: { name: 'Node-RED Subflows', description: 'All reusable subflow definitions' },
  nodes: {
    name: 'Installed Node Modules',
    description: 'Node-RED palette modules currently installed',
  },
  'context/global': {
    name: 'Global Context',
    description: 'Node-RED global context store (all key/value pairs)',
  },
};

function buildCollectionResponse(uri: string, name: string, description: string, payload: object) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(
          { uri, name, description, mimeType: 'application/json', ...payload },
          null,
          2
        ),
      },
    ],
  };
}

export class McpNodeRedServer {
  private server: Server;
  private nodeRedClient: NodeRedAPIClient;
  private sseHandler: SSEHandler;
  private config: McpServerConfig;
  private semanticIndex: SemanticFlowIndex;

  constructor(config: Partial<McpServerConfig> = {}) {
    this.config = {
      name: process.env.MCP_SERVER_NAME ?? 'nodered-mcp-server',
      version: process.env.MCP_SERVER_VERSION ?? '1.0.0',
      capabilities: {
        tools: true,
        resources: true,
        prompts: true,
        logging: true,
        elicitation: true,
      },
      nodeRed: {
        url: process.env.NODERED_URL ?? 'http://localhost:1880',
        timeout: parseInt(process.env.NODERED_TIMEOUT ?? '5000'),
        retries: parseInt(process.env.NODERED_RETRIES ?? '3'),
      },
      sse: {
        enabled: process.env.SSE_ENABLED !== 'false',
        port: parseInt(process.env.SSE_PORT ?? '3001'),
        heartbeatInterval: parseInt(process.env.SSE_HEARTBEAT_INTERVAL ?? '30000'),
        maxConnections: parseInt(process.env.SSE_MAX_CONNECTIONS ?? '100'),
      },
      ...config,
    };

    this.server = new Server(
      {
        name: this.config.name,
        version: this.config.version,
      },
      {
        // `elicitation` is advertised at runtime but not yet on ServerCapabilities.
        capabilities: {
          tools: this.config.capabilities.tools ? {} : undefined,
          resources: this.config.capabilities.resources ? {} : undefined,
          prompts: this.config.capabilities.prompts ? {} : undefined,
          logging: this.config.capabilities.logging ? {} : undefined,
          elicitation: this.config.capabilities.elicitation !== false ? {} : undefined,
        } as ServerCapabilities,
      }
    );

    this.nodeRedClient = new NodeRedAPIClient(this.config.nodeRed);
    this.sseHandler = new SSEHandler(this.config.sse);
    this.semanticIndex = new SemanticFlowIndex(
      this.nodeRedClient,
      createEmbeddingProvider(this.config.semantic),
      this.config.semantic?.indexTtlMs
    );

    this.setupHandlers();
  }

  /**
   * Setup MCP request handlers
   */
  private setupHandlers(): void {
    // Tools handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () =>
      Promise.resolve({
        tools: this.getToolDefinitions(),
      })
    );

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params;
      return await this.callTool(name, args ?? {});
    });

    // Resources handlers
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: await this.getResourceList(),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async request => {
      const { uri } = request.params;
      return await this.getResource(uri);
    });

    // Prompts handlers
    this.server.setRequestHandler(ListPromptsRequestSchema, async () =>
      Promise.resolve({
        prompts: this.getPromptDefinitions(),
      })
    );

    this.server.setRequestHandler(GetPromptRequestSchema, async request => {
      const { name, arguments: args } = request.params;
      const rendered = await this.getPrompt(name, args ?? {});
      return { description: rendered.description, messages: rendered.messages };
    });
  }

  // Raw elicitInput wrapper — try/catch around optional client elicitation
  private async tryElicitField<T>(
    message: string,
    requestedSchema: ElicitRequestedSchema,
    pick: (content: ElicitContent | undefined) => T | null
  ): Promise<T | null> {
    try {
      const res = await this.server.elicitInput({
        mode: 'form',
        message,
        requestedSchema,
      });
      return res.action === 'accept' ? pick(res.content) : null;
    } catch {
      return null;
    }
  }

  private tryElicitString(message: string, title: string, field: string): Promise<string | null> {
    const requestedSchema: ElicitRequestedSchema = {
      type: 'object',
      properties: { [field]: { type: 'string', title } },
      required: [field],
    };
    return this.tryElicitField(message, requestedSchema, c => {
      const value = c?.[field];
      return value ? String(value) : null;
    });
  }

  private async tryElicitFlowId(verb: string): Promise<string | null> {
    let list = '';
    try {
      const flows = await this.nodeRedClient.getFlowSummaries(['tab', 'subflow']);
      list = `\n\nAvailable flows:\n${flows
        .slice(0, 15)
        .map(f => `• ${f.label ?? '(no label)'} — ${f.id}`)
        .join('\n')}`;
    } catch {
      // getFlowSummaries failed — proceed without list
    }
    return this.tryElicitString(`Which flow do you want to ${verb}?${list}`, 'Flow ID', 'flowId');
  }

  private async tryElicitConfirm(message: string): Promise<boolean> {
    const requestedSchema: ElicitRequestedSchema = {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          title: 'Confirm',
          description: 'Set to true to proceed, false to cancel',
        },
      },
      required: ['confirmed'],
    };
    return (
      (await this.tryElicitField(message, requestedSchema, c =>
        c?.confirmed === true ? true : null
      )) ?? false
    );
  }

  private async resolveFlowId(args: ToolArgs, verb: string): Promise<string> {
    const flowId = asString(args.flowId) ?? (await this.tryElicitFlowId(verb));
    if (!flowId) throw new Error('Missing required parameter: flowId');
    return flowId;
  }

  /**
   * Get tool definitions, filtered to read-only tools when MCP_READ_ONLY is set
   */
  public getToolDefinitions() {
    const tools = this.getAllToolDefinitions();
    return isReadOnlyMode() ? tools.filter(tool => tool.annotations.readOnlyHint) : tools;
  }

  /**
   * Full, unfiltered tool definitions (used internally so callTool can give a
   * clear error when a write tool is called while read-only mode is active,
   * rather than an ambiguous "unknown tool" error)
   */
  private getAllToolDefinitions() {
    return ALL_TOOL_DEFINITIONS;
  }

  /**
   * Call a specific tool
   */
  public async callTool(name: string, args: ToolArgs): Promise<CallToolResult> {
    const timestamp = new Date().toISOString();
    let result: McpToolResult;

    try {
      if (isReadOnlyMode()) {
        const tool = this.getAllToolDefinitions().find(t => t.name === name);
        if (tool && !tool.annotations.readOnlyHint) {
          throw new Error(
            `Tool '${name}' is unavailable: the server is running in read-only mode (MCP_READ_ONLY=true)`
          );
        }
      }

      const outcome = await executeTool(this.toolExecContext(), name, args, timestamp);
      if (outcome.kind === 'content') {
        return outcome.response;
      }
      result = outcome.result;
    } catch (error) {
      result = {
        success: false,
        ...describeToolFailure(name, error),
        timestamp,
      };

      logDebug(`Tool '${name}' failed`, {
        tool: name,
        args,
        error: result.error,
        details: result.errorDetails,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private toolExecContext(): ToolExecContext {
    return {
      nodeRedClient: this.nodeRedClient,
      semanticIndex: this.semanticIndex,
      resolveFlowId: (args, verb) => this.resolveFlowId(args, verb),
      tryElicitString: (message, title, field) => this.tryElicitString(message, title, field),
      tryElicitConfirm: message => this.tryElicitConfirm(message),
    };
  }

  /**
   * Get list of available resources
   */
  public async getResourceList() {
    const resources: { uri: string; name: string; description: string; mimeType: string }[] = [
      ...Object.entries(NODERED_RESOURCE_META).map(([path, { name, description }]) => ({
        uri: `nodered://${path}`,
        name,
        description,
        mimeType: 'application/json' as const,
      })),
      {
        uri: 'system://runtime',
        name: 'Node-RED System Info',
        description: 'Node-RED runtime and connection status',
        mimeType: 'application/json',
      },
    ];

    try {
      const flows = await this.nodeRedClient.getFlows();
      for (const flow of flows) {
        resources.push({
          uri: `flow://${flow.id}`,
          name: flow.label ?? flow.id,
          description: `Node-RED flow: ${flow.label ?? flow.id}`,
          mimeType: 'application/json',
        });
      }
    } catch {
      // Dynamic per-flow resources unavailable; static collection resources still listed
    }

    return resources;
  }

  /**
   * Get specific resource
   */
  public async getResource(uri: string) {
    const [protocol, path] = uri.split('://');

    switch (protocol) {
      case 'flow': {
        if (!path) {
          throw new Error('Flow path is required');
        }
        const flow = await this.nodeRedClient.getFlow(path);
        const resource: NodeRedFlowResource = {
          uri,
          name: flow.label ?? flow.id,
          description: `Node-RED flow: ${flow.label ?? flow.id}`,
          mimeType: 'application/json',
          flow,
          metadata: {
            lastModified: new Date().toISOString(),
            nodeCount: flow.nodes.length || 0,
            status: flow.disabled ? 'inactive' : 'active',
          },
        };
        return {
          contents: [
            {
              uri,
              text: JSON.stringify(resource, null, 2),
              mimeType: 'application/json',
            },
          ],
        };
      }

      case 'system': {
        const systemInfo = await this.nodeRedClient.getRuntimeInfo();
        const resource: NodeRedSystemResource = {
          uri,
          name: 'Node-RED System Info',
          description: 'Node-RED runtime and connection status',
          mimeType: 'application/json',
          system: systemInfo,
          metadata: {
            timestamp: new Date().toISOString(),
            serverVersion: this.config.version,
            connected: true,
          },
        };
        return {
          contents: [
            {
              uri,
              text: JSON.stringify(resource, null, 2),
              mimeType: 'application/json',
            },
          ],
        };
      }

      case 'nodered': {
        if (!path) throw new Error('Invalid resource URI: missing path');
        const meta = NODERED_RESOURCE_META[path];
        if (!meta) throw new Error(`Unsupported nodered resource path: ${path}`);
        const { name, description } = meta;
        const timestamp = new Date().toISOString();
        switch (path) {
          case 'flows': {
            const items = await this.nodeRedClient.getFlowSummaries(['tab']);
            return buildCollectionResponse(uri, name, description, {
              items,
              metadata: { count: items.length, timestamp },
            });
          }
          case 'subflows': {
            const items = await this.nodeRedClient.getFlowSummaries(['subflow']);
            return buildCollectionResponse(uri, name, description, {
              items,
              metadata: { count: items.length, timestamp },
            });
          }
          case 'nodes': {
            const modules = await this.nodeRedClient.getInstalledModules();
            const items = Array.isArray(modules) ? modules : [];
            return buildCollectionResponse(uri, name, description, {
              items,
              metadata: { count: items.length, timestamp },
            });
          }
          case 'context/global': {
            const data = await this.nodeRedClient.getGlobalContext();
            return buildCollectionResponse(uri, name, description, {
              data,
              metadata: { timestamp },
            });
          }
          default:
            throw new Error(`Unsupported nodered resource path: ${path}`);
        }
      }

      default:
        throw new Error(`Unsupported resource protocol: ${protocol}`);
    }
  }

  /**
   * Get prompt definitions (delegates to prompt registry)
   */
  private getPromptDefinitions() {
    return promptRegistry.list();
  }

  /**
   * Get specific prompt (delegates to prompt registry)
   */
  private async getPrompt(name: string, args: ToolArgs) {
    return await promptRegistry.get(name, args);
  }

  /**
   * Get the underlying server instance
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Get SSE handler instance
   */
  getSSEHandler(): SSEHandler {
    return this.sseHandler;
  }

  /**
   * Get Node-RED client instance
   */
  getNodeRedClient(): NodeRedAPIClient {
    return this.nodeRedClient;
  }

  /**
   * Start the MCP server
   */
  async start(): Promise<void> {
    // Test Node-RED connection
    await this.nodeRedClient.testConnection();
    // Connection test completed silently
  }

  /**
   * Stop the MCP server
   */
  async stop(): Promise<void> {
    this.sseHandler.destroy();
    // Server stopped - logging disabled in stdio mode
    await Promise.resolve();
  }

  /**
   * Public method to list tools (for HTTP API)
   */
  async listTools() {
    return Promise.resolve({ tools: this.getToolDefinitions() });
  }

  /**
   * Public method to call tools (for HTTP API)
   * Accepts optional per-request Node-RED credentials from the OAuth token.
   */
  async callToolPublic(name: string, args: ToolArgs, nodeRedCredentials?: NodeRedCredentials) {
    if (nodeRedCredentials) {
      const savedClient = this.nodeRedClient;
      const authHeader =
        nodeRedCredentials.authType === 'basic'
          ? `Basic ${Buffer.from(`${nodeRedCredentials.username}:${nodeRedCredentials.password}`).toString('base64')}`
          : nodeRedCredentials.token
            ? `Bearer ${nodeRedCredentials.token}`
            : undefined;
      this.nodeRedClient = new NodeRedAPIClient({
        baseURL: nodeRedCredentials.url,
        headers: authHeader ? { Authorization: authHeader } : {},
      });
      try {
        return await this.callTool(name, args);
      } finally {
        this.nodeRedClient = savedClient;
      }
    }
    return await this.callTool(name, args);
  }

  /**
   * Public method to list resources (for HTTP API)
   */
  async listResources() {
    return { resources: await this.getResourceList() };
  }

  /**
   * Public method to read resource (for HTTP API)
   */
  async readResource(uri: string) {
    return await this.getResource(uri);
  }

  /**
   * Public method to list prompts (for HTTP API)
   */
  async listPrompts() {
    return Promise.resolve({ prompts: this.getPromptDefinitions() });
  }

  /**
   * Public method to get prompt (for HTTP API)
   */
  async getPromptPublic(name: string, args: ToolArgs) {
    return await this.getPrompt(name, args);
  }
}
