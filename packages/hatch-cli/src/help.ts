import {
  commandDefinitions,
  commandGroups,
  globalOptions,
  type CliCommandDefinition,
} from './commands';
import { CliError } from './error';

type CliCommand = CliCommandDefinition & { supported: boolean };

export type CliCommandGroup = {
  path: readonly string[];
  usage: string;
  description: string;
};

export type CliHelp = {
  /** Path the help is scoped to; empty for the root. */
  scope: readonly string[];
  /** Commands directly at this level, or only the selected command. */
  commands: CliCommand[];
  /** Child groups at this level; their commands are one level down. */
  groups: CliCommandGroup[];
  /** Commands and groups together, in command table order. */
  entries: (CliCommand | CliCommandGroup)[];
};

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => path[index] === part);
const isCommand = (path: readonly string[]) =>
  commandDefinitions.some((d) => d.path.join(' ') === path.join(' '));

/** Whether the words before the first flag name exactly a command group. */
export function namesGroup(words: readonly string[]) {
  const end = words.findIndex((word) => word.startsWith('-'));
  const path = end === -1 ? words : words.slice(0, end);
  return (
    path.length > 0 &&
    !isCommand(path) &&
    commandDefinitions.some((d) => startsWith(d.path, path))
  );
}

const unknownCommand = () =>
  new CliError('unknown_command', 'Unknown command. Use hatch help.');

/**
 * Resolves the help scope from the words after the global options. Words are
 * consumed while they name a deeper group or command; once a command is
 * selected the rest are its arguments. Under a group, a word that names
 * nothing is an unknown command.
 */
export function resolveHelpScope(words: readonly string[]) {
  const scope: string[] = [];
  for (const word of words) {
    if (word.startsWith('-') || (scope.length && isCommand(scope))) break;
    scope.push(word);
    if (!commandDefinitions.some((d) => startsWith(d.path, scope)))
      throw unknownCommand();
  }
  return scope;
}

/** Lists the commands and child groups directly under a scope. */
export function helpFor(scope: readonly string[]): CliHelp {
  const matching = commandDefinitions.filter((d) => startsWith(d.path, scope));
  if (!matching.length) throw unknownCommand();
  const commands: CliCommand[] = [];
  const groups: CliCommandGroup[] = [];
  const entries: CliHelp['entries'] = [];
  for (const definition of matching) {
    if (definition.path.length <= scope.length + 1) {
      commands.push(definition);
      entries.push(definition);
      continue;
    }
    const path = definition.path.slice(0, scope.length + 1);
    const name = path.join(' ');
    if (groups.some((group) => group.path.join(' ') === name)) continue;
    const group = {
      path,
      usage: `${name} <command>`,
      description: commandGroups[name] ?? '',
    };
    groups.push(group);
    entries.push(group);
  }
  return { scope, commands, groups, entries };
}

export function helpText(version: string, help: CliHelp) {
  const list = help.entries
    .map((entry) => `${entry.usage}\n  ${entry.description}`)
    .join('\n');
  const prefix = help.scope.length ? `${help.scope.join(' ')} ` : '';
  const more = help.groups.length
    ? `\n\nUse hatch help ${prefix}<command> to list the commands of a group.`
    : '';
  return `Hatch CLI ${version}\n\n${list}${more}\n\nGlobals: ${globalOptions.join(', ')}`;
}
