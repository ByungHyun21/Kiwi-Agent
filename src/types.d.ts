// Type declarations for text-imported static assets.
declare module "*.css" {
  const content: string;
  export default content;
}
declare module "*.min.js" {
  const content: string;
  export default content;
}
