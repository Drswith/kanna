import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { ArrowUp, CircleCheck, Ellipsis, Link, Mail, RotateCcw, User } from "lucide-react"
import { displayAttachments } from "../../../shared/display-tools"
import type { TicketChatLink, TicketDetail, TicketReply, TicketSummary } from "../../../shared/tickets"
import { readVisualizationArtifact } from "../../../shared/visualization"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../../app/chatFocusPolicy"
import { formatTicketTime, TICKET_STATE_LABELS, type TicketActivityRow } from "../../lib/tickets"
import { cn } from "../../lib/utils"
import { DelegatorIcon } from "../chat-ui/delegator-icon"
import { AttachmentsCard } from "../messages/DisplayToolMessage"
import { TranscriptMarkdown } from "../messages/shared"
import { UserMessageAttachments } from "../messages/UserMessage"
import { Visualization } from "../messages/Visualization"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { TicketChatMark, TicketMark } from "./TicketMark"

/**
 * One ticket, as the pane shows it under its breadcrumb: title, how it
 * stands and who is on it, what the work is, then everything that happened,
 * oldest first, and a composer to reply. Drawn from props; `TicketView` is
 * what subscribes and sends.
 */

/** A new line in the activity rises 4px into place. Not on the first paint, and not under reduced motion. */
const ARRIVE_CLASS = "transition-[opacity,translate] duration-200 ease-snappy starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none"

/** The status pill: the ticket's mark and the name of its column. */
export function TicketStatusPill({ ticket }: { ticket: Pick<TicketSummary, "id" | "state" | "unread"> }) {
  return (
    <span className="inline-flex h-6 items-center gap-[5px] rounded-[7px] border border-border pl-[5px] pr-[9px] text-xs font-medium">
      <TicketMark ticket={ticket} />
      {TICKET_STATE_LABELS[ticket.state]}
    </span>
  )
}

/** A chat on the ticket. A click opens it the way a chat link does, in the previewer. */
export function TicketChatChip({ link, title, onOpen }: { link: TicketChatLink; title: string; onOpen: (chatId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(link.chatId)}
      // The middle button, which opening a chat reads as "in a tab".
      onAuxClick={(event) => { if (event.button === 1) onOpen(link.chatId) }}
      className={cn(
        "inline-flex h-6 min-w-0 max-w-full items-center gap-[5px] rounded-[7px] border border-border pl-1 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "transition-[scale,background-color] duration-150 ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 pointer-hover:bg-muted",
      )}
    >
      <TicketChatMark link={link} />
      <span className="min-w-0 truncate">{title}</span>
    </button>
  )
}

/** What a reply carries besides its words: the delegator's visualizations and files, the user's attachments. */
function ReplyArtifacts({ reply }: { reply: TicketReply }) {
  const artifacts = reply.artifacts ?? []
  const visualizations = artifacts.flatMap((artifact) => {
    const read = readVisualizationArtifact([artifact])
    return read ? [read] : []
  })
  const files = displayAttachments(artifacts)
  return (
    <>
      {/* At the pane's width, with its own way to full size, as in a transcript. */}
      {visualizations.map((artifact) => (
        <div key={artifact.url} className="mt-1 overflow-hidden rounded-xl border border-border">
          <Visualization artifact={artifact} />
        </div>
      ))}
      {files.length > 0 ? <div className="mt-1"><AttachmentsCard attachments={files} /></div> : null}
      {reply.attachments && reply.attachments.length > 0 ? (
        <div className="mt-1 flex flex-col items-start gap-2"><UserMessageAttachments attachments={reply.attachments} align="start" /></div>
      ) : null}
    </>
  )
}

/** A reply, whole: who, when, the markdown, what it carries, and whether it asks the user. */
function TicketReplyRow({ reply, delegatorName, nowMs, arrives }: { reply: TicketReply; delegatorName: string; nowMs: number; arrives: boolean }) {
  const mine = reply.author === "user"
  return (
    <div className={cn("flex gap-2.5", arrives && ARRIVE_CLASS)}>
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-[7px]",
          mine ? "bg-purple-500/20 text-purple-600 dark:text-purple-400" : "bg-logo/15 text-logo",
        )}
      >
        {mine ? <User className="size-3.5" /> : <DelegatorIcon className="size-[13px]" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px] text-sm leading-[1.45]">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold">{mine ? "You" : delegatorName}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{formatTicketTime(reply.createdAt, nowMs)}</span>
        </div>
        <div className="prose prose-sm max-w-full text-pretty dark:prose-invert">
          <TranscriptMarkdown text={reply.text} />
        </div>
        <ReplyArtifacts reply={reply} />
        {reply.asksUser ? (
          <span className="inline-flex h-5 w-fit items-center rounded-md bg-blue-400/15 px-[7px] text-xs font-medium text-blue-600 dark:text-blue-400">
            Asks you
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The activity. History lines are quiet: no icon, indented to where a
 * reply's text starts (its 24px avatar and the 10px after it), so they read
 * as notes between the replies and not as more of them.
 */
export function TicketActivity({ rows, delegatorName, nowMs, arrivingKeys }: {
  rows: readonly TicketActivityRow[]
  delegatorName: string
  nowMs: number
  /** Rows that arrived while the ticket was open: they animate in. */
  arrivingKeys: ReadonlySet<string>
}) {
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => row.type === "reply" ? (
        <TicketReplyRow key={row.key} reply={row.reply} delegatorName={delegatorName} nowMs={nowMs} arrives={arrivingKeys.has(row.key)} />
      ) : (
        <div key={row.key} className={cn("flex items-baseline gap-2 pl-[34px] text-xs text-muted-foreground", arrivingKeys.has(row.key) && ARRIVE_CLASS)}>
          <span className="min-w-0">{row.text}</span>
          <span className="shrink-0 tabular-nums">{formatTicketTime(row.at, nowMs)}</span>
        </div>
      ))}
    </div>
  )
}

