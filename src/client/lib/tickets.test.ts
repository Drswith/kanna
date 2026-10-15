import { describe, expect, test } from "bun:test"
import type { TicketHistoryEvent, TicketReply, TicketSummary } from "../../shared/tickets"
import {
  adjacentTicketId,
  handoffStateLabel,
  ticketActivityBlocks,
  formatTicketNumbers,
  groupTicketBoard,
  handoffTicketOf,
  opensTicketInPane,
  parseTicketLink,
  readTicketLinkParam,
  repeatHandoffIds,
  reportTicketNumbers,
  ticketBoardColumns,
  ticketChipMarkKind,
  ticketDraftKey,
  ticketReplyCommand,
  ticketRepliesLabel,
  ticketLinkPath,
  ticketMarkKind,
  ticketShortState,
  ticketStepOrder,
  ticketWantsUser,
  withoutTicketLinkParam,
} from "./tickets"

function summary(number: number, state: TicketSummary["state"], extra: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: `tk_${String(number).padStart(6, "0")}`,
    delegatorChatId: "deleg",
    number,
    title: `Ticket ${number}`,
    state,
    statusLine: "",
    chats: [],
    createdAt: number,
    updatedAt: number * 10,
    unread: false,
    replyCount: 0,
    ...extra,
  }
}

describe("groupTicketBoard", () => {
  const board = [
    summary(1, "done"),
    summary(2, "in_progress"),
    summary(3, "done", { unread: true }),
    summary(4, "waiting_on_you"),
    summary(5, "in_progress"),
    summary(6, "done"),
  ]

  test("orders waiting on you, in progress, done, each latest first", () => {
    const groups = groupTicketBoard(board)
    expect(groups.map((group) => group.state)).toEqual(["waiting_on_you", "in_progress", "done"])
    expect(groups[1]!.tickets.map((ticket) => ticket.number)).toEqual([5, 2])
  })

  test("Done shows only its unread tickets, and counts the rest", () => {
    const done = groupTicketBoard(board).find((group) => group.state === "done")!
    expect(done.tickets.map((ticket) => ticket.number)).toEqual([3])
    expect(done.total).toBe(3)
    expect(done.hidden).toBe(2)
  })

  test("Show more shows every Done ticket", () => {
    const done = groupTicketBoard(board, { showAllDone: true }).find((group) => group.state === "done")!
    expect(done.tickets.map((ticket) => ticket.number)).toEqual([6, 3, 1])
    expect(done.hidden).toBe(0)
  })

  test("leaves out empty groups, and keeps Done with nothing unread", () => {
    const groups = groupTicketBoard([summary(1, "done"), summary(2, "in_progress")])
    expect(groups.map((group) => group.state)).toEqual(["in_progress", "done"])
    expect(groups[1]!.tickets).toEqual([])
    expect(groups[1]!.hidden).toBe(1)
  })

  test("the full board keeps all three columns", () => {
    expect(ticketBoardColumns([summary(1, "done")]).map((column) => column.total)).toEqual([0, 0, 1])
  })
})

describe("one mark per ticket", () => {
  const cases: Array<[TicketSummary["state"], boolean, ReturnType<typeof ticketMarkKind>]> = [
    ["in_progress", false, "working"],
    ["in_progress", true, "working"],
    ["waiting_on_you", false, "waiting"],
    ["done", true, "unread"],
    ["done", false, "read"],
  ]
  for (const [state, unread, mark] of cases) {
    test(`${state}${unread ? ", unread" : ""} wears ${mark}`, () => {
      expect(ticketMarkKind({ state, unread })).toBe(mark)
    })
  }

  test("a ticket wants the user when it waits on them or is unread, and then its title is bold", () => {
    expect(ticketWantsUser({ state: "waiting_on_you", unread: false })).toBe(true)
    expect(ticketWantsUser({ state: "done", unread: true })).toBe(true)
    expect(ticketWantsUser({ state: "done", unread: false })).toBe(false)
    expect(ticketWantsUser({ state: "in_progress", unread: false })).toBe(false)
  })

  test("a chip shows the chat's status, or its harness when it has none", () => {
    expect(ticketChipMarkKind("working")).toBe("working")
    expect(ticketChipMarkKind("waiting_on_you")).toBe("waiting")
    expect(ticketChipMarkKind("finished")).toBe("harness")
    expect(ticketChipMarkKind("stopped")).toBe("harness")
  })
})

