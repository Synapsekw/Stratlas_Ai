import type { Heads, Member, Op, Receipt, TeamProject } from '@aio/schema';

/**
 * Where the server keeps a team's data. Append-only for ops and receipts: there is no update or
 * delete (Postgres enforces it with grants and a trigger; the memory adapter by having no such
 * method). The server validates and stores; it never merges.
 */
export interface Store {
  /** Team projects this server holds. */
  projects(): Promise<TeamProject[]>;
  project(teamProjectId: string): Promise<TeamProject | null>;
  createProject(project: TeamProject): Promise<void>;
  members(teamProjectId: string): Promise<Member[]>;
  heads(teamProjectId: string): Promise<Heads>;
  /** Store ops not seen before (by id); returns the ids stored and the ids already there. */
  appendOps(
    teamProjectId: string,
    ops: readonly Op[],
  ): Promise<{ stored: string[]; duplicates: string[] }>;
  /** Ops after `since` per chain, in chain and seq order, at most `limit`. */
  opsSince(
    teamProjectId: string,
    since: Heads,
    limit: number,
  ): Promise<{ ops: Op[]; more: boolean }>;
  appendReceipts(receipts: readonly Receipt[]): Promise<void>;
  lastReceipt(): Promise<Receipt | null>;
}
