// Pre-flight probe: run the Client half in Node with a stub loader + stub React,
// to prove the module registers where we think it does before the page reloads.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = readFileSync(file, 'utf8')

const ReactStub = {
  Fragment: 'Fragment',
  createElement: (...args) => ({ el: args }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

const log = []
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      log.push(['load', spec.id])
      const mod = spec.factory((name) => {
        if (name === 'react') return ReactStub
        throw new Error(`unexpected require: ${name}`)
      })
      const ctx = {
        effect: (fn) => {
          fn()
          return () => {}
        },
        get: () => undefined,
        slots: {
          inject: (key, thunk) => {
            log.push(['inject', key])
            thunk()
          },
          register: (meta, component) => {
            log.push(['register', meta.name, meta.id, meta.order, typeof component])
            return () => {}
          },
        },
      }
      mod.apply(ctx)
      log.push(['inject-declared', JSON.stringify(mod.inject)])
    },
  },
}

new Function(source)()
for (const line of log) console.log(line.map(String).join(' | '))
