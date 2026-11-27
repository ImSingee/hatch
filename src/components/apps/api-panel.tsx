import {
  ActionIcon,
  Badge,
  Center,
  Code,
  Collapse,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { IconChevronRight, IconCopy } from '@tabler/icons-react';
import copy from 'copy-to-clipboard';
import { toast } from 'sonner';
import type {
  ApiField,
  ApiMessage,
  ProtoFile,
  RpcMethodApi,
  RpcServiceApi,
} from '~server/apps/manifest';
import { normalizedManifestQueryOptions } from '~queries/apps';
import { Markdownish } from '~components/agent/markdownish';
import { GroupCard, Section } from '~components/page/page';
import { CliCommand } from './cli-command';
import { useI18n } from '~i18n';

/** Local-name of a fully-qualified proto type (drops the package prefix). */
function shortType(fqName: string): string {
  const i = fqName.lastIndexOf('.');
  return i === -1 ? fqName : fqName.slice(i + 1);
}

/** Local-name type with its repeated/map shape, as the field declares it. */
function fieldType(field: ApiField): string {
  if (field.label === 'map') return `map<${field.mapKey}, ${field.type}>`;
  if (field.label === 'repeated') return `repeated ${field.type}`;
  return field.type;
}

function FieldTable({ message }: { message: ApiMessage | undefined }) {
  const { t } = useI18n();
  if (!message) return null;
  if (message.fields.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        {t('api.noFields')}
      </Text>
    );
  }
  return (
    <Table withTableBorder verticalSpacing={4} fz="xs">
      <Table.Tbody>
        {message.fields.map((field) => (
          <Table.Tr key={field.name}>
            <Table.Td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
              <Text size="xs" fw={600} ff="monospace">
                {field.jsonName}
              </Text>
            </Table.Td>
            {/* The description sits under the type so it gets the row's
                width; long nested type names wrap instead of squeezing it. */}
            <Table.Td style={{ verticalAlign: 'top' }}>
              <Group gap={4} wrap="wrap">
                <Text
                  size="xs"
                  c="dimmed"
                  ff="monospace"
                  style={{ overflowWrap: 'anywhere' }}
                >
                  {fieldType(field)}
                </Text>
                {field.label === 'optional' ? (
                  <Badge size="xs" variant="light" color="gray">
                    {t('api.optional')}
                  </Badge>
                ) : null}
                {field.oneof ? (
                  <Badge size="xs" variant="light" color="gray">
                    {t('api.oneof', { name: field.oneof })}
                  </Badge>
                ) : null}
                {field.deprecated ? (
                  <Badge size="xs" variant="light" color="red">
                    {t('api.deprecated')}
                  </Badge>
                ) : null}
              </Group>
              {field.description ? (
                <Markdownish text={field.description} math={false} />
              ) : null}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function MethodBadges({ method }: { method: RpcMethodApi }) {
  const { t } = useI18n();
  return (
    <>
      {method.deprecated ? (
        <Badge size="xs" variant="light" color="red">
          {t('api.deprecated')}
        </Badge>
      ) : null}
      {method.idempotency ? (
        <Tooltip label={t('api.safeToRetry')} withArrow position="top">
          <Badge size="xs" variant="light" color="teal">
            {method.idempotency === 'no_side_effects'
              ? t('api.noSideEffects')
              : t('api.idempotent')}
          </Badge>
        </Tooltip>
      ) : null}
    </>
  );
}

function MethodRow({
  method,
  messages,
}: {
  method: RpcMethodApi;
  messages: Map<string, ApiMessage> | undefined;
}) {
  const { t } = useI18n();
  const [opened, { toggle }] = useDisclosure(false);
  const hasDetails = Boolean(method.description || messages);
  return (
    <>
      <Table.Tr>
        <Table.Td style={{ width: 28 }}>
          {hasDetails ? (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={toggle}
              aria-expanded={opened}
              aria-label={
                opened
                  ? t('api.hideMethod', { name: method.name })
                  : t('api.showMethod', { name: method.name })
              }
            >
              <IconChevronRight
                size={15}
                style={{
                  transform: opened ? 'rotate(90deg)' : 'none',
                  transition: 'transform 120ms ease',
                }}
              />
            </ActionIcon>
          ) : null}
        </Table.Td>
        <Table.Td>
          <Group gap={6} wrap="wrap">
            <Text size="sm" fw={600} ff="monospace">
              {method.name}
            </Text>
            <MethodBadges method={method} />
          </Group>
        </Table.Td>
        <Table.Td>
          <Group gap={6} wrap="nowrap" align="center">
            {method.clientStreaming ? (
              <Badge size="xs" variant="light" color="grape">
                {t('api.stream')}
              </Badge>
            ) : null}
            <Tooltip label={method.inputType} withArrow position="top">
              <Text size="xs" c="dimmed" ff="monospace" truncate>
                {shortType(method.inputType)}
              </Text>
            </Tooltip>
            <Text size="xs" c="dimmed">
              →
            </Text>
            {method.serverStreaming ? (
              <Badge size="xs" variant="light" color="grape">
                {t('api.stream')}
              </Badge>
            ) : null}
            <Tooltip label={method.outputType} withArrow position="top">
              <Text size="xs" c="dimmed" ff="monospace" truncate>
                {shortType(method.outputType)}
              </Text>
            </Tooltip>
          </Group>
        </Table.Td>
      </Table.Tr>
      {hasDetails && opened ? (
        <Table.Tr>
          <Table.Td />
          <Table.Td colSpan={2}>
            <Stack gap="xs" py={4}>
              {method.description ? (
                <Markdownish text={method.description} math={false} />
              ) : null}
              {messages ? (
                <>
                  <Text size="xs" fw={700}>
                    {t('api.request', { type: method.inputType })}
                  </Text>
                  <FieldTable message={messages.get(method.inputType)} />
                  <Text size="xs" fw={700}>
                    {t('api.response', { type: method.outputType })}
                  </Text>
                  <FieldTable message={messages.get(method.outputType)} />
                </>
              ) : null}
            </Stack>
          </Table.Td>
        </Table.Tr>
      ) : null}
    </>
  );
}

function ServiceBlock({
  service,
  messages,
}: {
  service: RpcServiceApi;
  messages: Map<string, ApiMessage> | undefined;
}) {
  const { t } = useI18n();
  return (
    <Stack gap={6}>
      <Group gap={8} wrap="nowrap" align="baseline">
        <Text fw={700} size="sm" ff="monospace">
          {service.name}
        </Text>
        <Text size="xs" c="dimmed">
          {t('api.methods', { count: service.methods.length })}
        </Text>
      </Group>
      {service.description ? (
        <Markdownish text={service.description} math={false} />
      ) : null}
      {service.methods.length === 0 ? (
        <Text size="xs" c="dimmed">
          {t('api.noMethods')}
        </Text>
      ) : (
        <Table withTableBorder verticalSpacing={6} highlightOnHover>
          <Table.Tbody>
            {service.methods.map((m) => (
              <MethodRow key={m.name} method={m} messages={messages} />
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function ProtoSource({ file }: { file: ProtoFile }) {
  const { t } = useI18n();
  const [opened, { toggle }] = useDisclosure(false);
  return (
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap" align="center">
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          onClick={toggle}
          aria-label={
            opened
              ? t('api.hideFile', { path: file.path })
              : t('api.showFile', { path: file.path })
          }
        >
          <IconChevronRight
            size={15}
            style={{
              transform: opened ? 'rotate(90deg)' : 'none',
              transition: 'transform 120ms ease',
            }}
          />
        </ActionIcon>
        <Text
          size="xs"
          ff="monospace"
          c="dimmed"
          style={{ cursor: 'pointer' }}
          onClick={toggle}
        >
          {file.path}
        </Text>
        <Tooltip label={t('api.copyProto')} withArrow position="top">
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={t('api.copyFile', { path: file.path })}
            onClick={() => {
              copy(file.content);
              toast.success(t('api.protoCopied'));
            }}
          >
            <IconCopy size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Collapse expanded={opened}>
        <Code
          block
          style={{ fontSize: 'var(--mantine-font-size-xs)', whiteSpace: 'pre' }}
        >
          {file.content}
        </Code>
      </Collapse>
    </Stack>
  );
}

/**
 * Shows the RPC API the app declares via its proto: every service + method
 * with the authors' comments, `deprecated` and `idempotency_level`, each
 * method's request and response fields, plus the raw `.proto` sources
 * captured at deploy time. Self-hides for apps that
 * don't expose an RPC service.
 */
export function ApiPanel({ appId, slug }: { appId: string; slug: string }) {
  const { t } = useI18n();
  const query = useQuery(normalizedManifestQueryOptions(appId));

  if (query.isLoading) {
    return (
      <Section id="api" title={t('api.title')}>
        <GroupCard padded>
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        </GroupCard>
      </Section>
    );
  }

  const manifest = query.data;
  const api = manifest?.api;
  const messages = api?.types
    ? new Map(api.types.messages.map((message) => [message.name, message]))
    : undefined;

  return (
    <Section id="api" title={t('api.title')}>
      <GroupCard padded>
        {!manifest ? (
          <Text size="sm" c="dimmed">
            {t('api.notDeployed')}
          </Text>
        ) : (
          <Stack gap="lg">
            {!api || api.services.length === 0 ? (
              <Text size="sm" c="dimmed">
                {t('api.noServices')}
              </Text>
            ) : (
              <>
                <Stack gap={4}>
                  <Text size="sm" c="dimmed">
                    {t('api.servicesIntro')}
                  </Text>
                  {manifest.rpc ? (
                    <CliCommand command={`hatch app docs rpc ${slug}`} />
                  ) : null}
                  {api.types ? null : (
                    <Text size="xs" c="dimmed">
                      {t('api.incomplete')}
                    </Text>
                  )}
                </Stack>
                {api.services.map((service) => (
                  <ServiceBlock
                    key={service.name}
                    service={service}
                    messages={messages}
                  />
                ))}
                {api.protoFiles.length > 0 ? (
                  <Stack gap={6}>
                    <Text fw={700} size="sm">
                      {t('api.protoSource')}
                    </Text>
                    {api.protoFiles.map((file) => (
                      <ProtoSource key={file.path} file={file} />
                    ))}
                  </Stack>
                ) : null}
              </>
            )}
          </Stack>
        )}
      </GroupCard>
    </Section>
  );
}
