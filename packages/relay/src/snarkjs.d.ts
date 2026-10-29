declare module 'snarkjs' {
  export type Groth16Proof = {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  export const groth16: {
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
}
