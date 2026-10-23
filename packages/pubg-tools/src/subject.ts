import type { PubgDomainService, ToolEnvelope } from '@rine-kit/pubg-domain';
import { subjectError } from './envelopes.js';

/** The accounts a question is about, as concrete ids the Domain understands. */
export interface PubgSubjectAccounts {
  playerIds: string[];
  playerNames?: string[];
}

/** What the model may say about who a question concerns (see schemas.subjectShape). */
export interface PubgSubjectInput {
  playerIds?: string[];
  playerNames?: string[];
  personIds?: string[];
  team?: boolean;
}

/** The part of "who is asking" that only the host can know. Never derived from the model's words. */
export interface PubgSubjectHost {
  /** The asker's own accounts when the model named nobody; an error envelope when they have none. */
  self(): Promise<PubgSubjectAccounts | ToolEnvelope>;
  /** Accounts of persons the host knows by id (its identity store); omit when the host has none. */
  persons?(personIds: string[]): Promise<PubgSubjectAccounts | ToolEnvelope>;
}

const isAccounts = (value: PubgSubjectAccounts | ToolEnvelope): value is PubgSubjectAccounts =>
  'playerIds' in value;

function without<T extends PubgSubjectInput>(input: T): Omit<T, 'personIds' | 'team'> {
  const rest: Partial<T> = { ...input };
  delete rest.personIds;
  delete rest.team;
  return rest as Omit<T, 'personIds' | 'team'>;
}

/** Drops the identity fields of a tool that is not about people. */
export const stripSubject = without;

/**
 * Lab's subject policy, unchanged: `team` is an explicit request for the configured team and cannot be mixed with
 * anything else; explicit players are used as given; otherwise the host decides (persons it knows, or the
 * asker). Nothing falls back to the team implicitly.
 */
export async function resolveSubject<T extends PubgSubjectInput>(
  service: PubgDomainService,
  host: PubgSubjectHost,
  input: T,
): Promise<Omit<T, 'personIds' | 'team'> | ToolEnvelope> {
  const explicitPlayers = (input.playerIds?.length ?? 0) + (input.playerNames?.length ?? 0);
  const explicitPersons = input.personIds?.length ?? 0;
  if (input.team === true) {
    if (explicitPlayers || explicitPersons)
      return subjectError(
        'identity_subject_conflict',
        'team cannot be combined with another subject',
      );
    return { ...without(input), playerIds: service.team.players.map((player) => player.id) };
  }
  if (explicitPlayers) {
    if (explicitPersons)
      return subjectError(
        'identity_subject_conflict',
        'personIds cannot be combined with playerIds or playerNames',
      );
    return without(input);
  }
  const accounts =
    explicitPersons && host.persons ? await host.persons(input.personIds!) : await host.self();
  if (!isAccounts(accounts)) return accounts;
  return {
    ...without(input),
    playerIds: accounts.playerIds,
    ...(accounts.playerNames?.length ? { playerNames: accounts.playerNames } : {}),
  };
}
