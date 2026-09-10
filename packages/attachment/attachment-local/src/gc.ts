/**
 * Content-addressed garbage collection for the local attachment backend:
 * enumerate the provider-owned object trees and remove every entry whose id
 * is absent from a caller-declared keep set. Objects are shared across
 * sessions, so the keep set is the union of ids referenced by the session
 * logs that must remain readable; this module only decides what is stored.
 * @module @deepseek-ai/dsh-attachment-local/gc
 */

import { chmod, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { AttachmentId as AttachmentIdType } from '@deepseek-ai/dsh-attachment'

const ID_PREFIX = 'sha256:'

/**
 * Remove one stored entry regardless of its read-only mode. The publication
 * path stamps objects 0o400, which Windows treats as a delete-protection
 * attribute; clearing it before the unlink is the only portable removal.
 * @param path - the entry to remove (file or directory).
 */
async function removeEntry(path: string): Promise<void> {
  await chmod(path, 0o600).catch(() => {})
  await rm(path, { recursive: true, force: true })
}

/**
 * Remove every digest-named entry under one two-hex shard whose content-
 * addressed id is absent from `keep`, then prune the emptied shard.
 * @param shardPath - absolute two-hex shard directory.
 * @param keep - content-addressed ids that must survive.
 * @param signal - optional cancellation.
 * @returns the number of entries removed from this shard.
 */
async function collectShard(
  shardPath: string,
  keep: ReadonlySet<AttachmentIdType>,
  signal: AbortSignal | undefined,
): Promise<number> {
  signal?.throwIfAborted()
  let entries: string[]
  try {
    entries = await readdir(shardPath)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 0
    throw error
  }
  let removed = 0
  for (const name of entries) {
    // Only digest-named entries are content-addressed objects (or, under
    // `files/`, the digest-named directory holding its display-name aliases).
    // Non-digest leaves are not provider-owned and are never collected.
    if (!/^[0-9a-f]{64}$/.test(name)) continue
    signal?.throwIfAborted()
    if (keep.has(AttachmentId(`${ID_PREFIX}${name}`))) continue
    await removeEntry(join(shardPath, name))
    removed += 1
  }
  try {
    if ((await readdir(shardPath)).length === 0) await rm(shardPath, { recursive: true, force: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
  }
  return removed
}

/**
 * Remove every stored object (normalized image, verbatim file object, file
 * display-name alias, and derived request-image cache) whose content-
 * addressed id is absent from `keep`. The request-image cache is regenerable
 * derived data, so it is collected wholesale: any surviving id recomputes its
 * request version on the next model request.
 * @param root - absolute `DSH_HOME/attachments/v1` root.
 * @param keep - content-addressed ids that must survive.
 * @param signal - optional cancellation.
 * @returns the total number of stored entries removed.
 */
export async function deleteUnreferenced(
  root: string,
  keep: ReadonlySet<AttachmentIdType>,
  signal?: AbortSignal,
): Promise<number> {
  let removed = 0
  for (const sub of ['objects', 'file-objects', 'files', 'request-images']) {
    let shards: string[]
    try {
      shards = (await readdir(join(root, sub))).filter(name => /^[0-9a-f]{2}$/.test(name))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue
      throw error
    }
    for (const shard of shards) {
      removed += await collectShard(join(root, sub, shard), keep, signal)
    }
  }
  return removed
}
