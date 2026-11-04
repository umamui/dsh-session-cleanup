/**
 * dsh-session-cleanup — Host half.
 *
 * One dialog needs two host-side facts the page cannot compute itself: which
 * session directories are junk, and what it is safe to delete right now.
 *
 * `<DSH_HOME>\sessions\<escaped-cwd>\session-<uuid>\session.v4.jsonl.zstd` is
 * a concatenation of independent Zstandard frames ("one checksummed frame
 * holding only the header line, followed by one checksummed frame per persisted
 * append batch"). Node's buffer and stream zstd decoders both stop after the
 * FIRST frame, so decoding with them reports a single event for every session —
 * this plugin walks frame boundaries explicitly instead.
 *
 * Three categories are deletable, and each is decided from data, never guessed:
 *
 *   empty-dir       the workspace folder holds no entry at all;
 *   log-missing     no session log is left, only a `.bak-*` the move tool wrote
 *                   (the real log now lives under another workspace);
 *   no-user-message the log parses but holds zero human messages — only the
 *                   session / preset / sandbox / approval bookkeeping events.
 *
 * Anything with at least one human message is `has-conversation` and is never
 * offered. Deletion re-runs the same analysis for every path in the request, so
 * a dialog left open while a session gains its first message cannot delete it,
 * and a directory touched in the last 15 minutes is skipped as "probably live".
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Services activation waits for; everything else is resolved per request. */
export const inject = ['webServer']

export const name = 'dsh-session-cleanup'

const BASE = '/dsh-session-cleanup'
const SCAN_PATH = `${BASE}/scan`
const DELETE_PATH = `${BASE}/delete`

const LOG_NAME = 'session.v4.jsonl.zstd'
/** A directory written this recently may be a live session; never delete it. */
const RECENT_MS = 15 * 60 * 1000
const MAX_BODY_BYTES = 64 * 1024
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

const ZSTD_MAGIC = 0xfd2fb528

/** Byte ranges of every concatenated frame in `buffer`; an empty list if none. */
export function frameRanges(buffer) {
  const ranges = []
  let i = 0
  while (i + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(i)
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (i + 8 > buffer.length) break
      i += 8 + buffer.readUInt32LE(i + 4)
      continue
    }
    if (magic !== ZSTD_MAGIC) break
    const start = i
    i += 4
    const descriptor = buffer[i++]
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3
    const contentSizeFlag = descriptor >> 6
    if (!singleSegment) i += 1
    i += [0, 1, 2, 4][dictionaryFlag]
    i += contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag]
    let last = 0
    while (last === 0) {
      if (i + 3 > buffer.length) throw new Error('truncated block header')
      const blockHeader = buffer.readUInt32LE(i) & 0xffffff
      i += 3
      last = blockHeader & 1
      const blockType = (blockHeader >> 1) & 3
      const blockSize = blockHeader >> 3
      if (blockType === 0 || blockType === 2) i += blockSize
      else if (blockType === 1) i += 1
      else throw new Error('reserved block type')
    }
    if (checksum === 1) i += 4
    ranges.push([start, i])
  }
  return ranges
}

/** Decode a concatenated-frame session log into its text. */
export function decodeLog(buffer) {
  const ranges = frameRanges(buffer)
  if (ranges.length === 0) throw new Error('no zstd frame found')
  const parts = []
  for (const [from, to] of ranges) parts.push(zstdDecompressSync(buffer.subarray(from, to)))
  return Buffer.concat(parts).toString('utf8')
}

const dshHome = () => {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

const sessionsRoot = () => join(dshHome(), 'sessions')
const projectionCacheRoot = () => join(dshHome(), 'storages', 'session_projcache', 'sessions')

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** Directory entry sizes, so an empty log and a 400 KB log read differently. */
async function directoryBytes(directory, files) {
  let total = 0
  for (const file of files) {
    try {
      total += (await stat(join(directory, file))).size
    } catch {
      // A file that vanished mid-scan contributes nothing.
    }
  }
  return total
}

/**
 * Classify one workspace/session directory.
 * @param {string} root sessions root.
 * @param {string} workspaceDir one `<escaped-cwd>` entry.
 * @param {string} sessionId the `session-<uuid>` entry.
 * @returns {Promise<object>} the plan row for that session.
 */
export async function analyseSession(root, workspaceDir, sessionId) {
  const directory = join(root, workspaceDir, sessionId)
  const row = {
    id: sessionId,
    workspace: workspaceDir,
    directory,
    category: 'undecodable',
    title: '',
    createdAt: '',
    bytes: 0,
    files: 0,
    events: 0,
    userMessages: 0,
    mtime: 0,
    decodeError: '',
  }
  let entries
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) return Object.assign(row, { category: 'not-a-directory' })
    row.mtime = info.mtimeMs
    entries = await readdir(directory)
  } catch {
    return Object.assign(row, { category: 'gone' })
  }
  row.files = entries.length
  row.bytes = await directoryBytes(directory, entries)
  if (entries.length === 0) return Object.assign(row, { category: 'empty-dir' })
  if (!entries.includes(LOG_NAME)) return Object.assign(row, { category: 'log-missing' })

  let text
  try {
    text = decodeLog(await readFile(join(directory, LOG_NAME)))
  } catch (error) {
    return Object.assign(row, { category: 'undecodable', decodeError: messageOf(error) })
  }

  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    row.events += 1
    const data = event.data || {}
    if (event.type === 'user/message') {
      // `agent-instructions` and other injected prompts are not human input.
      const kind = data.source && data.source.kind
      if (kind === undefined || kind === 'user') row.userMessages += 1
    } else if (event.type === 'session') {
      const header = data.cwd === undefined ? event : data
      if (typeof header.title === 'string' && header.title !== '') row.title = header.title
      if (typeof header.createdAt === 'string') row.createdAt = header.createdAt
    } else if (event.type === 'session/title') {
      if (typeof data.title === 'string' && data.title !== '') row.title = data.title
    }
  }
  row.category = row.userMessages === 0 ? 'no-user-message' : 'has-conversation'
  return row
}

