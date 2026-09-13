import { BudgetStore, type BudgetState } from "./store";

export function summarizeBudget(state: BudgetState) {
  return { status: "verified" as const, identity: state.id, purpose: state.purpose, currency: "USD" as const, unit: "microUSD" as const,
    ceiling: state.ceilingMicros, settled: state.settledMicros, reserved: state.reservedMicros, uncertain: state.uncertainMicros - state.retainedRejectionMicros - state.retainedAbandonmentMicros, settledBounded: state.attempts.filter((attempt) => attempt.status === "settled").reduce((sum, attempt) => sum + attempt.uncertainMicros, 0), retainedRejection: state.retainedRejectionMicros, retainedAbandonment: state.retainedAbandonmentMicros, remaining: state.availableMicros,
    dispatchingAttempts: state.attempts.filter((attempt) => attempt.status === "dispatching").length,
    uncertainAttempts: state.attempts.filter((attempt) => attempt.status === "uncertain").length,
    rejectedAttempts: state.attempts.filter((attempt) => attempt.status === "rejected").length,
    abandonedAttempts: state.attempts.filter((attempt) => attempt.status === "abandoned").length,
  };
}

export function developmentBudgetStatus() {
  const budget = BudgetStore.openDevelopment();
  try { return summarizeBudget(budget.inspect()); } finally { budget.close(); }
}
