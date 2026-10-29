import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { validateRelayPayload } from './validation.js';

const word = (value: string) => `0x${value.padStart(64, '0')}`;
const valid = {
  proof: { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] },
  root: word('1'), nullifiers: [word('2'), word('0')],
  outputCommitments: [word('3'), word('4'), word('5'), word('6')],
  ciphertexts: ['0x1234', '0x', '0x', '0x'], publicAmount: '0', publicRecipient: ethers.ZeroAddress,
};

describe('relayer payload boundary', () => {
  it('accepts a complete proof payload without wallet secrets', () => {
    expect(validateRelayPayload(valid)).toEqual(valid);
  });
  it('rejects malformed commitments, amounts and ciphertext', () => {
    expect(() => validateRelayPayload({ ...valid, root: '1' })).toThrow('32 bytes');
    expect(() => validateRelayPayload({ ...valid, publicAmount: '-1' })).toThrow('decimal');
    expect(() => validateRelayPayload({ ...valid, ciphertexts: ['0x1', '0x', '0x', '0x'] })).toThrow('hex bytes');
    expect(() => validateRelayPayload({ ...valid, nullifiers: [word('2')] })).toThrow('2 items');
  });
  it('rejects withdrawal recipient inconsistencies', () => {
    expect(() => validateRelayPayload({ ...valid, publicAmount: '10' })).toThrow('recipient mismatch');
    expect(() => validateRelayPayload({ ...valid, publicRecipient: ethers.getAddress(`0x${'11'.repeat(20)}`) })).toThrow('recipient mismatch');
  });
});