/** Every session directory under the sessions root, classified. */
export async function scanSessions() {
  const root = sessionsRoot()
  const rows = []
  let workspaces
  try {
    workspaces = await readdir(root)
  } catch (error) {
    throw new Error(`读不到会话根目录 ${root}：${messageOf(error)}`)
  }
  for (const workspaceDir of workspaces.sort()) {
    let sessionDirs
    try {
      sessionDirs = await readdir(join(root, workspaceDir))
    } catch {
      continue
    }
    for (const sessionId of sessionDirs.sort()) {
      if (!sessionId.startsWith('session-')) continue
      rows.push(await analyseSession(root, workspaceDir, sessionId))
    }
  }
  const live = new Set(rows.filter((row) => row.category !== 'gone').map((row) => row.id))
  let cacheRows = []
  try {
    cacheRows = (await readdir(projectionCacheRoot())).filter((file) => file.endsWith('.json'))
  } catch {
    cacheRows = []
  }
  const orphans = cacheRows.filter((file) => !live.has(file.slice(0, -'.json'.length)))
  return { root, rows, cacheRows, orphans }
}

const DELETABLE = new Set(['empty-dir', 'log-missing', 'no-user-message'])

/** A name from the request is only accepted if it stays inside its root. */
function insideRoot(root, name, suffix = '') {
  if (typeof name !== 'string' || name === '' || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return undefined
  }
  const candidate = join(root, name)
  const expected = join(resolve(root), name + suffix)
  return resolve(candidate) === resolve(expected) ? candidate : undefined
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return typeof value === 'object' && value !== null ? value : {}
}

function send(response, status, payload) {
  if (response.headersSent) return
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(payload))
}

async function onScan(_request, response) {
  try {
    const report = await scanSessions()
    const byCategory = {}
    for (const row of report.rows) byCategory[row.category] = (byCategory[row.category] || 0) + 1
    send(response, 200, {
      ok: true,
      root: report.root,
      rows: report.rows,
      byCategory,
      cacheRows: report.cacheRows.length,
      orphans: report.orphans,
    })
  } catch (error) {
    send(response, 500, { ok: false, error: messageOf(error) })
  }
}

/**
 * Delete the requested paths, re-verifying each one first.
 * @param {{sessions?: Array<{workspace: string, id: string}>, cache?: string[]}} body
 * @returns {Promise<object>} what was deleted, skipped, refused, and reclaimed.
 */
export async function deleteSelection(body) {
  const root = sessionsRoot()
  const wanted = Array.isArray(body.sessions) ? body.sessions : []
  const wantedCache = Array.isArray(body.cache) ? body.cache : []
  const deleted = []
  const skipped = []
  const refused = []
  let freedBytes = 0

  for (const entry of wanted) {
    const workspaceDir = entry && entry.workspace
    const sessionId = entry && entry.id
    const workspacePath = insideRoot(root, workspaceDir)
    const sessionPath = insideRoot(join(root, workspaceDir), sessionId)
    if (workspacePath === undefined || sessionPath === undefined) {
      refused.push({ id: String(sessionId), reason: '路径越界' })
      continue
    }
    let row
    try {
      row = await analyseSession(root, workspaceDir, sessionId)
    } catch (error) {
      refused.push({ id: sessionId, reason: messageOf(error) })
      continue
    }
    if (!DELETABLE.has(row.category)) {
      refused.push({ id: sessionId, category: row.category, reason: '重新校验未通过' })
      continue
    }
    if (Date.now() - row.mtime < RECENT_MS) {
      skipped.push({ id: sessionId, reason: '最近有写入，可能正在使用' })
      continue
    }
    try {
      await rm(sessionPath, { recursive: true, force: true })
      deleted.push({ id: sessionId, category: row.category })
      freedBytes += row.bytes
    } catch (error) {
      refused.push({ id: sessionId, reason: messageOf(error) })
    }
  }

  const remaining = await scanSessions().catch(() => ({ rows: [] }))
  const liveIds = new Set(remaining.rows.filter((row) => row.category !== 'gone').map((row) => row.id))
  const cacheRoot = projectionCacheRoot()
  let removedCache = 0

  // A deleted session leaves its projection cache behind; drop that row now so a
  // single dialog pass leaves no orphan to clean up on the next run.
  const cacheTargets = wantedCache.slice()
  for (const item of deleted) cacheTargets.push(`${item.id}.json`)

  for (const file of cacheTargets) {
    const target = insideRoot(cacheRoot, file)
    if (target === undefined) continue
    if (liveIds.has(file.slice(0, -'.json'.length))) continue
    try {
      // Count only rows that really exist: `rm` with `force` also succeeds on a
      // missing path, which would inflate the reported number.
      await stat(target)
      await rm(target, { force: true })
      removedCache += 1
    } catch {
      // A cache row that cannot be removed is not an error worth failing on.
    }
  }

  return { deleted, skipped, refused, removedCache, freedBytes }
}

async function onDelete(request, response) {
  try {
    const body = await readJson(request)
    send(response, 200, { ok: true, ...(await deleteSelection(body)) })
  } catch (error) {
    send(response, 400, { ok: false, error: messageOf(error) })
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: SCAN_PATH, handler: onScan }), 'dsh-session-cleanup: scan')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: DELETE_PATH, handler: onDelete }), 'dsh-session-cleanup: delete')
}

export const __internals = { decodeLog, frameRanges, analyseSession, scanSessions, sessionsRoot, projectionCacheRoot }
