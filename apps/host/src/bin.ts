#!/usr/bin/env node
import { runHost } from './index.js'
process.exitCode = await runHost(process.argv.slice(2))