describe("ticketShortState", () => {
  const link = (chatId: string, state: "working" | "finished" | "failed", outstanding = state === "working") => ({ chatId, title: chatId, state, outstanding, lastSentAt: 0 })
  test("says how the ticket stands", () => {
    expect(ticketShortState({ state: "in_progress", chats: [link("a", "working")] })).toBe("working")
    expect(ticketShortState({ state: "in_progress", chats: [link("a", "working"), link("b", "working")] })).toBe("2 chats working")
    expect(ticketShortState({ state: "waiting_on_you", chats: [link("a", "finished")] })).toBe("asking you")
    expect(ticketShortState({ state: "done", chats: [link("a", "finished")] })).toBe("finished")
    expect(ticketShortState({ state: "done", chats: [link("a", "finished"), link("b", "finished")] })).toBe("2 chats finished")
  })
})

describe("hand-offs in a delegator's transcript", () => {
  const call = (id: string, result: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    kind: "tool",
    toolKind: "chat",
    toolName: "create_chat",
    input: { payload: {} },
    rawResult: result,
    ...extra,
  })

  test("reads the ticket a hand-off was for", () => {
    expect(handoffTicketOf(call("a", { chatId: "c1", ticket: { id: "tk_00000d", number: 13 } }))).toEqual({ ticketId: "tk_00000d", number: 13 })
    expect(handoffTicketOf(call("a", JSON.stringify({ ticket: { id: "tk_00000d", number: 13 } })))).toEqual({ ticketId: "tk_00000d", number: 13 })
    expect(handoffTicketOf(call("a", undefined, { input: { payload: { ticketId: "tk_00000d" } } }))).toEqual({ ticketId: "tk_00000d", number: null })
  })

  test("a returned call is read from its result alone", () => {
    expect(handoffTicketOf(call("a", { chatId: "c1" }, { resultEntryId: "r", input: { payload: { ticketId: "tk_00000d" } } }))).toBeNull()
  })

  test("an ordinary chat's hand-off, a failed one and other tools have none", () => {
    expect(handoffTicketOf(call("a", { chatId: "c1" }))).toBeNull()
    expect(handoffTicketOf(call("a", { ticket: { id: "tk_00000d", number: 13 } }, { isError: true }))).toBeNull()
    expect(handoffTicketOf(call("a", { ticket: { id: "tk_00000d", number: 13 } }, { toolKind: "bash", toolName: "Bash" }))).toBeNull()
  })

  test("only a ticket's first hand-off is its card", () => {
    const messages = [
      call("a", { ticket: { id: "tk_00000d", number: 13 } }),
      call("b", { ticket: { id: "tk_00000e", number: 14 } }),
      { id: "text", kind: "assistant_text" },
      call("c", { ticket: { id: "tk_00000d", number: 13 } }),
      call("d", { ticket: { id: "tk_00000d", number: 13 } }),
      call("e", { chatId: "plain" }),
    ]
    expect([...repeatHandoffIds(messages)]).toEqual(["c", "d"])
  })
})

