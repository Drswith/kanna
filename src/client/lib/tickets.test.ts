import { describe, expect, test } from "bun:test"
import type { TicketHistoryEvent, TicketReply, TicketSummary } from "../../shared/tickets"
import {
  collapseTicketActivity,
  formatTicketNumbers,
  groupTicketBoard,
  handoffTicketOf,
  readTicketLinkParam,
  repeatHandoffIds,
  reportTicketNumbers,
  ticketBoardColumns,
  ticketChipMarkKind,
  ticketLinkPath,
  ticketMarkKind,
  ticketShortState,
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

describe("collapseTicketActivity", () => {
  let id = 0
  const at = (minute: number) => minute * 60_000
  const event = (minute: number, body: Record<string, unknown>) => ({ id: `e${++id}`, ticketId: "tk_000001", createdAt: at(minute), ...body }) as TicketHistoryEvent
  const reply = (minute: number, author: "user" | "delegator", text: string): TicketReply => ({ id: `r${++id}`, ticketId: "tk_000001", author, text, createdAt: at(minute) })
  const names = { chat: (chatId: string) => chatId.toUpperCase(), delegator: "Delegator" }
  const lines = (history: TicketHistoryEvent[], replies: TicketReply[] = []) => collapseTicketActivity({ history, replies }, names)
    .map((row) => (row.type === "reply" ? `reply: ${row.reply.text}` : row.text))

  test("hand-offs in a row are one line", () => {
    expect(lines([event(1, { kind: "sent_to", chatId: "a" }), event(1, { kind: "sent_to", chatId: "b" })])).toEqual(["Sent to A and B"])
  })

  test("finishes that leave nothing owing end in Done, and name the chats only when the line above did not", () => {
    expect(lines([
      event(1, { kind: "sent_to", chatId: "a" }),
      event(1, { kind: "sent_to", chatId: "b" }),
      event(5, { kind: "chat_finished", chatId: "a" }),
      event(6, { kind: "chat_finished", chatId: "b" }),
    ])).toEqual(["Sent to A and B", "Both finished · Done"])
    expect(lines([event(1, { kind: "sent_to", chatId: "a" }), event(5, { kind: "chat_finished", chatId: "a" })]))
      .toEqual(["Sent to A", "A finished · Done"])
  })

  test("a finish with a chat still owing is not Done", () => {
    expect(lines([
      event(1, { kind: "sent_to", chatId: "a" }),
      event(1, { kind: "sent_to", chatId: "b" }),
      event(5, { kind: "chat_finished", chatId: "a" }),
    ])).toEqual(["Sent to A and B", "A finished"])
  })

  test("a reply breaks a run, and the same kind either side of it is two lines", () => {
    expect(lines(
      [event(1, { kind: "sent_to", chatId: "a" }), event(3, { kind: "sent_to", chatId: "b" })],
      [reply(2, "delegator", "progress")],
    )).toEqual(["Sent to A", "reply: progress", "Sent to B"])
  })

  test("closes, reopens and renames are lines of their own", () => {
    expect(lines([
      event(1, { kind: "closed", by: "user" }),
      event(2, { kind: "reopened", cause: "user_reply" }),
      event(3, { kind: "reopened", cause: "chat_started", chatId: "a" }),
      event(4, { kind: "reopened", cause: "manual", by: "delegator" }),
      event(5, { kind: "renamed", from: "Old" }),
      event(6, { kind: "chat_asking", chatId: "a" }),
      event(7, { kind: "chat_failed", chatId: "b" }),
    ])).toEqual([
      "Closed by you",
      "Reopened by your reply",
      "Reopened: A started",
      "Reopened by Delegator",
      "Renamed from ‘Old’",
      "A is asking you",
      "B failed · Done",
    ])
  })

  test("the merged line carries the latest time", () => {
    const rows = collapseTicketActivity({ history: [event(1, { kind: "sent_to", chatId: "a" }), event(4, { kind: "sent_to", chatId: "b" })], replies: [] }, names)
    expect(rows[0]!.at).toBe(at(4))
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
