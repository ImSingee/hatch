/** Build pipelines for authored source, one per dependency lockfile family. */
import type {
  SourceToolchain,
  SourceToolchainContext,
  SourceToolchainName,
} from '../source-toolchain';
import { createDenoToolchain } from './deno';
import { createNodeToolchain } from './node';

export function createSourceToolchain(
  name: SourceToolchainName,
  context: SourceToolchainContext,
): SourceToolchain {
  return name === 'node'
    ? createNodeToolchain(context)
    : createDenoToolchain(context);
}
