import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcProvider, type Network } from 'ethers';
import { createRelayServer, configFromEnv, type RelayConfig } from './server.js';
import type { RelayFeeConfig } from './fees.js';

const servers: http.Server[] = [];
const baseConfig: RelayConfig = {
  rpcUrl: 'http://127.0.0.1:8545',
  privateKey: `0x${'11'.repeat(32)}`,
  vaultAddress: `0x${'22'.repeat(20)}`,
  tokenAddress: `0x${'33'.repeat(20)}`,
};

async function start(overrides: Partial<RelayConfig> = {}) {
  const server = createRelayServer({ ...baseConfig, ...overrides });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function post(url: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${url}/relay`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
}

async function postChunked(url: string, chunks: string[]) {
  const target = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname, port: target.port, path: '/relay', method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

describe('Relayer HTTP boundary', () => {
  it('limits repeated requests and ignores spoofed forwarding headers by default', async () => {
    const { url } = await start({ rateLimitPerMinute: 1 });
    expect((await post(url, '{}', { 'x-forwarded-for': '203.0.113.1' })).status).toBe(400);
    expect((await post(url, '{}', { 'x-forwarded-for': '203.0.113.2' })).status).toBe(429);
  });

  it('returns 413 for declared and chunked oversized bodies', async () => {
    const { url, server } = await start({ maxBodyBytes: 8 });
    expect((await post(url, '{"too":"large"}')).status).toBe(413);
    expect(await postChunked(url, ['{"a":', '"123456789"}'])).toBe(413);
    expect(server.requestTimeout).toBe(15_000);
    expect(server.headersTimeout).toBe(10_000);
  });

  it('requires explicit production CORS and validated proxy configuration', async () => {
    await expect(configFromEnv({
      RPC_URL: 'http://127.0.0.1:8545', RELAYER_PRIVATE_KEY: baseConfig.privateKey,
      VAULT_ADDRESS: baseConfig.vaultAddress, TOKEN_ADDRESS: baseConfig.tokenAddress, RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
      RELAYER_FEE_AMOUNT: '250000', NODE_ENV: 'production',
    })).rejects.toThrow('CORS_ORIGIN');
    await expect(configFromEnv({
      RPC_URL: 'http://127.0.0.1:8545', RELAYER_PRIVATE_KEY: baseConfig.privateKey,
      VAULT_ADDRESS: baseConfig.vaultAddress, TOKEN_ADDRESS: baseConfig.tokenAddress, RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
      RELAYER_FEE_AMOUNT: '250000', TRUST_PROXY: 'yes',
    })).rejects.toThrow('TRUST_PROXY');
  });
});

describe('Relayer asset configuration', () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const secondToken = `0x${'44'.repeat(20)}`;
  const envBase = {
    RPC_URL: 'http://127.0.0.1:8545', RELAYER_PRIVATE_KEY: baseConfig.privateKey,
    VAULT_ADDRESS: baseConfig.vaultAddress, RELAYER_MNEMONIC: mnemonic,
  };
  const fee = (amount: string): RelayFeeConfig => ({
    address: `0x${'55'.repeat(20)}`, viewingSecretKey: `0x${'00'.repeat(32)}`,
    ownerSecret: '1', amount, quoteTtlMs: 300_000,
  });

  it('parses multiple assets and keeps the first as the auto-refill asset', async () => {
    vi.spyOn(JsonRpcProvider.prototype, 'getNetwork').mockResolvedValue({ chainId: 1n } as Network);
    const config = await configFromEnv({
      ...envBase, RELAYER_ASSETS: JSON.stringify([
        { token: baseConfig.tokenAddress, feeAmount: '2500000000000000' },
        { token: secondToken, feeAmount: '250000' },
      ]),
    });
    expect(config.tokenAddress).toBe(baseConfig.tokenAddress);
    expect(config.fee?.amount).toBe('2500000000000000');
    expect(Object.keys(config.assets ?? {})).toEqual([baseConfig.tokenAddress, secondToken]);
    expect(config.assets?.[secondToken]?.amount).toBe('250000');
  });

  it('retains the legacy single-asset environment format', async () => {
    vi.spyOn(JsonRpcProvider.prototype, 'getNetwork').mockResolvedValue({ chainId: 1n } as Network);
    const config = await configFromEnv({
      ...envBase, TOKEN_ADDRESS: baseConfig.tokenAddress, RELAYER_FEE_AMOUNT: '250000',
    });
    expect(config.tokenAddress).toBe(baseConfig.tokenAddress);
    expect(config.fee?.amount).toBe('250000');
    expect(config.assets).toBeUndefined();
  });

  it('rejects malformed, duplicate and empty multi-asset configuration', async () => {
    await expect(configFromEnv({ ...envBase, RELAYER_ASSETS: '[]' })).rejects.toThrow('between 1 and 32');
    await expect(configFromEnv({
      ...envBase, RELAYER_ASSETS: JSON.stringify([
        { token: baseConfig.tokenAddress, feeAmount: '1' },
        { token: `0x${baseConfig.tokenAddress.slice(2).toUpperCase()}`, feeAmount: '2' },
      ]),
    })).rejects.toThrow('unique');
    await expect(configFromEnv({
      ...envBase, RELAYER_ASSETS: JSON.stringify([{ token: baseConfig.tokenAddress, feeAmount: '0' }]),
    })).rejects.toThrow('positive');
  });

  it('binds quotes to the requested asset and requires a token in multi-asset mode', async () => {
    vi.spyOn(JsonRpcProvider.prototype, 'getNetwork').mockResolvedValue({ chainId: 1n } as Network);
    const { url } = await start({ assets: {
      [baseConfig.tokenAddress]: fee('2500000000000000'),
      [secondToken]: fee('250000'),
    } });
    const response = await fetch(`${url}/quote?token=${secondToken}`);
    expect(response.status).toBe(200);
    const quote = await response.json();
    expect(quote.token).toBe(secondToken);
    expect(quote.feeAmount).toBe('250000');
    expect((await fetch(`${url}/quote`)).status).toBe(400);
    expect((await fetch(`${url}/quote?token=${`0x${'66'.repeat(20)}`}`)).status).toBe(404);
  });

  it('requires a Dummy Proof estimate and returns Type 1 dynamic Gas quote fields', async () => {
    vi.spyOn(JsonRpcProvider.prototype, 'getNetwork').mockResolvedValue({ chainId: 1n } as Network);
    vi.spyOn(JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      gasPrice: 100_000_000n,
    } as Awaited<ReturnType<JsonRpcProvider['getFeeData']>>);
    const { url } = await start({ assets: {
      [baseConfig.tokenAddress]: {
        ...fee('1'), pricing: { kind: 'native', multiplierBps: 10_000 },
      },
    } });
    expect((await fetch(`${url}/quote?token=${baseConfig.tokenAddress}`)).status).toBe(400);
    expect((await fetch(`${url}/quote?token=${baseConfig.tokenAddress}&gasEstimate=0`)).status).toBe(400);
    const feeConfigResponse = await fetch(`${url}/fee-config?token=${baseConfig.tokenAddress}`);
    expect(feeConfigResponse.status).toBe(200);
    expect((await feeConfigResponse.json()).dynamicGasFee).toBe(true);
    const response = await fetch(`${url}/quote?token=${baseConfig.tokenAddress}&gasEstimate=100000`);
    expect(response.status).toBe(200);
    const quote = await response.json();
    expect(quote).toMatchObject({
      feeAmount: '12000000000000', gasEstimate: '100000', gasLimit: '120000',
      gasPrice: '100000000', overallBatchMinGasPrice: '100000000',
    });
  });
});
