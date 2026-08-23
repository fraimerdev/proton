export const SUGGESTION_STATUSES = ['open', 'accepted', 'denied', 'implemented'] as const;

export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export function isSuggestionStatus(value: string): value is SuggestionStatus {
  return (SUGGESTION_STATUSES as readonly string[]).includes(value);
}

export const DECISIONS = ['accept', 'deny', 'implement'] as const;

export type Decision = (typeof DECISIONS)[number];

export function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

const STATUS_FOR: Record<Decision, SuggestionStatus> = {
  accept: 'accepted',
  deny: 'denied',
  implement: 'implemented',
};

export function statusFor(decision: Decision): SuggestionStatus {
  return STATUS_FOR[decision];
}

export function isDecided(status: SuggestionStatus): boolean {
  return status !== 'open';
}

export function votingOpen(status: SuggestionStatus): boolean {
  return status === 'open';
}

export type DecisionOutcome =
  | { outcome: 'decided'; from: SuggestionStatus; to: SuggestionStatus; redecided: boolean }
  | { outcome: 'unchanged'; status: SuggestionStatus };

// Every decision is reachable from every other: staff accept something and deny it a week later.
// The row keeps only the newest decider and reason, so the post shows one verdict, not a history.
export function decide(current: SuggestionStatus, decision: Decision): DecisionOutcome {
  const to = statusFor(decision);
  if (current === to) return { outcome: 'unchanged', status: current };

  return { outcome: 'decided', from: current, to, redecided: isDecided(current) };
}
