#!/usr/bin/env node
import { runApi } from './index.js'
process.exitCode = await runApi()
