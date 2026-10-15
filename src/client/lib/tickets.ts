import { CHAT_TOOL_NAMES } from "../../shared/tools"
import type { AgentProvider, ChatAttachment, ModelOptions } from "../../shared/types"
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

/**
 * Every ticket, in the order stepping goes through them from an open one
 * (the ↑ and ↓ in its header, k and j): the list's, top to bottom, with
 * Done's read tickets in it too, as "Show N more" shows them, so a step
 * reaches each one. The delegator's other chats are not tickets, and are not in it.
 */
export function ticketStepOrder(tickets: readonly TicketSummary[]): string[] {
  return groupTicketBoard(tickets, { showAllDone: true }).flatMap((group) => group.tickets.map((ticket) => ticket.id))
}

/** The ticket a step from `ticketId` lands on, or null at that end, and for a ticket not in the order. */
export function adjacentTicketId(order: readonly string[], ticketId: string, direction: "next" | "previous"): string | null {
  const index = order.indexOf(ticketId)
  if (index < 0) return null
  return order[index + (direction === "next" ? 1 : -1)] ?? null
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

/** What the activity calls the people in it. Kanna knows no name for the user, so they are "you". */
export interface TicketActivityNames {
  chat: (chatId: string) => string
  delegator: string
}

/**
 * A ticket's activity, as the pane draws it, in the transcript's own forms.
 * The user's replies are their bubbles and the delegator's are an agent's
 * text, as each would read in a chat.
 *
 * A hand-off is one row, where it was sent, standing for the chat it went to
 * and kept up to date there: working, then finished, failed or asking you.
 * Not a line for the send and another for the report, which said one thing
 * twice, a screen apart. A second hand-off to the same chat is a row of its
 * own, where it was sent.
 *
 * Everything else in the history (a close, a reopen, a rename) is a tool row
 * of its own. They come one at a time, so nothing is folded.
 *
 * The user's message opens a turn, as their prompt does in a chat, and the
 * rule with the time on it goes over it (`TimeBoundary`), the chat's way of
 * dating a prompt. Not over the first thing in the activity, as a chat's
 * first prompt has none either.
 */
export type TicketActivityBlock =
  | { type: "divider"; key: string; at: number }
  | { type: "user"; key: string; reply: TicketReply }
  | { type: "delegator"; key: string; reply: TicketReply }
  | {
    type: "handoff"
    key: string
    /** When it was sent: where the row sits. */
    at: number
    chatId: string
    /** How the work stands: from the chat's report once there is one, else the chat's own state now. */
    state: TicketChatState
    /** When the chat reported on it, finished or failed. */
    settledAt?: number
  }
  | {
    type: "event"
    key: string
    at: number
    text: string
    kind: TicketHistoryEvent["kind"]
    /** The chat it names, which a click on it opens. */
    chatId?: string
  }

type HandoffBlock = Extract<TicketActivityBlock, { type: "handoff" }>

function eventText(event: TicketHistoryEvent, names: TicketActivityNames): string {
  const who = (by: "user" | "delegator" | undefined) => (by === "delegator" ? names.delegator : "you")
  switch (event.kind) {
    case "closed": return `Closed by ${who(event.by)}`
    case "reopened":
      if (event.cause === "user_reply") return "Reopened by your reply"
      if (event.cause === "chat_started") return event.chatId ? `Reopened: ${names.chat(event.chatId)} started` : "Reopened"
      return `Reopened by ${who(event.by)}`
    case "renamed": return `Renamed from ‘${event.from}’`
    // A report with no hand-off before it to land on (one sent before the
    // board kept them): said where it happened.
    case "chat_finished": return `${names.chat(event.chatId)} finished`
    case "chat_failed": return `${names.chat(event.chatId)} failed`
    case "chat_asking": return `${names.chat(event.chatId)} is asking you`
    case "sent_to": return `Sent to ${names.chat(event.chatId)}`
  }
}

export function ticketActivityBlocks(
  ticket: Pick<TicketDetail, "replies" | "history" | "chats">,
  names: TicketActivityNames,
): TicketActivityBlock[] {
  const blocks: TicketActivityBlock[] = []
  // Each chat's hand-offs still waiting on its report. A final report clears
  // every one of them (the server's rule), so it settles them all.
  const open = new Map<string, HandoffBlock[]>()
  const asked = new Set<HandoffBlock>()

  for (const item of ticketActivity(ticket)) {
    if (item.type === "reply") {
      const mine = item.reply.author === "user"
      if (mine && blocks.length > 0) blocks.push({ type: "divider", key: `${item.reply.id}:divider`, at: item.at })
      blocks.push({ type: mine ? "user" : "delegator", key: item.reply.id, reply: item.reply })
      continue
    }
    const event = item.event
    if (event.kind === "sent_to") {
      const block: HandoffBlock = { type: "handoff", key: event.id, at: event.createdAt, chatId: event.chatId, state: "working" }
      blocks.push(block)
      open.set(event.chatId, [...(open.get(event.chatId) ?? []), block])
      continue
    }
    if (event.kind === "chat_finished" || event.kind === "chat_failed" || event.kind === "chat_asking") {
      const waiting = open.get(event.chatId) ?? []
      if (waiting.length > 0) {
        if (event.kind === "chat_asking") {
          for (const block of waiting) asked.add(block)
        } else {
          for (const block of waiting) {
            block.state = event.kind === "chat_finished" ? "finished" : "failed"
            block.settledAt = event.createdAt
            asked.delete(block)
          }
          open.delete(event.chatId)
        }
        continue
      }
    }
    const chatId = "chatId" in event && typeof event.chatId === "string" ? event.chatId : undefined
    blocks.push({ type: "event", key: event.id, at: event.createdAt, text: eventText(event, names), kind: event.kind, ...(chatId ? { chatId } : {}) })
  }

  // What has not reported reads as its chat does now: still working, asking,
  // or stopped without a word.
  const live = new Map(ticket.chats.map((link) => [link.chatId, link.state]))
  for (const waiting of open.values()) {
    for (const block of waiting) block.state = live.get(block.chatId) ?? (asked.has(block) ? "waiting_on_you" : "working")
  }
  return blocks
}

/**
 * The rule between a ticket's body and its activity: how many replies there
 * are, the user's and the delegator's. Not the hand-offs and other events,
 * which are not anything anyone said.
 */
export function ticketRepliesLabel(count: number): string {
  if (count === 0) return "No replies yet"
  return `${count} ${count === 1 ? "reply" : "replies"}`
}

/** What a hand-off's row says of it: "Working", "Finished", "Asking you". */
export function handoffStateLabel(state: TicketChatState): string {
  switch (state) {
    case "working": return "Working"
    case "waiting_on_you": return "Asking you"
    case "finished": return "Finished"
    case "failed": return "Failed"
    case "stopped": return "Stopped"
  }
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

// ── Replying ──────────────────────────────────────────────────────────────

/**
 * Where a ticket's composer keeps its draft (`chatInputStore`): its own key,
 * apart from the delegator chat's draft and from every other ticket's. Not
 * a chat id, so nothing that reads drafts as chats can take it for one.
 */
export function ticketDraftKey(delegatorChatId: string, ticketId: string): string {
  return `ticket:${delegatorChatId}:${ticketId}`
}

/** The composer's settings for the turn a reply starts, as `chat.send` carries them. */
export interface TicketReplyRun {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
  autoPlan?: boolean
}

/**
 * The command a reply sends: what was typed, trimmed, the composer's
 * uploads as they came back from the upload route (the shape a chat's
 * message carries them in), and its settings. None of either is left out
 * rather than sent empty.
 */
export function ticketReplyCommand(
  delegatorChatId: string,
  ticketId: string,
  text: string,
  attachments: readonly ChatAttachment[] = [],
  run: TicketReplyRun = {},
) {
  const settings = Object.fromEntries(Object.entries(run).filter(([, value]) => value !== undefined)) as TicketReplyRun
  return {
    type: "ticket.reply" as const,
    chatId: delegatorChatId,
    ticketId,
    text: text.trim(),
    ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    ...settings,
  }
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

/** The full date and time, for the tooltip on a relative one. */
export function formatTicketFullTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

/** The linked chat a hand-off went to, for its card: by id, else the latest. */
export function handoffChat(ticket: Pick<TicketSummary, "chats">, chatId: string | null): TicketChatLink | null {
  return (chatId ? ticket.chats.find((chat) => chat.chatId === chatId) : null) ?? ticket.chats[0] ?? null
}
