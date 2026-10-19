/** Screens player-chosen public texts (nicknames, guild name / description / notice) against the chat word filter. */
export interface TextGuard {
  /** True when the text must be refused (only when the filter is enabled in block mode). */
  rejects(text: string): boolean;
}
