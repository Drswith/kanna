import { randomUUID } from "node:crypto"
import { copyFile, lstat, rm, stat, utimes } from "node:fs/promises"
import path from "node:path"
import { LOG_PREFIX } from "../shared/branding"
import { readTreeBlobs, resolveWorkingTreeLocation, runGit, type WorkingTreeLocation } from "./diff-store"
import type { TouchedFile } from "./events"

/**
 * Which files a chat actually changed, by snapshotting the working tree at each
 * turn boundary and diffing the two trees.
 *
 * The point is to answer "did this chat touch anything that's still
 * uncommitted?" without a clock. The old answer compared the chat's last turn
 * end against a per-project "when did the tree get dirty" timestamp, which is a
 * proxy for authorship rather than a measurement of it: one file left
 * uncommitted overnight flagged every chat that had run since, and none of them
 * had necessarily touched it.
 *
 * Snapshots measure the filesystem, so they don't care *how* a file changed —
 * an Edit tool, `sed -i` inside a Bash call, a formatter on save, or a subagent
 * all land in the diff identically. Parsing tool calls would see only the first.
 *
 * The trees are written with `git write-tree` against a throwaway index, so the
 * user's index is never touched and nothing is committed, staged, or moved. No
 * refs are created either: we need the tree only long enough to diff it, and
 * loose objects are not pruned anywhere near that fast. (If per-chat diffs or
 * turn-level revert ever want the trees kept, add refs then — the recorded
 * paths don't change.)
 *
 * Each recorded path carries the blob it held in `HEAD` when the turn *started*
 * — the committed content the turn's edit was made on top of. That's what
 * expires a claim: once anyone commits the path, `HEAD` no longer holds that
 * blob and the chat stops being relevant to it, without any clock being
 * involved. Turn *start* rather than turn end, because agents routinely commit
 * their own work mid-turn — a base read afterwards would be the chat's own
 * commit and would keep the chat alive on work it had already landed.
 */

/** A path one turn changed, and the committed content it was based on. */
export type { TouchedFile } from "./events"

/**
 * Dirty files at or above this size are fingerprinted by size and mtime rather
 * than hashed. Snapshots run on every turn boundary of every chat, and a
 * project that renders video or keeps datasets untracked would otherwise have
 * each one hash, compress and write gigabytes of loose objects that nothing
 * ever prunes. Source files sit far below this.
 *
 * The fingerprint is a stat, not the content, so a `touch` or a rewrite with
 * identical bytes still counts as a change. Reading the file to rule that out
 * is the cost this exists to avoid.
 */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024

/** The worktree at one instant. */
interface Snapshot {
  /** Tree object of the worktree, dirty content included, large files left out. */
  tree: string
  /** The large dirty files `tree` leaves out: path → `size:mtime:ctime:ino`. */
  largeFiles: Map<string, string>
}

/** What `beginTurn` banks: the pre-turn worktree, and the commit it sat on. */
interface PendingTurn {
  snapshot: Snapshot | null
  /** `HEAD` at turn start; `null` on an unborn HEAD (nothing committed yet). */
  head: string | null
}

/** A project's capture now running, and the one queued to start after it. */
interface CaptureQueue {
  running?: Promise<Snapshot | null>
  next?: Promise<Snapshot | null>
}

/** Per-chat pre-turn state, plus a location cache so `git rev-parse` runs once per project. */
export class TurnFileTracker {
  private readonly pendingTurns = new Map<string, Promise<PendingTurn>>()
  private readonly locations = new Map<string, Promise<WorkingTreeLocation | null>>()
  private readonly captureQueues = new Map<string, CaptureQueue>()

  constructor(
    private readonly options: {
      /** Absolute project path for a chat, or null when it can't be resolved. */
      resolveChatPath: (chatId: string) => string | null
      /** Persist the files a turn changed. Never called with an empty list. */
      recordFiles: (chatId: string, files: TouchedFile[]) => Promise<void>
    }
  ) {}

