// Ambient shim so the plain TypeScript language server can resolve `*.vue`
// imports. vue-tsc derives precise component types directly from the SFCs, but
// the editor's TS server relies on this fallback declaration.
declare module "*.vue" {
  const component: import("vue").DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
