
export function parseArgs(argv) {
  const values = new Map()
  const flags = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const name = token.slice(2)
    if (name === 'list' || name === 'json' || name === 'bootstrap-upstream') { flags.add(name); continue }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${name}`)
    if (values.has(name)) throw new Error(`duplicate argument: --${name}`)
    values.set(name, value); i += 1
  }
  return { values, flags }
}
export function requireValue(args, name) {
  const value = args.values.get(name)
  if (!value || value.trim() === '') throw new Error(`--${name} must be non-empty`)
  return value
}