export function TicketDetailBody({ ticket, chatTitle, onOpenChat, activity }: {
  ticket: TicketDetail
  chatTitle: (link: TicketChatLink) => string
  onOpenChat: (chatId: string) => void
  activity: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <h2 className="text-lg font-semibold leading-tight tracking-[-0.01em] text-foreground">{ticket.title}</h2>
      <div className="flex flex-wrap items-center gap-1.5">
        <TicketStatusPill ticket={ticket} />
        {ticket.chats.map((link) => <TicketChatChip key={link.chatId} link={link} title={chatTitle(link)} onOpen={onOpenChat} />)}
      </div>
      {ticket.body.trim() ? (
        <div className="text-sm leading-normal">
          <div className="prose prose-sm max-w-full text-pretty dark:prose-invert">
            <TranscriptMarkdown text={ticket.body} />
          </div>
          {ticket.bodyEditedAt !== undefined ? <span className="text-xs text-muted-foreground">Edited</span> : null}
        </div>
      ) : null}
      <h3 className="pt-0.5 text-xs font-semibold text-muted-foreground">Activity</h3>
      {activity}
    </div>
  )
}

const MENU_ITEM_CLASS = "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none focus-visible:bg-muted pointer-hover:bg-muted [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"

/**
 * The ticket's ••• menu: Close or Reopen, Mark as unread, Copy link. Radix's
 * popover without the app's wrapper, whose own entrance would win over this
 * one's (`kanna-ticket-menu` in index.css).
 */
export function TicketMenu({ done, onSetStatus, onMarkUnread, onCopyLink }: {
  done: boolean
  onSetStatus: (status: "done" | "open") => void
  onMarkUnread: () => void
  onCopyLink: () => void
}) {
  const [open, setOpen] = useState(false)
  const run = (action: () => void) => () => {
    setOpen(false)
    action()
  }
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label="Ticket menu"
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
                "transition-[scale,background-color,color] duration-150 ease-snappy active:scale-[0.94] motion-reduce:transition-none motion-reduce:active:scale-100",
                "pointer-hover:bg-muted pointer-hover:text-foreground",
                open && "bg-muted text-foreground",
              )}
            >
              <Ellipsis />
            </button>
          </PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent>Ticket menu</TooltipContent>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          {...{ [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "" }}
          className="kanna-ticket-menu z-50 w-[190px] rounded-[10px] border border-border p-1 text-popover-foreground shadow-[0_10px_30px_rgb(0_0_0/0.16)] outline-none"
        >
          {done ? (
            <button type="button" className={MENU_ITEM_CLASS} onClick={run(() => onSetStatus("open"))}><RotateCcw />Reopen</button>
          ) : (
            <button type="button" className={MENU_ITEM_CLASS} onClick={run(() => onSetStatus("done"))}><CircleCheck />Close</button>
          )}
          <button type="button" className={MENU_ITEM_CLASS} onClick={run(onMarkUnread)}><Mail />Mark as unread</button>
          <button type="button" className={MENU_ITEM_CLASS} onClick={run(onCopyLink)}><Link />Copy link</button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

const COMPOSER_MAX_HEIGHT_PX = 160

/**
 * "Reply…" at the foot of the ticket. Enter sends and Shift+Enter breaks the
 * line, as in the chat's composer. What is sent goes on the ticket and on to
 * the delegator, so the field empties only once the server has taken it.
 */
export function TicketComposer({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)

  // Grows with what is typed, to a limit, then scrolls.
  useLayoutEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = "auto"
    field.style.height = `${Math.min(field.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`
  }, [text])

  const canSend = text.trim().length > 0 && !sending
  const send = () => {
    if (!canSend) return
    setSending(true)
    setError(null)
    onSend(text.trim())
      .then(() => setText(""))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setSending(false))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    send()
  }

  return (
    <div className="shrink-0 border-t border-border px-2.5 pb-2.5 pt-2">
      {error ? <p role="alert" className="px-1 pb-1.5 text-xs text-destructive">{error}</p> : null}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-card py-[5px] pl-3.5 pr-[5px] focus-within:border-blue-500 focus-within:ring-3 focus-within:ring-blue-500/20">
        <textarea
          ref={fieldRef}
          value={text}
          rows={1}
          placeholder="Reply…"
          aria-label="Reply on the ticket"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-[30px] min-w-0 flex-1 resize-none bg-transparent py-[5px] text-sm leading-5 outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          aria-label="Send reply"
          disabled={!canSend}
          onClick={send}
          className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-[scale,opacity] duration-150 ease-snappy active:scale-[0.94] disabled:opacity-40 disabled:active:scale-100 motion-reduce:transition-none"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </div>
  )
}