  /**
   * Snapshot before the turn runs. Fire-and-forget: the capture races the
   * agent's first tool call, which is fine — a file the agent changes before
   * the snapshot lands simply shows up as pre-existing dirt rather than as this
   * turn's work. Blocking the turn on a `git add -A` would be the worse trade.
   * Captures run one per project (see `captureSnapshot`), so this one can also
   * wait out a capture already running for another chat, which widens that
   * window by up to one capture.
   *
   * Returns the capture promise so tests can wait for a deterministic baseline;
   * production callers ignore it.
   */
  beginTurn(chatId: string): Promise<void> {
    const localPath = this.options.resolveChatPath(chatId)
    if (!localPath) return Promise.resolve()
    const capture = this.captureTurn(localPath)
    this.pendingTurns.set(chatId, capture)
    return capture.then(() => undefined, () => undefined)
  }

  /**
   * Snapshot after the turn and record the delta. A missing pre-tree (server
   * restarted mid-turn, project isn't a repo, capture failed) records nothing
   * rather than guessing — a chat with no recorded paths is simply never
   * flagged, which is the safe direction.
   */
  async endTurn(chatId: string): Promise<void> {
    const pending = this.pendingTurns.get(chatId)
    this.pendingTurns.delete(chatId)
    if (!pending) return
    const localPath = this.options.resolveChatPath(chatId)
    if (!localPath) return

    try {
      const [pre, post] = await Promise.all([pending, this.captureSnapshot(localPath)])
      if (!pre.snapshot || !post) return
      const changes = await this.diffSnapshots(localPath, pre.snapshot, post)
      if (changes.length === 0) return
      await this.options.recordFiles(chatId, await this.toTouchedFiles(localPath, pre.head, changes))
    } catch (error) {
      // Never let file tracking break a turn's completion path.
      console.warn(`${LOG_PREFIX} turn file tracking failed for chat ${chatId}:`, error)
    }
  }

  /** Drops a chat's pending state without recording anything. */
  forget(chatId: string): void {
    this.pendingTurns.delete(chatId)
  }

  /**
   * Pairs each changed path with the blob it held at the turn's starting commit.
   *
   * An unborn HEAD gives every path a `null` base — accurate, since nothing is
   * committed there — while a failed lookup leaves the base *absent*, which
   * reads downstream as "unknown" and keeps the pre-base-blob behaviour rather
   * than inventing a base that would expire the claim early.
   */
  private async toTouchedFiles(
    localPath: string,
    head: string | null,
    changes: TurnFileChange[]
  ): Promise<TouchedFile[]> {
    const paths = changes.map((change) => change.path)
    if (head === null) return changes.map((change) => ({ ...change, baseBlob: null }))
    const location = await this.locationFor(localPath)
    const blobs = location ? await readTreeBlobs(location.repoRoot, head, paths) : null
    if (!blobs) return changes.map((change) => ({ ...change }))
    return changes.map((change) => ({ ...change, baseBlob: blobs.get(change.path) ?? null }))
  }

  /** The pre-turn worktree and the commit it sits on, captured together. */
  private async captureTurn(localPath: string): Promise<PendingTurn> {
    const [snapshot, head] = await Promise.all([
      this.captureSnapshot(localPath),
      this.readHead(localPath),
    ])
    return { snapshot, head }
  }

  /** `null` on an unborn HEAD or a project that isn't a repo. */
  private async readHead(localPath: string): Promise<string | null> {
    const location = await this.locationFor(localPath)
    if (!location) return null
    const head = await runGit(["rev-parse", "--verify", "HEAD"], location.repoRoot)
    return head.exitCode === 0 ? head.stdout.trim() || null : null
  }

  private locationFor(localPath: string): Promise<WorkingTreeLocation | null> {
    const cached = this.locations.get(localPath)
    if (cached) return cached
    const resolved = resolveWorkingTreeLocation(localPath)
    this.locations.set(localPath, resolved)
    return resolved
  }

  /**
   * One capture per project at a time. Every chat in a project snapshots the
   * same worktree, so parallel captures only compete for the disk. A request
   * joins the queued capture if there is one, since that capture has not
   * started yet and so still sees everything up to the request. It never
   * joins the running one, which may have read the tree before the request
   * was made.
   */
  private captureSnapshot(localPath: string): Promise<Snapshot | null> {
    let queue = this.captureQueues.get(localPath)
    if (!queue) {
      queue = {}
      this.captureQueues.set(localPath, queue)
    }
    if (queue.next) return queue.next
    if (!queue.running) return this.startCapture(localPath, queue)
    const ready = queue.running.then(() => undefined, () => undefined)
    const next = ready.then(() => {
      queue.next = undefined
      return this.startCapture(localPath, queue)
    })
    queue.next = next
    return next
  }

