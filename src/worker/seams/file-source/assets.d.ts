// wrangler.jsonc `rules` import .pptx and .pdf files as raw bytes (Data modules).
declare module "*.pptx" {
  const bytes: ArrayBuffer;
  export default bytes;
}
declare module "*.pdf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
