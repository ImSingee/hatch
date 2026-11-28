/** Read an App's declared API from a build package. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import {
  FileDescriptorSetSchema,
  type FileDescriptorSet,
} from '@bufbuild/protobuf/wkt';
import type { AppApi, ProtoFile } from '../server/apps/manifest';
import { describeApi } from './api-reference';
import {
  BUILD_PACKAGE_API_DESCRIPTOR,
  BUILD_PACKAGE_PROTO_DIR,
} from './format';

/** Every `.proto` in the package, as the App's `proto/` paths. */
async function readProtoFiles(root: string): Promise<ProtoFile[]> {
  const protoRoot = path.join(root, BUILD_PACKAGE_PROTO_DIR);
  const files: ProtoFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.proto')) {
        files.push({
          path: path.posix.join(
            'proto',
            path.relative(protoRoot, full).split(path.sep).join('/'),
          ),
          content: await fs.readFile(full, 'utf8'),
        });
      }
    }
  }
  await walk(protoRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * The API a package declares: services and methods exactly as the wire sees
 * them and the types they use, with their proto comments, from the compiled
 * descriptor set, plus the raw proto sources.
 */
export async function readAppApi(
  root: string,
): Promise<{ api: AppApi; descriptors: FileDescriptorSet }> {
  const descriptors = fromBinary(
    FileDescriptorSetSchema,
    await fs.readFile(path.join(root, BUILD_PACKAGE_API_DESCRIPTOR)),
  );
  return {
    api: {
      ...describeApi(descriptors),
      protoFiles: await readProtoFiles(root),
    },
    descriptors,
  };
}
