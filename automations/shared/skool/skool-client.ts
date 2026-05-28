import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import {
  getMembersAsUser as getMembersAsUserHttp,
  listMembersAsAdmin as listMembersAsAdminHttp,
  listRawMembersAsAdmin as listRawMembersAsAdminHttp,
} from './members-api.js';
import type { SkoolMember, RawMemberData } from './types.js';

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
    const dataDir = process.env['SKOOL_CLI_DATA_DIR'] ?? join(homedir(), '.skool-cli');
    const hasAuthState = existsSync(join(dataDir, 'auth-state.json'));
    const check = hasAuthState ? await this.inner.checkSession(group) : { success: false };
    if (!check.success) {
      const reason = hasAuthState ? 'session invalid' : 'no auth state file';
      this.log.info({ group, reason }, 'logging in');
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

  /** Fetches all members via the admin-authenticated paginated path. Pass maxPages to cap (useful for debugging). */
  async listMembersAsAdmin(options: {
    group: string;
    maxPages?: number;
    log?: pino.Logger;
  }): Promise<SkoolMember[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookies = (await (this.inner as any).api.getCookies()) as string;
    return listMembersAsAdminHttp({ ...options, cookies });
  }

  /** Same as listMembersAsAdmin but returns un-normalized payloads (needed for the full onboarding survey). */
  async listRawMembersAsAdmin(options: {
    group: string;
    maxPages?: number;
    log?: pino.Logger;
  }): Promise<RawMemberData[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookies = (await (this.inner as any).api.getCookies()) as string;
    return listRawMembersAsAdminHttp({ ...options, cookies });
  }

  /** Returns ~30 members via the non-admin path. No pagination — Skool ignores the page param on this endpoint. */
  async getMembersAsUser(options: { group: string; log?: pino.Logger }): Promise<SkoolMember[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cookies = (await (this.inner as any).api.getCookies()) as string;
    return getMembersAsUserHttp({ ...options, cookies });
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
