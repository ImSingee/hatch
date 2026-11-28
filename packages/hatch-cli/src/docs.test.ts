import { describe, expect, it } from 'vitest';
import { parseDocsCommand } from './docs';

const parse = (...args: string[]) =>
  parseDocsCommand(['app', 'docs', ...args], 0).command;

describe('hatch app docs arguments', () => {
  it('maps list and get to the App and doc they name', () => {
    expect(parse('list', 'orders')).toEqual({
      kind: 'list',
      app: 'orders',
      page: { limit: 0, cursor: undefined },
    });
    expect(parse('list', 'orders', '--limit', '5', '--cursor', '10')).toEqual({
      kind: 'list',
      app: 'orders',
      page: { limit: 5, cursor: '10' },
    });
    expect(parse('get', 'orders', 'order-webhook', '--json')).toEqual({
      kind: 'get',
      app: 'orders',
      docId: 'order-webhook',
    });
    expect(parse('rpc', 'orders', '--json')).toEqual({
      kind: 'rpc',
      app: 'orders',
    });
  });

  it.each([
    [['show', 'orders']],
    [['list']],
    [['list', 'a', 'b']],
    [['list', 'orders', '--limit', '0']],
    [['list', 'orders', '--limit', '101']],
    [['list', 'orders', '--cursor', 'abc']],
    [['get', 'orders']],
    [['get', 'orders', 'a', 'b']],
    [['get', 'orders', 'Bad_Id']],
    [['get', 'orders', 'a', '--limit', '5']],
    [['rpc']],
    [['rpc', 'orders', 'extra']],
    [['rpc', 'orders', '--limit', '5']],
  ])('rejects %j before any request', (args) => {
    expect(() => parse(...args)).toThrow(
      expect.objectContaining({ code: 'invalid_arguments' }),
    );
  });
});
