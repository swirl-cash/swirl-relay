import { describe, expect, it } from 'vitest';
import type { Provider } from 'ethers';
import { calculateDynamicRelayFee, issueDynamicRelayQuote } from './dynamic-fees.js';
import type { RelayFeeConfig } from './fees.js';

const fee: RelayFeeConfig = {
  address: 'swirl1test', viewingSecretKey: `0x${'00'.repeat(32)}`, ownerSecret: '1', amount: '1', quoteTtlMs: 300_000,
};

describe('Dynamic Relay Gas fees', () => {
  it('uses 120% of the estimate and the quoted legacy gasPrice', () => {
    const result = calculateDynamicRelayFee({ gasEstimate: 100_000n, gasPrice: 100_000_000n, multiplierBps: 10_000, kind: 'native' });
    expect(result.gasLimit).toBe(120_000n);
    expect(result.maximumGas).toBe(12_000_000_000_000n);
    expect(result.feeAmount).toBe(12_000_000_000_000n);
  });

  it('applies the configured multiplier without confusing it with the 20% Gas buffer', () => {
    const result = calculateDynamicRelayFee({ gasEstimate: 100_000n, gasPrice: 100_000_000n, multiplierBps: 12_500, kind: 'native' });
    expect(result.feeAmount).toBe(15_000_000_000_000n);
  });

  it('converts native Gas cost to six-decimal stablecoins with both prices', () => {
    const result = calculateDynamicRelayFee({
      gasEstimate: 100_000n, gasPrice: 100_000_000n, multiplierBps: 10_000, kind: 'stable', ethUsdPrice: 2500, tokenUsdPrice: 1,
    });
    expect(result.feeAmount).toBe(30_000n);
  });

  it('binds the quote to gasEstimate, gasLimit and overallBatchMinGasPrice', async () => {
    const provider = { getFeeData: async () => ({ gasPrice: 100_000_000n }) } as Provider;
    const quote = await issueDynamicRelayQuote({
      fee: { ...fee, pricing: { kind: 'native', multiplierBps: 10_000 } }, provider,
      chainId: 1n, vault: `0x${'22'.repeat(20)}`, token: `0x${'33'.repeat(20)}`, gasEstimate: 100_000n,
    });
    expect(quote.gasEstimate).toBe('100000');
    expect(quote.gasLimit).toBe('120000');
    expect(quote.gasPrice).toBe('100000000');
    expect(quote.overallBatchMinGasPrice).toBe(quote.gasPrice);
    expect(quote.feeAmount).toBe('12000000000000');
  });
});
