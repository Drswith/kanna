import {
  deriveTicketState,
  describeTicket,
  summarizeTicket,
  ticketAttentionCount,
  ticketChatLinks,
  type TicketArtifact,
  type TicketAuthor,
  type TicketChatInfo,
  type TicketDetail,
  type TicketHistoryEvent,
  type TicketRecord,
  type TicketReply,
  type TicketState,
  type TicketSummary,
} from "../shared/tickets"
import type { ChatAttachment } from "../shared/types"
import type { TicketStore, TicketStoreEventInput } from "./ticket-store"

/**
 * The rules of a delegator's ticket board, over `TicketStore`. See
 * `shared/tickets.ts` for what a ticket is and how its column is derived.
 *
 * Every write here is one the orchestrator makes for an actor it has already
 * checked: the delegator's agent through its tools, the user through the
 * router, Kanna itself for hand-offs and reports. This file knows nothing of
 * messages; what gets sent to the delegator is the orchestrator's to decide.
 *
 * It also keeps the nudge's ledger: tickets that got news the delegator has
 * to answer (a user reply, a final report), and tickets it then wrote on or
 * handed work from. In memory only. A restart loses at most one nudge.
 */

type HistoryInput = TicketHistoryEvent extends infer E ? E extends TicketHistoryEvent ? Omit<E, "id" | "ticketId" | "createdAt"> : never : never

/** Why a ticket is on the nudge's list. */
export type TicketNewsReason = { kind: "user_reply" } | { kind: "report"; chatId: string }

interface LedgerEntry {
  /** When news last landed. */
  newsAt: number
  reasons: TicketNewsReason[]
  /** When the delegator last wrote on it or handed work from it. */
  addressedAt?: number
}