describe("report lines name their tickets", () => {
  const numbers = new Map([["tk_00000d", 13], ["tk_00000e", 14], ["tk_00000f", 15]])
  const numberOf = (id: string) => numbers.get(id)

  test("numbers each sub-chat's tickets from the board", () => {
    const refs = reportTicketNumbers({ c1: ["tk_00000d"], c2: ["tk_00000f", "tk_00000e", "tk_00000f"] }, numberOf)
    expect(refs.get("c1")).toEqual([13])
    expect(refs.get("c2")).toEqual([14, 15])
  })

  test("a ticket the board does not have, and a report with none, name nothing", () => {
    expect(reportTicketNumbers({ c1: ["tk_0000ff"] }, numberOf).size).toBe(0)
    expect(reportTicketNumbers(undefined, numberOf).size).toBe(0)
  })

  test("formats the numbers", () => {
    expect(formatTicketNumbers([13])).toBe("#13")
    expect(formatTicketNumbers([13, 14])).toBe("#13, #14")
  })
})

describe("ticket links", () => {
  test("round-trips a ticket through its link", () => {
    const path = ticketLinkPath("chat-1", "tk_6f0c2a")
    expect(path).toBe("/chat/chat-1?ticket=tk_6f0c2a")
    expect(readTicketLinkParam(path.slice(path.indexOf("?")))).toBe("tk_6f0c2a")
  })

  test("ignores anything that is not a ticket id", () => {
    expect(readTicketLinkParam("?ticket=../../etc")).toBeNull()
    expect(readTicketLinkParam("?ticket=")).toBeNull()
    expect(readTicketLinkParam("")).toBeNull()
  })

  test("drops the ticket from the query and keeps the rest", () => {
    expect(withoutTicketLinkParam("?ticket=tk_6f0c2a")).toBe("")
    expect(withoutTicketLinkParam("?a=1&ticket=tk_6f0c2a")).toBe("?a=1")
  })
})

describe("replying on a ticket", () => {
  test("each ticket keeps its own draft, apart from its delegator's", () => {
    const key = ticketDraftKey("chat-1", "tk_00000d")
    expect(key).not.toBe("chat-1")
    expect(key).not.toBe(ticketDraftKey("chat-1", "tk_00000e"))
    expect(key).not.toBe(ticketDraftKey("chat-2", "tk_00000d"))
  })

  test("the composer's uploads go to ticket.reply as they are", () => {
    const attachment = {
      id: "up_1",
      kind: "image" as const,
      displayName: "shot.png",
      absolutePath: "/p/.kanna/uploads/shot.png",
      relativePath: "./.kanna/uploads/shot.png",
      contentUrl: "/api/projects/p1/uploads/shot.png/content",
      mimeType: "image/png",
      size: 12,
    }
    expect(ticketReplyCommand("chat-1", "tk_00000d", "  look  ", [attachment]))
      .toEqual({ type: "ticket.reply", chatId: "chat-1", ticketId: "tk_00000d", text: "look", attachments: [attachment] })
  })

  test("a reply with no files sends none", () => {
    expect(ticketReplyCommand("chat-1", "tk_00000d", "hi")).toEqual({ type: "ticket.reply", chatId: "chat-1", ticketId: "tk_00000d", text: "hi" })
  })
})

describe("stepping between tickets", () => {
  const board = [
    summary(1, "done"),
    summary(2, "in_progress"),
    summary(3, "done", { unread: true }),
    summary(4, "waiting_on_you"),
    summary(5, "in_progress"),
    summary(6, "done"),
  ]
  const order = ticketStepOrder(board)
  const id = (number: number) => summary(number, "done").id

  test("goes through the list's order, Done's hidden read tickets included", () => {
    // Waiting on you, In progress latest first, then all of Done latest first.
    expect(order).toEqual([4, 5, 2, 6, 3, 1].map(id))
  })

  test("steps across a group's edge", () => {
    expect(adjacentTicketId(order, id(4), "next")).toBe(id(5))
    expect(adjacentTicketId(order, id(2), "next")).toBe(id(6))
    expect(adjacentTicketId(order, id(6), "previous")).toBe(id(2))
  })

  test("stops at the ends, and knows nothing of a ticket not on the board", () => {
    expect(adjacentTicketId(order, id(4), "previous")).toBeNull()
    expect(adjacentTicketId(order, id(1), "next")).toBeNull()
    expect(adjacentTicketId(order, "tk_ffffff", "next")).toBeNull()
  })
})

