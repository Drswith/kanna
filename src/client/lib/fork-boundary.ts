import type { ChatForkOrigin, HydratedTranscriptMessage, TranscriptEntry } from "../../shared/types"

/** The "Forked from" line, and the message it is drawn after. */
export interface ForkBoundary {
  sourceChatId: string
  /** When the fork was made. Epoch ms. */
  at: number
  /** Index into the hydrated messages of the last one copied from the source. */
  afterMessageIndex: number
}

/**
 * Where a fork's copied history ends, among the messages loaded.
 *
 * The server says where in entries (`ChatForkOrigin.entryCount`); this finds
 * the last hydrated message built from one of those. Entries and messages are
 * not one to one (a tool result folds into its call, a subagent's steps into
 * its Agent call), but a message keeps the id of the entry it started from.
 *
 * Null when the copy is not in the window: the window starts past it, and the
 * line appears once older messages page in and bring the copy's end with them.
 */
export function resolveForkBoundary(
  forkedFrom: ChatForkOrigin | undefined,
  entries: readonly TranscriptEntry[],
  startIndex: number,
  messages: readonly HydratedTranscriptMessage[],
): ForkBoundary | null {
  if (!forkedFrom) return null
  const copied = Math.min(forkedFrom.entryCount - startIndex, entries.length)
  if (copied <= 0) return null
  const copiedIds = new Set<string>()
  for (let index = 0; index < copied; index += 1) copiedIds.add(entries[index]!._id)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (copiedIds.has(messages[index]!.id)) {
      return { sourceChatId: forkedFrom.chatId, at: forkedFrom.at, afterMessageIndex: index }
    }
  }
  return null
}
