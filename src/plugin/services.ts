/**
 * Construct shared plugin services (stores, adapter, audit).
 */

import type { AccessLinkStore } from '../access/link-store.js';
import { createFlowAdapter } from '../runtime/create-adapter.js';
import type { FlowAdapter, RedRuntimeHost } from '../runtime/types.js';
import { AuditLog } from '../storage/audit-log.js';
import { ensureAiAccessDirs, resolveAiAccessPaths } from '../storage/paths.js';
import { ProposalStore } from '../storage/proposals.js';

import { createConfiguredLinkStore } from './links.js';
import { ProposalService } from './proposal-service.js';
import { resolveAiAccessSettings } from './settings.js';
import type { NodeRedPluginAPI } from './types.js';

export interface PluginServices {
  linkStore: AccessLinkStore;
  proposalStore: ProposalStore;
  auditLog: AuditLog;
  flowAdapter: FlowAdapter;
  proposalService: ProposalService;
}

export interface CreatePluginServicesOptions {
  flowAdapter?: FlowAdapter;
  linkStore?: AccessLinkStore;
}

function localAdminBaseUrl(RED: NodeRedPluginAPI): string {
  const settings = RED.settings as {
    uiPort?: number;
    httpAdminRoot?: string;
  };
  const port = typeof settings.uiPort === 'number' ? settings.uiPort : 1880;
  const root = settings.httpAdminRoot ?? '/';
  const prefix = !root || root === '/' ? '' : root.replace(/\/$/, '');
  return `http://127.0.0.1:${port}${prefix}`;
}

export function createPluginServices(
  RED: NodeRedPluginAPI,
  options: CreatePluginServicesOptions = {}
): PluginServices {
  const aiPaths = resolveAiAccessPaths(RED.settings.userDir);
  ensureAiAccessDirs(aiPaths);

  const linkStore = options.linkStore ?? createConfiguredLinkStore(RED);
  const proposalStore = new ProposalStore(aiPaths);
  const auditLog = new AuditLog(aiPaths);
  const flowAdapter =
    options.flowAdapter ??
    createFlowAdapter({
      // Plugin RED may expose runtime.flows at runtime; typed loosely here.
      RED: RED as unknown as RedRuntimeHost,
      http: { baseUrl: localAdminBaseUrl(RED) },
    });
  const proposalService = new ProposalService(
    proposalStore,
    auditLog,
    flowAdapter,
    () => resolveAiAccessSettings(RED.settings).defaultDeploymentType
  );

  return { linkStore, proposalStore, auditLog, flowAdapter, proposalService };
}
