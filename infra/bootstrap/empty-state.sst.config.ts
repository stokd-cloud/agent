/// <reference path="./.sst/platform/config.d.ts" />

const apps = ['stokd-agent-data', 'stokd-agent-api'] as const
const stages = ['source-val12', 'restore-val12'] as const

export default $config({
  app(input) {
    const name = process.env.AGENT_EMPTY_SST_APP
    if (!apps.includes(name as typeof apps[number])) throw new Error('AGENT_EMPTY_SST_APP must name one reviewed Work 1.2 SST app')
    if (!stages.includes(input.stage as typeof stages[number])) throw new Error('empty SST state initializer received an unsupported stage')
    return {
      name,
      home: 'aws',
      version: '3.19.3',
      removal: 'retain',
      protect: true,
      providers: { aws: { region: 'us-east-1' } },
    }
  },
  async run() {
    // This administrator-only configuration exists solely to let pinned SST
    // create its empty Pulumi checkpoint. It must never register resources.
    return {}
  },
})
