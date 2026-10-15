import {
  ticketLinkPath,
  type TicketChatLink,
  type TicketChatState,
  type TicketDetail,
  type TicketHistoryEvent,
  type TicketRecord,
  type TicketState,
  type TicketSummary,
} from "../shared/tickets"
import type { TicketNewsReason } from "./ticket-board"

/**
 * What the delegator's agent reads about its tickets: the line a report
 * gains, the header on a user's ticket reply, the nudge, and the shapes the
 * ticket tools return. Everything here goes inside a `<system-message>` or
 * a tool result, so the user never sees it.
 */

const STATE_WORDS: Record<TicketState, string> = {
  waiting_on_you: "Waiting on the user",
  in_progress: "In progress",
  done: "Done",
}

const CHAT_STATE_WORDS: Record<TicketChatState, string> = {
  working: "working",
  waiting_on_you: "waiting on the user",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
}

/** `#13 "Escape hold" (tk_6f0c2a)`: how the agent is shown a ticket, with the id to pass back. */
export function ticketLabel(ticket: Pick<TicketRecord, "id" | "number" | "title">) {
  return `#${ticket.number} ${JSON.stringify(ticket.title)} (${ticket.id})`
}

function joinLabels(labels: string[]) {
  if (labels.length <= 1) return labels[0] ?? ""
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
}

/** The line a report's header gains, naming the tickets the sub-chat's hand-offs belong to. Null for none. */
export function ticketReportLine(tickets: readonly Pick<TicketRecord, "id" | "number" | "title">[]): string | null {
  if (tickets.length === 0) return null
  return `For ticket${tickets.length === 1 ? "" : "s"} ${joinLabels(tickets.map(ticketLabel))}`
}

function chatsLine(links: readonly TicketChatLink[]) {
  if (links.length === 0) return "No chats have worked on it yet."
  return `Its chats: ${links.map((link) => `"${link.title}" (chat id ${link.chatId}) ${CHAT_STATE_WORDS[link.state]}`).join("; ")}.`
}

function howToAnswer(ticketId: string) {
  return `Reply on the ticket with reply_to_ticket; the user reads the ticket. Pass ticketId "${ticketId}" to create_chat, send_message or fork_chat when you hand work on.`
}

/**
 * What the delegator is told with a user's ticket reply: a wire-only turn
 * notice (`buildTurnNotices`), after what the user wrote, so the prompt
 * starts with their words, a `/skill` included, as a chat message does.
 *
 * `ticket` is the ticket as it stands when the turn starts, and its state is
 * what the delegator is told: a reply answers a question (`asksUser`
 * clears), so the state from before it would say the ticket still waits on
 * the user when it now waits on the delegator. `reopenedByReply` says the
 * reply took it out of Done.
 */
export function buildTicketReplyHeader(ticket: TicketSummary, reopenedByReply: boolean) {
  const state = reopenedByReply
    ? "It was Done, and this reply reopened it."
    : `It is ${STATE_WORDS[ticket.state]}.`
  return [
    "<system-message>",
    `The user replied on ticket ${ticketLabel(ticket)}, in the ticket and not in this chat. ${state}`,
    chatsLine(ticket.chats),
    howToAnswer(ticket.id),
    "</system-message>",
  ].join("\n")
}


/** What the delegator is told when the user reopens a Done ticket by hand. */
export function buildTicketReopenMessage(ticket: TicketSummary) {
  return [
    "<system-message>",
    `The user reopened ticket ${ticketLabel(ticket)}, which was Done. Find out what is still wanted, and act on it.`,
    chatsLine(ticket.chats),
    howToAnswer(ticket.id),
    "</system-message>",
  ].join("\n")
}

function reasonText(reason: TicketNewsReason, chatTitle: (chatId: string) => string) {
  return reason.kind === "user_reply" ? "the user replied" : `"${chatTitle(reason.chatId)}" reported`
}

/**
 * The nudge: once, after a delegator's turns run out, for tickets that got a
 * user reply or a final report it neither wrote on nor handed work from.
 */
export function buildTicketNudge(
  unanswered: ReadonlyArray<{ ticket: Pick<TicketRecord, "id" | "number" | "title">; reasons: readonly TicketNewsReason[] }>,
  chatTitle: (chatId: string) => string,
) {
  const lines = unanswered.map(({ ticket, reasons }) => {
    const said = [...new Set(reasons.map((reason) => reasonText(reason, chatTitle)))]
    return `- ${ticketLabel(ticket)}: ${joinLabels(said)}.`
  })
  return [
    "<system-message>",
    "Kanna here, not the user. These tickets got news that you have not posted on:",
    ...lines,
    "The user follows the work on its tickets, not in this chat. Post on each with reply_to_ticket: what came back, what happens next, or a question with asksUser: true. If you are handing the work on, one line saying so is enough.",
    "</system-message>",
  ].join("\n")
}

// ── Tool results ─────────────────────────────────────────────────────────

function iso(timestamp: number) {
  return new Date(timestamp).toISOString()
}

function agentChat(link: TicketChatLink) {
  return {
    chatId: link.chatId,
    title: link.title,
    link: `/chat/${link.chatId}`,
    state: link.state,
    ...(link.outstanding ? { outstanding: true as const } : {}),
    lastSentAt: iso(link.lastSentAt),
  }
}

/** A ticket's row, as `list_tickets` returns it. */
export function agentTicketSummary(ticket: TicketSummary) {
  return {
    ticketId: ticket.id,
    number: ticket.number,
    title: ticket.title,
    // For the agent to link the ticket with, as `[#N Title](link)`: copied, not built.
    link: ticketLinkPath(ticket.delegatorChatId, ticket.id),
    state: ticket.state,
    status: ticket.statusLine,
    chats: ticket.chats.map(agentChat),
    replies: ticket.replyCount,
    updatedAt: iso(ticket.updatedAt),
  }
}

function agentHistory(event: TicketHistoryEvent, chatTitle: (chatId: string) => string) {
  const { id: _id, ticketId: _ticketId, createdAt, ...rest } = event
  return {
    ...rest,
    ...("chatId" in rest && rest.chatId ? { chatTitle: chatTitle(rest.chatId) } : {}),
    at: iso(createdAt),
  }
}

/** One ticket whole, as `read_ticket` returns it. */
export function agentTicketDetail(ticket: TicketDetail, chatTitle: (chatId: string) => string) {
  return {
    ...agentTicketSummary(ticket),
    body: ticket.body,
    ...(ticket.closed ? { closed: { ...ticket.closed, at: iso(ticket.closed.at) } } : {}),
    ...(ticket.asksUser ? { asksUser: true as const } : {}),
    ...(ticket.awaitingDelegator ? { awaitingYourReply: true as const } : {}),
    createdAt: iso(ticket.createdAt),
    replies: ticket.replies.map((reply) => ({
      replyId: reply.id,
      author: reply.author,
      text: reply.text,
      ...(reply.artifacts?.length
        ? { artifacts: reply.artifacts.map((artifact) => artifact.type === "visualization" ? { type: artifact.type, title: artifact.title, url: artifact.url } : { type: artifact.type, name: artifact.name, url: artifact.url }) }
        : {}),
      ...(reply.attachments?.length ? { attachments: reply.attachments.map((file) => ({ name: file.displayName, path: file.absolutePath })) } : {}),
      ...(reply.asksUser ? { asksUser: true as const } : {}),
      at: iso(reply.createdAt),
    })),
    history: ticket.history.map((event) => agentHistory(event, chatTitle)),
  }
}
