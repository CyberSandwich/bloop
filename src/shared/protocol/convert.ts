// The conversion job (ADR 0019).

/** What starts one conversion in its Converter object (ADR 0019): ids only, never file bytes or an address. */
export interface ConvertParams {
  fileId: string;
  version: number;
  attempt: number;
  profile: string;
  scope: string;
}
