/** Names of the NSH runtime files `nsh package` writes (content-addressed). */

// Every runtime file `nsh package` writes carries a content digest in its
// name or in its directory's (`browser.<digest>/runtime.js`).
const RUNTIME_FILE =
  /^(?:browser\.[0-9a-f]{8,}\/[\w.-]+|[\w-]+\.[0-9a-f]{8,}\.(?:js|wasm|bin|css))(?:\.(?:br|gz))?$/;

export function isRuntimeFileName(relative: string): boolean {
  return RUNTIME_FILE.test(relative) && !relative.includes('..');
}
