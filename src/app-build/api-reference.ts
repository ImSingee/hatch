/**
 * Describe an App's RPC API for its reference docs: services, methods and the
 * types they use, with the authors' proto comments and protobuf's built-in
 * `deprecated` / `idempotency_level` options. Comments are the only way to
 * annotate the API; there are no platform-specific options for it.
 */
import {
  ScalarType,
  createFileRegistry,
  type DescEnum,
  type DescField,
  type DescMessage,
  type DescMethod,
} from '@bufbuild/protobuf';
import {
  MethodOptions_IdempotencyLevel,
  type FileDescriptorSet,
} from '@bufbuild/protobuf/wkt';
import type {
  ApiEnum,
  ApiField,
  ApiMessage,
  ApiTypes,
  RpcIdempotency,
  RpcMethodApi,
  RpcServiceApi,
} from '../server/apps/manifest';
import { protoComment } from './proto-comments';

const WELL_KNOWN_PREFIX = 'google.protobuf.';

function scalarName(type: ScalarType): string {
  return ScalarType[type].toLowerCase();
}

function idempotency(method: DescMethod): RpcIdempotency | undefined {
  switch (method.idempotency) {
    case MethodOptions_IdempotencyLevel.NO_SIDE_EFFECTS:
      return 'no_side_effects';
    case MethodOptions_IdempotencyLevel.IDEMPOTENT:
      return 'idempotent';
    default:
      return undefined;
  }
}

/** Optional keys are omitted rather than set to `undefined` (jsonb-safe). */
function notes(
  desc: Parameters<typeof protoComment>[0] & { deprecated: boolean },
) {
  const description = protoComment(desc);
  return {
    ...(description ? { description } : {}),
    ...(desc.deprecated ? { deprecated: true as const } : {}),
  };
}

function methodApi(method: DescMethod): RpcMethodApi {
  const level = idempotency(method);
  const { description, deprecated } = notes(method);
  return {
    name: method.name,
    ...(description ? { description } : {}),
    inputType: method.input.typeName,
    outputType: method.output.typeName,
    clientStreaming:
      method.methodKind === 'client_streaming' ||
      method.methodKind === 'bidi_streaming',
    serverStreaming:
      method.methodKind === 'server_streaming' ||
      method.methodKind === 'bidi_streaming',
    ...(deprecated ? { deprecated } : {}),
    ...(level ? { idempotency: level } : {}),
  };
}

type Value =
  | { kind: 'scalar'; type: string }
  | { kind: 'enum'; type: string; desc: DescEnum }
  | { kind: 'message'; type: string; desc: DescMessage };

function fieldValue(field: DescField): Value {
  const kind =
    field.fieldKind === 'list'
      ? field.listKind
      : field.fieldKind === 'map'
        ? field.mapKind
        : field.fieldKind;
  switch (kind) {
    case 'scalar':
      return { kind, type: scalarName(field.scalar!) };
    case 'enum':
      return { kind, type: field.enum!.typeName, desc: field.enum! };
    case 'message':
      return { kind, type: field.message!.typeName, desc: field.message! };
  }
}

function fieldApi(field: DescField): { api: ApiField; value: Value } {
  const value = fieldValue(field);
  const label =
    field.fieldKind === 'list'
      ? 'repeated'
      : field.fieldKind === 'map'
        ? 'map'
        : field.proto.proto3Optional
          ? 'optional'
          : 'single';
  const { description, deprecated } = notes(field);
  return {
    value,
    api: {
      name: field.name,
      jsonName: field.jsonName,
      kind: value.kind,
      type: value.type,
      label,
      ...(field.fieldKind === 'map'
        ? { mapKey: scalarName(field.mapKey) }
        : {}),
      ...(field.oneof ? { oneof: field.oneof.name } : {}),
      ...(description ? { description } : {}),
      ...(deprecated ? { deprecated } : {}),
    },
  };
}

/** App messages and enums reachable from the methods, in discovery order. */
function collectTypes(roots: DescMessage[]): ApiTypes {
  const messages: ApiMessage[] = [];
  const enums: ApiEnum[] = [];
  const seen = new Set<string>();
  const queue: (DescMessage | DescEnum)[] = [...roots];
  while (queue.length > 0) {
    const desc = queue.shift()!;
    if (seen.has(desc.typeName)) continue;
    seen.add(desc.typeName);
    if (desc.typeName.startsWith(WELL_KNOWN_PREFIX)) continue;
    if (desc.kind === 'enum') {
      enums.push({
        name: desc.typeName,
        ...notes(desc),
        values: desc.values.map((value) => ({
          name: value.name,
          number: value.number,
          ...notes(value),
        })),
      });
      continue;
    }
    const fields = desc.fields.map((field) => {
      const { api, value } = fieldApi(field);
      if (value.kind !== 'scalar') queue.push(value.desc);
      return api;
    });
    messages.push({ name: desc.typeName, ...notes(desc), fields });
  }
  return { messages, enums };
}

/** Services, methods and their types from a compiled descriptor set. */
export function describeApi(set: FileDescriptorSet): {
  services: RpcServiceApi[];
  types: ApiTypes;
} {
  const registry = createFileRegistry(set);
  const services: RpcServiceApi[] = [];
  const roots: DescMessage[] = [];
  for (const proto of set.file) {
    const file = registry.getFile(proto.name);
    if (!file) continue;
    for (const service of file.services) {
      services.push({
        name: service.typeName,
        ...notes(service),
        methods: service.methods.map(methodApi),
      });
      for (const method of service.methods) {
        roots.push(method.input, method.output);
      }
    }
  }
  return { services, types: collectTypes(roots) };
}
