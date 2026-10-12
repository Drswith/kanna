import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { DelegatePreference } from "../lib/delegators"

/**
 * What the new chat page's delegate control was last set to, per project:
 * whether delegating is on there, and which delegator it last sent to. Kept
 * in this browser, like the composer's other choices. What it means is
 * `resolveDelegateTarget`'s to say; this only remembers.
 */
interface DelegateState {
  projects: Record<string, DelegatePreference>
  setPreference: (projectId: string, preference: DelegatePreference) => void
}

export const useDelegateStore = create<DelegateState>()(
  persist(
    (set) => ({
      projects: {},
      setPreference: (projectId, preference) => set((state) => {
        const current = state.projects[projectId]
        if (current?.on === preference.on && current?.chatId === preference.chatId) return state
        return { projects: { ...state.projects, [projectId]: preference } }
      }),
    }),
    { name: "delegate-preferences", version: 1 },
  ),
)
