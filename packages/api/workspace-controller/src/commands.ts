/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceTrashUnknownSessionError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { toTrashEntry, workspaceView } from './feed.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceEmptyTrashValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceRestoreSessionRequest,
  WorkspaceTrashSessionRequest,
  WorkspaceTrashValue,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      try {
        const existing = await this.ctx.workspaceRegistry.resolveByPath(request.path)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(request.sessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceUnknownSessionError)) throw error
      throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Move one Session to the recycle bin, detaching it from its Workspace.
   * @param request - Session identity to trash.
   * @returns the complete resulting trash set.
   */
  async trashSession(request: WorkspaceTrashSessionRequest): Promise<WorkspaceTrashValue> {
    try {
      await this.ctx.workspaceRegistry.trashSession(request.sessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceTrashUnknownSessionError)) throw error
      throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
    }
    return { trashedSessions: this.ctx.workspaceRegistry.trashedSessions.map(toTrashEntry) }
  }

  /**
   * Restore one Session from the recycle bin to its originating Workspace.
   * @param request - Session identity to restore.
   * @returns the complete resulting trash set.
   */
  async restoreSession(request: WorkspaceRestoreSessionRequest): Promise<WorkspaceTrashValue> {
    await this.ctx.workspaceRegistry.restoreSession(request.sessionId)
    return { trashedSessions: this.ctx.workspaceRegistry.trashedSessions.map(toTrashEntry) }
  }

  /**
   * Permanently delete every trashed Session: logs, caches, and spills.
   * After deletion, performs attachment garbage collection for remaining sessions.
   * @returns the number of sessions permanently deleted.
   */
  async emptyTrash(): Promise<WorkspaceEmptyTrashValue> {
    // Collect remaining session IDs before deletion (trashed sessions are not in workspaces).
    const remainingSessionIds = collectRemainingSessionIds(this.ctx.workspaceRegistry)
    const deleted = await this.ctx.workspaceRegistry.emptyTrash()
    // Perform attachment GC if the attachment service is available.
    if (deleted > 0) {
      const attachments = this.ctx.get('attachments')
      if (attachments !== undefined) {
        const keep = await collectAttachmentRefs(this.ctx, remainingSessionIds)
        await attachments.deleteUnreferenced(keep)
      }
    }
    return { deleted }
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Collect all session IDs from all workspaces (remaining after trash deletion). */
function collectRemainingSessionIds(registry: { list(): Workspace[] }): Set<SessionId> {
  const ids = new Set<SessionId>()
  for (const workspace of registry.list()) {
    for (const id of workspace.sessionIds) {
      ids.add(id)
    }
  }
  return ids
}

/** Scan session logs for attachment references and return the union of all referenced IDs. */
async function collectAttachmentRefs(
  ctx: Context,
  sessionIds: ReadonlySet<SessionId>,
): Promise<ReadonlySet<AttachmentId>> {
  const keep = new Set<AttachmentId>()
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return keep
  for (const id of sessionIds) {
    let handle
    try {
      handle = await persistence.open(id, 'read')
    } catch {
      continue
    }
    try {
      const { events } = await handle.read(0)
      for (const event of events) {
        scanEventForAttachmentRefs(event, keep)
      }
    } catch {
      // Skip unreadable sessions.
    } finally {
      await handle[Symbol.asyncDispose]()
    }
  }
  return keep
}

/** Scan a single session event for attachment ID references. */
function scanEventForAttachmentRefs(event: unknown, keep: Set<AttachmentId>): void {
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return
  const carrier = data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    stream?: Array<{ type?: unknown; chunk?: { type?: unknown; block?: unknown } }>
  }
  scanContentForAttachmentRefs(carrier.content, keep)
  if (carrier.message !== undefined) scanContentForAttachmentRefs(carrier.message.content, keep)
  if (carrier.inserted !== undefined) {
    for (const message of carrier.inserted) scanContentForAttachmentRefs(message.content, keep)
  }
  if (carrier.stream !== undefined) {
    for (const record of carrier.stream) {
      if (record.type === 'chunk' && record.chunk?.type === 'block-end') {
        scanContentForAttachmentRefs([record.chunk.block], keep)
      }
    }
  }
}

/** Recursively scan content blocks for attachment references. */
function scanContentForAttachmentRefs(content: unknown, keep: Set<AttachmentId>): void {
  if (!Array.isArray(content)) return
  const pending: unknown[] = []
  for (const item of content) pending.push(item)
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as { attachmentId?: unknown }
      if (typeof ref.attachmentId === 'string') keep.add(ref.attachmentId as AttachmentId)
    }
    if (block.type === 'file' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as { attachmentId?: unknown }
      if (typeof ref.attachmentId === 'string') keep.add(ref.attachmentId as AttachmentId)
    }
    if (Array.isArray(block.content)) {
      for (const item of block.content) pending.push(item)
    }
  }
}
