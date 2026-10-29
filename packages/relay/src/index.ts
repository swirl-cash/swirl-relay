import { ethers } from 'ethers';
import { createRelayServer, configFromEnv } from './server.js';
import { startNativeGasRefiller } from './auto-refill.js';

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const config = await configFromEnv();
const server = createRelayServer(config);
let stopRefill: (() => void) | undefined;
if (process.env.RELAYER_AUTO_REFILL === 'true') {
  const gatewayAddress = process.env.NATIVE_GATEWAY_ADDRESS;
  const indexerUrl = process.env.INDEXER_URL;
  const wasmPath = process.env.PROVING_WASM_PATH;
  const zkeyPath = process.env.PROVING_ZKEY_PATH;
  if (!gatewayAddress || !indexerUrl || !wasmPath || !zkeyPath) {
    throw new Error('Auto-refill requires NATIVE_GATEWAY_ADDRESS, INDEXER_URL, PROVING_WASM_PATH and PROVING_ZKEY_PATH');
  }
  const legacyMinGas = process.env.RELAYER_MIN_GAS_WEI;
  const minGasWei = legacyMinGas ?? '20000000000000000';
  if (!/^[0-9]+$/.test(minGasWei) || BigInt(minGasWei) <= 0n) throw new Error('Invalid RELAYER_MIN_GAS_WEI');
  const minGasUsd = Number(process.env.RELAYER_MIN_GAS_USD ?? '5');
  const targetGasUsd = Number(process.env.RELAYER_TARGET_GAS_USD ?? '10');
  if (!Number.isFinite(minGasUsd) || minGasUsd <= 0 || !Number.isFinite(targetGasUsd) || targetGasUsd < minGasUsd) {
    throw new Error('Invalid Relayer USD Gas thresholds');
  }
  const ethUsdFeedAddress = process.env.ETH_USD_FEED_ADDRESS ?? '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
  if (!ethers.isAddress(ethUsdFeedAddress)) throw new Error('Invalid ETH_USD_FEED_ADDRESS');
  const intervalSeconds = Number(process.env.RELAYER_REFILL_INTERVAL_SECONDS ?? '60');
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10) throw new Error('Invalid RELAYER_REFILL_INTERVAL_SECONDS');
  stopRefill = startNativeGasRefiller({
    config, gatewayAddress, indexerUrl, wasmPath, zkeyPath,
    ...(legacyMinGas !== undefined
      ? { minGasWei: BigInt(minGasWei), targetGasWei: BigInt(minGasWei) }
      : { minGasUsd, targetGasUsd, ethUsdFeedAddress }),
    intervalMs: intervalSeconds * 1000,
  });
  console.log(`SWIRL native Gas auto-refill enabled; mode=${legacyMinGas !== undefined ? 'legacy Wei' : `USD ${minGasUsd}/${targetGasUsd}`}`);
}
server.listen(port, '127.0.0.1', () => {
  console.log(`SWIRL relayer listening on 127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopRefill?.();
    server.close(() => process.exit(0));
  });
}
