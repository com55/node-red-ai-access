/**
 * Fallback adapter over the localhost Node-RED Admin HTTP API (v2).
 */

import { FlowNotFoundError, FlowRevisionConflictError } from './errors.js';
import { assertFlowsSnapshot, normalizeFlowTab, replaceFlowTabInFlatFlows } from './flows-util.js';
import type {
  DeploymentType,
  FlowAdapter,
  FlowSnapshot,
  FlowsSnapshot,
  HttpAdapterOptions,
  UpdateFlowParams,
  UpdateFlowResult,
} from './types.js';

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export class HttpAdapter implements FlowAdapter {
  readonly kind = 'http' as const;
  private readonly baseUrl: string;
  private readonly accessToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpAdapterOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.accessToken = options.accessToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private headers(extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    headers.set('Accept', 'application/json');
    headers.set('Node-RED-API-Version', 'v2');
    if (this.accessToken) {
      headers.set('Authorization', `Bearer ${this.accessToken}`);
    }
    return headers;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers),
    });
    return response;
  }

  private async readJson(response: Response, what: string): Promise<unknown> {
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string; code?: string };
        detail = parsed.message ?? parsed.code ?? text;
      } catch {
        // keep raw text
      }
      if (response.status === 404) {
        throw new FlowNotFoundError(what);
      }
      if (response.status === 409) {
        throw new FlowRevisionConflictError('unknown', 'unknown', `Admin API ${what}`);
      }
      throw new Error(`Admin API ${what} failed (${response.status}): ${detail}`);
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`Admin API ${what} returned non-JSON`);
    }
  }

  async getFlows(): Promise<FlowsSnapshot> {
    const response = await this.request('/flows');
    const body = await this.readJson(response, 'GET /flows');
    return assertFlowsSnapshot(body, 'GET /flows');
  }

  async getFlow(flowId: string): Promise<FlowSnapshot> {
    const encoded = encodeURIComponent(flowId);
    const [flowsResponse, flowResponse] = await Promise.all([
      this.request('/flows'),
      this.request(`/flow/${encoded}`),
    ]);

    if (flowResponse.status === 404) {
      throw new FlowNotFoundError(flowId);
    }

    const flowsBody = await this.readJson(flowsResponse, 'GET /flows');
    const flowBody = await this.readJson(flowResponse, `GET /flow/${flowId}`);
    const snapshot = assertFlowsSnapshot(flowsBody, 'GET /flows');

    return {
      rev: snapshot.rev,
      flow: normalizeFlowTab(flowId, flowBody),
    };
  }

  async updateFlow(params: UpdateFlowParams): Promise<UpdateFlowResult> {
    const deploymentType: DeploymentType = params.deploymentType ?? 'nodes';
    const current = await this.getFlows();

    if (current.rev !== params.expectedRev) {
      throw new FlowRevisionConflictError(params.expectedRev, current.rev, 'updateFlow');
    }

    const merged = replaceFlowTabInFlatFlows(current.flows, params.flowId, params.flow);
    const response = await this.request('/flows', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Node-RED-Deployment-Type': deploymentType,
      },
      body: JSON.stringify({
        flows: merged,
        rev: params.expectedRev,
      }),
    });

    if (response.status === 409) {
      // Prefer reporting the caller's expected rev vs whatever the API returns.
      let currentRev = current.rev;
      try {
        const errBody = (await response.clone().json()) as { current_rev?: string };
        if (typeof errBody.current_rev === 'string') {
          currentRev = errBody.current_rev;
        }
      } catch {
        // ignore parse errors
      }
      throw new FlowRevisionConflictError(params.expectedRev, currentRev, 'updateFlow');
    }

    const body = await this.readJson(response, 'POST /flows');
    if (!body || typeof body !== 'object' || typeof (body as { rev?: unknown }).rev !== 'string') {
      throw new Error('Admin API POST /flows did not return a rev');
    }

    return {
      flowId: params.flowId,
      rev: (body as { rev: string }).rev,
    };
  }
}
