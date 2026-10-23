import { useSidebarReady } from "../../stores/sidebarStore"
import { useChatReferenceActions, useSidebarThread } from "../chat-ui/chat-reference"
import { formatPromptTimestamp, TimeBoundary } from "./ResultMessage"

/**
 * The line where a fork's copied history ends and its own begins: "Forked
 * from Parser audit · 5:24 PM", on the rule that divides turns.
 *
 * The source's title is the sidebar's, so a rename shows here at once, and
 * it opens the source the way any link to another chat does (`onOpenChat`:
 * the previewer, beside this one). A source the sidebar no longer has was
 * deleted, and is named as such rather than linked to nothing.
 */
export function ForkBoundary({ sourceChatId, at }: { sourceChatId: string; at: number }) {
  const ready = useSidebarReady()
  const source = useSidebarThread(sourceChatId)
  const actions = useChatReferenceActions()
  return (
    <ForkBoundaryLine
      // Until the sidebar has spoken, a source it has not listed is not yet a deleted one.
      source={!ready ? "unknown" : source ? { title: source.title } : "deleted"}
      at={at}
      onOpen={actions ? () => actions.onOpenChat(sourceChatId) : undefined}
    />
  )
}

export function ForkBoundaryLine({ source, at, onOpen }: {
  source: { title: string } | "deleted" | "unknown"
  at: number
  /** Absent where there is nothing to open a chat in (the export viewer). */
  onOpen?: () => void
}) {
  const time = formatPromptTimestamp(new Date(at).toISOString())
  const title = typeof source === "object" ? source.title : null
  return (
    <TimeBoundary
      // The label keeps its width as a time's does, and gives way only to a
      // title too long for the column, which is cut instead.
      labelClassName="flex min-w-0 max-w-[80%] items-baseline"
      label={(
        <>
          <span className="shrink-0">{title !== null ? "Forked from " : source === "deleted" ? "Forked from a deleted chat" : "Forked"}</span>
          {title !== null && onOpen ? (
            <button
              type="button"
              onClick={onOpen}
              className="min-w-0 cursor-pointer truncate underline-offset-2 transition-colors hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {title}
            </button>
          ) : title !== null ? <span className="min-w-0 truncate">{title}</span> : null}
          <span className="shrink-0">{` · ${time}`}</span>
        </>
      )}
    />
  )
}
