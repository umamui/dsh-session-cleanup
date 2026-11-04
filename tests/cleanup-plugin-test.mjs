// Behaviour test for dsh-session-cleanup's Host half, run against a throwaway
// DSH_HOME so no real session is touched.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'dsh-cleanup-test-'))
process.env.DSH_HOME = home

const module_ = await import('file:///E:/deepseekwork/workspace/daily conversation/plugins/dsh-session-cleanup/index.js')

const frame = (value) => zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))
const log = (...values) => Buffer.concat(values.map(frame))

const ws = join(home, 'sessions', '--E-ws-a--')
const cache = join(home, 'storages', 'session_projcache', 'sessions')
mkdirSync(ws, { recursive: true })
mkdirSync(cache, { recursive: true })

const mk = (id, files) => {
  const dir = join(ws, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

mk('session-00000000-0000-4000-8000-00000000000a', {})
mk('session-00000000-0000-4000-8000-00000000000b', { 'session.v4.jsonl.zstd.bak-1': 'x'.repeat(500) })
mk('session-00000000-0000-4000-8000-00000000000c', {
  'session.v4.jsonl.zstd': log(
    { type: 'session', cwd: 'E:\\ws', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'permission-preset', data: { preset: 'balanced' } },
    { type: 'session/title', data: { title: '只有元事件' } },
  ),
})
mk('session-00000000-0000-4000-8000-00000000000d', {
  'session.v4.jsonl.zstd': log(
    { type: 'session', cwd: 'E:\\ws', createdAt: '2026-01-01T00:00:00.000Z' },
    { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { content: [{ type: 'text', text: 'hi' }] } },
  ),
})
const recent = mk('session-00000000-0000-4000-8000-00000000000e', {})
const now = new Date()
utimesSync(recent, now, now)

// The other five are backdated so the 15-minute "probably live" guard lets them through.
const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
for (const suffix of ['a', 'b', 'c', 'd']) {
  utimesSync(join(ws, `session-00000000-0000-4000-8000-00000000000${suffix}`), old, old)
}

for (const id of ['00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-00000000000d', '99999999-0000-4000-8000-00000000000f']) {
  writeFileSync(join(cache, `session-${id}.json`), '{}')
}

const scan = await module_.scanSessions()
console.log('categories:', JSON.stringify(
  Object.fromEntries(scan.rows.map((row) => [row.id.slice(-2), `${row.category}/${row.userMessages}msg`])),
))
console.log('orphans:', JSON.stringify(scan.orphans))

const result = await module_.deleteSelection({
  sessions: scan.rows.map((row) => ({ workspace: row.workspace, id: row.id })),
  cache: scan.orphans,
})
console.log('deleted:', result.deleted.map((item) => item.id.slice(-2)).join(','))
console.log('skipped:', JSON.stringify(result.skipped.map((item) => `${item.id.slice(-2)}:${item.reason}`)))
console.log('refused:', JSON.stringify(result.refused.map((item) => `${item.id.slice(-2)}:${item.reason}`)))
console.log('removedCache:', result.removedCache, 'freedBytes:', result.freedBytes)
console.log('dirs left:', readdirSync(ws).map((name) => name.slice(-2)).join(','))
console.log('cache left:', readdirSync(cache).length)

const traversal = await module_.deleteSelection({ sessions: [{ workspace: '..', id: 'session-x' }], cache: ['../../evil.json'] })
console.log('traversal refused:', JSON.stringify(traversal.refused), 'removedCache:', traversal.removedCache)

rmSync(home, { recursive: true, force: true })