function shortId(prefix: string, length = 8) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, length)}`
}

export class TicketBoard {
  private readonly store: TicketStore
  private readonly chatInfo: (chatId: string) => TicketChatInfo | undefined
  private readonly now: () => number
  private readonly ledgers = new Map<string, Map<string, LedgerEntry>>()

  constructor(args: {
    store: TicketStore
    chatInfo: (chatId: string) => TicketChatInfo | undefined
    now?: () => number
  }) {
    this.store = args.store
    this.chatInfo = args.chatInfo
    this.now = args.now ?? Date.now
  }

  get version() {
    return this.store.version
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  list(delegatorChatId: string): TicketRecord[] {
    return this.store.list(delegatorChatId)
  }

  get(delegatorChatId: string, ticketId: string): TicketRecord | undefined {
    return this.store.get(delegatorChatId, ticketId.trim())
  }

  require(delegatorChatId: string, ticketId: string): TicketRecord {
    const ticket = this.get(delegatorChatId, ticketId)
    if (!ticket) throw new Error(`Ticket ${ticketId} not found on this delegator's board. list_tickets shows its tickets.`)
    return ticket
  }

  stateOf(ticket: TicketRecord): TicketState {
    return deriveTicketState(ticket, ticketChatLinks(ticket, this.chatInfo))
  }

  summaries(delegatorChatId: string): TicketSummary[] {
    return this.list(delegatorChatId).map((ticket) => summarizeTicket(ticket, this.chatInfo))
  }

  summary(ticket: TicketRecord): TicketSummary {
    return summarizeTicket(ticket, this.chatInfo)
  }

  detail(delegatorChatId: string, ticketId: string): TicketDetail | null {
    const ticket = this.get(delegatorChatId, ticketId)
    return ticket ? describeTicket(ticket, this.chatInfo) : null
  }

  attention(delegatorChatId: string): number {
    return ticketAttentionCount(this.summaries(delegatorChatId))
  }

  /** Has the delegator ever had a ticket. Old delegators start with an empty board. */
  hasBoard(delegatorChatId: string) {
    return this.list(delegatorChatId).length > 0
  }

  /** The tickets this chat still owes a final report on. */
  ticketsAwaiting(delegatorChatId: string, childChatId: string): TicketRecord[] {
    return this.list(delegatorChatId)
      .filter((ticket) => ticket.handoffs.some((handoff) => handoff.childChatId === childChatId && handoff.outstanding))
      .sort((a, b) => a.number - b.number)
  }

  /** Of these chats, the ones no hand-off links to any ticket. */
  untracked(delegatorChatId: string, chatIds: readonly string[]): string[] {
    const linked = new Set<string>()
    for (const ticket of this.list(delegatorChatId)) {
      for (const handoff of ticket.handoffs) linked.add(handoff.childChatId)
    }
    return chatIds.filter((chatId) => !linked.has(chatId))
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  private history(ticketId: string, at: number, event: HistoryInput): TicketStoreEventInput {
    return { type: "history_added", at, event: { id: shortId("th"), ticketId, createdAt: at, ...event } as TicketHistoryEvent }
  }

  /** A short id no ticket on this board has: `tk_` and six hex digits, more if it must. */
  private newTicketId(delegatorChatId: string) {
    for (let length = 6; ; length += 1) {
      const id = shortId("tk", length)
      if (!this.store.get(delegatorChatId, id)) return id
    }
  }

  /**
   * The events that take a Done ticket back out of Done, or none. A close is
   * dropped with it, so the ticket is not held in Done once its new work ends.
   */
  private reopenEvents(ticket: TicketRecord, at: number, cause: Extract<HistoryInput, { kind: "reopened" }>): TicketStoreEventInput[] {
    if (this.stateOf(ticket) !== "done") return []
    return [
      this.history(ticket.id, at, cause),
      ...(ticket.closed?.status === "done" ? [{ type: "flags_set", at, ticketId: ticket.id, closed: null } as const] : []),
    ]
  }

  async create(delegatorChatId: string, input: { title: string; body?: string }): Promise<TicketRecord> {
    const title = input.title.trim()
    if (!title) throw new Error("A ticket needs a title.")
    const at = this.now()
    const id = this.newTicketId(delegatorChatId)
    await this.store.append(delegatorChatId, [{
      type: "ticket_created",
      at,
      ticket: { id, number: this.store.nextNumber(delegatorChatId), title, body: input.body?.trim() ?? "" },
    }])
    return this.store.get(delegatorChatId, id)!
  }

  async edit(delegatorChatId: string, ticketId: string, input: { title?: string; body?: string }) {
    const ticket = this.require(delegatorChatId, ticketId)
    const at = this.now()
    const title = input.title?.trim()
    if (input.title !== undefined && !title) throw new Error("The title cannot be empty.")
    const events: TicketStoreEventInput[] = []
    const renamed = title !== undefined && title !== ticket.title
    const body = input.body !== undefined && input.body.trim() !== ticket.body ? input.body.trim() : undefined
    if (renamed || body !== undefined) {
      events.push({ type: "ticket_edited", at, ticketId: ticket.id, ...(renamed ? { title } : {}), ...(body !== undefined ? { body } : {}) })
    }
    if (renamed) events.push(this.history(ticket.id, at, { kind: "renamed", from: ticket.title }))
    await this.store.append(delegatorChatId, events)
    return ticket
  }

  /**
   * An explicit close or reopen. A close takes the ticket to Done unless a
   * chat on it is still working or waiting (those win), and drops a question
   * or a reply it was waiting on. A reopen does something only to a Done
   * ticket: it stays out of Done until work handed on after it finishes, or
   * it is closed again. A user's reopen also waits on the delegator.
   * Returns whether anything changed.
   */
  async setStatus(delegatorChatId: string, ticketId: string, status: "done" | "open", by: TicketAuthor): Promise<boolean> {
    const ticket = this.require(delegatorChatId, ticketId)
    const at = this.now()
    if (status === "done") {
      if (ticket.closed?.status === "done") return false
      await this.store.append(delegatorChatId, [
        { type: "flags_set", at, ticketId: ticket.id, closed: { status: "done", by, at }, asksUser: false, awaitingDelegator: false },
        this.history(ticket.id, at, { kind: "closed", by }),
      ])
      return true
    }
    if (this.stateOf(ticket) !== "done") return false
    await this.store.append(delegatorChatId, [
      { type: "flags_set", at, ticketId: ticket.id, closed: { status: "open", by, at }, ...(by === "user" ? { awaitingDelegator: true } : {}) },
      this.history(ticket.id, at, { kind: "reopened", cause: "manual", by }),
    ])
    return true
  }

  /**
   * A reply on the ticket. The delegator's answers a user reply
   * (`awaitingDelegator`) and may ask one (`asksUser`); the user's answers a
   * question, waits on the delegator, reads the ticket, and reopens it if it
   * was Done.
   */
  async reply(delegatorChatId: string, ticketId: string, input: {
    author: TicketAuthor
    text: string
    artifacts?: TicketArtifact[]
    attachments?: ChatAttachment[]
    asksUser?: boolean
  }): Promise<TicketReply> {
    const ticket = this.require(delegatorChatId, ticketId)
    const text = input.text.trim()
    if (!text && !input.artifacts?.length && !input.attachments?.length) throw new Error("A reply needs text or a file.")
    const at = this.now()
    const reply: TicketReply = {
      id: shortId("rp"),
      ticketId: ticket.id,
      author: input.author,
      text,
      ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.author === "delegator" && input.asksUser ? { asksUser: true as const } : {}),
      createdAt: at,
    }
    const events: TicketStoreEventInput[] = []
    if (input.author === "user") {
      events.push(...this.reopenEvents(ticket, at, { kind: "reopened", cause: "user_reply" }))
      events.push({ type: "reply_added", at, reply })
      events.push({ type: "flags_set", at, ticketId: ticket.id, asksUser: false, awaitingDelegator: true })
      events.push({ type: "read_set", at, ticketId: ticket.id, readAt: at })
      this.noteNews(delegatorChatId, ticket.id, { kind: "user_reply" }, at)
    } else {
      events.push({ type: "reply_added", at, reply })
      events.push({ type: "flags_set", at, ticketId: ticket.id, awaitingDelegator: false, ...(input.asksUser ? { asksUser: true } : {}) })
      this.noteAddressed(delegatorChatId, ticket.id, at)
    }
    await this.store.append(delegatorChatId, events)
    return reply
  }

  /**
   * The delegator handed work on this ticket to a chat. A Done ticket comes
   * back out of it, and a user reply it was waiting on is answered.
   */
  async handoff(delegatorChatId: string, ticketId: string, childChatId: string, options?: { outstanding?: boolean }) {
    const ticket = this.require(delegatorChatId, ticketId)
    const at = this.now()
    await this.store.append(delegatorChatId, [
      ...this.reopenEvents(ticket, at, { kind: "reopened", cause: "chat_started", chatId: childChatId }),
      {
        type: "handoff_added",
        at,
        handoff: { delegationId: shortId("dl"), ticketId: ticket.id, childChatId, createdAt: at, outstanding: options?.outstanding ?? true },
      },
      this.history(ticket.id, at, { kind: "sent_to", chatId: childChatId }),
      ...(ticket.awaitingDelegator ? [{ type: "flags_set", at, ticketId: ticket.id, awaitingDelegator: false } as const] : []),
    ])
    this.noteAddressed(delegatorChatId, ticket.id, at)
  }

  /**
   * A chat reported to the delegator, or stopped to ask the user something.
   * Each ticket it still owes gets the line. A final report settles its
   * hand-offs and is news the delegator has to pass on.
   */
  async recordChatEvent(
    delegatorChatId: string,
    childChatId: string,
    kind: "chat_finished" | "chat_failed" | "chat_asking",
    options?: { final?: boolean },
  ): Promise<TicketRecord[]> {
    const tickets = this.ticketsAwaiting(delegatorChatId, childChatId)
    if (tickets.length === 0) return tickets
    const at = this.now()
    const events = tickets.map((ticket) => this.history(ticket.id, at, { kind, chatId: childChatId }))
    if (options?.final) {
      events.push({ type: "handoffs_settled", at, childChatId })
      for (const ticket of tickets) this.noteNews(delegatorChatId, ticket.id, { kind: "report", chatId: childChatId }, at)
    }
    await this.store.append(delegatorChatId, events)
    return tickets
  }

  /**
   * The chat owes no report any more without having made one: stopped by its
   * parent, adopted away, or its hand-off never started. All its hand-offs,
   * or those on `ticketIds`.
   */
  async settle(delegatorChatId: string, childChatId: string, ticketIds?: string[]) {
    const owed = this.ticketsAwaiting(delegatorChatId, childChatId).filter((ticket) => !ticketIds || ticketIds.includes(ticket.id))
    if (owed.length === 0) return
    await this.store.append(delegatorChatId, [{ type: "handoffs_settled", at: this.now(), childChatId, ...(ticketIds ? { ticketIds } : {}) }])
  }

  async markRead(delegatorChatId: string, ticketId: string) {
    const ticket = this.require(delegatorChatId, ticketId)
    const at = Math.max(this.now(), ticket.updatedAt)
    await this.store.append(delegatorChatId, [{ type: "read_set", at, ticketId: ticket.id, readAt: at }])
  }

  async markUnread(delegatorChatId: string, ticketId: string) {
    const ticket = this.require(delegatorChatId, ticketId)
    await this.store.append(delegatorChatId, [{ type: "read_set", at: this.now(), ticketId: ticket.id, readAt: null }])
  }

  // ── The nudge's ledger ─────────────────────────────────────────────────

  private ledger(delegatorChatId: string) {
    let ledger = this.ledgers.get(delegatorChatId)
    if (!ledger) {
      ledger = new Map()
      this.ledgers.set(delegatorChatId, ledger)
    }
    return ledger
  }

  private noteNews(delegatorChatId: string, ticketId: string, reason: TicketNewsReason, at: number) {
    const ledger = this.ledger(delegatorChatId)
    const entry = ledger.get(ticketId)
    if (entry) {
      entry.newsAt = at
      entry.reasons.push(reason)
    } else {
      ledger.set(ticketId, { newsAt: at, reasons: [reason] })
    }
  }

  private noteAddressed(delegatorChatId: string, ticketId: string, at: number) {
    const entry = this.ledgers.get(delegatorChatId)?.get(ticketId)
    if (entry) entry.addressedAt = at
  }

  /**
   * The tickets with news the delegator has not written on or handed work
   * from since, and clears the ledger. Called once each time its turns run
   * out, so each piece of news is nudged about at most once.
   */
  takeUnanswered(delegatorChatId: string): Array<{ ticket: TicketRecord; reasons: TicketNewsReason[] }> {
    const ledger = this.ledgers.get(delegatorChatId)
    if (!ledger) return []
    this.ledgers.delete(delegatorChatId)
    const unanswered: Array<{ ticket: TicketRecord; reasons: TicketNewsReason[] }> = []
    for (const [ticketId, entry] of ledger) {
      if (entry.addressedAt !== undefined && entry.addressedAt >= entry.newsAt) continue
      const ticket = this.store.get(delegatorChatId, ticketId)
      if (ticket) unanswered.push({ ticket, reasons: entry.reasons })
    }
    return unanswered.sort((a, b) => a.ticket.number - b.ticket.number)
  }

  /** Drops the ledger without nudging: the user stopped the delegator, or it went away. */
  forgetNews(delegatorChatId: string) {
    this.ledgers.delete(delegatorChatId)
  }
}
