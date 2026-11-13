// Process and response budgets shared by the MCP server, task store and App
// provider. These bound local work; they are not deadlines for an App task.
export const runtimeConfig = Object.freeze({
  localWaitMaxMs: 20_000,
  conversationDefaultWaitMs: 3_000,
  statePollMs: 250,
  routeGateWaitMs: 20_000,
  workerPollMs: 1_000,
  workerHeartbeatStaleMs: 10_000,
  sidecarStopWaitMs: 10_000,
  sidecarReadyWaitMs: 20_000,
  nativeCommandTimeoutMs: 60_000,
  nativeCommandSettleGraceMs: 250,
  nativeResponseLimitBytes: 256 * 1024,
  inlineArtifactBytes: 24 * 1024,
  artifactPageBytes: 24 * 1024,
});
