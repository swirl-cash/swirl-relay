import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers';
import {
  createNoteForAddress, createTransferProof, decryptNote, encryptNote, noteCommitment, noteNullifier,
  SwirlMerkleTree, zeroNote, type ProofInput, type SwirlNote,
} from '@swirl/wallet';
import { createChainlinkEthUsdReader, gasRefillAmount, usdToWei } from './gas-policy.js';
import type { RelayConfig } from './server.js';

const VAULT_ABI = [
  'function zeroNoteCommitment() view returns (bytes32)',
  'function merkleRoot() view returns (bytes32)',
  'function nullifiers(bytes32) view returns (bool)',
];
const GATEWAY_ABI = [
  'function unshieldNative((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount)',
];
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

type OwnedFeeNote = { note: SwirlNote & { leafIndex: number }; amount: bigint; nullifier: bigint };
type IndexerEvent = {
  kind?: string;
  leafIndex?: number;
  commitment?: string;
  commitments?: string[];
  ciphertext?: string;
  ciphertexts?: string[];
};

export type AutoRefillOptions = {
  config: RelayConfig;
  gatewayAddress: string;
  indexerUrl: string;
  wasmPath: string;
  zkeyPath: string;
  minGasWei?: bigint;
  targetGasWei?: bigint;
  minGasUsd?: number;
  targetGasUsd?: number;
  ethUsdFeedAddress?: string;
  ethUsdPrice?: () => Promise<number>;
  intervalMs?: number;
};

export function selectRefillNotes(notes: OwnedFeeNote[], targetAmount?: bigint): OwnedFeeNote[] {
  if (targetAmount !== undefined) {
    if (targetAmount <= 0n) return [];
    const single = [...notes].sort((a, b) => a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0)
      .find((item) => item.amount >= targetAmount);
    if (single) return [single];
  }
  return [...notes].sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0).slice(0, 2);
}

function ciphertextHash(ciphertexts: [string, string, string, string]): bigint {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts]);
  return BigInt(ethers.keccak256(encoded)) % FIELD_SIZE;
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
}

