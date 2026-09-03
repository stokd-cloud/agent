import { createServer } from 'node:http'

export class FakeEcsAdmissionService {
  constructor({ clusterArn, serviceArn }) {
    this.clusterArn = clusterArn
    this.serviceArn = serviceArn
    this.endpoint = null
    this.server = null
    this.describeCount = 0
    this.driftAtCall = null
  }

  setDriftAtCall(call) { this.driftAtCall = call }

  async start() {
    this.server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const target = request.headers['x-amz-target']
      if (request.method !== 'POST' || target !== 'AmazonEC2ContainerServiceV20141113.DescribeServices') {
        response.writeHead(400, { 'content-type': 'application/x-amz-json-1.1' })
        response.end(JSON.stringify({ __type: 'InvalidParameterException', message: 'unsupported fixture operation' }))
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      this.describeCount += 1
      const desiredCount = this.driftAtCall === this.describeCount ? 1 : 0
      const serviceArn = body.services?.[0]
      response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' })
      response.end(JSON.stringify({
        failures: [],
        services: [{
          clusterArn: body.cluster,
          serviceArn,
          desiredCount,
          runningCount: 0,
        }],
      }))
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    this.endpoint = `http://127.0.0.1:${address.port}`
  }

  async stop() {
    if (!this.server) return
    await new Promise(resolve => this.server.close(resolve))
    this.server = null
  }
}
