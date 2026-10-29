import { ethers } from 'ethers';
import type { POIProofResult } from '@swirl/wallet';

export type RelayPayload = {
  proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };
  root: string;
  nullifiers: [string, string];
  outputCommitments: [string, string, string, string];
  ciphertexts: [string, string, string, string];
  publicAmount: string;
  publicRecipient: string;
  quoteId?: string;
  preTransactionPOI?: POIProofResult;
};

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const MAX_CIPHERTEXT_BYTES = 4096;

function integer(value: unknown, name: string): string {
  if (typeof value !== 'string' || !INTEGER.test(value)) throw new Error(`${name} must be a decimal integer string`);
  if (BigInt(value) >= 21888242871839275222246405745257275088548364400416034343698204186575808495617n) {
    throw new Error(`${name} exceeds the BN254 field`);
  }
  return value;
}

function bytes32(value: unknown, name: string): string {
  if (typeof value !== 'string' || !BYTES32.test(value)) throw new Error(`${name} must be 32 bytes`);
  return value;
}

function ciphertext(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error(`${name} must be hex bytes`);
  if ((value.length - 2) / 2 > MAX_CIPHERTEXT_BYTES) throw new Error(`${name} is too large`);
  return value;
}

function tuple<T>(value: unknown, length: number, name: string, validate: (item: unknown, name: string) => T): T[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${name} must contain ${length} items`);
  return value.map((item, index) => validate(item, `${name}[${index}]`));
}

export function validateRelayPayload(value: unknown): RelayPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required');
  const body = value as Record<string, unknown>;
  if (typeof body.proof !== 'object' || body.proof === null) throw new Error('Proof required');
  const proof = body.proof as Record<string, unknown>;
  const publicAmount = integer(body.publicAmount, 'publicAmount');
  if (BigInt(publicAmount) > (1n << 128n) - 1n) throw new Error('publicAmount exceeds 128 bits');
  if (typeof body.publicRecipient !== 'string' || !ethers.isAddress(body.publicRecipient)) throw new Error('Invalid publicRecipient');
  const recipient = ethers.getAddress(body.publicRecipient);
  if ((BigInt(publicAmount) === 0n) !== (recipient === ethers.ZeroAddress)) throw new Error('Withdrawal recipient mismatch');
  if (body.quoteId !== undefined && (typeof body.quoteId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.quoteId))) throw new Error('Invalid quoteId');
  if (body.preTransactionPOI !== undefined && (typeof body.preTransactionPOI !== 'object' || body.preTransactionPOI === null || Array.isArray(body.preTransactionPOI))) {
    throw new Error('Invalid Pre-Transaction POI');
  }
  return {
    proof: {
      a: tuple(proof.a, 2, 'proof.a', integer) as [string, string],
      b: tuple(proof.b, 2, 'proof.b', (row, name) => tuple(row, 2, name, integer)) as [[string, string], [string, string]],
      c: tuple(proof.c, 2, 'proof.c', integer) as [string, string],
    },
    root: bytes32(body.root, 'root'),
    nullifiers: tuple(body.nullifiers, 2, 'nullifiers', bytes32) as [string, string],
    outputCommitments: tuple(body.outputCommitments, 4, 'outputCommitments', bytes32) as [string, string, string, string],
    ciphertexts: tuple(body.ciphertexts, 4, 'ciphertexts', ciphertext) as [string, string, string, string],
    publicAmount,
    publicRecipient: recipient,
    ...(typeof body.quoteId === 'string' ? { quoteId: body.quoteId } : {}),
    ...(typeof body.preTransactionPOI === 'object' && body.preTransactionPOI !== null ? { preTransactionPOI: body.preTransactionPOI as POIProofResult } : {}),
  };
}
