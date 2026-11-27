/** What the native App player passes the App at launch (`host.params`). */
import { describe, expect, it } from 'vitest';
import { launchParams } from '../../../../sdk-internal/app/src/native-player';

describe('the native player launch parameters', () => {
  it('passes the platform the Mobile app names in the address', () => {
    expect(launchParams('/notes', '?platform=ios')).toEqual({
      route: '/notes',
      platform: 'ios',
    });
    expect(launchParams('', '?platform=android')).toEqual({
      route: '',
      platform: 'android',
    });
  });

  it('passes the route alone in a browser and for any other platform', () => {
    for (const search of [
      '',
      '?x=1',
      '?platform=',
      '?platform=web',
      '?platform=windows',
      '?platform=IOS',
    ])
      expect(launchParams('/a', search)).toEqual({ route: '/a' });
  });
});