describe("ticketActivityBlocks", () => {
  let id = 0
  const at = (minute: number) => minute * 60_000
  const event = (minute: number, body: Record<string, unknown>) => ({ id: `e${++id}`, ticketId: "tk_000001", createdAt: at(minute), ...body }) as TicketHistoryEvent
  const reply = (minute: number, author: "user" | "delegator", text: string): TicketReply => ({ id: `r${++id}`, ticketId: "tk_000001", author, text, createdAt: at(minute) })
  const names = { chat: (chatId: string) => chatId.toUpperCase(), delegator: "Delegator" }
  const link = (chatId: string, state: "working" | "waiting_on_you" | "finished" | "failed" | "stopped") => ({ chatId, title: chatId, state, outstanding: state === "working", lastSentAt: 0 })
  const blocks = (history: TicketHistoryEvent[], replies: TicketReply[] = [], chats: ReturnType<typeof link>[] = []) => ticketActivityBlocks({ history, replies, chats }, names)
  const handoffs = (list: ReturnType<typeof blocks>) => list.flatMap((block) => (block.type === "handoff" ? [block] : []))

  test("a hand-off and its report are one row, where it was sent, settled in place", () => {
    const list = blocks([event(10, { kind: "sent_to", chatId: "a" }), event(52, { kind: "chat_finished", chatId: "a" })])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ type: "handoff", chatId: "a", at: at(10), state: "finished", settledAt: at(52) })
  })

  test("a hand-off with no report yet reads as its chat does now", () => {
    expect(handoffs(blocks([event(1, { kind: "sent_to", chatId: "a" })], [], [link("a", "working")]))[0]!.state).toBe("working")
    expect(handoffs(blocks([event(1, { kind: "sent_to", chatId: "a" }), event(2, { kind: "chat_asking", chatId: "a" })], [], [link("a", "waiting_on_you")]))[0]!.state).toBe("waiting_on_you")
    // Asked, then answered and working again: it says so.
    expect(handoffs(blocks([event(1, { kind: "sent_to", chatId: "a" }), event(2, { kind: "chat_asking", chatId: "a" })], [], [link("a", "working")]))[0]!.state).toBe("working")
  })

  test("a failure settles it as failed", () => {
    expect(handoffs(blocks([event(1, { kind: "sent_to", chatId: "a" }), event(3, { kind: "chat_failed", chatId: "a" })]))[0]).toMatchObject({ state: "failed", settledAt: at(3) })
  })

  test("a second hand-off to the same chat is its own row, at its own point, and one report settles both", () => {
    const list = blocks(
      [event(1, { kind: "sent_to", chatId: "a" }), event(5, { kind: "sent_to", chatId: "a" }), event(9, { kind: "chat_finished", chatId: "a" })],
      [reply(3, "user", "and the ring")],
    )
    expect(list.map((block) => block.type)).toEqual(["handoff", "divider", "user", "handoff"])
    expect(handoffs(list).map((block) => [block.at, block.state, block.settledAt])).toEqual([[at(1), "finished", at(9)], [at(5), "finished", at(9)]])
  })

  test("a report after a hand-off settled lands on the next one only", () => {
    const list = handoffs(blocks([
      event(1, { kind: "sent_to", chatId: "a" }), event(2, { kind: "chat_finished", chatId: "a" }),
      event(5, { kind: "sent_to", chatId: "a" }), event(9, { kind: "chat_failed", chatId: "a" }),
    ]))
    expect(list.map((block) => [block.state, block.settledAt])).toEqual([["finished", at(2)], ["failed", at(9)]])
  })

  test("closes, reopens and renames are single rows, and none says Done", () => {
    const list = blocks([
      event(1, { kind: "sent_to", chatId: "a" }),
      event(2, { kind: "chat_finished", chatId: "a" }),
      event(3, { kind: "closed", by: "user" }),
      event(4, { kind: "reopened", cause: "chat_started", chatId: "b" }),
      event(5, { kind: "renamed", from: "Old" }),
    ])
    const events = list.flatMap((block) => (block.type === "event" ? [block] : []))
    expect(events.map((block) => block.text)).toEqual(["Closed by you", "Reopened: B started", "Renamed from ‘Old’"])
    expect(events[1]!.chatId).toBe("b")
    expect(JSON.stringify(list)).not.toContain("Done")
  })

  test("a report with no hand-off before it is said where it happened, and names its chat", () => {
    const list = blocks([event(1, { kind: "chat_finished", chatId: "a" })])
    expect(list[0]).toMatchObject({ type: "event", text: "A finished", chatId: "a" })
  })

  test("replies are the user's bubble or the delegator's text", () => {
    expect(blocks([], [reply(1, "user", "hi"), reply(2, "delegator", "hello")]).map((block) => block.type)).toEqual(["user", "delegator"])
  })

  test("each message of the user's after the first thing opens a turn, under the rule with its time", () => {
    const list = blocks([event(1, { kind: "sent_to", chatId: "a" })], [reply(2, "user", "faster"), reply(3, "delegator", "On it."), reply(4, "user", "thanks")])
    expect(list.map((block) => block.type)).toEqual(["handoff", "divider", "user", "delegator", "divider", "user"])
    expect(list[1]).toMatchObject({ type: "divider", at: at(2) })
  })

  test("the activity's first message has no rule over it, as a chat's first prompt has none", () => {
    expect(blocks([], [reply(1, "user", "hi")]).map((block) => block.type)).toEqual(["user"])
    // Nor does the delegator's text: a rule dates the user's prompts only.
    expect(blocks([], [reply(1, "delegator", "hello"), reply(2, "delegator", "again")]).map((block) => block.type)).toEqual(["delegator", "delegator"])
  })

  test("states read as words", () => {
    expect(["working", "waiting_on_you", "finished", "failed", "stopped"].map((state) => handoffStateLabel(state as never)))
      .toEqual(["Working", "Asking you", "Finished", "Failed", "Stopped"])
  })
})

