
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  AGENT_EVENT_STREAM_CONTENT_TYPE,
  AGENT_JSON_CONTENT_TYPE,
  AgentProtocolError,
  deserializeHttpsCommand,
  invalidRequestError,
  serializeHttpsResponse,
  serializeSseEvent,
  unsupportedError,
  type AgentApplicationService,
  type AgentId,
  isAgentId,
  type CommandFailure,
  type CommandId,
  type CommandResponse,
  type ConversationId,
} from '@stokd-cloud/agent-protocol'

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
function failedResponse(rawBody: string, error: unknown): CommandFailure {
  let commandId='cmd_unsupported' as CommandId
  try { const parsed=JSON.parse(rawBody) as Record<string,unknown>;if(isAgentId('command',parsed.commandId))commandId=parsed.commandId as CommandId } catch {}
  return {schemaVersion:'1.0',commandId,ok:false,error:error instanceof AgentProtocolError?error.envelope:invalidRequestError(error instanceof Error?error.message:String(error))}
}
export function createAgentHttpServer(service: AgentApplicationService): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://agent.invalid')
    if (request.method === 'POST' && url.pathname === '/v1/commands') {
      const rawBody=await body(request)
      try {
        const command=deserializeHttpsCommand(rawBody,request.headers['content-type'])
        const encoded=serializeHttpsResponse(await service.execute(command));response.writeHead(200,{'content-type':encoded.contentType});response.end(encoded.body)
      } catch(error) {
        const failure=failedResponse(rawBody,error);const encoded=serializeHttpsResponse(failure)
        response.writeHead(failure.error.exitCode===7?422:400,{'content-type':encoded.contentType});response.end(encoded.body)
      }
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/events') {
      const agentId=url.searchParams.get('agentId') as AgentId|null;const conversationId=url.searchParams.get('conversationId') as ConversationId|null
      if(!agentId||!conversationId){response.writeHead(400);response.end('missing event cursor');return}
      const after=url.searchParams.get('afterSequence');response.writeHead(200,{'content-type':AGENT_EVENT_STREAM_CONTENT_TYPE,'cache-control':'no-cache'})
      for await(const event of service.events({agentId,conversationId,...(after?{afterSequence:Number(after)}:{})}))response.write(serializeSseEvent(event))
      response.end();return
    }
    response.writeHead(404,{'content-type':AGENT_JSON_CONTENT_TYPE});response.end(JSON.stringify({schemaVersion:'1.0',ok:false,error:'not_found'}))
  })
}
export async function runApi(io: {readonly stderr:{write(value:string):unknown}}=process): Promise<7> {
  io.stderr.write(`${JSON.stringify({schemaVersion:'1.0',ok:false,error:unsupportedError('agent API service is not implemented')})}\n`);return 7
}
