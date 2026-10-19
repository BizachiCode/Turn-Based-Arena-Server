export type AdminUserRef = {
  userId: string;
  username: string;
  email: string | null;
  /** In-game nickname (profile name); null before the profile exists. */
  name?: string | null;
};

/** Read access to accounts for GM tools. */
export interface AdminUserDirectory {
  /** Exact match on id, username, email or nickname. */
  resolve(selector: string): Promise<AdminUserRef | null>;
  /** Fuzzy search (id/username/email/nickname contains), best matches first. */
  search(query: string, limit: number): Promise<AdminUserRef[]>;
}
