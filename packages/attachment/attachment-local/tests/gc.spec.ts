import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { NormalizationPolicy } from '../src/normalization.ts'
import { saveFileVerbatim } from '../src/file-store.ts'
import { deleteUnreferenced } from '../src/gc.ts'
import { saveImageFile } from '../src/store.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-attachment-gc-'))
  roots.push(value)
  return join(value, 'attachments', 'v1')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
  'base64',
))

const OTHER_PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
))

const POLICY: NormalizationPolicy = { maxPixels: 2048 * 2048, maxDimension: 8192, maxBytes: 1024 * 1024 }

const LIMITS = {
  maxImageBytes: 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 2048,
  maxImagePixels: 16,
  maxImageDimension: 2000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
} as const

const imageInput = (data: Uint8Array): SaveImageAttachment => ({ data, mediaType: 'image/png' })

describe('deleteUnreferenced', () => {
  it('removes image objects absent from keep and retains the kept ones', async () => {
    const storageRoot = await root()
    const kept = await saveImageFile(storageRoot, imageInput(PNG), LIMITS, POLICY)
    const garbage = await saveImageFile(storageRoot, imageInput(OTHER_PNG), LIMITS, POLICY)
    const sha256 = (ref: { attachmentId: string }): string => String(ref.attachmentId).slice('sha256:'.length)

    const removed = await deleteUnreferenced(storageRoot, new Set([kept.attachmentId]))

    expect(removed).toBeGreaterThanOrEqual(1)
    expect(await readdir(join(storageRoot, 'objects', sha256(kept).slice(0, 2)))).toContain(sha256(kept))
    const garbageEntries = await readdir(join(storageRoot, 'objects', sha256(garbage).slice(0, 2))).catch(() => [])
    expect(garbageEntries).not.toContain(sha256(garbage))
  })

  it('removes verbatim file objects and their display-name aliases, retaining kept files', async () => {
    const storageRoot = await root()
    const keptBytes = Buffer.from('kept file bytes')
    const garbageBytes = Buffer.from('garbage file bytes')
    const kept = await saveFileVerbatim(storageRoot, { data: keptBytes, name: 'kept.txt' })
    const garbage = await saveFileVerbatim(storageRoot, { data: garbageBytes, name: 'garbage.txt' })
    const sha256 = (ref: FileAttachmentRef): string => String(ref.attachmentId).slice('sha256:'.length)

    const removed = await deleteUnreferenced(storageRoot, new Set([kept.attachmentId]))

    expect(removed).toBeGreaterThanOrEqual(2)
    expect(await readdir(join(storageRoot, 'file-objects', sha256(kept).slice(0, 2)))).toContain(sha256(kept))
    // Garbage shards pruned or their digest entries removed.
    const garbageFOShard = join(storageRoot, 'file-objects', sha256(garbage).slice(0, 2))
    const garbageFSEntries = join(storageRoot, 'files', sha256(garbage).slice(0, 2))
    expect(await readdir(garbageFOShard).catch(() => [])).not.toContain(sha256(garbage))
    expect(await readdir(garbageFSEntries).catch(() => [])).not.toContain(sha256(garbage))
  })

  it('leaves non-digest entries under a shard untouched', async () => {
    const storageRoot = await root()
    await mkdir(join(storageRoot, 'objects', 'ab'), { recursive: true })
    await writeFile(join(storageRoot, 'objects', 'ab', 'not-a-digest'), 'stray')

    await deleteUnreferenced(storageRoot, new Set())

    const shard = await readdir(join(storageRoot, 'objects', 'ab'))
    expect(shard).toContain('not-a-digest')
  })

  it('is idempotent over an empty store and an unknown root', async () => {
    const storageRoot = await root()
    expect(await deleteUnreferenced(storageRoot, new Set())).toBe(0)
    expect(await deleteUnreferenced(join(storageRoot, 'absent'), new Set())).toBe(0)
  })

  it('collects regenerable request-images directory entries if present', async () => {
    const storageRoot = await root()
    const variantHash = createHash('sha256').update('variant').digest('hex')
    const riDir = join(storageRoot, 'request-images', variantHash.slice(0, 2))
    await mkdir(riDir, { recursive: true })
    await writeFile(join(riDir, variantHash), 'cache')

    const removed = await deleteUnreferenced(storageRoot, new Set())

    expect(removed).toBe(1)
    // The request-images directory is empty or gone after GC.
    const riEntries = await readdir(join(storageRoot, 'request-images')).catch(() => [])
    expect(riEntries).toEqual([])
  })

  it('keeps objects referenced in keep and removes unreferenced ones', async () => {
    const storageRoot = await root()
    const kept = await saveImageFile(storageRoot, imageInput(PNG), LIMITS, POLICY)
    const garbage = await saveImageFile(storageRoot, imageInput(OTHER_PNG), LIMITS, POLICY)
    const sha256 = (ref: { attachmentId: string }): string => String(ref.attachmentId).slice('sha256:'.length)

    const removed = await deleteUnreferenced(storageRoot, new Set([kept.attachmentId]))

    expect(removed).toBeGreaterThanOrEqual(1)
    expect(await readdir(join(storageRoot, 'objects', sha256(kept).slice(0, 2)))).toContain(sha256(kept))
    // Garbage shard pruned or its digest entry removed.
    const garbageShard = join(storageRoot, 'objects', sha256(garbage).slice(0, 2))
    const garbageEntries = await readdir(garbageShard).catch(() => [])
    expect(garbageEntries).not.toContain(sha256(garbage))
  })
})
