import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginRpcContract } from "@getpaseo/plugin";
import type { z } from "zod";

const BotContext = createContext<string | null>(null);

export function BotScope({ botId, children }: { botId: string; children: ReactNode }) {
  return <BotContext.Provider value={botId}>{children}</BotContext.Provider>;
}

export function useBotId(): string {
  const botId = useContext(BotContext);
  if (!botId) throw new Error("Select a bot before calling the integration.");
  return botId;
}

export function useBotRpc<Input extends z.ZodType, Output extends z.ZodType>(contract: PluginRpcContract<Input, Output>) {
  const invoke = useRpc(contract);
  const botId = useBotId();
  return useCallback((input: z.input<Input>): Promise<z.output<Output>> => invoke(Object.assign({}, input, { botId })), [invoke, botId]);
}
