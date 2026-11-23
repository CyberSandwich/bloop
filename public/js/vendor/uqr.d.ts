// Types for the vendored uqr.js, only the part bloop calls. The vendored file stays unmodified.
export interface QrCode {
  version: number;
  maskPattern: number;
  size: number;
  /** Dark modules are true; the border is included. */
  data: boolean[][];
}
export interface QrOptions {
  ecc?: "L" | "M" | "Q" | "H";
  boostEcc?: boolean;
  minVersion?: number;
  maxVersion?: number;
  maskPattern?: number;
  border?: number;
}
export function encode(data: string, options?: QrOptions): QrCode;
