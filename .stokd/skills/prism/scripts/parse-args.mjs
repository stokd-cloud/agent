#!/usr/bin/env node
/**
 * Prism CLI parser — shared contract for /prism skill pack.
 * Usage: node parse-args.mjs <raw invocation without skill name>
 * Prints JSON to stdout.
 */
const raw = process.argv.slice(2).join(' ').trim()

function slugify(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

function defaultSectionNames(n) {
  const names = ['hero']
  for (let i = 1; i < n; i += 1) names.push(`stage-${i}`)
  return names
}

function parse(input) {
  if (!input) {
    return { mode: 'docs', docs: true }
  }

  const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? []
  const lucky = tokens.some((t) => /^(lucky|feeling-lucky)$/i.test(t))
  const filtered = tokens.filter((t) => !/^(lucky|feeling-lucky)$/i.test(t))

  /** @type {Record<string, string>} */
  const flags = {}
  const positionals = []
  for (let i = 0; i < filtered.length; i += 1) {
    const t = filtered[i]
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const next = filtered[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = 'true'
      }
    } else {
      positionals.push(t)
    }
  }

  let sectionNames
  let sectionCount

  if (flags.sections) {
    const s = flags.sections
    if (/^\d+$/.test(s)) {
      sectionCount = clamp(parseInt(s, 10), 2, 16)
      sectionNames = defaultSectionNames(sectionCount)
    } else {
      sectionNames = s.split(',').map((x) => x.trim()).filter(Boolean)
      if (sectionNames.length < 2) sectionNames = defaultSectionNames(7)
      sectionCount = clamp(sectionNames.length, 2, 16)
      sectionNames = sectionNames.slice(0, sectionCount)
    }
  } else if (positionals[0] && /^\d+$/.test(positionals[0])) {
    sectionCount = clamp(parseInt(positionals[0], 10), 2, 16)
    sectionNames = defaultSectionNames(sectionCount)
    positionals.shift()
  } else if (lucky) {
    sectionCount = 7
    sectionNames = defaultSectionNames(7)
  } else {
    sectionCount = 7
    sectionNames = defaultSectionNames(7)
  }

  let boards = flags.boards ? clamp(parseInt(flags.boards, 10), 1, 16) : sectionCount
  if (!Number.isFinite(boards)) boards = sectionCount

  let themes = []
  if (flags.themes) {
    themes = flags.themes.split(/[,]+/).map((x) => x.trim()).filter(Boolean)
  }
  if (positionals.length) {
    const rest = positionals.join(' ')
    themes = themes.concat(rest.split(/[,]+/).map((x) => x.trim()).filter(Boolean))
  }
  // de-dupe preserve order
  themes = [...new Set(themes)]

  const narrative = flags.narrative || ''
  const res = flags.res || null
  const board = flags.board || null
  const runDir = flags['run-dir'] || flags.runDir || null
  const incarnation = flags.incarnation ? slugify(flags.incarnation) : null

  if (!lucky && themes.length === 0 && !flags.themes && modeNeedsThemes()) {
    // still allow docs-like empty themes only if pure flags for res/board
  }

  return {
    mode: lucky ? 'lucky' : 'run',
    docs: false,
    lucky,
    sections: sectionNames.map((name, i) => ({
      index: i,
      name,
      slug: slugify(name) || `stage-${i}`,
      slot: String(i).padStart(2, '0'),
    })),
    sectionCount,
    boards,
    themes,
    theme_line: themes.join(', '),
    narrative,
    res,
    board,
    runDir,
    incarnation,
    raw: input,
  }

  function modeNeedsThemes() {
    return true
  }
}

const result = parse(raw)
if (result.mode === 'docs') {
  result.help = [
    'Usage: /prism [<N>] [<themes…>]',
    '       /prism --sections <n|name,name,…> --boards <n> --themes <…> [--narrative …]',
    '       /prism lucky | feeling-lucky',
    'Defaults: sections=7 (hero..stage-6), boards=section count',
    'See references/CLI.md and references/EXAMPLES.md',
  ]
}

process.stdout.write(JSON.stringify(result, null, 2) + '\n')
