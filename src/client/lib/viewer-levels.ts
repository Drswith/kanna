import type { ViewerItem } from "../stores/viewerStore"

/**
 * What is under what in the viewer's pane, and so where Back goes.
 *
 * The pane holds one thing at a time, but things are opened from other
 * things, and each remembers where it came from: a file opened over a chat
 * (`returnTo`), a chat stepped to from another (`back`), a chat picked from
 * the graph (`graph`) or from a delegator's list (`delegated`). Read together
 * those are a stack, and this is its one reading.
 *
 * Under all of it, on a delegator's page, is the pane's floor: the list of
 * the chats under the delegator. The pane rests on it and cannot go lower,
 * which is what makes it a pane that does not close. An ordinary chat has no
 * floor, and the bottom of its stack is the pane shut.
 *
 * Kept free of the store, for tests.
 */

/** As much of a chat's viewer as says what is under it. */
export interface ViewerLevel {
  item: ViewerItem
  widthPx?: number
  returnTo?: { item: ViewerItem; widthPx?: number }
}

export type ViewerLevelBelow =
  /** What Back shows, and the pane width to show it at, when one is remembered. */
  | { item: ViewerItem; widthPx?: number }
  /** Nothing is under it and nothing holds the pane open. */
  | "closed"
  /** It is the floor. There is nowhere to go back to, and it does not close. */
  | "floor"

/** A chat, the graph and a delegator's list share a pane width; see `viewerWidthClass`. */
function sharesChatWidth(item: ViewerItem) {
  return item.kind === "chat" || item.kind === "graph" || item.kind === "delegated"
}

function sameItem(left: ViewerItem, right: ViewerItem) {
  return left.kind === "delegated" && right.kind === "delegated" && left.chatId === right.chatId
}

export function viewerLevelBelow(level: ViewerLevel, floor: ViewerItem | null): ViewerLevelBelow {
  const { item } = level
  // Something opened over a chat, the graph or the list goes back to it, at
  // the width it had.
  if (level.returnTo) return { ...level.returnTo }

  // From here down everything shares the pane's width, so it carries over.
  const kept = level.widthPx !== undefined ? { widthPx: level.widthPx } : {}
  if (item.kind === "chat") {
    const origin = {
      ...(item.graph ? { graph: item.graph } : {}),
      ...(item.delegated ? { delegated: item.delegated } : {}),
    }
    const previous = item.back?.[item.back.length - 1]
    if (previous) {
      const back = item.back!.slice(0, -1)
      return { item: { kind: "chat", chatId: previous, ...(back.length > 0 ? { back } : {}), ...origin }, ...kept }
    }
    // The first chat of a trail goes back to what it was picked from: the
    // graph, which was itself opened over the list if there is one.
    if (item.graph) return { item: { kind: "graph", chatId: item.graph }, ...kept }
    if (item.delegated) return { item: { kind: "delegated", chatId: item.delegated }, ...kept }
  }

  if (!floor) return "closed"
  if (sameItem(item, floor)) return "floor"
  return { item: floor, ...(sharesChatWidth(item) ? kept : {}) }
}

/** Whether Back has somewhere to go: a level under this one that is not the pane shut. */
export function hasViewerLevelBelow(level: ViewerLevel, floor: ViewerItem | null): boolean {
  const below = viewerLevelBelow(level, floor)
  return below !== "closed" && below !== "floor"
}

/**
 * What Escape finds in the pane (`resolveEscapePress`): something it can
 * close or step back from, or a pane resting on its floor, which it leaves
 * alone and goes on past.
 */
export function viewerPaneForEscape(level: ViewerLevel | null, floor: ViewerItem | null): "none" | "open" | "floor" {
  if (!level) return "none"
  return viewerLevelBelow(level, floor) === "floor" ? "floor" : "open"
}
