/**
 * Node-RED Event Listener Service
 * Receives real-time events from Node-RED via WebSocket Comms API
 * and forwards them through SSE to connected clients.
 */

import { SSEHandler } from '../server/sse-handler.js';
import {
  NodeRedFlowEvent,
  NodeRedRuntimeEvent,
  NodeRedStatusEvent,
} from '../types/nodered.js';

import { NodeRedAPIClient } from './nodered-api.js';
import { NodeRedWsClient } from './nodered-ws-client.js';

type StatusFill = NonNullable<NodeRedStatusEvent['data']['status']['fill']>;
type StatusShape = NonNullable<NodeRedStatusEvent['data']['status']['shape']>;

const STATUS_FILLS = new Set<string>(['red', 'green', 'yellow', 'blue', 'grey']);
const STATUS_SHAPES = new Set<string>(['ring', 'dot']);

function toStatusFill(value: string | undefined): StatusFill | undefined {
  return value !== undefined && STATUS_FILLS.has(value) ? (value as StatusFill) : undefined;
}

function toStatusShape(value: string | undefined): StatusShape | undefined {
  return value !== undefined && STATUS_SHAPES.has(value) ? (value as StatusShape) : undefined;
}

function baseURLFromClient(client: NodeRedAPIClient): string {
  return client
    .getCommsWsUrl()
    .replace(/\/comms$/, '')
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://');
}

export class NodeRedEventListener {
  private sseHandler: SSEHandler;
  private wsClient: NodeRedWsClient;
  private isMonitoring = false;
  private lastEventTimestamp: number = Date.now();

  constructor(sseHandler: SSEHandler, nodeRedClient: NodeRedAPIClient, wsClient?: NodeRedWsClient) {
    this.sseHandler = sseHandler;
    if (wsClient) {
      this.wsClient = wsClient;
    } else {
      const baseURL = baseURLFromClient(nodeRedClient);
      this.wsClient = new NodeRedWsClient(sseHandler, {
        baseURL,
        onEvent: () => {
          this.lastEventTimestamp = Date.now();
        },
      });
    }
  }

  startEventMonitoring(): void {
    if (this.isMonitoring) {
      console.log('Node-RED event monitoring already started');
      return;
    }

    console.log('Starting Node-RED event monitoring (WebSocket)');
    this.isMonitoring = true;
    this.wsClient.connect();
    this.broadcastRuntimeEvent('start', 'Node-RED event monitoring started');
  }

  stopEventMonitoring(): void {
    if (!this.isMonitoring) return;

    console.log('Stopping Node-RED event monitoring');
    this.isMonitoring = false;
    this.wsClient.disconnect();
    this.broadcastRuntimeEvent('stop', 'Node-RED event monitoring stopped');
  }

  private broadcastRuntimeEvent(
    event: 'start' | 'stop' | 'restart' | 'error',
    message: string
  ): void {
    const runtimeEvent: NodeRedRuntimeEvent = {
      type: 'runtime',
      timestamp: new Date().toISOString(),
      data: {
        event,
        message,
        memory: process.memoryUsage(),
      },
    };
    this.sseHandler.broadcast(runtimeEvent);
  }

  /** Manually signal a flow deploy (called from express-app on deploy endpoint). */
  onFlowDeploy(flowId?: string): void {
    const deployEvent: NodeRedFlowEvent = {
      type: 'flow',
      timestamp: new Date().toISOString(),
      data: {
        id: flowId ?? 'global',
        event: 'deploy',
        message: flowId ? `Flow ${flowId} deployed` : 'All flows deployed',
      },
    };
    this.sseHandler.broadcast(deployEvent);
  }

  /** Manually signal a node status update. */
  onNodeStatus(nodeId: string, status: { fill?: string; shape?: string; text?: string }): void {
    this.lastEventTimestamp = Date.now();
    const statusEvent: NodeRedStatusEvent = {
      type: 'status',
      timestamp: new Date().toISOString(),
      data: {
        id: nodeId,
        status: {
          fill: toStatusFill(status.fill),
          shape: toStatusShape(status.shape),
          text: status.text ?? undefined,
        },
      },
    };
    this.sseHandler.broadcast(statusEvent);
  }

  getStatus(): { isMonitoring: boolean; lastEventTimestamp: number } {
    return {
      isMonitoring: this.isMonitoring,
      lastEventTimestamp: this.lastEventTimestamp,
    };
  }
}
