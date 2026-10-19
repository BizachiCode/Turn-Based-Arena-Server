import { Schema, type } from "@colyseus/schema";

/** `map` room state. `int32` matches the Unity `MapState` schema (`[Type(0, "int32")]`). */
export class MapState extends Schema {
  @type("int32") serverTimeUnix: number = Math.floor(Date.now() / 1000);
}