  private startCapture(localPath: string, queue: CaptureQueue): Promise<Snapshot | null> {
    const running = this.writeSnapshot(localPath).finally(() => {
      if (queue.running === running) queue.running = undefined
    })
    queue.running = running
    return running
  }

  /**
   * The whole worktree as a tree object, untracked files included and
   * `.gitignore` respected — `git add -A` decides both for us, so the snapshot
   * matches what `git status` reports as dirty. Large dirty files are left out
   * of the tree and fingerprinted instead (see `LARGE_FILE_BYTES`).
   */
  private async writeSnapshot(localPath: string): Promise<Snapshot | null> {
    const location = await this.locationFor(localPath)
    if (!location) return null

    const indexPath = path.join(location.gitDir, `kanna-snapshot-index-${randomUUID()}`)
    const env = { ...process.env, GIT_INDEX_FILE: indexPath }
    try {
      await seedIndex(location, indexPath, env)
      const largeFiles = await findLargeDirtyFiles(location.repoRoot, env)
      if (!largeFiles) return null
      // Literal so a path with `*` or `[` in it excludes only itself. Over
      // stdin so no number of large files can hit the argument limit; that
      // needs git 2.25+, and older git fails the `add`, so turns record nothing.
      const pathspecs = [".", ...[...largeFiles.keys()].map((filePath) => `:(exclude,literal)${filePath}`)]
      const added = await runGit(
        ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
        location.repoRoot,
        { env, stdin: pathspecs.join("\0") },
      )
      if (added.exitCode !== 0) return null
      const written = await runGit(["write-tree"], location.repoRoot, { env })
      if (written.exitCode !== 0) return null
      const tree = written.stdout.trim()
      return tree ? { tree, largeFiles } : null
    } finally {
      await rm(indexPath, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Tree changes plus large-file changes. A large file has no blob on either
   * side, so it carries no line counts, the same as a binary file.
   */
  private async diffSnapshots(localPath: string, before: Snapshot, after: Snapshot): Promise<TurnFileChange[]> {
    const treeChanges = before.tree === after.tree ? [] : await this.diffTrees(localPath, before.tree, after.tree)
    const largeChanged = new Set<string>()
    for (const [filePath, fingerprint] of before.largeFiles) {
      if (after.largeFiles.get(filePath) !== fingerprint) largeChanged.add(filePath)
    }
    for (const filePath of after.largeFiles.keys()) {
      if (!before.largeFiles.has(filePath)) largeChanged.add(filePath)
    }
    // A large file's tree entry is whatever the user's index holds for it, since
    // `add -A` skipped it, so staging one mid-turn changes the tree without the
    // turn touching it. Only the fingerprints speak for a path that was large on
    // either side. That also covers a file crossing the threshold, whose
    // tree-side counts would describe only half the change.
    const large = new Set([...before.largeFiles.keys(), ...after.largeFiles.keys()])
    return [
      ...treeChanges.filter((change) => !large.has(change.path)),
      ...[...largeChanged].map((filePath) => ({ path: filePath })),
    ]
  }

  /**
   * What the turn changed, and by how much.
   *
   * `--no-renames` on purpose: a rename should yield *both* names, since either
   * one can be the path that later shows up dirty. It also keeps `-z` records
   * to a single path each — a rename under `-z` splits its paths across extra
   * NUL fields.
   *
   * `-z` because the default output C-quotes any path with a space or a quote
   * in it, which would then match neither `git status` nor the file on disk.
   */
  private async diffTrees(localPath: string, fromTree: string, toTree: string): Promise<TurnFileChange[]> {
    const location = await this.locationFor(localPath)
    if (!location) return []
    const diff = await runGit(
      ["diff", "--numstat", "-z", "--no-renames", fromTree, toTree],
      location.repoRoot,
    )
    if (diff.exitCode !== 0) return []
    return parseNumstat(diff.stdout)
  }
}

/**
 * Starts the throwaway index as a copy of the real one, so `add -A` hashes only
 * what changed since the user's last `git status`. The copy brings the stat
 * cache with it. An index seeded by `read-tree HEAD` has none, so every
 * tracked file would be re-hashed on every snapshot. The copy keeps its mtime
 * because git's racy-clean check compares entries against it. With no index
 * to copy, seed from HEAD; that fails, as expected, on an unborn HEAD.
 */
async function seedIndex(location: WorkingTreeLocation, indexPath: string, env: Record<string, string | undefined>) {
  const userIndex = path.join(location.gitDir, "index")
  try {
    const { atime, mtime } = await stat(userIndex)
    await copyFile(userIndex, indexPath)
    await utimes(indexPath, atime, mtime)
  } catch {
    await rm(indexPath, { force: true }).catch(() => undefined)
    await runGit(["read-tree", "HEAD"], location.repoRoot, { env })
  }
}

/**
 * Dirty files at or above `LARGE_FILE_BYTES`, by path, each with a
 * `size:mtime:ctime:ino` fingerprint. ctime can't be set back and a replaced
 * file gets a new inode, so a same-size edit that keeps the old mtime
 * (`cp -p`, `rsync -a`) still shows.
 *
 * Dirty means untracked, or different from `HEAD`, staged or not. Measured
 * against the index instead, staging a file would take it out of the set, and
 * the turn it happened in would read that as a change. `diff-index` compares
 * stat data and never reads a file, and with `ls-files` it costs a directory
 * walk and a stat per file. On an unborn HEAD everything in the index is
 * uncommitted, so the index is the list.
 *
 * A deleted file can't be stat'ed and is left to `add -A`, which records the
 * deletion without hashing anything.
 */
async function findLargeDirtyFiles(
  repoRoot: string,
  env: Record<string, string | undefined>
): Promise<Map<string, string> | null> {
  const [untracked, againstHead] = await Promise.all([
    runGit(["ls-files", "-z", "--others", "--exclude-standard"], repoRoot, { env }),
    runGit(["diff-index", "--name-only", "-z", "--no-renames", "HEAD"], repoRoot, { env }),
  ])
  const changed = againstHead.exitCode === 0
    ? againstHead
    : await runGit(["ls-files", "-z", "--cached"], repoRoot, { env })
  if (untracked.exitCode !== 0 || changed.exitCode !== 0) return null
  const paths = [...new Set(`${untracked.stdout}\0${changed.stdout}`.split("\0").filter(Boolean))]
  const largeFiles = new Map<string, string>()
  for (let index = 0; index < paths.length; index += STAT_BATCH) {
    await Promise.all(paths.slice(index, index + STAT_BATCH).map(async (filePath) => {
      const stats = await lstat(path.join(repoRoot, filePath)).catch(() => null)
      if (stats?.isFile() && stats.size >= LARGE_FILE_BYTES) {
        largeFiles.set(filePath, `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`)
      }
    }))
  }
  return largeFiles
}

const STAT_BATCH = 256

/** One path a turn changed, with the lines it added and removed there. */
export interface TurnFileChange {
  path: string
  /** Absent for binary files, which numstat reports as `-` rather than a count. */
  additions?: number
  deletions?: number
}

/**
 * `--numstat -z` records: `<additions> TAB <deletions> TAB <path> NUL`.
 *
 * Binary files come back as `-` on both counts. Those keep the path (the chat
 * did change the file) but carry no numbers, so nothing downstream has to
 * decide what "+0" means for a PNG.
 */
export function parseNumstat(stdout: string): TurnFileChange[] {
  const changes: TurnFileChange[] = []
  for (const record of stdout.split("\0")) {
    if (!record) continue
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const filePath = record.slice(secondTab + 1)
    if (!filePath) continue
    const additions = Number.parseInt(record.slice(0, firstTab), 10)
    const deletions = Number.parseInt(record.slice(firstTab + 1, secondTab), 10)
    changes.push({
      path: filePath,
      ...(Number.isNaN(additions) ? {} : { additions }),
      ...(Number.isNaN(deletions) ? {} : { deletions }),
    })
  }
  return changes
}
