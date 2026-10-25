// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { SessionBanner, SessionBannerView } from '@/components/session-banner';
import { ActivityController } from '@/session/activity-controller';
import { SessionProvider } from '@/session/session-provider';
import { selectBanner } from '@/session/banner';
import { FakeClock, flush } from '@/test/fake-clock';
import { activeStatus, dormantStatus, feed, NOW } from '@/test/fixtures';
import type { SessionStatus } from '@gtfs-rt-debugger/shared';

function renderState(
  phase: 'engaged' | 'paused-hidden' | 'paused-idle' | 'ended',
  status: SessionStatus | null,
  error: Error | null = null,
) {
  const banner = selectBanner({ phase, status, error }, NOW);
  if (!banner) throw new Error('expected a banner');
  const onAction = vi.fn();
  render(<SessionBannerView banner={banner} onAction={onAction} />);
  return onAction;
}

describe('SessionBannerView', () => {
  it('paused (tab hidden)', () => {
    renderState('paused-hidden', activeStatus());
    expect(screen.getByRole('alert')).toHaveTextContent('Paused — tab hidden');
    expect(screen.getByRole('alert')).toHaveTextContent(/press a key to resume/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('paused (idle)', () => {
    renderState('paused-idle', activeStatus());
    expect(screen.getByRole('alert')).toHaveTextContent('Paused — no activity for a minute');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ended, with a Restart action', async () => {
    const onAction = renderState('ended', dormantStatus('max-duration'));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Session ended after the maximum running time.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('unreachable', () => {
    renderState('engaged', activeStatus(), new ApiError('network', 'x'));
    expect(screen.getByRole('alert')).toHaveTextContent("Can't reach the server.");
    expect(screen.getByRole('alert')).toHaveTextContent(/last data received/);
  });

  it('schedule loading', () => {
    renderState(
      'engaged',
      activeStatus({ schedule: { state: 'loading', loadedAt: null, error: null } }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Downloading the schedule…');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('schedule failed, with a Retry action', async () => {
    const onAction = renderState(
      'engaged',
      activeStatus({
        schedule: {
          state: 'failed',
          loadedAt: null,
          error: { code: 'timeout', message: 'The schedule download timed out.' },
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The schedule download timed out.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('stale feed', () => {
    renderState(
      'engaged',
      activeStatus({
        realtime: {
          vehiclePositions: feed(),
          tripUpdates: feed({ stale: true, lastSuccessAt: NOW - 90 }),
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Trip updates feed is stale.');
    expect(screen.getByRole('alert')).toHaveTextContent('last successful update');
  });
});

describe('SessionBanner (connected to a controller)', () => {
  it('shows nothing until there is something to say, and Restart starts the session', async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    let respond: (status: SessionStatus) => void = () => {};
    const controller = new ActivityController({
      clock,
      api: {
        start: () => {
          calls.push('start');
          return new Promise((resolve) => (respond = resolve));
        },
        ping: () => {
          calls.push('ping');
          return new Promise((resolve) => (respond = resolve));
        },
      },
    });

    render(
      <SessionProvider controller={controller}>
        <SessionBanner />
      </SessionProvider>,
    );
    expect(calls).toEqual(['start']);
    expect(screen.queryByRole('alert')).toBeNull();

    respond(dormantStatus('max-duration'));
    await flush();
    expect(await screen.findByRole('alert')).toHaveTextContent('Session ended');

    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(calls).toEqual(['start', 'start']);
    respond(activeStatus());
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
