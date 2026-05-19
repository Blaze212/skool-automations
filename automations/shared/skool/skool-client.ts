import { SkoolClient as RawSkoolClient } from 'skool-cli';
import type {
  SkoolMember as CliSkoolMember,
  SkoolPost,
  ChatChannel,
  ChatMessage,
  SkoolNotification,
  CreatePostOptions,
  OperationResult,
} from 'skool-cli';
import type pino from 'pino';
import { createLogger } from '../logger.js';
import { fetchAllMembers as fetchAllMembersHttp } from './members-api.js';
import type { SkoolMember } from './types.js';

export interface PendingMember {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  bio: string;
  photoUrl: string;
  requestedAt: string;
  questions?: { question: string; answer: string }[];
}

export type { CliSkoolMember as CliMember, SkoolPost, ChatChannel, ChatMessage, SkoolNotification };

export interface SkoolClientConfig {
  email: string;
  password: string;
}

export class SkoolClient {
  private inner: RawSkoolClient;
  private log = createLogger('skool-client');

  constructor(_config: SkoolClientConfig) {
    this.inner = new RawSkoolClient();
    this._config = _config;
  }

  private _config: SkoolClientConfig;

  async ensureSession(group: string): Promise<void> {
    const check = await this.inner.checkSession(group);
    if (!check.success) {
      this.log.info({ group }, 'session invalid — logging in');
      const result = await this.inner.login(this._config.email, this._config.password);
      if (!result.success) throw new Error(`Skool login failed: ${result.message}`);
      this.log.info({ group }, 'login successful');
    }
  }

  async getMembers(group: string, search?: string): Promise<CliSkoolMember[]> {
    const result = await this.inner.getMembers(group, search);
    return result.members;
  }

  async getPendingMembers(group: string): Promise<PendingMember[]> {
    const result = await this.inner.getPendingMembers(group);
    return result.pending ?? [];
  }

  async getPosts(group: string): Promise<SkoolPost[]> {
    const result = await this.inner.getPosts(group);
    return result.posts;
  }

  async createPost(options: CreatePostOptions): Promise<OperationResult> {
    return this.inner.createPost(options);
  }

  async getChats(): Promise<ChatChannel[]> {
    const result = await this.inner.getChats();
    return result.channels ?? [];
  }

  async getChatMessages(channelId: string): Promise<ChatMessage[]> {
    const result = await this.inner.getChatMessages(channelId);
    return result.messages;
  }

  async sendChatMessage(channelId: string, message: string): Promise<OperationResult> {
    return this.inner.sendChatMessage(channelId, message);
  }

  async getNotifications(): Promise<SkoolNotification[]> {
    const result = await this.inner.getNotifications();
    return result.notifications;
  }

  async markNotificationsRead(): Promise<OperationResult> {
    return this.inner.markNotificationsRead();
  }

  async fetchAllMembers(options: {
    group: string;
    maxPages?: number;
    log?: pino.Logger;
  }): Promise<SkoolMember[]> {
    // Use getCookies() — same as skool-cli's internal request() method
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookies = (await (this.inner as any).api.getCookies()) as string;
    return fetchAllMembersHttp({ ...options, cookies });
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
