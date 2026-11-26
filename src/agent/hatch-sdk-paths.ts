/** Where the platform-owned SDK lives in a source tree, and its import map. */
import path from 'node:path';
import {
  APP_SDK,
  LEGACY_DATA_SDK,
  sdkImports,
} from '../../sdk-internal/definitions';

export const HATCH_SDK_IMPORT_MAP = '.hatch/import-map.json';
export const HATCH_BUF_GEN_CONFIG = '.hatch/buf.gen.yaml';

export const APP_HATCH_SDK_IMPORTS = sdkImports([APP_SDK, LEGACY_DATA_SDK]);

export function appHatchDataPackageDir(root: string): string {
  return path.join(root, '.hatch', 'sdk', '@hatch', 'data');
}

export function hatchImportMapPath(root: string): string {
  return path.join(root, ...HATCH_SDK_IMPORT_MAP.split('/'));
}
