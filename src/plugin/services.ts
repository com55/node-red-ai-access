/**
 * Construct shared plugin services (stores, adapter, audit).
 */

import type { AccessLinkStore } from '../access/link-store.js';
import { createFlowAdapter } from '../runtime/create-adapter.js';
import {
  AdapterUnavailableError,
  PLUGIN_MISCONFIGURED_HTTP_AUTH_MESSAGE,
  PluginMisconfiguredError,
} from '../runtime/errors.js';
import type { FlowAdapter, RedRuntimeHost } from '../runtime/types.js';
import { AuditLog } from '../storage/audit-log.js';
import { ensureAiAccessDirs, resolveAiAccessPaths } from '../storage/paths.js';
import { ProposalStore } from '../storage/proposals.js';
import { SettingsStore } from '../storage/settings-store.js';

import { createConfiguredLinkStore } from './links.js';
import { ProposalService } from './proposal-service.js';
import { bindSettingsStore, isAdminAuthEnabled, resolveAiAccessSettings } from './settings.js';
import type { NodeRedPluginAPI } from './types.js';

/** Adapter that fails every call with a clear misconfiguration error. */
function misconfiguredAdapter(message: string): FlowAdapter {
  const fail = (): Promise<never> => Promise.reject(new PluginMisconfiguredError(message));
  return {
    kind: 'http',
    getFlows: fail,
    getFlow: fail,
    updateFlow: fail,
  };
}

export interface PluginServices {
  linkStore: AccessLinkStore;
  proposalStore: ProposalStore;
  auditLog: AuditLog;
  flowAdapter: FlowAdapter;
  proposalService: ProposalService;
  settingsStore: SettingsStore;
}

export interface CreatePluginServicesOptions {
  flowAdapter?: FlowAdapter;
  linkStore?: AccessLinkStore;
  settingsStore?: SettingsStore;
  /** When false, do not bind the process-wide settings store (tests). Default true. */
  bindSettings?: boolean;
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

  const settingsStore = options.settingsStore ?? new SettingsStore(aiPaths, RED.settings.aiAccess);
  if (options.bindSettings !== false) {
    bindSettingsStore(settingsStore);
  }

  const linkStore = options.linkStore ?? createConfiguredLinkStore(RED);
  linkStore.configureDefaults({
    defaultTtlSeconds: settingsStore.getEffective().defaultLinkTtlSeconds,
    maxActiveLinks: settingsStore.getEffective().maxActiveLinks,
  });
  const proposalStore = new ProposalStore(aiPaths);
  const auditLog = new AuditLog(aiPaths);
  let flowAdapter: FlowAdapter;
  if (options.flowAdapter) {
    flowAdapter = options.flowAdapter;
  } else {
    try {
      flowAdapter = createFlowAdapter({
        // Plugin RED from createNodeApi has no .runtime; resolveRuntimeHost also
        // tries the process-wide @node-red/runtime singleton when initialized.
        RED: RED as unknown as RedRuntimeHost,
        http: { baseUrl: localAdminBaseUrl(RED) },
        adminAuthEnabled: isAdminAuthEnabled(RED.settings),
      });
    } catch (error) {
      const message =
        error instanceof AdapterUnavailableError
          ? error.message
          : PLUGIN_MISCONFIGURED_HTTP_AUTH_MESSAGE;
      RED.log?.warn?.(`AI Access flow adapter unavailable: ${message}`);
      flowAdapter = misconfiguredAdapter(message);
    }
  }
  const proposalService = new ProposalService(
    proposalStore,
    auditLog,
    flowAdapter,
    () => resolveAiAccessSettings(RED.settings).defaultDeploymentType
  );

  return {
    linkStore,
    proposalStore,
    auditLog,
    flowAdapter,
    proposalService,
    settingsStore,
  };
}
