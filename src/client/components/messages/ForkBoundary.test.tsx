import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage, TranscriptEntry } from "../../../shared/types"
import { buildResolvedTranscriptRows, KannaTranscriptRow } from "../../app/KannaTranscript"
import { resolveForkBoundary } from "../../lib/fork-boundary"
import { ChatReferenceProvider, type ChatReferenceActions } from "../chat-ui/chat-reference"
import { ForkBoundaryLine } from "./ForkBoundary"
import { formatPromptTimestamp } from "./ResultMessage"
import { OpenLocalLinkProvider } from "./shared"

const FORKED_AT = new Date(2026, 9, 21, 17, 24).getTime()
const at = new Date(FORKED_AT - 60_000).toISOString()

const entry = (_id: string, kind: string, extra: Record<string, unknown> = {}) => (
  { _id, kind, createdAt: 1, ...extra } as unknown as TranscriptEntry
)

const prompt = (id: string): HydratedTranscriptMessage => ({ id, kind: "user_prompt", content: id, timestamp: at })
const text = (id: string): HydratedTranscriptMessage => ({ id, kind: "assistant_text", text: id, timestamp: at })
const result = (id: string, success = true): HydratedTranscriptMessage => (
  { id, kind: "result", success, result: success ? "ok" : "it broke", durationMs: 5, timestamp: at } as HydratedTranscriptMessage
)

const actions = { onOpenChat: () => undefined } as unknown as ChatReferenceActions

function render(messages: HydratedTranscriptMessage[], afterMessageIndex: number | null) {
  const rows = buildResolvedTranscriptRows(messages, {
    isLoading: false,
    latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, TodoWrite: null },
    forkBoundary: afterMessageIndex === null ? null : { sourceChatId: "source", at: FORKED_AT, afterMessageIndex },
  })
  const html = renderToStaticMarkup(
    <ChatReferenceProvider value={actions}>
      <OpenLocalLinkProvider onOpenLocalLink={() => undefined}>
        {rows.map((row) => (
          <section key={row.id} data-row={row.id}>
            <KannaTranscriptRow
              row={row}
              onToolGroupExpandedChange={() => undefined}
              onAskUserQuestionSubmit={() => undefined}
              onExitPlanModeConfirm={() => undefined}
            />
          </section>
        ))}
      </OpenLocalLinkProvider>
    </ChatReferenceProvider>,
  )
  return { rows, html }
}

/** The row each "Forked from" line is drawn in. */
function rowsWithLine(html: string) {
  return [...html.matchAll(/<section data-row="([^"]+)">(.*?)<\/section>/g)]
    .filter(([, , body]) => body!.includes("Forked"))
    .map(([, id]) => id)
}

describe("resolveForkBoundary", () => {
  const origin = { chatId: "source", at: FORKED_AT, entryCount: 4 }
  // The copy: a prompt, a tool call and its result (one message), the turn's result.
  const entries = [
    entry("u1", "user_prompt"), entry("call", "tool_call"), entry("call-result", "tool_result"), entry("r1", "result"),
    entry("u2", "user_prompt"), entry("a2", "assistant_text"),
  ]
  const messages = [prompt("u1"), { ...text("call"), kind: "tool" } as unknown as HydratedTranscriptMessage, result("r1"), prompt("u2"), text("a2")]

  test("is after the last message built from a copied entry", () => {
    expect(resolveForkBoundary(origin, entries, 0, messages)).toEqual({ sourceChatId: "source", at: FORKED_AT, afterMessageIndex: 2 })
    // A tool result last: it folded into its call, which is where the copy ends.
    expect(resolveForkBoundary({ ...origin, entryCount: 3 }, entries, 0, messages)?.afterMessageIndex).toBe(1)
  })

  test("follows the window: positioned against where it starts, and absent while the copy is not loaded", () => {
    expect(resolveForkBoundary(origin, entries.slice(3), 3, messages.slice(2))?.afterMessageIndex).toBe(0)
    expect(resolveForkBoundary(origin, entries.slice(4), 4, messages.slice(3))).toBeNull()
  })

  test("is at the end of a fork that has nothing of its own yet, and nowhere on a chat that is no fork", () => {
    expect(resolveForkBoundary(origin, entries.slice(0, 4), 0, messages.slice(0, 3))?.afterMessageIndex).toBe(2)
    expect(resolveForkBoundary(undefined, entries, 0, messages)).toBeNull()
  })
})

describe("the Forked from line", () => {
  const time = formatPromptTimestamp(new Date(FORKED_AT).toISOString())

  test("takes the place of the rule that closed the copy's last turn", () => {
    const { html } = render([prompt("u1"), text("a1"), result("r1"), prompt("u2")], 2)
    expect(rowsWithLine(html)).toEqual(["r1"])
    expect(html).toContain(`· ${time}`)
    // One rule there, not two: the result's own time is not drawn as well.
    expect(html).not.toContain("Worked for")
  })

  test("goes under the copy's last row when that is not a turn's rule", () => {
    const { html } = render([prompt("u1"), text("a1"), result("r1", false), prompt("u2")], 2)
    expect(rowsWithLine(html)).toEqual(["r1"])
    expect(html).toContain("it broke")
    // A copied message that draws nothing passes the line to the row before it.
    const usage = { id: "usage", kind: "context_window_updated", timestamp: at } as unknown as HydratedTranscriptMessage
    expect(rowsWithLine(render([prompt("u1"), text("a1"), usage, prompt("u2")], 2).html)).toEqual(["a1"])
  })

  test("is not drawn when the copy is not loaded", () => {
    expect(rowsWithLine(render([prompt("u2")], null).html)).toEqual([])
  })

  test("names the source as a link that opens it", () => {
    const html = renderToStaticMarkup(<ForkBoundaryLine source={{ title: "Delegator Tickets: Web UI" }} at={FORKED_AT} onOpen={() => undefined} />)
    expect(html).toContain("Forked from\u00a0</span><button")
    expect(html).toContain(">Delegator Tickets: Web UI</button>")
    expect(html).toContain(`\u00a0· ${time}`)
    // Where there is nothing to open it in, the title is only words.
    expect(renderToStaticMarkup(<ForkBoundaryLine source={{ title: "Parser" }} at={FORKED_AT} />)).not.toContain("<button")
  })

  test("says the source was deleted, with nothing to open", () => {
    const html = renderToStaticMarkup(<ForkBoundaryLine source="deleted" at={FORKED_AT} onOpen={() => undefined} />)
    expect(html).toContain("Forked from a deleted chat")
    expect(html).not.toContain("<button")
  })
})
