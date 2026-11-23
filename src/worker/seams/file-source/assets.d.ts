// wrangler.jsonc `rules` import the demo files as raw bytes (Data modules).
declare module "*.pptx" {
  const bytes: ArrayBuffer;
  export default bytes;
}
declare module "*.pdf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
declare module "*.jpg" {
  const bytes: ArrayBuffer;
  export default bytes;
}
