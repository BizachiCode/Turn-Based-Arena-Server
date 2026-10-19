import { Client, Room } from "@colyseus/sdk";
import { cli, Options } from "@colyseus/loadtest";

/**
 * Load-test scenario: every simulated client creates a guest account through the `auth` room
 * and then joins the room passed with `--room` (default `presence`) using the issued access token.
 */
export async function main(options: Options) {
    const client = new Client(options.endpoint);

    const authRoom: Room = await client.joinOrCreate("auth");
    const auth: any = await authRoom.request("auth", { type: "guest", deviceId: `loadtest-${Math.random()}` });
    await authRoom.leave();

    const room: Room = await client.joinOrCreate(options.roomName, { accessToken: auth.accessToken });
    console.log("joined successfully!", room.roomId);

    room.onLeave((code) => {
        console.log("left", code);
    });
}

cli(main);
