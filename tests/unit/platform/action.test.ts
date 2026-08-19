import { describe, expect, it } from 'vitest';
import { createActionService } from '@platform/browser/action/service';
import type { WebExtApi } from '@platform/browser/webext';
import { PlatformError } from '@shared/result/errors';
import { createFakeWebExt } from './_fake-webext';

describe('action adapter', () => {
  it('writes badge text/color and title, globally and per-tab', async () => {
    const fake = createFakeWebExt();
    const action = createActionService(fake.api);

    await action.setBadgeText('3', 7);
    await action.setBadgeBackgroundColor('#4C6EF5', 7);
    await action.setTitle('AetherDL', 7);
    await action.setBadgeText('', 9);

    expect(fake.action.badgeText.get(7)).toBe('3');
    expect(fake.action.badgeColor.get(7)).toBe('#4C6EF5');
    expect(fake.action.title.get(7)).toBe('AetherDL');
    expect(fake.action.badgeText.get(9)).toBe('');
  });

  it('applies globally when no tabId is given', async () => {
    const fake = createFakeWebExt();
    const action = createActionService(fake.api);
    await action.setBadgeText('5');
    expect(fake.action.badgeText.get('global')).toBe('5');
  });

  it('enables and disables the action', async () => {
    const fake = createFakeWebExt();
    const action = createActionService(fake.api);
    await action.enable(1);
    await action.disable(2);
    expect(fake.action.enabled.get(1)).toBe(true);
    expect(fake.action.enabled.get(2)).toBe(false);
  });

  it('throws a typed PlatformError when the action namespace is absent', async () => {
    const fake = createFakeWebExt();
    const noAction: WebExtApi = { ...fake.api };
    delete noAction.action;
    const action = createActionService(noAction);
    await expect(action.setBadgeText('1')).rejects.toBeInstanceOf(PlatformError);
  });

  it('wraps a native write failure as a typed PlatformError', async () => {
    const fake = createFakeWebExt();
    const failing = {
      ...fake.api,
      action: {
        ...fake.api.action!,
        setBadgeText: () => Promise.reject(new Error('tab gone')),
      },
    };
    const action = createActionService(failing);
    await expect(action.setBadgeText('1', 1)).rejects.toBeInstanceOf(PlatformError);
  });
});
