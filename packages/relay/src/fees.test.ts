import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createNoteForAddress, createSwirlWallet, encryptNote, noteCommitment } from '@swirl/wallet';
import { feeConfigFromMnemonic, issueRelayQuote, verifyRelayFeeOutput } from './fees.js';
import type { RelayPayload } from './validation.js';

const TOKEN = `0x${'11'.repeat(20)}`;
const VAULT = `0x${'22'.repeat(20)}`;
const MNEMONIC = 'test test test test test test test test test test test junk';
const word = (value: bigint) => ethers.toBeHex(value, 32);

async function fixture() {
  const fee = await feeConfigFromMnemonic(MNEMONIC, 31337, '250000', 300_000);
  const quote = issueRelayQuote(fee, 31337n, VAULT, TOKEN);
  const note = await createNoteForAddress({ address: fee.address, token: BigInt(TOKEN), amount: 250000n, chainId: 31337 });
  const payload = {
    proof: { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] },
    root: word(1n), nullifiers: [word(2n), word(0n)],
    outputCommitments: [word(await noteCommitment(note)), word(0n), word(0n), word(0n)],
    ciphertexts: [ethers.hexlify(encryptNote(note, fee.address)), '0x', '0x', '0x'],
    publicAmount: '0', publicRecipient: ethers.ZeroAddress, quoteId: quote.id,
  } as RelayPayload;
  return { fee, quote, note, payload };
}

describe('Relayer private fee output', () => {
  it('verifies the quoted amount, token, recipient ciphertext and commitment', async () => {
    const { fee, quote, payload } = await fixture();
    await expect(verifyRelayFeeOutput(payload, quote, fee)).resolves.toBeUndefined();
  });

  it('rejects a missing, underpaid or substituted fee output before submission', async () => {
    const { fee, quote, note, payload } = await fixture();
    await expect(verifyRelayFeeOutput({ ...payload, ciphertexts: ['0x', '0x', '0x', '0x'] }, quote, fee)).rejects.toThrow('encrypted');
    await expect(verifyRelayFeeOutput({
      ...payload,
      ciphertexts: [ethers.hexlify(encryptNote({ ...note, amount: 1n }, fee.address)), '0x', '0x', '0x'],
    }, quote, fee)).rejects.toThrow('amount mismatch');
    await expect(verifyRelayFeeOutput({ ...payload, outputCommitments: [word(0n), word(0n), word(0n), word(0n)] }, quote, fee)).rejects.toThrow('commitment mismatch');
    await expect(verifyRelayFeeOutput({ ...payload, quoteId: 'forged' }, quote, fee)).rejects.toThrow('does not match');
  });
});
