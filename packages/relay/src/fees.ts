import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { bytesToBigint, createSwirlWallet, decryptNote, noteCommitment } from '@swirl/wallet';
import type { RelayPayload } from './validation.js';

export type RelayFeePricing = {
  kind: 'native' | 'stable';
  multiplierBps: number;
  ethUsdFeedAddress?: string;
  tokenUsdFeedAddress?: string;
  tokenUsdDescription?: string;
  ethUsdPrice?: () => Promise<number>;
  tokenUsdPrice?: () => Promise<number>;
};

export type RelayFeeConfig = {
  address: string;
  viewingSecretKey: string;
  ownerSecret: string;
  amount: string;
  quoteTtlMs: number;
  pricing?: RelayFeePricing;
};

export type RelayQuote = {
  id: string;
  chainId: string;
  vault: string;
  token: string;
  feeAddress: string;
  feeAmount: string;
  expiresAt: number;
  gasEstimate?: string;
  gasLimit?: string;
  gasPrice?: string;
  overallBatchMinGasPrice?: string;
};

export function issueRelayQuote(
  fee: RelayFeeConfig, chainId: bigint, vault: string, token: string, now = Date.now(),
): RelayQuote {
  return {
    id: randomUUID(), chainId: chainId.toString(), vault: ethers.getAddress(vault), token: ethers.getAddress(token),
    feeAddress: fee.address, feeAmount: fee.amount, expiresAt: now + fee.quoteTtlMs,
  };
}

export async function verifyRelayFeeOutput(payload: RelayPayload, quote: RelayQuote, fee: RelayFeeConfig): Promise<void> {
  if (payload.quoteId !== quote.id) throw new Error('Relayer quote does not match this request');
  if (quote.expiresAt <= Date.now()) throw new Error('Relayer quote expired');
  const note = await decryptNote(
    ethers.getBytes(payload.ciphertexts[0]), ethers.getBytes(fee.viewingSecretKey), BigInt(fee.ownerSecret),
  );
  if (!note) throw new Error('Relayer fee output is not encrypted to this Relayer');
  if (note.token !== BigInt(quote.token)) throw new Error('Relayer fee token mismatch');
  if (note.amount !== BigInt(quote.feeAmount)) throw new Error('Relayer fee amount mismatch');
  if (await noteCommitment(note) !== BigInt(payload.outputCommitments[0])) throw new Error('Relayer fee commitment mismatch');
}

export async function feeConfigFromMnemonic(mnemonic: string, chainId: number, amount: string, quoteTtlMs: number): Promise<RelayFeeConfig> {
  if (!/^(0|[1-9][0-9]*)$/.test(amount) || BigInt(amount) <= 0n) throw new Error('RELAYER_FEE_AMOUNT must be a positive atomic-token integer');
  const wallet = await createSwirlWallet(chainId, mnemonic);
  return {
    address: wallet.address,
    viewingSecretKey: ethers.hexlify(wallet.viewingSecretKey),
    ownerSecret: bytesToBigint(wallet.noteSecretKey).toString(),
    amount,
    quoteTtlMs,
  };
}
