import { CHAT_TOOL_NAMES } from "../../shared/tools"
import {
  compareTicketsByActivity,
  TICKET_ID_PATTERN,
  ticketActivity,
  type TicketChatLink,
  type TicketChatState,
  type TicketDetail,
  type TicketHistoryEvent,
  type TicketReply,
  type TicketState,
  type TicketSummary,
} from "../../shared/tickets"

/**
 * A delegator's ticket board on the client: the rules that are not drawing.
 * How the board is grouped, which one mark a ticket wears, how its activity
 * reads, which hand-offs in the delegator's transcript are a ticket's first,
 * and the link that opens one. React-free for tests. The board itself, and
 * every ticket's column, come from the server (`shared/tickets.ts`).
 */

export const TICKET_STATE_LABELS: Record<TicketState, string> = {
  waiting_on_you: "Waiting on you",
  in_progress: "In progress",
  done: "Done",
}

/** Top to bottom in the pane, left to right expanded: what wants the user first. */
const BOARD_ORDER: readonly TicketState[] = ["waiting_on_you", "in_progress", "done"]

export interface TicketBoardGroup {
  state: TicketState
  label: string
  /** Every ticket in the column, for its count. */
  total: number
  /** The ones the compact list shows. */
  tickets: TicketSummary[]
  /** Read Done tickets behind "Show N more". */
  hidden: number
}

/**
 * The compact list's groups, empty ones left out, each latest activity first.
 * Done shows only its unread tickets until asked for the rest: a delegator's
 * read Done tickets are most of its board within a day, and they are the
 * ones nobody needs to see again.
 */
export function groupTicketBoard(tickets: readonly TicketSummary[], { showAllDone = false } = {}): TicketBoardGroup[] {
  return BOARD_ORDER.flatMap((state) => {
    const column = tickets.filter((ticket) => ticket.state === state).sort(compareTicketsByActivity)
    if (column.length === 0) return []
    const shown = state === "done" && !showAllDone ? column.filter((ticket) => ticket.unread) : column
    return [{ state, label: TICKET_STATE_LABELS[state], total: column.length, tickets: shown, hidden: column.length - shown.length }]
  })
}

/** The full board's columns: all three, empty or not, so they hold their places. */
export function ticketBoardColumns(tickets: readonly TicketSummary[]): TicketBoardGroup[] {
  return BOARD_ORDER.map((state) => {
    const column = tickets.filter((ticket) => ticket.state === state).sort(compareTicketsByActivity)
    return { state, label: TICKET_STATE_LABELS[state], total: column.length, tickets: column, hidden: 0 }
  })
}

/**
 * The one mark a ticket wears, wherever it is drawn: the sidebar's own marks
 * for the same news. In progress spins, waiting on you is the blue ping, Done
 * and unread is the green one. Done and read has no status to show, so it
 * shows what it is, as a read chat shows its harness icon.
 */
export type TicketMarkKind = "working" | "waiting" | "unread" | "read"

export function ticketMarkKind(ticket: Pick<TicketSummary, "state" | "unread">): TicketMarkKind {
  if (ticket.state === "waiting_on_you") return "waiting"
  if (ticket.state === "in_progress") return "working"
  return ticket.unread ? "unread" : "read"
}

/** Whether the ticket wants the user: its title is bold, so unread is never told by colour alone. */
export function ticketWantsUser(ticket: Pick<TicketSummary, "state" | "unread">): boolean {
  return ticket.state === "waiting_on_you" || ticket.unread
}

/** A linked chat's mark on a chip: its status while it has one, else its harness logo. */
export type TicketChipMarkKind = "working" | "waiting" | "harness"

