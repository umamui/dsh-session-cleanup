// Locale regression: prove the footer action never renders a raw key, whether
// the locale service accepts our dictionaries or rejects the registration.
//
// Three scenarios:
//   ok      the service registers both locales and resolves them
//   taken   the (namespace, locale) pair is already occupied -> register throws
//   absent  no locale service at all -> ctx.get('locale') is undefined
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')
const source = readFileSync(FILE, 'utf8')

function makeReact() {
  return {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
}

function findButton(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findButton(child, out)
    return out
  }
  if (node.type === 'button') out.push(node)
  for (const child of node.children || []) findButton(child, out)
  return out
}

function makeLocale(mode) {
  if (mode === 'absent') return undefined
  if (mode === 'taken') {
    return {
      getLocale: () => ({ active: 'zh' }),
      register: () => {
        throw new Error('duplicate (namespace, locale)')
      },
      bind: () => (key) => key,
    }
  }
  const dicts = new Map()
  return {
    getLocale: () => ({ active: 'zh' }),
    register(ns, table) {
      dicts.set(ns, table)
      return () => {}
    },
    bind(ns) {
      return (key) => {
        const table = dicts.get(ns)
        const value = table && table.zh && table.zh[key]
        return typeof value === 'string' ? value : key
      }
    },
  }
}

function scenario(mode) {
  let component = null
  const locale = makeLocale(mode)
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        const mod = spec.factory((name) => {
          if (name === 'react') return makeReact()
          throw new Error(`unexpected require: ${name}`)
        })
        const ctx = {
          effect: (fn) => {
            fn()
            return () => {}
          },
          get: (key) => (key === 'locale' ? locale : undefined),
          slots: {
            inject: (_key, thunk) => thunk(),
            register: (_meta, registered) => {
              component = registered
              return () => {}
            },
          },
        }
        mod.apply(ctx)
      },
    },
  }
  new Function(source)()
  if (component === null) throw new Error(`${mode}: no component registered`)

  const tree = component({ wide: true })
  const [button] = findButton(tree)
  if (button === undefined) throw new Error(`${mode}: no button rendered`)

  const label = button.props['aria-label']
  const text = (button.children || []).find((child) => child && child.type === 'span')
  return { label, text: text ? text.children[0] : '', title: button.props.title }
}

const failures = []
const expectations = [
  ['ok', '清理会话'],
  ['taken', '清理会话'],
  ['absent', '清理会话'],
]

for (const [mode, expected] of expectations) {
  const result = scenario(mode)
  const ok = result.label === expected && result.text === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${mode.padEnd(7)} label=${JSON.stringify(result.label)} text=${JSON.stringify(result.text)}`)
  console.log(`      title=${JSON.stringify(result.title)}`)
  if (!ok) failures.push(`${mode}: expected ${expected}`)
  if (result.label === 'action.label' || result.text === 'action.label') failures.push(`${mode}: raw key rendered`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\nall locale scenarios render Chinese')
