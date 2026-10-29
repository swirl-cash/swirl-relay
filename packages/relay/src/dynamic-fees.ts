import { Contract, type Provider } from 'ethers';
import { issueRelayQuote, type RelayFeeConfig, type RelayQuote } from './fees.js';
import { createChainlinkEthUsdReader } from './gas-policy.js';

const PRICE_FEED_ABI = [
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

export function calculateDynamicRelayFee(input: {
  gasEstimate: bigint;
  gasPrice: bigint;
  multiplierBps: number;
  kind: 'native' | 'stable';
  ethUsdPrice?: number;
  tokenUsdPrice?: number;
}): { feeAmount: bigint; gasLimit: bigint; maximumGas: bigint } {
  const { gasEstimate, gasPrice, multiplierBps, kind } = input;
  if (gasEstimate <= 0n || gasPrice <= 0n || !Number.isInteger(multiplierBps) || multiplierBps < 1 || multiplierBps > 100_000) {
    throw new Error('Invalid dynamic Relay Gas parameters');
  }
  // Reserve a 20% gas-estimate buffer and bind the quote to the resulting maximum cost.
  const gasLimit = gasEstimate * 12_000n / 10_000n;
  const maximumGas = gasLimit * gasPrice;
  const nativeFee = maximumGas * BigInt(multiplierBps) / 10_000n;
  if (kind === 'native') return { feeAmount: nativeFee, gasLimit, maximumGas };
  const { ethUsdPrice, tokenUsdPrice } = input;
  if (!Number.isFinite(ethUsdPrice) || !(ethUsdPrice! > 0) || !Number.isFinite(tokenUsdPrice) || !(tokenUsdPrice! > 0)) {
    throw new Error('Stablecoin Relay fees require positive ETH/USD and token/USD prices');
  }
  const ethPriceMicros = BigInt(Math.ceil(ethUsdPrice! * 1_000_000));
  const tokenPriceMicros = BigInt(Math.ceil(tokenUsdPrice! * 1_000_000));
  // Convert wei (18 decimals) to a 6-decimal stablecoin using the two on-chain prices.
  const feeAmount = nativeFee * ethPriceMicros / (tokenPriceMicros * 1_000_000_000_000n);
  if (feeAmount <= 0n) throw new Error('Dynamic Relay fee rounded to zero');
  return { feeAmount, gasLimit, maximumGas };
}

function createChainlinkUsdReader(provider: Provider, feedAddress: string, expectedDescription: string): () => Promise<number> {
  const feed = new Contract(feedAddress, PRICE_FEED_ABI, provider);
  return async () => {
    const [description, decimals, round] = await Promise.all([
      feed.description() as Promise<string>, feed.decimals() as Promise<bigint>,
      feed.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
    ]);
    if (description !== expectedDescription) throw new Error(`Unexpected ${expectedDescription} price feed`);
    const [answer, updatedAt] = [round[1], round[3]];
    // Stablecoin feeds normally use a 24-hour heartbeat plus deviation updates;
    // do not apply the much shorter ETH/USD freshness window to these feeds.
    if (answer <= 0n || updatedAt <= 0n || BigInt(Math.floor(Date.now() / 1000)) - updatedAt > 172_800n) {
      throw new Error(`${expectedDescription} price feed returned an invalid or stale round`);
    }
    return Number(answer * 1_000_000n / (10n ** decimals)) / 1_000_000;
  };
}

export async function issueDynamicRelayQuote(input: {
  fee: RelayFeeConfig;
  provider: Provider;
  chainId: bigint;
  vault: string;
  token: string;
  gasEstimate: bigint;
}): Promise<RelayQuote> {
  const { fee, provider, gasEstimate } = input;
  const pricing = fee.pricing;
  if (!pricing) throw new Error('Dynamic Relay pricing is not configured');
  const feeData = await provider.getFeeData();
  if (!feeData.gasPrice || feeData.gasPrice <= 0n) throw new Error('No legacy gasPrice is available for the Type 1 Relay transaction');
  const readEthUsd = pricing.ethUsdPrice ?? (pricing.ethUsdFeedAddress
    ? createChainlinkEthUsdReader(provider, pricing.ethUsdFeedAddress) : undefined);
  const readTokenUsd = pricing.tokenUsdPrice ?? (pricing.tokenUsdFeedAddress
    ? createChainlinkUsdReader(provider, pricing.tokenUsdFeedAddress, pricing.tokenUsdDescription ?? '') : undefined);
  const [ethUsdPrice, tokenUsdPrice] = pricing.kind === 'stable'
    ? await Promise.all([readEthUsd?.(), readTokenUsd?.()]) : [];
  const calculated = calculateDynamicRelayFee({
    gasEstimate, gasPrice: feeData.gasPrice, multiplierBps: pricing.multiplierBps, kind: pricing.kind, ethUsdPrice, tokenUsdPrice,
  });
  return {
    ...issueRelayQuote(fee, input.chainId, input.vault, input.token),
    feeAmount: calculated.feeAmount.toString(), gasEstimate: gasEstimate.toString(), gasLimit: calculated.gasLimit.toString(),
    gasPrice: feeData.gasPrice.toString(), overallBatchMinGasPrice: feeData.gasPrice.toString(),
  };
}
