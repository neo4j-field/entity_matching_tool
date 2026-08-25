import Anthropic from '@anthropic-ai/sdk'
import { getSettings } from './settings-service'
import { fieldKey } from '../shared/field-key'
import { loadSession, listPairs } from './session-service'
import { getCachedSchema } from './schema-service'
import { recordCall, tokensFromUsage, emptyTokens } from './usage-service'
import type { CandidatePair, LlmCallRecord, ScoreDistributions, Session } from '../shared/types'

function buildSystemPrompt(
  session: Session,
  distributions: ScoreDistributions | null,
  currentPair: CandidatePair | null
): string {
  const { fields, surfacingRule, label } = session

  const metricLines = fields.flatMap((f) =>
    f.metrics.map((m) => `    ${fieldKey(f)} · ${m.metricId} [threshold ${m.threshold}]`)
  ).join('\n')

  const pairs = listPairs(session.id)
  const total = pairs.length
  const pending = pairs.filter((p) => p.verdict === 'pending').length
  const dup = pairs.filter((p) => p.verdict === 'duplicate').length
  const distinct = pairs.filter((p) => p.verdict === 'distinct').length

  const schema = getCachedSchema()
  const labelMeta = schema?.labels.find((l) => l.name === label)

  let prompt = `You are an assistant helping a user deduplicate nodes in a Neo4j knowledge graph. Be concise. Never apply a verdict yourself — the human always makes the final call.

Session context:
- Label: ${label} (${labelMeta?.count ?? '?'} nodes)
- Comparison fields: ${fields.map((f) => `${f.propertyName} (${labelMeta?.properties.find((p) => p.name === f.propertyName)?.types.join(', ') ?? 'String'})`).join(', ')}
- Active metrics:
${metricLines}
- Surfacing rule: ${surfacingRule.mode}
- Pairs in queue: ${total} total, ${pending} pending, ${dup + distinct} decided (${dup} duplicate, ${distinct} distinct)`

  if (distributions) {
    const fmt = (p: { metricId: string; fieldName: string; p50: number; p75: number; p90: number; p95: number; max: number }) =>
      `- ${p.fieldName} · ${p.metricId}: p50=${p.p50.toFixed(2)} p75=${p.p75.toFixed(2)} p90=${p.p90.toFixed(2)} p95=${p.p95.toFixed(2)} max=${p.p90.toFixed(2)}`

    prompt += `\n\nScore distributions (all ${total} pairs):\n${distributions.all.map(fmt).join('\n')}`
    if (pending < total) {
      prompt += `\n\nScore distributions (${pending} pending pairs):\n${distributions.pending.map(fmt).join('\n')}`
    }
  }

  if (currentPair) {
    const propLines = (snap: typeof currentPair.nodeA) =>
      Object.entries(snap.properties).map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`).join('\n')
    const scoreLines = currentPair.scores.map((s) => `    ${s.fieldName} · ${s.metricId}: ${s.score.toFixed(3)}`).join('\n')
    prompt += `\n\nCurrent pair:\n  Node A:\n${propLines(currentPair.nodeA)}\n  Node B:\n${propLines(currentPair.nodeB)}\n  Scores:\n${scoreLines}`
  }

  return prompt
}

export async function sendMessage(
  sessionId: string,
  pairId: string | null,
  userMessage: string,
  onChunk: (chunk: string) => void,
  onDone: () => void,
  onUsage?: (record: LlmCallRecord) => void
): Promise<void> {
  const settings = getSettings()
  if (!settings.anthropicApiKey) throw new Error('No Anthropic API key configured')

  const session = loadSession(sessionId)
  if (!session) throw new Error('Session not found')

  const currentPair = pairId ? listPairs(sessionId).find((p) => p.id === pairId) ?? null : null

  // Score distributions are stored on session stats — for now pass null if not yet computed
  const distributions: ScoreDistributions | null = null

  const client = new Anthropic({ apiKey: settings.anthropicApiKey })
  const model = settings.assistantModel
  const systemPrompt = buildSystemPrompt(session, distributions, currentPair ?? null)
  const startedAt = Date.now()

  const report = (record: LlmCallRecord): void => onUsage?.(record)

  try {
    const stream = await client.messages.stream({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        onChunk(chunk.delta.text)
      }
    }

    // Usage only lands on the accumulated final message — the deltas don't carry it.
    const final = await stream.finalMessage()
    report(
      recordCall({
        jobId: null,
        sessionId,
        kind: 'assistant-chat',
        model: final.model,
        startedAt,
        tokens: tokensFromUsage(final.usage),
        ok: true,
        stopReason: final.stop_reason,
        features: {
          systemPromptChars: systemPrompt.length,
          userMessageChars: userMessage.length,
          hasPair: pairId ? 1 : 0,
        },
      })
    )
  } catch (err) {
    report(
      recordCall({
        jobId: null,
        sessionId,
        kind: 'assistant-chat',
        model,
        startedAt,
        tokens: emptyTokens(),
        ok: false,
        error: (err as Error).message,
        features: {
          systemPromptChars: systemPrompt.length,
          userMessageChars: userMessage.length,
          hasPair: pairId ? 1 : 0,
        },
      })
    )
    throw err
  }

  onDone()
}
