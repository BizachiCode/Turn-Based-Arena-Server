// GM panel "Chat", "Mail history" and "Audit log". Deleting a chat line or revoking a broadcast is audited on the
// admin trail; muting a sender is the existing `AdminPlayersService.mute`.

import type { AuditLog } from "../../shared/kernel/audit.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type {
  AdminAuditQuery,
  AdminAuditRow,
  AdminChatMessage,
  AdminChatQuery,
  AdminChatScope,
  AdminDirectMail,
  AdminMailBroadcast,
  AdminModerationRepository,
} from "./admin-moderation.ports.js";
import type { AdminUserDirectory } from "./admin.ports.js";
import { AdminPlayerError } from "./admin-players.service.js";

/** The chat word filter as the GM panel sees it (`ChatTextFilter`). */
export interface ChatFilterAdmin {
  describe(): { enabled: boolean; mode: "mask" | "block"; wholeWordOnly: boolean; maskChar: string; words: number; allowList: number };
  snapshot(limit?: number): { sinceUnix: number; masked: number; blocked: number; players: Array<{ userId: string; masked: number; blocked: number; lastAtUnix: number }> };
  preview(text: string): { enabled: boolean; mode: "mask" | "block"; matched: boolean; blocked: boolean; input: string; output: string };
}

export type AdminModerationDeps = {
  repo: AdminModerationRepository;
  audit: AuditLog;
  clock: Clock;
  /** Word filter and the account directory used to name the players in its stats. */
  chatFilter?: ChatFilterAdmin;
  users?: AdminUserDirectory;
};

export class AdminModerationService {
  constructor(private readonly deps: AdminModerationDeps) {}

  /** Filter settings (counts only, never the word list) and the per-player counters since boot. */
  async chatFilter() {
    const filter = this.deps.chatFilter;
    if (!filter) throw new AdminPlayerError("The chat filter is not available.");
    const stats = filter.snapshot(25);
    const players = await Promise.all(stats.players.map(async (entry) => ({
      ...entry,
      username: (await this.deps.users?.resolve(entry.userId).catch((): null => null))?.username ?? null,
    })));
    return { filter: filter.describe(), stats: { ...stats, players } };
  }

  /** What the chat would do with `text` right now (not counted in the stats). */
  chatFilterTest(text: string) {
    const filter = this.deps.chatFilter;
    if (!filter) throw new AdminPlayerError("The chat filter is not available.");
    return { result: filter.preview(text) };
  }

  /** Newest first; `before` pages back. Global channels and guild chat history as stored. */
  async chat(query: Partial<AdminChatQuery> & { scope: AdminChatScope }): Promise<{ messages: AdminChatMessage[] }> {
    const messages = await this.deps.repo.chatMessages({
      scope: query.scope,
      channel: query.channel ?? null,
      guildId: query.guildId ?? null,
      userId: query.userId ?? null,
      limit: query.limit ?? 50,
      before: query.before ?? null,
    });
    return { messages };
  }

  chatChannels() {
    return this.deps.repo.chatChannels();
  }

  /** Removes the line from the stored history (clients that already received it keep it until they reconnect). */
  async deleteChatMessage(scope: AdminChatScope, id: number, reason?: string): Promise<{ message: AdminChatMessage }> {
    const message = await this.deps.repo.deleteChatMessage(scope, id);
    if (!message) throw new AdminPlayerError("Message not found.");
    await this.deps.audit.record({
      userId: message.userId,
      kind: "GM_CHAT_DELETE",
      meta: { scope, id, channel: message.channel, guildId: message.guildId, text: message.message.slice(0, 120), reason: clean(reason) },
    });
    return { message };
  }

  async mailHistory(limit = 50, before: number | null = null): Promise<{ broadcasts: AdminMailBroadcast[]; direct: AdminDirectMail[] }> {
    const [broadcasts, direct] = await Promise.all([
      this.deps.repo.broadcasts(limit, this.deps.clock.now()),
      this.deps.repo.directMails(limit, before),
    ]);
    return { broadcasts, direct };
  }

  /** Inboxes that already hold the mail keep it; the others never receive it. */
  async revokeBroadcast(id: string, reason?: string): Promise<{ id: string; title: string }> {
    const revoked = await this.deps.repo.revokeBroadcast(id);
    if (!revoked) throw new AdminPlayerError("Broadcast not found.");
    await this.deps.audit.record({ userId: null, kind: "GM_MAIL_REVOKE", meta: { broadcastId: id, title: revoked.title, reason: clean(reason) } });
    return { id, title: revoked.title };
  }

  async auditLog(query: Partial<AdminAuditQuery>): Promise<{ entries: AdminAuditRow[] }> {
    const entries = await this.deps.repo.auditLog({
      kind: query.kind || null,
      userId: query.userId || null,
      from: query.from ?? null,
      to: query.to ?? null,
      before: query.before ?? null,
      limit: query.limit ?? 50,
    });
    return { entries };
  }

  async auditKinds(): Promise<string[]> {
    return this.deps.repo.auditKinds();
  }
}

function clean(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().slice(0, 255) : "";
  return text.length > 0 ? text : null;
}
