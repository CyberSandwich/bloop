// The library, uploads and conversion errors (ADRs 0013, 0017, 0019).

/** The library, uploads and conversion (ADRs 0013, 0017, 0019). */
export type LibraryError =
  | "quota_exceeded"
  | "library_full"
  | "upload_not_found"
  | "upload_expired"
  | "part_invalid"
  | "size_mismatch"
  | "file_disabled"
  | "convert_unavailable"
  | "encrypted"
  | "upload_busy"
  | "upload_gone"
  | "up_next_full"
  | "export_busy"
  | "export_limit"
  | "export_paused";
