import type { PluginBeforeRequests } from "@getpaseo/plugin/server";

type Request = PluginBeforeRequests["agent.session_open"];
type Server = Request["mcpServers"][string];

export async function sessionMcp(request: Request, resolve: (agentId: string, key: string, provider: string) => Promise<Server | undefined>): Promise<Request | undefined> {
  const key = request.labels["itsaplan.key"];
  if (request.purpose !== "interactive" || request.labels["itsaplan.mcp-launch"] !== "1" || !key) return;
  const server = await resolve(request.agentId, key, request.provider);
  if (!server) return;
  return { ...request, mcpServers: { ...request.mcpServers, itsaplan: server } };
}
