import { useState, type ReactNode } from "react"
import type { TicketSummary } from "../../../shared/tickets"
import { formatTicketTime, groupTicketBoard, ticketBoardColumns, ticketWantsUser } from "../../lib/tickets"
import { cn } from "../../lib/utils"
import { TicketMark } from "./TicketMark"

/**
 * A delegator's ticket board, in the two shapes the pane gives it: a list
 * grouped by column while the pane sits beside the chat, three columns of
 * cards once it is expanded over it. Drawn from the summaries on the
 * delegator's chat snapshot and nothing else, so it is live as they are.
 * There is no dragging: a ticket's column is derived from its chats.
 */

/** A press gives a row or card 1.5%, in and out on the app's curve. */
const PRESS_CLASS = "transition-[scale] duration-150 ease-snappy active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100"

/** A group's heading: its name and its count, no icon. Sticky, on the card's own colour so rows pass under it. */
export function TicketGroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-[1] flex items-baseline gap-1.5 bg-surface px-4 pb-1 pt-3 text-[13px] font-semibold">
      {label}
      <span className="font-normal tabular-nums text-muted-foreground">{count}</span>
    </div>
  )
}

/**
 * A ticket in the list: its mark, its title (bold while it wants the user),
 * one muted line on how it stands, and its time. One mark and no harness
 * logos: the chats doing the work are the ticket's business, on its page.
 */
export function TicketRow({ ticket, nowMs, onOpen }: { ticket: TicketSummary; nowMs: number; onOpen: (ticketId: string) => void }) {
  const wants = ticketWantsUser(ticket)
  return (
    // The rows touch, with their spacing inside them, so the pointer moving
    // down the list never falls between two.
    <button
      type="button"
      onClick={() => onOpen(ticket.id)}
      aria-label={`#${ticket.number} ${ticket.title}, ${ticket.statusLine}`}
      className={cn(
        "mx-1.5 flex w-[calc(100%-12px)] min-w-0 items-start gap-2.5 rounded-lg border border-transparent py-[7px] pl-2 pr-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "pointer-hover:border-border pointer-hover:bg-muted/45",
        PRESS_CLASS,
      )}
    >
      {/* 2px down: the slot is 16px and the title's line 20. */}
      <span className="mt-0.5 flex shrink-0"><TicketMark ticket={ticket} /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className={cn("truncate text-sm", wants ? "font-semibold" : "font-normal")}>{ticket.title}</span>
        <span className="truncate text-xs text-muted-foreground">{ticket.statusLine}</span>
      </span>
      <span className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground">{formatTicketTime(ticket.updatedAt, nowMs)}</span>
    </button>
  )
}

/**
 * The board as a list: Waiting on you, In progress, Done. Done holds its
 * unread tickets and a way to the rest. `otherChats` is the delegator's
 * chats no ticket links to, under a group of their own at the end.
 */
export function TicketBoardList({ tickets, nowMs, onOpenTicket, otherChats }: {
  tickets: readonly TicketSummary[]
  nowMs: number
  onOpenTicket: (ticketId: string) => void
  otherChats?: { count: number; rows: ReactNode } | null
}) {
  const [showAllDone, setShowAllDone] = useState(false)
  const groups = groupTicketBoard(tickets, { showAllDone })
  return (
    <div className="pb-2">
      {groups.map((group) => (
        <section key={group.state} aria-label={group.label}>
          <TicketGroupHeading label={group.label} count={group.total} />
          {group.tickets.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} nowMs={nowMs} onOpen={onOpenTicket} />)}
          {group.state === "done" && (group.hidden > 0 || showAllDone) ? (
            <button
              type="button"
              onClick={() => setShowAllDone((shown) => !shown)}
              // In line with the titles: the row's 8px and border, the mark and its gap.
              className="mx-1.5 mb-1.5 w-[calc(100%-12px)] rounded-lg py-1.5 pl-[35px] pr-2.5 text-left text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-hover:text-foreground"
            >
              {group.hidden > 0 ? `Show ${group.hidden} more` : "Show fewer"}
            </button>
          ) : null}
        </section>
      ))}
      {otherChats && otherChats.count > 0 ? (
        <section aria-label="Other chats">
          <TicketGroupHeading label="Other chats" count={otherChats.count} />
          {otherChats.rows}
        </section>
      ) : null}
    </div>
  )
}

/** A ticket on the full board: its mark, number and time on top, the title, one line of status. */
export function TicketCard({ ticket, nowMs, onOpen }: { ticket: TicketSummary; nowMs: number; onOpen: (ticketId: string) => void }) {
  const wants = ticketWantsUser(ticket)
  return (
    <button
      type="button"
      onClick={() => onOpen(ticket.id)}
      aria-label={`#${ticket.number} ${ticket.title}, ${ticket.statusLine}`}
      className={cn(
        "flex w-full min-w-0 flex-col gap-1 rounded-[10px] border border-border bg-card px-3 pb-[11px] pt-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "pointer-hover:border-muted-foreground/40",
        PRESS_CLASS,
      )}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <TicketMark ticket={ticket} />
        <span className="tabular-nums">#{ticket.number}</span>
        <span className="ml-auto tabular-nums">{formatTicketTime(ticket.updatedAt, nowMs)}</span>
      </span>
      <span className={cn("text-sm leading-[1.35]", wants ? "font-semibold" : "font-medium")}>{ticket.title}</span>
      <span className="truncate text-xs text-muted-foreground">{ticket.statusLine}</span>
    </button>
  )
}

/**
 * The board expanded: three columns, each scrolling on its own, all of
 * every column shown. Read Done tickets are here too: this is where the
 * whole board is looked at.
 */
export function TicketBoardColumns({ tickets, nowMs, onOpenTicket }: {
  tickets: readonly TicketSummary[]
  nowMs: number
  onOpenTicket: (ticketId: string) => void
}) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[repeat(3,minmax(220px,1fr))] gap-3 overflow-auto p-3">
      {ticketBoardColumns(tickets).map((column) => (
        <section
          key={column.state}
          aria-label={column.label}
          className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto rounded-xl bg-muted/45 p-2 scrollbar-hide"
        >
          <h3 className="mx-1.5 mb-0.5 mt-1 flex items-baseline gap-1.5 text-[13px] font-semibold">
            {column.label}
            <span className="font-normal tabular-nums text-muted-foreground">{column.total}</span>
          </h3>
          {column.tickets.length === 0
            ? <p className="mx-1.5 text-xs text-muted-foreground">None</p>
            : column.tickets.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} nowMs={nowMs} onOpen={onOpenTicket} />)}
        </section>
      ))}
    </div>
  )
}
