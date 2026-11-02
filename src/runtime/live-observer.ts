import type { FlowAdapter, FlowsSnapshot } from './types.js';

// Runtime deploy events can arrive before setFlows resolves. Retain the previous
// distinct revision so a late completion can still compare against pre-landing live.
const snapshots = new WeakMap<
  FlowAdapter,
  { current: FlowsSnapshot; previous: FlowsSnapshot | undefined }
>();
const observing = new WeakSet<FlowAdapter>();

export function recordLiveSnapshot(adapter: FlowAdapter, live: FlowsSnapshot): void {
  const prior = snapshots.get(adapter);
  if (prior?.current.rev === live.rev) return;
  snapshots.set(adapter, { current: structuredClone(live), previous: prior?.current });
}

export function liveBeforeRevision(adapter: FlowAdapter, rev: string): FlowsSnapshot | undefined {
  const observed = snapshots.get(adapter);
  return observed?.current.rev === rev ? observed.previous : observed?.current;
}

export function observeFlowSnapshots(adapter: FlowAdapter): void {
  if (observing.has(adapter)) return;
  observing.add(adapter);
  const read = adapter.getFlows.bind(adapter);
  adapter.getFlows = async () => {
    const live = await read();
    recordLiveSnapshot(adapter, live);
    return live;
  };
}