export function startNativeGasRefiller(options: AutoRefillOptions): () => void {
  const { config } = options;
  if (!config.fee) throw new Error('Auto-refill requires the Relayer fee wallet');
  if (!ethers.isAddress(options.gatewayAddress) || !ethers.isAddress(config.vaultAddress) || !ethers.isAddress(config.tokenAddress)) throw new Error('Invalid auto-refill contract address');
  const usdMode = options.minGasUsd !== undefined || options.targetGasUsd !== undefined;
  if (usdMode && (!(options.minGasUsd! > 0) || !(options.targetGasUsd! >= options.minGasUsd!))) {
    throw new Error('Auto-refill USD target must not be below its positive minimum threshold');
  }
  if (!usdMode && (!(options.minGasWei! > 0n) || (options.targetGasWei ?? options.minGasWei)! < options.minGasWei!)) {
    throw new Error('Auto-refill Gas target must not be below its positive minimum threshold');
  }
  if (usdMode && !options.ethUsdPrice && !options.ethUsdFeedAddress) throw new Error('USD auto-refill requires an ETH/USD price feed');
  const tokenAddress = ethers.getAddress(config.tokenAddress);
  const provider = new JsonRpcProvider(config.rpcUrl);
  const relayer = new Wallet(config.privateKey, provider);
  const vault = new Contract(config.vaultAddress, VAULT_ABI, provider);
  const gateway = new Contract(options.gatewayAddress, GATEWAY_ABI, relayer);
  const fee = config.fee;
  const ownerSecret = BigInt(fee.ownerSecret);
  const readEthUsd = options.ethUsdPrice ?? (options.ethUsdFeedAddress
    ? createChainlinkEthUsdReader(provider, options.ethUsdFeedAddress) : undefined);
  async function requiredRefill(balance: bigint): Promise<bigint> {
    if (usdMode) {
      const price = await readEthUsd!();
      return gasRefillAmount(balance, usdToWei(options.minGasUsd!, price), usdToWei(options.targetGasUsd!, price));
    }
    return gasRefillAmount(balance, options.minGasWei!, options.targetGasWei ?? options.minGasWei!);
  }
  let running = false;
  let stopped = false;

  async function availableFeeNotes(): Promise<OwnedFeeNote[]> {
    const [zeroCommitment, { chainId }, response] = await Promise.all([
      vault.zeroNoteCommitment(), provider.getNetwork(),
      fetch(`${options.indexerUrl.replace(/\/$/, '')}/events`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) }),
    ]);
    if (!response.ok) throw new Error(`Auto-refill indexer returned HTTP ${response.status}`);
    const snapshot = await response.json() as { version?: number; chainId?: string; vault?: string; zeroCommitment?: string; events?: IndexerEvent[] };
    if (snapshot.version !== 3 || snapshot.chainId !== chainId.toString()
      || snapshot.vault?.toLowerCase() !== config.vaultAddress.toLowerCase()
      || snapshot.zeroCommitment !== zeroCommitment || !Array.isArray(snapshot.events)) {
      throw new Error('Auto-refill indexer snapshot does not match this vault');
    }
    const token = BigInt(tokenAddress);
    const commitments: bigint[] = [BigInt(zeroCommitment)];
    const encrypted: { index: number; ciphertext: string }[] = [];
    for (const event of snapshot.events) {
      if (!Number.isSafeInteger(event.leafIndex) || (event.leafIndex ?? -1) < 0) throw new Error('Invalid auto-refill event index');
      const index = event.leafIndex!;
      if (event.kind === 'shield' && event.commitment && event.ciphertext) {
        commitments[index] = BigInt(event.commitment);
        encrypted.push({ index, ciphertext: event.ciphertext });
      } else if (event.kind === 'transacted' && event.commitments?.length === 4 && event.ciphertexts?.length === 4) {
        for (let offset = 0; offset < 4; offset++) {
          commitments[index + offset] = BigInt(event.commitments[offset]);
          encrypted.push({ index: index + offset, ciphertext: event.ciphertexts[offset] });
        }
      } else throw new Error('Invalid auto-refill event payload');
    }
    if (Array.from({ length: commitments.length }, (_, index) => commitments[index]).some((value) => value === undefined)) {
      throw new Error('Auto-refill event history has a missing leaf');
    }
    const tree = await SwirlMerkleTree.create(16, commitments);
    if (tree.root !== BigInt(await vault.merkleRoot())) throw new Error('Auto-refill indexer root does not match the vault');
    const notes: OwnedFeeNote[] = [];
    for (const item of encrypted) {
      if (item.ciphertext === '0x') continue;
      const note = await decryptNote(ethers.getBytes(item.ciphertext), ethers.getBytes(fee.viewingSecretKey), ownerSecret);
      if (!note) continue;
      if (note.token !== token || await noteCommitment(note) !== commitments[item.index]) throw new Error('Invalid Relayer fee note');
      const nullifier = await noteNullifier(ownerSecret, item.index);
      if (await vault.nullifiers(ethers.toBeHex(nullifier, 32))) continue;
      notes.push({ note: { ...note, leafIndex: item.index }, amount: note.amount, nullifier });
    }
    return notes;
  }

  async function refill() {
    if (running || stopped) return;
    running = true;
    try {
      const refillAmount = await requiredRefill(await provider.getBalance(relayer.address));
      if (refillAmount === 0n) return;
      const notes = selectRefillNotes(await availableFeeNotes(), refillAmount);
      if (!notes.length) {
        console.warn('SWIRL auto-refill: Gas is below threshold but no unspent fee notes are available');
        return;
      }
      const token = BigInt(tokenAddress);
      const zeroCommitment = await vault.zeroNoteCommitment();
      const { chainId } = await provider.getNetwork();
      // Rebuild once more immediately before proving so every path belongs to the current root.
      const response = await fetch(`${options.indexerUrl.replace(/\/$/, '')}/events`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Auto-refill indexer became unavailable');
      const snapshot = await response.json() as { events?: IndexerEvent[] };
      if (!Array.isArray(snapshot.events)) throw new Error('Auto-refill indexer events are unavailable');
      const commitments: bigint[] = [BigInt(zeroCommitment)];
      for (const event of snapshot.events) {
        const index = event.leafIndex;
        if (!Number.isSafeInteger(index) || (index ?? -1) < 0) throw new Error('Invalid auto-refill rebuild index');
        if (event.kind === 'shield' && event.commitment) commitments[index!] = BigInt(event.commitment);
        else if (event.kind === 'transacted' && event.commitments?.length === 4) {
          for (let offset = 0; offset < 4; offset++) commitments[index! + offset] = BigInt(event.commitments[offset]);
        } else throw new Error('Invalid auto-refill rebuild event');
      }
      const tree = await SwirlMerkleTree.create(16, commitments);
      if (tree.root !== BigInt(await vault.merkleRoot())) throw new Error('Auto-refill root changed before proving');
      const inputs = notes.map((item) => ({ note: item.note, merklePath: tree.path(item.note.leafIndex), ownerSecret })) as [ProofInput] | [ProofInput, ProofInput];
      const totalInput = notes.reduce((sum, item) => sum + item.amount, 0n);
      const publicAmount = totalInput < refillAmount ? totalInput : refillAmount;
      const changeAmount = totalInput - publicAmount;
      const changeNote = changeAmount > 0n ? await createNoteForAddress({
        address: fee.address, token, amount: changeAmount, chainId: Number(chainId),
      }) : undefined;
      // The native gateway decodes ciphertext[0] as the ETH recipient. Change belongs in ciphertext[1].
      const ciphertexts: [string, string, string, string] = [
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [relayer.address]),
        changeNote ? ethers.hexlify(encryptNote(changeNote, fee.address)) : '0x', '0x', '0x',
      ];
      const proof = await createTransferProof({
        inputs, outputs: changeNote ? [changeNote, zeroNote(token)] : [zeroNote(token)],
        zeroInputPath: tree.path(0), publicAmount,
        ciphertextHash: ciphertextHash(ciphertexts), publicRecipient: BigInt(options.gatewayAddress), chainId,
        assets: { wasm: options.wasmPath, zkey: options.zkeyPath },
      });
      if (await requiredRefill(await provider.getBalance(relayer.address)) === 0n) return;
      const args = [proof.solidity, ethers.toBeHex(proof.root, 32), proof.nullifiers.map((value) => ethers.toBeHex(value, 32)),
        proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)), ciphertexts, publicAmount] as const;
      await gateway.unshieldNative.staticCall(...args);
      const transaction = await gateway.unshieldNative(...args);
      console.log(`SWIRL auto-refill submitted ${transaction.hash}; notes=${notes.length}; amount=${ethers.formatEther(publicAmount)} ETH; change=${ethers.formatEther(changeAmount)} ETH`);
      await transaction.wait();
      console.log(`SWIRL auto-refill confirmed; Gas balance=${ethers.formatEther(await provider.getBalance(relayer.address))} ETH`);
    } catch (error) {
      console.error(`SWIRL auto-refill failed: ${errorMessage(error)}`);
    } finally {
      running = false;
    }
  }

  void refill();
  const timer = setInterval(() => void refill(), options.intervalMs ?? 60_000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
