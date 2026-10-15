import { Loader2 } from "lucide-react"
import { cn } from "../../lib/utils"

/**
 * The slot every mark at the head of a row is drawn in: 16px, the size of the
 * harness icon the status glyph takes the place of, with the glyph centred.
 * The spinner is drawn at 14px so it does not look heavier than the icons
 * around it, and without the slot it was a 14px box: the title after it sat
 * 2px left of where it sits after any other mark, and anything lined up under
 * the mark's centre (the line under a quote, see `ReplyQuoteRow`) was off it.
 */
export const STATUS_MARK_SLOT_CLASS = "flex size-4 shrink-0 items-center justify-center"

/**
 * The sidebar's status marks, one per thing a row can want: the brand spinner
 * while working, a grey one while waiting on work handed off, a blue ping
 * when waiting on the user, a green ping when unread. A chat's row draws them
 * (`renderChatStatusDot`) and so does a ticket (`TicketMark`), so the two say
 * the same thing the same way.
 *
 * `enters` grows a ping in, for one that has just appeared: see `TicketMark`.
 */
export type StatusMarkKind = "working" | "waiting_on_subagent" | "waiting" | "unread"

export function StatusMark({ kind, label, enters = false }: { kind: StatusMarkKind; label?: string; enters?: boolean }) {
  if (kind === "working" || kind === "waiting_on_subagent") {
    return (
      <span className={STATUS_MARK_SLOT_CLASS}>
        <Loader2 aria-label={label} className={cn("size-3.5 animate-spin", kind === "working" ? "text-logo" : "text-muted-foreground")} />
      </span>
    )
  }
  const blue = kind === "waiting"
  return (
    <div role={label ? "img" : undefined} aria-label={label} className={cn("relative", STATUS_MARK_SLOT_CLASS, enters && "kanna-mark-enter")}>
      <div className={cn("absolute size-2.5 rounded-full kanna-ping", blue ? "bg-blue-400/80" : "bg-emerald-400/80")} />
      <div className={cn("size-2.5 rounded-full ring-2 ring-muted/20 dark:ring-muted/50", blue ? "bg-blue-400" : "bg-emerald-400")} />
    </div>
  )
}
