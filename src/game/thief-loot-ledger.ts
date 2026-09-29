export type GeneratedDrop = { code: string; quantity: number };

/** 只从已经生成的最终包扣出一件；无合法件时不创建物品。调用方在同一事务内发给偷窃者。 */
export const redeemThiefReservation = (generated: GeneratedDrop[], eligibleCodes: ReadonlySet<string>) => {
  const remaining = generated.map(drop => ({ ...drop }));
  const selected = remaining.find(drop => drop.quantity > 0 && eligibleCodes.has(drop.code));
  if (!selected) return { remaining, stolen: null as GeneratedDrop | null };
  selected.quantity -= 1;
  return { remaining: remaining.filter(drop => drop.quantity > 0), stolen: { code: selected.code, quantity: 1 } };
};
