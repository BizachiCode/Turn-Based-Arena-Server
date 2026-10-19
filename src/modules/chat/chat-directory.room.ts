import type { AuthContext } from "@colyseus/core";
import { Schema } from "@colyseus/schema";
import { BaseRoom } from "../../shared/rooms/base-room.js";
import { forwardedAddressOf } from "../../shared/rooms/client-address.js";
import { CHAT_OCCUPANCY_TOPIC } from "./chat.occupancy.js";
import type { ChatService } from "./chat.service.js";

export class ChatDirectoryState extends Schema {}

export type ChatDirectoryRoomDeps = {
  chat: ChatService;
};

/** Anonymous room listing chat channels; pushes `channels_update` when occupancy changes. */
export class ChatDirectoryRoom extends BaseRoom<ChatDirectoryState, ChatDirectoryRoomDeps> {
  state = new ChatDirectoryState();

  static async onAuth(_token: string, _options: unknown, context: AuthContext) {
    return { address: forwardedAddressOf(context) };
  }

  private readonly onOccupancy = (raw: string | Buffer) => {
    try {
      const update = JSON.parse(raw.toString());
      this.broadcast("channels_update", { ...update, serverTimeUnix: Math.floor(Date.now() / 1000) });
    } catch {
      // ignore malformed occupancy updates
    }
  };

  onCreate(): void {
    this.setMetadata({ kind: "directory" });

    this.handleRequest("list", {
      handle: () => ({ ...this.deps.chat.getDirectorySnapshot() }),
    });

    void this.presence.subscribe(CHAT_OCCUPANCY_TOPIC, this.onOccupancy);
  }

  onDispose(): void {
    void this.presence.unsubscribe(CHAT_OCCUPANCY_TOPIC, this.onOccupancy);
  }
}
