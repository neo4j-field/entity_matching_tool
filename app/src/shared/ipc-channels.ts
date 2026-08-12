// Canonical list of all IPC channel names.
// Both main and renderer import from here — no stringly-typed magic elsewhere.

export const IPC = {
  // Connection
  CONNECTION_SAVE: 'connection:save',
  CONNECTION_LIST: 'connection:list',
  CONNECTION_DELETE: 'connection:delete',
  CONNECTION_TEST: 'connection:test',
  CONNECTION_CONNECT: 'connection:connect',
  CONNECTION_DISCONNECT: 'connection:disconnect',

  // Schema
  SCHEMA_DISCOVER: 'schema:discover',
  SCHEMA_ESTIMATE_PAIRS: 'schema:estimatePairs',

  // Session
  SESSION_LIST: 'session:list',
  SESSION_CREATE: 'session:create',
  SESSION_LOAD: 'session:load',
  SESSION_SAVE: 'session:save',
  SESSION_DELETE: 'session:delete',

  // Compute
  COMPUTE_START: 'compute:start',
  COMPUTE_CANCEL: 'compute:cancel',
  COMPUTE_PROGRESS: 'compute:progress', // main→renderer push
  COMPUTE_DONE: 'compute:done',         // main→renderer push

  // Pairs
  PAIRS_LIST: 'pairs:list',
  PAIRS_SET_VERDICT: 'pairs:setVerdict',
  PAIRS_SET_NOTE: 'pairs:setNote',
  PAIRS_REFILTER: 'pairs:refilter',
  PAIRS_EXPORT: 'pairs:export',
  PAIRS_AUTO_CLASSIFY: 'pairs:autoClassify',
  PAIRS_AUTO_CLASSIFY_CANCEL: 'pairs:autoClassify:cancel',
  PAIRS_AUTO_CLASSIFY_PROGRESS: 'pairs:autoClassify:progress', // main→renderer push

  // Merge
  MERGE_DRY_RUN: 'merge:dryRun',
  MERGE_APPLY: 'merge:apply',

  // Audit
  AUDIT_LIST: 'audit:list',

  // Assistant
  ASSISTANT_SEND: 'assistant:send',
  ASSISTANT_CHUNK: 'assistant:chunk',   // main→renderer push (streaming)
  ASSISTANT_DONE: 'assistant:done',     // main→renderer push

  // Node detail (lazy-loaded in review panel)
  NODE_NEIGHBORS: 'node:neighbors',
  NODE_SOURCE_PASSAGES: 'node:sourcePassages',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // AI configuration suggestion
  CONFIGURE_SUGGEST: 'configure:suggest',

  // LLM usage, cost, and estimation
  USAGE_ESTIMATE: 'usage:estimate',
  USAGE_SESSION: 'usage:session',
  USAGE_LIFETIME: 'usage:lifetime',
  USAGE_PRICING: 'usage:pricing',
  USAGE_CALL: 'usage:call', // main→renderer push, one per completed LLM call

  // Auto-classify run plan (batching, cached prefix, cost estimate)
  CLASSIFY_PLAN: 'classify:plan',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
