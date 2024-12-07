import { elizaLogger, generateMessageResponse, composeContext } from "@ai16z/eliza";
import {
  Content,
  Memory,
  ModelClass,
  Client,
  IAgentRuntime,
  State,
  stringToUuid,
  messageCompletionFooter
} from "@ai16z/eliza";
import { REST } from '@discordjs/rest';
import {
  Routes,
  RESTGetAPIChannelMessagesResult,
  APIMessage
} from 'discord-api-types/v10';
import { VoiceConnection } from '@discordjs/voice';

interface DiscordRoomState {
  channelId: string;
  lastMessageId?: string;
  voiceConnection?: VoiceConnection;
  pollingInterval?: NodeJS.Timeout;
}

interface MessageHandler {
  (message: APIMessage): Promise<void>;
}

class BrowserDiscordManager {
  private rest: REST;
  private agents: Map<string, IAgentRuntime>;
  private roomStates: Map<string, DiscordRoomState>;
  private messageHandlers: Set<MessageHandler>;
  private POLLING_INTERVAL = 2000;
  private currentDMChannel: string | null = null;

  constructor(runtime: IAgentRuntime) {
    elizaLogger.log("BrowserDiscordManager constructor");
    this.agents = new Map();
    this.roomStates = new Map();
    this.messageHandlers = new Set();

    // @ts-ignore
    const token = runtime?.currentCharacter?.settings?.secrets?.discord_token || runtime.token || '';
    this.rest = new REST({
      version: '10',
      headers: {
        'Authorization': `Bot ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (https://discord.js.org, 1.0.0)'
      }
    }).setToken(token);

    this.registerAgent(runtime);
    this.initializeDMChannel();
  }

  private async initializeDMChannel() {
    try {
      // Static channel for testing
      const dmChannel = { id: "202880968556544000" };
      this.currentDMChannel = dmChannel.id;
      this.startPollingDMs();
    } catch (error) {
      elizaLogger.error('Error initializing DM channel:', error);
    }
  }

  private startPollingDMs() {
    if (!this.currentDMChannel) return;

    const state: DiscordRoomState = { channelId: this.currentDMChannel };
    this.roomStates.set('dm', state);

    // @ts-ignore
    state.pollingInterval = setInterval(() => {
      this.pollMessages('dm');
    }, this.POLLING_INTERVAL);
  }

  private async registerAgent(runtime: IAgentRuntime) {
    this.agents.set(runtime.agentId, runtime);
  }

  public addMessageHandler(handler: MessageHandler) {
    this.messageHandlers.add(handler);
  }

  public removeMessageHandler(handler: MessageHandler) {
    this.messageHandlers.delete(handler);
  }

  private async handleNewMessages(channelId: string, messages: APIMessage[]) {
    for (const message of messages) {
      if (message.author.bot) continue;

      for (const handler of this.messageHandlers) {
        try {
          await handler(message);
        } catch (error) {
          elizaLogger.error('Error in message handler:', error);
        }
      }
    }
  }

  private async pollMessages(agentId: string) {
    const state = this.roomStates.get(agentId);
    if (!state?.channelId) return;

    try {
        // @ts-ignore
      const token = this.rest.token;
      const response = await fetch(`/api/discord/messages/${state.channelId}`, {
        headers: {
          'Authorization': `Bot ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const messages = await response.json();
      if (messages.length > 0) {
        state.lastMessageId = messages[0].id;
        await this.handleNewMessages(state.channelId, messages.reverse());
      }
    } catch (error) {
      elizaLogger.error('Error polling messages:', error);
    }
   }

  public async setActiveChannel(agentId: string, channelId: string) {
    const existingState = this.roomStates.get(agentId);
    if (existingState?.pollingInterval) {
      clearInterval(existingState.pollingInterval);
    }

    const state = { channelId };
    this.roomStates.set(agentId, state);

    try {
      const messages = await this.rest.get(
        Routes.channelMessages(channelId),
        // @ts-ignore
        { query: { limit: 1 } }
      ) as APIMessage[];

      if (messages.length > 0) {
        // @ts-ignore
        state.lastMessageId = messages[0].id;
      }

      // @ts-ignore
      state.pollingInterval = setInterval(() => {
        this.pollMessages(agentId);
      }, this.POLLING_INTERVAL);

    } catch (error) {
      elizaLogger.error('Error fetching channel messages:', error);
    }
  }

  public async sendMessage(agentId: string, content: Content) {
    const runtime = this.agents.get(agentId);
    const state = this.roomStates.get(agentId);
    const channelId = state?.channelId || this.currentDMChannel;

    if (!runtime || !channelId) {
      throw new Error('Agent not found or no active channel');
    }

    try {
      const response = await this.rest.post(Routes.channelMessages(channelId), {
        body: {
          content: content.text,
          ...(content.inReplyTo && {
            message_reference: { message_id: content.inReplyTo }
          })
        }
      }) as APIMessage;

      const memory: Memory = {
        id: stringToUuid(response.id),
        agentId: runtime.agentId,
        userId: runtime.agentId,
        roomId: stringToUuid(channelId),
        content: {
          text: content.text,
          source: 'discord',
          inReplyTo: content.inReplyTo
        },
        createdAt: Date.now()
      };

      await runtime.messageManager.createMemory(memory);
      if (state) state.lastMessageId = response.id;

      return memory;
    } catch (error) {
      elizaLogger.error('Error sending Discord message:', error);
      throw error;
    }
  }

  public async cleanup(agentId: string) {
    const state = this.roomStates.get(agentId);
    if (state?.pollingInterval) {
      clearInterval(state.pollingInterval);
    }
    this.roomStates.delete(agentId);
    this.agents.delete(agentId);
    this.messageHandlers.clear();
  }
}

export const BrowserDiscordClientInterface: Client = {
  start: async (runtime: IAgentRuntime) => {
    elizaLogger.log("BrowserDiscordClientInterface start");
    const manager = new BrowserDiscordManager(runtime);
    return manager;
  },
  stop: async (runtime: IAgentRuntime) => {
    elizaLogger.log("Browser Discord client stopping");
  }
};

export default BrowserDiscordClientInterface;