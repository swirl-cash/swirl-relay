import * as snarkjs from 'snarkjs';
import { ethers } from 'ethers';
import {
  PRE_TRANSACTION_LEAF_INDEX, POINodeClient, createPreTransactionTxidPath, hex32,
  swirlBoundParamsHash, swirlTransactionID, swirlTxidLeaf,
} from '@swirl/wallet';
import type { RelayPayload } from './validation.js';

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;

export type PreTransactionPOIConfig = {
  nodeUrl: string;
  listKey: string;
  verificationKey: unknown;
};

function bytes32(value: unknown, name: string): string {
  if (typeof value !== 'string' || !BYTES32.test(value) || BigInt(value) >= FIELD_SIZE) {
    throw new Error(`${name} must be a BN254 field element encoded as bytes32`);
  }
  return value;
}

function integer(value: unknown, name: string): string {
  if (typeof value !== 'string' || !INTEGER.test(value) || BigInt(value) >= FIELD_SIZE) {
    throw new Error(`${name} must be a BN254 field element`);
  }
  return value;
}

function strings(value: unknown, length: number, name: string): string[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${name} must contain ${length} items`);
  return value.map((item, index) => bytes32(item, `${name}[${index}]`));
}

function sameField(left: string, right: string): boolean {
  return BigInt(left) === BigInt(right);
}

function assertProofShape(proof: unknown): asserts proof is snarkjs.Groth16Proof {
  if (typeof proof !== 'object' || proof === null) throw new Error('Pre-Transaction POI proof is required');
  const candidate = proof as Record<string, unknown>;
  if (candidate.protocol !== 'groth16' || candidate.curve !== 'bn128'
    || !Array.isArray(candidate.pi_a) || candidate.pi_a.length !== 3
    || !Array.isArray(candidate.pi_b) || candidate.pi_b.length !== 3
    || !candidate.pi_b.every((row) => Array.isArray(row) && row.length === 2)
    || !Array.isArray(candidate.pi_c) || candidate.pi_c.length !== 3) {
    throw new Error('Malformed Pre-Transaction POI Groth16 proof');
  }
}

export async function verifyPreTransactionPOI(
  payload: RelayPayload,
  options: PreTransactionPOIConfig & { chainId: number; vault: string; token: string },
): Promise<void> {
  const candidate = payload.preTransactionPOI;
  if (!candidate) throw new Error('Pre-Transaction POI proof is required');
  assertProofShape(candidate.proof);
  if (!Array.isArray(candidate.publicSignals) || candidate.publicSignals.length !== 8) {
    throw new Error('Pre-Transaction POI public signals must contain 8 items');
  }
  const publicSignals = candidate.publicSignals.map((value, index) => integer(value, `publicSignals[${index}]`));
  const blindedCommitmentsOut = strings(candidate.blindedCommitmentsOut, 4, 'blindedCommitmentsOut');
  const poiMerkleRoots = strings(candidate.poiMerkleRoots, 2, 'poiMerkleRoots');
  const txidMerkleRoot = bytes32(candidate.txidMerkleRoot, 'txidMerkleRoot');
  const txidIfHasUnshield = bytes32(candidate.txidIfHasUnshield, 'txidIfHasUnshield');
  const txid = bytes32(candidate.txid, 'txid');
  const txidLeaf = bytes32(candidate.txidLeaf, 'txidLeaf');
  if (!Number.isSafeInteger(candidate.txidMerkleRootIndex) || candidate.txidMerkleRootIndex !== 0) {
    throw new Error('Pre-Transaction POI must use the Dummy TXID tree path');
  }

  // Recompute every transaction binding from the exact payload that will be
  // broadcast. A valid proof for another ciphertext, token, fee or recipient
  // therefore cannot be attached to this request.
  const encodedCiphertexts = ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [payload.ciphertexts]);
  const ciphertextHash = BigInt(ethers.keccak256(encodedCiphertexts)) % FIELD_SIZE;
  const boundParamsHash = await swirlBoundParamsHash({
    ciphertextHash,
    publicAmount: BigInt(payload.publicAmount),
    publicRecipient: BigInt(payload.publicRecipient),
    token: BigInt(options.token),
    chainId: BigInt(options.chainId),
  });
  const expectedTxid = await swirlTransactionID({
    nullifiers: payload.nullifiers.map(BigInt) as [bigint, bigint],
    outputCommitments: payload.outputCommitments.map(BigInt) as [bigint, bigint, bigint, bigint],
    boundParamsHash,
  });
  const expectedLeaf = await swirlTxidLeaf(expectedTxid, PRE_TRANSACTION_LEAF_INDEX);
  const dummyPath = await createPreTransactionTxidPath(expectedLeaf);
  if (!sameField(txid, hex32(expectedTxid)) || !sameField(txidLeaf, hex32(expectedLeaf))
    || !sameField(txidMerkleRoot, hex32(dummyPath.root))) {
    throw new Error('Pre-Transaction POI is not bound to this transaction payload');
  }
  const expectedUnshield = BigInt(payload.publicAmount) > 0n ? expectedTxid : 0n;
  if (!sameField(txidIfHasUnshield, hex32(expectedUnshield))) throw new Error('Invalid Pre-Transaction Unshield TXID');
  const expectedSignals = [
    ...blindedCommitmentsOut, txidMerkleRoot, txidIfHasUnshield, ...poiMerkleRoots,
  ].map((value) => BigInt(value).toString());
  if (publicSignals.some((value, index) => value !== expectedSignals[index])) {
    throw new Error('Pre-Transaction POI public signals do not match its metadata');
  }

  const client = new POINodeClient({
    url: options.nodeUrl, chainId: options.chainId, vault: options.vault, listKey: options.listKey,
  });
  if (!(await client.validatePOIRoots(poiMerkleRoots))) throw new Error('Unknown historical POI Merkle root');
  if (!(await snarkjs.groth16.verify(options.verificationKey, publicSignals, candidate.proof))) {
    throw new Error('Invalid Pre-Transaction POI Groth16 proof');
  }
}
