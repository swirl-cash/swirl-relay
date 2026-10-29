import { Contract, type Provider } from 'ethers';

const PRICE_FEED_ABI = [
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

export function usdToWei(usd: number, ethUsdPrice: number): bigint {
  if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) {
    throw new Error('USD amount and ETH/USD price must be positive');
  }
  const usdMicros = BigInt(Math.ceil(usd * 1_000_000));
  const priceMicros = BigInt(Math.ceil(ethUsdPrice * 1_000_000));
  return usdMicros * 10n ** 18n / priceMicros;
}

export function gasRefillAmount(balanceWei: bigint, minimumWei: bigint, targetWei: bigint): bigint {
  if (minimumWei <= 0n || targetWei < minimumWei) throw new Error('Gas target must not be below the minimum threshold');
  if (balanceWei >= minimumWei) return 0n;
  return targetWei > balanceWei ? targetWei - balanceWei : 0n;
}

export function createChainlinkEthUsdReader(provider: Provider, feedAddress: string): () => Promise<number> {
  const feed = new Contract(feedAddress, PRICE_FEED_ABI, provider);
  return async () => {
    const [description, decimals, round] = await Promise.all([
      feed.description() as Promise<string>,
      feed.decimals() as Promise<bigint>,
      feed.latestRoundData() as Promise<[bigint, bigint, bigint, bigint, bigint]>,
    ]);
    if (description !== 'ETH / USD') throw new Error('Unexpected ETH/USD price feed');
    const [answer, updatedAt] = [round[1], round[3]];
    if (answer <= 0n || updatedAt <= 0n) throw new Error('ETH/USD price feed returned an invalid round');
    if (BigInt(Math.floor(Date.now() / 1000)) - updatedAt > 7200n) throw new Error('ETH/USD price feed is stale');
    const scale = 10n ** decimals;
    return Number(answer * 1_000_000n / scale) / 1_000_000;
  };
}
