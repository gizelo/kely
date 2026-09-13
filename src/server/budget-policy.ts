export type BudgetExposure = { spentMicros: number; reservedMicros: number; uncertainMicros: number; ceilingMicros: number };

export function canReserveBudget(exposure: BudgetExposure, maximumAttemptMicros: number) {
  const amounts = [...Object.values(exposure), maximumAttemptMicros];
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0) || maximumAttemptMicros === 0) return false;
  const total = BigInt(exposure.spentMicros) + BigInt(exposure.reservedMicros) + BigInt(exposure.uncertainMicros) + BigInt(maximumAttemptMicros);
  return total <= BigInt(exposure.ceilingMicros);
}
