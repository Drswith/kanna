import { useEffect, useRef } from "react"
import { MessageCircle, Ticket } from "lucide-react"
import type { TicketChatLink, TicketSummary } from "../../../shared/tickets"
import { ticketChipMarkKind, ticketMarkKind, type TicketMarkKind } from "../../lib/tickets"
import { cn } from "../../lib/utils"
import { useSidebarThread } from "../chat-ui/chat-reference"
import { PROVIDER_ICONS } from "../chat-ui/ChatPreferenceControls"
import { STATUS_MARK_SLOT_CLASS, StatusMark } from "../chat-ui/StatusMark"

const MARK_LABELS: Record<TicketMarkKind, string> = {
  working: "In progress",
  waiting: "Waiting on you",
  unread: "Done, unread",
  read: "Done",
}

/**
 * The mark each ticket was last drawn with, anywhere on the page. A ping
 * grows in only when a ticket already seen changes to it: not on the page's
 * first paint, and not when a row is drawn again or moves to another group
 * (which mounts it afresh) still saying what it said.
 */
const lastMarks = new Map<string, TicketMarkKind>()

function useMarkEnters(ticketId: string, kind: TicketMarkKind): boolean {
  const decided = useRef<{ kind: TicketMarkKind; enters: boolean } | null>(null)
  if (decided.current?.kind !== kind) {
    const previous = lastMarks.get(ticketId) ?? decided.current?.kind
    decided.current = { kind, enters: previous !== undefined && previous !== kind && (kind === "waiting" || kind === "unread") }
  }
  useEffect(() => {
    lastMarks.set(ticketId, kind)
  }, [kind, ticketId])
  return decided.current.enters
}

/** The muted ticket glyph, in a mark's slot: a read ticket, and the lines that point at one. */
export function TicketGlyph({ className }: { className?: string }) {
  return (
    <span className={STATUS_MARK_SLOT_CLASS}>
      <Ticket aria-hidden className={cn("size-4 text-muted-foreground", className)} />
    </span>
  )
}

/**
 * A ticket's one mark (`ticketMarkKind`): the sidebar's spinner and pings,
 * or for a read Done ticket the ticket glyph, as a read chat shows its icon.
 * The same on a row, a card, the status pill and the transcript's card.
 */
export function TicketMark({ ticket }: { ticket: Pick<TicketSummary, "id" | "state" | "unread"> }) {
  const kind = ticketMarkKind(ticket)
  const enters = useMarkEnters(ticket.id, kind)
  if (kind === "read") return <TicketGlyph />
  return <StatusMark kind={kind} label={MARK_LABELS[kind]} enters={enters} />
}

/**
 * A linked chat's mark on its chip: the sidebar's mark while it is working
 * or waiting on the user, and its harness logo once it is neither. Never
 * both, and never the chat's unread ping: the ticket says whether there is
 * news, and the chip only who did the work.
 */
export function TicketChatMark({ link }: { link: Pick<TicketChatLink, "chatId" | "state"> }) {
  const thread = useSidebarThread(link.chatId)
  const kind = ticketChipMarkKind(link.state)
  if (kind !== "harness") return <StatusMark kind={kind} label={kind === "working" ? "Working" : "Waiting on you"} />
  const Harness = thread?.row.provider ? PROVIDER_ICONS[thread.row.provider] : MessageCircle
  return (
    <span className={STATUS_MARK_SLOT_CLASS}>
      <Harness aria-hidden className="size-3 text-muted-foreground" />
    </span>
  )
}
