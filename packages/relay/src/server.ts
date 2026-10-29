import http from 'node:http';
import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { validateRelayPayload } from './validation.js';
import { feeConfigFromMnemonic, issueRelayQuote, verifyRelayFeeOutput, type RelayFeeConfig, type RelayQuote } from './fees.js';
import { issueDynamicRelayQuote } from './dynamic-fees.js';
import { verifyPreTransactionPOI, type PreTransactionPOIConfig } from './pre-transaction-poi.js';

const VAULT_ABI = [
  'function transact((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount, address publicRecipient, address token)',
];

export type RelayConfig = {
  rpcUrl: string;
  privateKey: string;
  vaultAddress: string;
  tokenAddress: string;
  corsOrigin?: string;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  trustProxy?: boolean;
  maxTrackedClients?: number;
  fee?: RelayFeeConfig;
  assets?: Record<string, RelayFeeConfig>;
  ppoi?: PreTransactionPOIConfig;
};

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const value = error as { shortMessage?: string; reason?: string; message?: string };
    return value.shortMessage || value.reason || value.message || 'Relay failed';
  }
  return 'Relay failed';
}

class BodyTooLargeError extends Error {}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAborted = () => onError(new Error('Request aborted'));
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        settled = true;
        chunks.length = 0;
        request.removeListener('data', onData);
        request.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

