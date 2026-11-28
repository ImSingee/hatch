/** Read the source comment attached to a protobuf descriptor. */
import type {
  DescEnum,
  DescEnumValue,
  DescField,
  DescFile,
  DescMessage,
  DescMethod,
  DescService,
} from '@bufbuild/protobuf';

type Commented =
  | DescMessage
  | DescField
  | DescEnum
  | DescEnumValue
  | DescService
  | DescMethod;

/** Source-code-info path of a descriptor inside its file. */
function sourcePath(desc: Commented): number[] {
  switch (desc.kind) {
    case 'message':
      return desc.parent
        ? [
            ...sourcePath(desc.parent),
            3,
            desc.parent.proto.nestedType.indexOf(desc.proto),
          ]
        : [4, desc.file.proto.messageType.indexOf(desc.proto)];
    case 'enum':
      return desc.parent
        ? [
            ...sourcePath(desc.parent),
            4,
            desc.parent.proto.enumType.indexOf(desc.proto),
          ]
        : [5, desc.file.proto.enumType.indexOf(desc.proto)];
    case 'enum_value':
      return [
        ...sourcePath(desc.parent),
        2,
        desc.parent.proto.value.indexOf(desc.proto),
      ];
    case 'field':
      return [
        ...sourcePath(desc.parent),
        2,
        desc.parent.proto.field.indexOf(desc.proto),
      ];
    case 'service':
      return [6, desc.file.proto.service.indexOf(desc.proto)];
    case 'rpc':
      return [
        ...sourcePath(desc.parent),
        2,
        desc.parent.proto.method.indexOf(desc.proto),
      ];
  }
}

const locationsByFile = new WeakMap<
  DescFile,
  Map<string, { leading: string; trailing: string }>
>();

function locations(file: DescFile) {
  let map = locationsByFile.get(file);
  if (!map) {
    map = new Map();
    for (const location of file.proto.sourceCodeInfo?.location ?? []) {
      map.set(location.path.join(','), {
        leading: location.leadingComments ?? '',
        trailing: location.trailingComments ?? '',
      });
    }
    locationsByFile.set(file, map);
  }
  return map;
}

/**
 * The comment written on a descriptor, as Markdown: the leading comment, or
 * the trailing one when there is none. Each line loses the single space after
 * `//`, buf lint directives are dropped, and blank edges are trimmed.
 * Detached comments (separated by a blank line) are not part of it.
 */
export function protoComment(desc: Commented): string | undefined {
  const file =
    desc.kind === 'enum_value' || desc.kind === 'rpc' || desc.kind === 'field'
      ? desc.parent.file
      : desc.file;
  const location = locations(file).get(sourcePath(desc).join(','));
  const raw = location?.leading.trim() ? location.leading : location?.trailing;
  if (!raw) return undefined;
  const lines = raw
    .split('\n')
    .map((line) => (line.startsWith(' ') ? line.slice(1) : line).trimEnd())
    .filter((line) => !line.trimStart().startsWith('buf:lint:'));
  const text = lines.join('\n').trim();
  return text || undefined;
}
