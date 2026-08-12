// Shared runtime constants. Types live in types.ts; IPC channel names in
// ipc-channels.ts.

// The model every LLM feature falls back to. Sonnet 5 is chosen over the
// cheaper Haiku 4.5 because its 1024-token prompt-cache floor is a quarter of
// Haiku's 4096 — auto-classify's shared prefix only pays for itself once it
// caches, and on Haiku a typical prefix sits below the floor and is re-sent at
// full price on every call.
export const DEFAULT_ASSISTANT_MODEL = 'claude-sonnet-5'

// Auto-classify defaults. Kept here rather than inline so the settings service
// and the Settings form can't drift apart.
export const DEFAULT_CLASSIFY_BATCH_SIZE = 20

// Twenty rather than a smaller number because the shared prefix has to clear
// the model's prompt-cache floor to be worth sending at all, and examples are
// most of its bulk. Measured on a real session, twenty examples put the prefix
// above even Haiku 4.5's 4096-token floor, where twelve fell short.
export const DEFAULT_CLASSIFY_FEW_SHOT_COUNT = 20

export const DEFAULT_CLASSIFY_CACHED_PREFIX = true

// Batches sent in parallel. Calls are almost entirely output-token generation
// (~160 tok/s measured), so wall-clock scales close to 1/concurrency until the
// account's output-tokens-per-minute limit binds. Four is deliberately modest;
// raise it if the run isn't hitting 429s.
export const DEFAULT_CLASSIFY_CONCURRENCY = 4

// Compute refuses a configuration that would build more candidate pairs than
// this. Shared so the Configure screen can warn before a run rather than after.
export const MAX_CANDIDATE_PAIRS = 5_000_000
