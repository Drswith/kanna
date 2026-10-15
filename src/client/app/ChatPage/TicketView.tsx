import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft } from "lucide-react"
import type { TicketChatLink, TicketDetail } from "../../../shared/tickets"
import { useSidebarThread } from "../../components/chat-ui/chat-reference"
import { TicketActivity, TicketComposer, TicketDetailBody, TicketMenu, TicketStatusPill } from "../../components/tickets/TicketDetail"
import { useTicketClock } from "../../components/tickets/useTicketClock"
import { ViewerIconButton, ViewerSurface } from "../../components/viewer/ViewerSurface"
import { copyTextToClipboard } from "../../lib/clipboard"
import { delegatorDisplayTitle } from "../../lib/delegators"
import { collapseTicketActivity, ticketLinkPath } from "../../lib/tickets"
import { useStableSidebarThreads } from "../useStableSidebarThreads"
import { useSidebarStore } from "../../stores/sidebarStore"
import { useTicketSummary } from "../../stores/ticketBoardStore"
import { useViewerStore, type ViewerItem } from "../../stores/viewerStore"
import { useOpenChat } from "../useOpenChat"
import type { ChatPreviewContext } from "./ChatPreview"

type TicketItem = Extract<ViewerItem, { kind: "ticket" }>

/**
 * One ticket in the pane, over its delegator's board: subscribed to on the
 * `ticket` topic for as long as it is open, which pushes it whole whenever
 * anything on it changes. Until the first push it is drawn from its row on
 * the board, so it opens with its title and state at once.
 *
 * Opening it marks it read, and so does news landing while it is open. Mark
 * as unread goes back to the board, since staying would read it again.
 */
export const TicketView = memo(function TicketView({ item, context, onClose }: {
  item: TicketItem
  context: ChatPreviewContext
  onClose: () => void
}) {
  const { socket } = context
  const { chatId, ticketId } = item
  const summary = useTicketSummary(chatId, ticketId)
  const [detail, setDetail] = useState<TicketDetail | null | undefined>(undefined)
  useEffect(() => socket.subscribe<TicketDetail | null>({ type: "ticket", chatId, ticketId }, setDetail), [chatId, socket, ticketId])

  const delegator = useSidebarThread(chatId)
  const delegatorName = delegatorDisplayTitle(delegator?.title ?? "")
  const threads = useStableSidebarThreads(useSidebarStore((store) => store.data))
  const titles = useMemo(() => new Map(threads.map((thread) => [thread.chatId, thread.title])), [threads])
  const chatTitle = useCallback((link: Pick<TicketChatLink, "chatId" | "title">) => titles.get(link.chatId) ?? link.title, [titles])
  const linkTitles = useMemo(() => new Map((detail?.chats ?? []).map((link) => [link.chatId, link.title])), [detail?.chats])
  const nameOfChat = useCallback((id: string) => titles.get(id) ?? linkTitles.get(id) ?? "A chat", [linkTitles, titles])

  // Read on open, and again when news lands while it is open, unless it was
  // just marked unread here (and then the view has gone back to the board).
  const unread = detail?.unread ?? summary?.unread ?? false
  const updatedAt = detail?.updatedAt ?? summary?.updatedAt
  const markedUnreadRef = useRef(false)
  useEffect(() => {
    if (!unread || markedUnreadRef.current) return
    void socket.command({ type: "ticket.markRead", chatId, ticketId }).catch(() => {})
  }, [chatId, socket, ticketId, unread, updatedAt])

  const rows = useMemo(
    () => (detail ? collapseTicketActivity(detail, { chat: nameOfChat, delegator: delegatorName }) : []),
    [delegatorName, detail, nameOfChat],
  )
  // What was there when the ticket first drew stays still. What arrives
  // after rises in, unless it is the reply just sent from the keyboard.
  const firstKeysRef = useRef<Set<string> | null>(null)
  if (detail && firstKeysRef.current === null) firstKeysRef.current = new Set(rows.map((row) => row.key))
  const sentByKeyRef = useRef(false)
  const arrivingKeys = useMemo(() => {
    const first = firstKeysRef.current
    if (!first) return new Set<string>()
    return new Set(rows
      .filter((row) => !first.has(row.key) && !(sentByKeyRef.current && row.type === "reply" && row.reply.author === "user"))
      .map((row) => row.key))
  }, [rows])

  // Opened at the latest, as a conversation is, and kept there as it grows
  // while the reader is there.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stuckRef = useRef(true)
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller && stuckRef.current) scroller.scrollTop = scroller.scrollHeight
  }, [rows])

  const stepBack = useViewerStore((store) => store.stepBack)
  const now = useTicketClock()
  const shown = detail ?? null
  const head = shown ?? summary

  const reply = useCallback(async (text: string) => {
    sentByKeyRef.current = window.event instanceof KeyboardEvent
    stuckRef.current = true
    await socket.command({ type: "ticket.reply", chatId, ticketId, text })
  }, [chatId, socket, ticketId])
  const setStatus = useCallback((status: "done" | "open") => {
    void socket.command({ type: "ticket.setStatus", chatId, ticketId, status }).catch(() => {})
  }, [chatId, socket, ticketId])
  const markUnread = useCallback(() => {
    markedUnreadRef.current = true
    void socket.command({ type: "ticket.markUnread", chatId, ticketId }).catch(() => {})
    stepBack()
  }, [chatId, socket, stepBack, ticketId])
  const copyLink = useCallback(() => {
    void copyTextToClipboard(new URL(ticketLinkPath(chatId, ticketId), window.location.origin).href)
  }, [chatId, ticketId])

  const openChat = useOpenChat()
  const number = head ? `#${head.number}` : "Ticket"
  return (
    <ViewerSurface
      label={head ? `Ticket ${number}, ${head.title}` : "Ticket"}
      leading={<ViewerIconButton label="Back to the board (Esc)" onClick={stepBack}><ChevronLeft /></ViewerIconButton>}
      title={(
        <span className="flex min-w-0 items-center gap-1.5">
          <button type="button" onClick={stepBack} className="shrink-0 font-normal text-muted-foreground outline-none focus-visible:underline pointer-hover:text-foreground">Board</button>
          <span aria-hidden className="text-muted-foreground">/</span>
          <span className="font-semibold tabular-nums">{number}</span>
        </span>
      )}
      toolbar={head ? (
        <TicketMenu
          done={head.state === "done"}
          onSetStatus={setStatus}
          onMarkUnread={markUnread}
          onCopyLink={copyLink}
        />
      ) : null}
      onClose={onClose}
      bodyClassName="flex flex-col overflow-hidden"
    >
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const box = event.currentTarget
          stuckRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {shown ? (
          <TicketDetailBody
            ticket={shown}
            chatTitle={chatTitle}
            onOpenChat={(id) => openChat(id, { from: "preview" })}
            activity={<TicketActivity rows={rows} delegatorName={delegatorName} nowMs={now} arrivingKeys={arrivingKeys} />}
          />
        ) : summary ? (
          // The board's row, until the ticket itself arrives.
          <div className="flex flex-col gap-3 px-4 py-3.5">
            <h2 className="text-lg font-semibold leading-tight tracking-[-0.01em]">{summary.title}</h2>
            <div className="flex"><TicketStatusPill ticket={summary} /></div>
          </div>
        ) : detail === null ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">This ticket is not on the board any more.</p>
        ) : null}
      </div>
      {detail !== null ? <TicketComposer onSend={reply} /> : null}
    </ViewerSurface>
  )
})