describe("ticketRepliesLabel", () => {
  test("counts replies, and says when there are none", () => {
    expect(ticketRepliesLabel(0)).toBe("No replies yet")
    expect(ticketRepliesLabel(1)).toBe("1 reply")
    expect(ticketRepliesLabel(3)).toBe("3 replies")
  })
})

describe("a ticket's link in a message", () => {
  test("names its delegator and ticket", () => {
    expect(parseTicketLink("/chat/chat-1?ticket=tk_6f0c2a")).toEqual({ chatId: "chat-1", ticketId: "tk_6f0c2a" })
    expect(parseTicketLink("/chat/chat-1/?a=1&ticket=tk_6f0c2a#end")).toEqual({ chatId: "chat-1", ticketId: "tk_6f0c2a" })
  })

  test("a chat's own link, and anything not a ticket id, is no ticket", () => {
    expect(parseTicketLink("/chat/chat-1")).toBeNull()
    expect(parseTicketLink("/chat/chat-1?ticket=nope")).toBeNull()
    expect(parseTicketLink("/settings?ticket=tk_6f0c2a")).toBeNull()
  })

  test("a plain click opens it in the pane; a modified or middle click, or a page with no pane, follows the address", () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
    expect(opensTicketInPane(click, true)).toBe(true)
    expect(opensTicketInPane({ ...click, metaKey: true }, true)).toBe(false)
    expect(opensTicketInPane({ ...click, ctrlKey: true }, true)).toBe(false)
    expect(opensTicketInPane({ ...click, button: 1 }, true)).toBe(false)
    expect(opensTicketInPane(click, false)).toBe(false)
  })
})
