export const DATA_MODES = Object.freeze({
  loading: "loading",
  live: "live",
  degraded: "degraded",
  demo: "demo",
});

export function deriveDataMode(state) {
  if (state.demo) return DATA_MODES.demo;
  if (state.online === false || state.eventError || state.clansError) {
    return DATA_MODES.degraded;
  }
  if (!state.hasCommitted) return DATA_MODES.loading;
  if (
    state.reconnecting
    || !state.event
    || state.eventFromCache
    || state.clansFromCache
  ) {
    return DATA_MODES.degraded;
  }
  return DATA_MODES.live;
}

// Holds event and clan snapshots until both sides of a subscription cycle
// settle. That prevents a new event from rendering against an old clan list.
export function createSnapshotCoordinator({
  onCommit = () => {},
  onStatus = () => {},
} = {}) {
  let event = null;
  let clans = [];
  let hasCommitted = false;
  let cycle = null;
  let eventError = null;
  let clansError = null;
  let eventFromCache = false;
  let clansFromCache = false;

  const state = () => ({
    event,
    clans,
    hasCommitted,
    reconnecting: !!cycle && hasCommitted,
    eventError: cycle ? cycle.eventError : eventError,
    clansError: cycle ? cycle.clansError : clansError,
    eventFromCache: cycle ? cycle.eventFromCache : eventFromCache,
    clansFromCache: cycle ? cycle.clansFromCache : clansFromCache,
  });

  const publishStatus = () => onStatus(state());

  const commitCycleIfReady = () => {
    if (!cycle?.eventSettled || !cycle?.clansSettled) return;
    if (!cycle.eventError) {
      event = cycle.event;
      eventFromCache = cycle.eventFromCache;
    }
    if (!cycle.clansError) {
      clans = cycle.clans;
      clansFromCache = cycle.clansFromCache;
    }
    eventError = cycle.eventError;
    clansError = cycle.clansError;
    hasCommitted = true;
    cycle = null;
    publishStatus();
    onCommit({ event, clans }, {
      kind: "cycle",
      eventError,
      clansError,
    });
  };

  const beginCycle = () => {
    cycle = {
      eventSettled: false,
      clansSettled: false,
      event,
      clans,
      eventError: null,
      clansError: null,
      eventFromCache,
      clansFromCache,
    };
    publishStatus();
  };

  const receive = (kind, value, { fromCache = false } = {}) => {
    if (cycle) {
      cycle[`${kind}Settled`] = true;
      cycle[kind] = value;
      cycle[`${kind}Error`] = null;
      cycle[`${kind}FromCache`] = fromCache;
      commitCycleIfReady();
      return;
    }
    if (kind === "event") {
      event = value;
      eventError = null;
      eventFromCache = fromCache;
    } else {
      clans = value;
      clansError = null;
      clansFromCache = fromCache;
    }
    publishStatus();
    onCommit({ event, clans }, { kind });
  };

  const fail = (kind, error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (cycle) {
      cycle[`${kind}Settled`] = true;
      cycle[`${kind}Error`] = normalized;
      commitCycleIfReady();
      if (cycle) publishStatus();
      return;
    }
    if (kind === "event") eventError = normalized;
    else clansError = normalized;
    publishStatus();
  };

  return {
    beginCycle,
    receiveEvent: (value, meta) => receive("event", value, meta),
    receiveClans: (value, meta) => receive("clans", value, meta),
    failEvent: error => fail("event", error),
    failClans: error => fail("clans", error),
    getState: state,
  };
}

export function calculateServerOffset(serverDateMs, requestStartedAt, responseReceivedAt) {
  const [server, started, received] =
    [serverDateMs, requestStartedAt, responseReceivedAt].map(Number);
  if (![server, started, received].every(Number.isFinite) || received < started) return 0;
  return server - ((started + received) / 2);
}

export function createServerClock(now = () => Date.now()) {
  let offset = 0;
  return {
    now: () => now() + offset,
    getOffset: () => offset,
    setOffset: value => {
      offset = Number.isFinite(Number(value)) ? Number(value) : 0;
      return offset;
    },
  };
}

export async function syncServerClock(fetchImpl, url, clock, now = () => Date.now()) {
  const startedAt = now();
  const response = await fetchImpl(url, { method: "HEAD", cache: "no-store" });
  const receivedAt = now();
  const serverDate = Date.parse(response.headers.get("date") ?? "");
  if (!response.ok || !Number.isFinite(serverDate)) {
    throw new Error("Server clock was unavailable.");
  }
  return clock.setOffset(calculateServerOffset(serverDate, startedAt, receivedAt));
}

export function createVisibilityController({
  document: targetDocument,
  subscribe,
  onHidden = () => {},
  onVisible = () => {},
}) {
  let unsubscribe = null;
  let disposed = false;

  const detach = () => {
    if (!unsubscribe) return;
    const stop = unsubscribe;
    unsubscribe = null;
    stop();
  };
  const attach = () => {
    if (disposed || targetDocument.hidden || unsubscribe) return;
    unsubscribe = subscribe() ?? (() => {});
  };
  const handleVisibility = () => {
    if (targetDocument.hidden) {
      detach();
      onHidden();
    } else {
      onVisible();
      attach();
    }
  };

  targetDocument.addEventListener("visibilitychange", handleVisibility);
  attach();

  return {
    isAttached: () => !!unsubscribe,
    dispose: () => {
      disposed = true;
      detach();
      targetDocument.removeEventListener("visibilitychange", handleVisibility);
    },
  };
}
