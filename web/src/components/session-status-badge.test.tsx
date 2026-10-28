// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SessionStatusBadge } from '@/components/session-status-badge';
import { ActivityController } from '@/session/activity-controller';
import { SessionProvider } from '@/session/session-provider';
import { FakeClock, flush } from '@/test/fake-clock';
import { activeStatus } from '@/test/fixtures';

describe('SessionStatusBadge', () => {
  it('is reachable with the keyboard and explains itself on focus', async () => {
    const controller = new ActivityController({
      clock: new FakeClock(),
      api: {
        start: () => Promise.resolve(activeStatus()),
        ping: () => Promise.resolve(activeStatus()),
      },
    });
    render(
      <SessionProvider controller={controller}>
        <SessionStatusBadge />
      </SessionProvider>,
    );
    await flush();

    await userEvent.tab();
    const badge = screen.getByText('Live');
    expect(badge).toHaveFocus();
    expect(
      (await screen.findAllByText('Updating every 10 seconds while you use this page.')).length,
    ).toBeGreaterThan(0);
  });
});