export function ticketChipMarkKind(state: TicketChatState): TicketChipMarkKind {
  if (state === "working") return "working"
  if (state === "waiting_on_you") return "waiting"
  return "harness"
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * How a ticket stands, in the few words after "Sent to X" on its card in the
 * delegator's transcript: "working", "2 chats working", "asking you",
 * "finished". About the ticket, not the one chat the card names: the card is
 * the ticket's, and the chat is only where this hand-off went.
 */
export function ticketShortState(ticket: Pick<TicketSummary, "state" | "chats">): string {
  if (ticket.state === "waiting_on_you") return "asking you"
  if (ticket.state === "in_progress") {
    const working = ticket.chats.filter((chat) => chat.outstanding && chat.state === "working").length
    return working > 1 ? `${working} chats working` : "working"
  }
  const failed = ticket.chats.some((chat) => chat.state === "failed")
  if (ticket.chats.length > 1) return `${ticket.chats.length} chats ${failed ? "done" : "finished"}`
  return failed ? "failed" : "finished"
}

// ── Activity ──────────────────────────────────────────────────────────────

export type TicketActivityRow =
  | { type: "reply"; key: string; at: number; reply: TicketReply }
  /** One quiet line, standing for one or more history events. */
  | { type: "history"; key: string; at: number; text: string }

/** What the activity calls the people in it. Kanna knows no name for the user, so they are "you". */
export interface TicketActivityNames {
  chat: (chatId: string) => string
  delegator: string
}

type ChatEventKind = "sent_to" | "chat_finished" | "chat_failed" | "chat_asking"

function isChatEvent(event: TicketHistoryEvent): event is Extract<TicketHistoryEvent, { kind: ChatEventKind }> {
  return event.kind === "sent_to" || event.kind === "chat_finished" || event.kind === "chat_failed" || event.kind === "chat_asking"
}

function chatEventText(kind: ChatEventKind, names: string[], lastSent: readonly string[]): string {
  if (kind === "sent_to") return `Sent to ${joinNames(names)}`
  if (kind === "chat_asking") return `${joinNames(names)} ${names.length > 1 ? "are" : "is"} asking you`
  const verb = kind === "chat_finished" ? "finished" : "failed"
  // The chats the line above sent it to, all done at once, need not be named again.
  const same = names.length > 1 && names.length === lastSent.length && names.every((name) => lastSent.includes(name))
  if (same) return `${names.length === 2 ? "Both" : `All ${names.length}`} ${verb}`
  return `${joinNames(names)} ${verb}`
}

function soloEventText(event: TicketHistoryEvent, names: TicketActivityNames): string {
  const who = (by: "user" | "delegator" | undefined) => (by === "delegator" ? names.delegator : "you")
  switch (event.kind) {
    case "closed": return `Closed by ${who(event.by)}`
    case "reopened":
      if (event.cause === "user_reply") return "Reopened by your reply"
      if (event.cause === "chat_started") return event.chatId ? `Reopened: ${names.chat(event.chatId)} started` : "Reopened"
      return `Reopened by ${who(event.by)}`
    case "renamed": return `Renamed from ‘${event.from}’`
    default: return ""
  }
}

/**
 * A ticket's activity as it reads: replies in full, and between them the
 * history as few quiet lines as say it.
 *
 * In a run of history with no reply in it, events of one kind in a row are
 * one line ("Sent to A and B", "Both finished"). A run of finishes that
 * leaves no chat still owing a report is when the ticket went Done, and says
 * so on the same line ("Both finished · Done"): the server keeps no event for
 * that, since it is derived, so it is read back here from the sends and
 * finishes before it. Everything else is a line of its own.
 */
export function collapseTicketActivity(
  ticket: Pick<TicketDetail, "replies" | "history">,
  names: TicketActivityNames,
): TicketActivityRow[] {
  const rows: TicketActivityRow[] = []
  // Chats sent work and not yet finished, replayed from the history.
  const owing = new Set<string>()
  let lastSent: string[] = []
  // The line being built from a run of one kind of chat event.
  let open: { kind: ChatEventKind; key: string; at: number; names: string[]; chatIds: Set<string> } | null = null

  const flush = () => {
    if (!open) return
    let text = chatEventText(open.kind, open.names, lastSent)
    if (open.kind === "sent_to") lastSent = open.names
    else if ((open.kind === "chat_finished" || open.kind === "chat_failed") && owing.size === 0) text += " · Done"
    rows.push({ type: "history", key: open.key, at: open.at, text })
    open = null
  }

  for (const item of ticketActivity(ticket)) {
    if (item.type === "reply") {
      flush()
      rows.push({ type: "reply", key: item.reply.id, at: item.at, reply: item.reply })
      continue
    }
    const event = item.event
    if (!isChatEvent(event)) {
      flush()
      const text = soloEventText(event, names)
      if (text) rows.push({ type: "history", key: event.id, at: event.createdAt, text })
      continue
    }
    if (event.kind === "sent_to") owing.add(event.chatId)
    else if (event.kind !== "chat_asking") owing.delete(event.chatId)
    if (open && open.kind !== event.kind) flush()
    if (!open) open = { kind: event.kind, key: event.id, at: event.createdAt, names: [], chatIds: new Set() }
    if (!open.chatIds.has(event.chatId)) {
      open.chatIds.add(event.chatId)
      open.names.push(names.chat(event.chatId))
    }
    open.at = Math.max(open.at, event.createdAt)
  }
  flush()
  return rows
}

// ── The delegator's transcript ────────────────────────────────────────────

/** A hand-off's ticket, as its tool call carries it. */
export interface HandoffTicketRef {
  ticketId: string
  /** From the call itself, for a ticket the board no longer has. */
  number: number | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** A result as an object: one already, or an older record's JSON in a text block. */
function resultObject(result: unknown): Record<string, unknown> | null {
  const direct = record(result)
  if (direct) return direct
  const first = Array.isArray(result) ? record(result[0])?.text : result
  if (typeof first !== "string" || !first.trim()) return null
  try {
    return record(JSON.parse(first))
  } catch {
    return null
  }
}

function ticketIdOf(value: unknown): string | null {
  return typeof value === "string" && TICKET_ID_PATTERN.test(value) ? value : null
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null
}

/** As much of a transcript row as says whether it is a hand-off. */
export interface HandoffCandidate {
  id: string
  kind: string
  toolKind?: string
  toolName?: string
  isError?: boolean
  input?: { payload?: Record<string, unknown> }
  rawResult?: unknown
  /** Set once the call has returned. */
  resultEntryId?: string
}

/**
 * The ticket a delegator's `create_chat`, `send_message` or `fork_chat` was
 * for, or null for any other row, a failed call, and a hand-off from an
 * ordinary chat. A returned call says it in its result (`ticket: { id,
 * number }`), and one without that field was not for a ticket. A call still
 * in flight is read from what it asked for (`ticketId` in its input), so its
 * card is the ticket's from the start.
 */
export function handoffTicketOf(message: HandoffCandidate): HandoffTicketRef | null {
  if (message.kind !== "tool" || message.isError) return null
  const named = message.toolKind === "chat" || (message.toolKind === "unknown_tool" && CHAT_TOOL_NAMES.includes(message.toolName ?? ""))
  if (!named) return null
  if (!message.resultEntryId && message.rawResult === undefined) {
    const asked = ticketIdOf(message.input?.payload?.ticketId)
    return asked ? { ticketId: asked, number: null } : null
  }
  const ticket = record(resultObject(message.rawResult)?.ticket)
  const ticketId = ticketIdOf(ticket?.id)
  return ticketId ? { ticketId, number: numberOf(ticket?.number) } : null
}

/**
 * The hand-offs that are not their ticket's first in what the transcript
 * holds: each draws as a slim "Also sent to" line, since the ticket's card
 * is already further up. Over the loaded window, so the earliest loaded
 * hand-off of a ticket is its card even when an older one is not loaded.
 */
export function repeatHandoffIds(messages: readonly HandoffCandidate[]): Set<string> {
  const seen = new Set<string>()
  const repeats = new Set<string>()
  for (const message of messages) {
    const ref = handoffTicketOf(message)
    if (!ref) continue
    if (seen.has(ref.ticketId)) repeats.add(message.id)
    else seen.add(ref.ticketId)
  }
  return repeats
}

/**
 * The ticket numbers each sub-chat's part of a report is for: the report
 * source's `tickets` (the hand-offs it still owed a report on, by chat),
 * numbered from the board. A ticket the board does not have is left out, as
 * is a chat with none: a report to an ordinary chat, or on work handed out
 * before the board.
 */
export function reportTicketNumbers(
  tickets: Readonly<Record<string, readonly string[]>> | undefined,
  numberOf: (ticketId: string) => number | undefined,
): Map<string, number[]> {
  const numbers = new Map<string, number[]>()
  for (const [chatId, ids] of Object.entries(tickets ?? {})) {
    const found = [...new Set(ids)].flatMap((id) => {
      const number = numberOf(id)
      return number === undefined ? [] : [number]
    })
    if (found.length > 0) numbers.set(chatId, found.sort((a, b) => a - b))
  }
  return numbers
}

/** Ticket numbers as a report line or a quote names them: "#13", "#13, #14". */
export function formatTicketNumbers(numbers: readonly number[]): string {
  return numbers.map((number) => `#${number}`).join(", ")
}

// ── Links ─────────────────────────────────────────────────────────────────

/** The query parameter that opens a ticket over its delegator's chat. */
export const TICKET_LINK_PARAM = "ticket"

/** A ticket's address: its delegator's chat, with the ticket open in the pane. */
export function ticketLinkPath(chatId: string, ticketId: string): string {
  return `/chat/${encodeURIComponent(chatId)}?${TICKET_LINK_PARAM}=${encodeURIComponent(ticketId)}`
}

/** The ticket a page's query asks to open, or null. Anything that is not a ticket id is ignored. */
export function readTicketLinkParam(search: string): string | null {
  const value = new URLSearchParams(search).get(TICKET_LINK_PARAM)
  return value && TICKET_ID_PATTERN.test(value) ? value : null
}

/** The same query without the ticket in it: the link is spent once the ticket is open. */
export function withoutTicketLinkParam(search: string): string {
  const params = new URLSearchParams(search)
  params.delete(TICKET_LINK_PARAM)
  const rest = params.toString()
  return rest ? `?${rest}` : ""
}

// ── Time ──────────────────────────────────────────────────────────────────

function sameDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

/**
 * A ticket's time on a row, a card or a line: the clock today, the weekday
 * this week, the date before that. Short enough to sit in tabular figures at
 * the end of a row.
 */
export function formatTicketTime(at: number, nowMs: number): string {
  const date = new Date(at)
  const now = new Date(nowMs)
  if (sameDay(date, now)) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  if (nowMs - at < 6 * 24 * 60 * 60 * 1000 && at < nowMs) return date.toLocaleDateString(undefined, { weekday: "short" })
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })
}

/** The linked chat a hand-off went to, for its card: by id, else the latest. */
export function handoffChat(ticket: Pick<TicketSummary, "chats">, chatId: string | null): TicketChatLink | null {
  return (chatId ? ticket.chats.find((chat) => chat.chatId === chatId) : null) ?? ticket.chats[0] ?? null
}