function clientAddress(request: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function withinRateLimit(
  requests: Map<string, { reset: number; count: number }>, key: string,
  limit: number, maxTrackedClients: number,
): boolean {
  const now = Date.now();
  if (requests.size >= maxTrackedClients) {
    for (const [ip, quota] of requests) if (quota.reset <= now) requests.delete(ip);
  }
  const quota = requests.get(key);
  if (!quota || quota.reset <= now) {
    if (!quota && requests.size >= maxTrackedClients) return false;
    requests.set(key, { reset: now + 60_000, count: 1 });
    return true;
  }
  quota.count += 1;
  return quota.count <= limit;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}`);
  return parsed;
}

export function createRelayServer(config: RelayConfig): http.Server {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const relayer = new Wallet(config.privateKey, provider);
  const vault = new Contract(config.vaultAddress, VAULT_ABI, relayer);
  const corsOrigin = config.corsOrigin ?? '*';
  const maxBodyBytes = config.maxBodyBytes ?? 65_536;
  const rateLimit = config.rateLimitPerMinute ?? 30;
  const maxTrackedClients = config.maxTrackedClients ?? 10_000;
  const trustProxy = config.trustProxy ?? false;
  if (![maxBodyBytes, rateLimit, maxTrackedClients].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('Relay body, rate and client limits must be positive integers');
  }
  const assetEntries = config.assets
    ? Object.entries(config.assets).map(([token, fee]) => [ethers.getAddress(token), fee] as const)
    : [[ethers.getAddress(config.tokenAddress), config.fee] as const];
  if (!assetEntries.length) throw new Error('At least one Relayer asset is required');
  const feeAssets = new Map(assetEntries.map(([token, fee]) => [token.toLowerCase(), fee]));
  const defaultToken = assetEntries[0][0];
  const requests = new Map<string, { reset: number; count: number }>();
  const quotes = new Map<string, RelayQuote>();
  const usedQuotes = new Map<string, number>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, quota] of requests) if (quota.reset <= now) requests.delete(ip);
    for (const [id, quote] of quotes) if (quote.expiresAt <= now) quotes.delete(id);
    for (const [id, expiry] of usedQuotes) if (expiry <= now) usedQuotes.delete(id);
  }, 60_000);
  cleanup.unref();

  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('access-control-allow-origin', corsOrigin);
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    if (request.method === 'OPTIONS') return send(204, {});
    const url = new URL(request.url ?? '/', 'http://relay.local');
    const ip = clientAddress(request, trustProxy);
    if (!withinRateLimit(requests, ip, rateLimit, maxTrackedClients)) return send(429, { error: 'Rate limit exceeded' });
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const network = await provider.getNetwork();
        return send(200, {
          ok: true, chainId: network.chainId.toString(), relayer: relayer.address, vault: config.vaultAddress,
          feeEnabled: assetEntries.some(([, fee]) => Boolean(fee)),
          assets: assetEntries.map(([token, fee]) => ({
            token, feeAmount: fee?.pricing ? 'dynamic' : fee?.amount, feeAddress: fee?.address, dynamicGasFee: Boolean(fee?.pricing),
          })),
        });
      } catch (error) {
        return send(503, { error: errorMessage(error) });
      }
    }
    if (request.method === 'GET' && url.pathname === '/fee-config') {
      const requestedToken = url.searchParams.get('token') ?? (assetEntries.length === 1 ? defaultToken : null);
      if (!requestedToken || !ethers.isAddress(requestedToken)) return send(400, { error: 'A valid token query parameter is required' });
      const tokenAddress = ethers.getAddress(requestedToken);
      const fee = feeAssets.get(tokenAddress.toLowerCase());
      if (!fee) return send(404, { error: 'Relayer asset is not configured' });
      return send(200, {
        chainId: (await provider.getNetwork()).chainId.toString(), vault: config.vaultAddress, token: tokenAddress,
        relayer: relayer.address, feeAddress: fee.address, dynamicGasFee: Boolean(fee?.pricing),
      });
    }
    if (request.method === 'GET' && url.pathname === '/quote') {
      try {
        const requestedToken = url.searchParams.get('token') ?? (assetEntries.length === 1 ? defaultToken : null);
        if (!requestedToken || !ethers.isAddress(requestedToken)) return send(400, { error: 'A valid token query parameter is required' });
        const tokenAddress = ethers.getAddress(requestedToken);
        const fee = feeAssets.get(tokenAddress.toLowerCase());
        if (!fee) return send(404, { error: 'Relayer asset is not configured' });
        if (quotes.size >= maxTrackedClients) return send(429, { error: 'Too many outstanding quotes' });
        const network = await provider.getNetwork();
        const gasEstimateText = url.searchParams.get('gasEstimate');
        if (fee.pricing && (!gasEstimateText || !/^[1-9][0-9]*$/.test(gasEstimateText))) {
          return send(400, { error: 'A positive gasEstimate from a Dummy Proof is required' });
        }
        const quote = fee.pricing
          ? await issueDynamicRelayQuote({ fee, provider, chainId: network.chainId, vault: config.vaultAddress, token: tokenAddress, gasEstimate: BigInt(gasEstimateText!) })
          : issueRelayQuote(fee, network.chainId, config.vaultAddress, tokenAddress);
        quotes.set(quote.id, quote);
        return send(200, quote);
      } catch (error) {
        return send(503, { error: errorMessage(error) });
      }
    }
    if (request.method !== 'POST' || url.pathname !== '/relay') return send(404, { error: 'Not found' });

    const declaredLength = Number(request.headers['content-length'] ?? 0);
    if (declaredLength > maxBodyBytes) {
      request.resume();
      return send(413, { error: 'Request body too large' });
    }

    try {
      const body = await readBody(request, maxBodyBytes);
      let json: unknown;
      try { json = JSON.parse(body.toString('utf8')); }
      catch { return send(400, { error: 'Invalid JSON' }); }
      const payload = validateRelayPayload(json);
      if (payload.quoteId && usedQuotes.has(payload.quoteId)) return send(409, { error: 'Relayer quote was already used' });
      const quote = payload.quoteId ? quotes.get(payload.quoteId) : undefined;
      if (!quote) return send(400, { error: 'Relayer quote is missing, unknown or expired' });
      const fee = feeAssets.get(quote.token.toLowerCase());
      if (!fee) return send(400, { error: 'Relayer quote asset is not configured' });
      if (config.ppoi) {
        await verifyPreTransactionPOI(payload, {
          ...config.ppoi, chainId: Number(quote.chainId), vault: config.vaultAddress, token: quote.token,
        });
      } else if (payload.preTransactionPOI) {
        throw new Error('Pre-Transaction POI is not enabled on this Relayer');
      }
      await verifyRelayFeeOutput(payload, quote, fee);
      usedQuotes.set(quote.id, quote.expiresAt);
      quotes.delete(quote.id);
      // The fee note is decrypted only inside this process and verified against
      // its proof-bound commitment before this Relayer pays any gas.
      try {
        await vault.transact.staticCall(
          payload.proof, payload.root, payload.nullifiers, payload.outputCommitments,
          payload.ciphertexts, payload.publicAmount, payload.publicRecipient, quote.token,
        );
      } catch (error) {
        usedQuotes.delete(quote.id);
        quotes.set(quote.id, quote);
        throw error;
      }
      const transaction = await vault.transact(
        payload.proof, payload.root, payload.nullifiers, payload.outputCommitments,
        payload.ciphertexts, payload.publicAmount, payload.publicRecipient, quote.token,
        ...(fee.pricing ? [{
          type: 1, gasPrice: BigInt(quote.overallBatchMinGasPrice!), gasLimit: BigInt(quote.gasLimit!),
        }] : []),
      );
      return send(202, { transactionHash: transaction.hash, relayer: relayer.address, feeAmount: quote.feeAmount });
    } catch (error) {
      if (error instanceof BodyTooLargeError) return send(413, { error: 'Request body too large' });
      return send(400, { error: errorMessage(error) });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => clearInterval(cleanup));
  return server;
}

export async function configFromEnv(env = process.env): Promise<RelayConfig> {
  const {
    RPC_URL, RELAYER_PRIVATE_KEY, VAULT_ADDRESS, TOKEN_ADDRESS, CORS_ORIGIN,
    RELAYER_MNEMONIC, RELAYER_FEE_AMOUNT, RELAYER_ASSETS, RELAYER_QUOTE_TTL_SECONDS,
    MAX_BODY_BYTES, RATE_LIMIT_PER_MINUTE, MAX_TRACKED_CLIENTS, TRUST_PROXY, NODE_ENV,
    RELAYER_DYNAMIC_GAS_FEE, RELAYER_GAS_MULTIPLIER_BPS, ETH_USD_FEED_ADDRESS,
    PPOI_NODE_URL, PPOI_LIST_KEY, PPOI_VKEY,
  } = env;
  if (!RPC_URL || !RELAYER_PRIVATE_KEY || !VAULT_ADDRESS) throw new Error('RPC_URL, RELAYER_PRIVATE_KEY and VAULT_ADDRESS are required');
  if (!RELAYER_MNEMONIC) throw new Error('RELAYER_MNEMONIC is required');
  if (!ethers.isAddress(VAULT_ADDRESS)) throw new Error('Invalid VAULT_ADDRESS');
  if (RELAYER_ASSETS === undefined && (!TOKEN_ADDRESS || !RELAYER_FEE_AMOUNT)) {
    throw new Error('TOKEN_ADDRESS and RELAYER_FEE_AMOUNT are required without RELAYER_ASSETS');
  }
  if (TOKEN_ADDRESS !== undefined && !ethers.isAddress(TOKEN_ADDRESS)) throw new Error('Invalid TOKEN_ADDRESS');
  if (NODE_ENV === 'production' && !CORS_ORIGIN) throw new Error('CORS_ORIGIN is required in production');
  if (TRUST_PROXY !== undefined && TRUST_PROXY !== 'true' && TRUST_PROXY !== 'false') throw new Error('Invalid TRUST_PROXY');
  const ppoiConfigured = Boolean(PPOI_NODE_URL || PPOI_LIST_KEY || PPOI_VKEY);
  if ((ppoiConfigured || NODE_ENV === 'production') && (!PPOI_NODE_URL || !PPOI_LIST_KEY || !PPOI_VKEY)) {
    throw new Error('PPOI_NODE_URL, PPOI_LIST_KEY and PPOI_VKEY are required together and in production');
  }
  let ppoi: PreTransactionPOIConfig | undefined;
  if (PPOI_NODE_URL && PPOI_LIST_KEY && PPOI_VKEY) {
    let url: URL;
    try { url = new URL(PPOI_NODE_URL); } catch { throw new Error('Invalid PPOI_NODE_URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid PPOI_NODE_URL');
    if (!/^[0-9a-fA-F]{64}$/.test(PPOI_LIST_KEY)) throw new Error('Invalid PPOI_LIST_KEY');
    let verificationKey: unknown;
    try { verificationKey = JSON.parse(await (await import('node:fs/promises')).readFile(PPOI_VKEY, 'utf8')); }
    catch { throw new Error('PPOI_VKEY must be a readable JSON verification key'); }
    if (typeof verificationKey !== 'object' || verificationKey === null) throw new Error('Invalid PPOI verification key');
    ppoi = { nodeUrl: PPOI_NODE_URL, listKey: PPOI_LIST_KEY, verificationKey };
  }
  const dynamicGasFee = RELAYER_DYNAMIC_GAS_FEE === 'true';
  if (dynamicGasFee && RELAYER_ASSETS === undefined) throw new Error('Dynamic Gas fees require RELAYER_ASSETS with asset kinds');
  const multiplierBps = Number(RELAYER_GAS_MULTIPLIER_BPS ?? '10000');
  if (!Number.isInteger(multiplierBps) || multiplierBps < 1 || multiplierBps > 100_000) throw new Error('Invalid RELAYER_GAS_MULTIPLIER_BPS');
  const ethUsdFeedAddress = ETH_USD_FEED_ADDRESS ?? '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
  if (!ethers.isAddress(ethUsdFeedAddress)) throw new Error('Invalid ETH_USD_FEED_ADDRESS');

  let assetInputs: { token: string; feeAmount: string; kind?: 'native' | 'stable'; tokenUsdFeedAddress?: string; tokenUsdDescription?: string }[];
  if (RELAYER_ASSETS !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(RELAYER_ASSETS); }
    catch { throw new Error('RELAYER_ASSETS must be a JSON array'); }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 32) {
      throw new Error('RELAYER_ASSETS must contain between 1 and 32 assets');
    }
    const seen = new Set<string>();
    assetInputs = parsed.map((item) => {
      if (typeof item !== 'object' || item === null) throw new Error('Invalid RELAYER_ASSETS entry');
      const { token, feeAmount, kind, tokenUsdFeedAddress: tokenFeed, tokenUsdDescription } = item as {
        token?: unknown; feeAmount?: unknown; kind?: unknown; tokenUsdFeedAddress?: unknown; tokenUsdDescription?: unknown;
      };
      if (typeof token !== 'string' || !ethers.isAddress(token)) throw new Error('Invalid RELAYER_ASSETS token');
      if (typeof feeAmount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(feeAmount) || BigInt(feeAmount) <= 0n) {
        throw new Error('RELAYER_ASSETS feeAmount must be a positive atomic-token integer');
      }
      if (dynamicGasFee && kind !== 'native' && kind !== 'stable') throw new Error('Dynamic assets require kind native or stable');
      if (dynamicGasFee && kind === 'stable' && (typeof tokenFeed !== 'string' || !ethers.isAddress(tokenFeed)
        || typeof tokenUsdDescription !== 'string' || !tokenUsdDescription)) {
        throw new Error('Dynamic stable assets require a token/USD feed and description');
      }
      const key = token.toLowerCase();
      if (seen.has(key)) throw new Error('RELAYER_ASSETS tokens must be unique');
      seen.add(key);
      return {
        token: ethers.getAddress(token), feeAmount, kind: kind as 'native' | 'stable' | undefined,
        tokenUsdFeedAddress: tokenFeed as string | undefined, tokenUsdDescription: tokenUsdDescription as string | undefined,
      };
    });
  } else {
    assetInputs = [{ token: ethers.getAddress(TOKEN_ADDRESS!), feeAmount: RELAYER_FEE_AMOUNT! }];
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const { chainId } = await provider.getNetwork();
  const quoteTtlSeconds = positiveInteger(RELAYER_QUOTE_TTL_SECONDS, 'RELAYER_QUOTE_TTL_SECONDS', 300);
  const assets: Record<string, RelayFeeConfig> = {};
  for (const item of assetInputs) {
    const asset = await feeConfigFromMnemonic(RELAYER_MNEMONIC, Number(chainId), item.feeAmount, quoteTtlSeconds * 1000);
    if (dynamicGasFee) asset.pricing = {
      kind: item.kind!, multiplierBps, ethUsdFeedAddress,
      tokenUsdFeedAddress: item.tokenUsdFeedAddress, tokenUsdDescription: item.tokenUsdDescription,
    };
    assets[item.token.toLowerCase()] = asset;
  }
  const defaultAsset = assetInputs[0];
  const fee = assets[defaultAsset.token.toLowerCase()];
  return {
    rpcUrl: RPC_URL, privateKey: RELAYER_PRIVATE_KEY, vaultAddress: VAULT_ADDRESS,
    tokenAddress: defaultAsset.token, corsOrigin: CORS_ORIGIN,
    maxBodyBytes: positiveInteger(MAX_BODY_BYTES, 'MAX_BODY_BYTES', 65_536),
    rateLimitPerMinute: positiveInteger(RATE_LIMIT_PER_MINUTE, 'RATE_LIMIT_PER_MINUTE', 30),
    maxTrackedClients: positiveInteger(MAX_TRACKED_CLIENTS, 'MAX_TRACKED_CLIENTS', 10_000),
    trustProxy: TRUST_PROXY === 'true', fee, ppoi,
    assets: RELAYER_ASSETS === undefined ? undefined : assets,
  };
}
