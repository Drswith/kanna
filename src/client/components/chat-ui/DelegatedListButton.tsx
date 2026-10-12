import { Workflow } from "lucide-react"
import { delegatedAttentionCount } from "../../lib/delegators"
import { useSidebarStore } from "../../stores/sidebarStore"
import { openViewer } from "../../stores/viewerStore"

/**
 * On a phone, a delegator's way to the chats under it: one button in the
 * navbar that is always there, which opens the list over the transcript (the
 * viewer's overlay, as anything opens there) and counts the chats in it that
 * want the user.
 *
 * It stands in for the pane a delegator has on a desktop, where the list is
 * always in view. There is no room for one here, so "always there" becomes
 * "always one tap away", and the count is what the list would have shown at
 * a glance. In the brand colour, as the mark of the thing the page is.
 */
export function DelegatedListButton({ chatId }: { chatId: string }) {
  // A number, so the button re-renders when the count moves and not for
  // every push of the sidebar.
  const count = useSidebarStore((state) => {
    let total = 0
    for (const group of state.data.projectGroups) total += delegatedAttentionCount(group.chats, chatId)
    return total
  })
  const label = count > 0 ? `Delegated chats, ${count} ${count === 1 ? "wants" : "want"} you` : "Delegated chats"
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => openViewer({ kind: "delegated", chatId })}
      // The navbar's own button box at this width (see the widgets button).
      className="pointer-events-auto flex h-[45px] min-w-[42px] shrink-0 items-center justify-center gap-1 px-1.5 text-logo outline-none transition-transform duration-150 ease-snappy focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.94] motion-reduce:transition-none"
    >
      <Workflow strokeWidth={2.25} className="size-5 shrink-0" />
      {count > 0 ? (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-foreground/10 px-1 text-xs font-bold leading-none text-foreground tabular-nums">
          {count}
        </span>
      ) : null}
    </button>
  )
}
