import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * What this browser remembers about delegators: whether each one's list has
 * been shown yet, and when each was last opened.
 */
interface DelegateState {
  /**
   * The delegators whose page has shown its list in the pane once. The list
   * is there by default the first time a delegator is opened; from then on
   * the pane is as it was left, and this is what tells the two apart.
   */
  paneShown: Record<string, true>
  markPaneShown: (chatId: string) => void
  /**
   * When each delegator's page was last opened here. A click on a project
   * with several opens the one last viewed (`resolveProjectNewChat`). Kept in
   * this browser like the rest: another device goes by its own, or by which
   * is most active.
   */
  viewedAt: Record<string, number>
  markViewed: (chatId: string) => void
}

export const useDelegateStore = create<DelegateState>()(
  persist(
    (set) => ({
      paneShown: {},
      markPaneShown: (chatId) => set((state) => (
        state.paneShown[chatId] ? state : { paneShown: { ...state.paneShown, [chatId]: true } }
      )),
      viewedAt: {},
      markViewed: (chatId) => set((state) => ({ viewedAt: { ...state.viewedAt, [chatId]: Date.now() } })),
    }),
    {
      name: "delegate-preferences",
      // Version 1 also kept, per project, where the new chat page's delegate
      // control sent a message. That control is gone.
      version: 2,
      migrate: (persisted) => {
        const { projects: _projects, ...rest } = (persisted ?? {}) as Record<string, unknown>
        return rest as unknown as DelegateState
      },
    },
  ),
)
