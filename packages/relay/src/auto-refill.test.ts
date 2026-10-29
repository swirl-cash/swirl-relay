import { describe, expect, it } from 'vitest';
import { selectRefillNotes } from './auto-refill.js';
import { gasRefillAmount, usdToWei } from './gas-policy.js';

const note = (amount: bigint, leafIndex: number) => ({
  amount,
  nullifier: BigInt(leafIndex + 1),
  note: { owner: 1n, token: 2n, amount, randomness: 3n, leafIndex },
});

describe('Relayer native Gas auto-refill', () => {
  it('selects at most the two largest unspent fee notes', () => {
    const selected = selectRefillNotes([note(10n, 1), note(30n, 2), note(20n, 3)]);
    expect(selected.map((item) => item.amount)).toEqual([30n, 20n]);
  });

  it('handles empty and single-note balances', () => {
    expect(selectRefillNotes([])).toEqual([]);
    expect(selectRefillNotes([note(10n, 1)]).map((item) => item.amount)).toEqual([10n]);
  });

  it('converts the USD target using the current ETH/USD price', () => {
    expect(usdToWei(10, 2500)).toBe(4_000_000_000_000_000n);
  });

  it('does nothing above the minimum and returns the shortfall below it', () => {
    const minimum = usdToWei(5, 2500);
    const target = usdToWei(10, 2500);
    expect(gasRefillAmount(minimum, minimum, target)).toBe(0n);
    expect(gasRefillAmount(target, minimum, target)).toBe(0n);
    expect(gasRefillAmount(1_000_000_000_000_000n, minimum, target)).toBe(3_000_000_000_000_000n);
  });

  it('selects the smallest single note that covers the target', () => {
    const selected = selectRefillNotes([note(10n, 1), note(30n, 2), note(20n, 3)], 15n);
    expect(selected.map((item) => item.amount)).toEqual([20n]);
  });

  it('uses at most the two largest notes when no single note is sufficient', () => {
    const selected = selectRefillNotes([note(10n, 1), note(30n, 2), note(20n, 3)], 40n);
    expect(selected.map((item) => item.amount)).toEqual([30n, 20n]);
  });
});
