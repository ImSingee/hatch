import { describe, expect, it } from 'vitest';
import { commandDefinitions, commandGroups } from './commands';
import { helpFor, namesGroup, resolveHelpScope } from './help';

const groupPaths = [
  ...new Set(
    commandDefinitions.flatMap((definition) =>
      definition.path
        .slice(1)
        .map((_, index) => definition.path.slice(0, index + 1).join(' ')),
    ),
  ),
];

describe('hierarchical help', () => {
  it('describes every command group and keeps groups and commands apart', () => {
    const commands = new Set(commandDefinitions.map((d) => d.path.join(' ')));
    expect(groupPaths.filter((group) => !commandGroups[group])).toEqual([]);
    expect(groupPaths.filter((group) => commands.has(group))).toEqual([]);
    expect(Object.keys(commandGroups).sort()).toEqual([...groupPaths].sort());
  });

  it('reaches every command by walking one level at a time', () => {
    const reached: string[] = [];
    const walk = (scope: readonly string[]) => {
      const help = helpFor(scope);
      for (const command of help.commands) reached.push(command.path.join(' '));
      for (const group of help.groups) walk(group.path);
    };
    walk([]);
    expect(reached.sort()).toEqual(
      commandDefinitions.map((d) => d.path.join(' ')).sort(),
    );
  });

  it('stops at a command and treats later words as its arguments', () => {
    expect(resolveHelpScope(['app', 'get', 'app-1', '--help'])).toEqual([
      'app',
      'get',
    ]);
    expect(helpFor(['app', 'get']).commands).toHaveLength(1);
  });

  it('rejects a word that names nothing under a group', () => {
    for (const words of [['operation'], ['auth', 'key'], ['app', 'kv', 'x']])
      expect(() => resolveHelpScope(words)).toThrow(
        expect.objectContaining({ code: 'unknown_command' }),
      );
  });

  it('recognizes a bare group, which lists its commands', () => {
    expect(namesGroup(['auth'])).toBe(true);
    expect(namesGroup(['app', 'kv', '--json'])).toBe(true);
    expect(namesGroup(['auth', 'status'])).toBe(false);
    expect(namesGroup(['auth', 'foo'])).toBe(false);
  });
});
