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
    expect(screen.getByRole('status')).toHaveTextContent('Paused — tab hidden');
    expect(screen.getByRole('status')).toHaveTextContent(/press a key to resume/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('paused (idle)', () => {
    renderState('paused-idle', activeStatus());
    expect(screen.getByRole('status')).toHaveTextContent('Paused — no activity for a minute');
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
    expect(screen.getByRole('status')).toHaveTextContent('Downloading the schedule…');
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
    expect(screen.getByRole('status')).toHaveTextContent('Trip updates feed is stale.');
    expect(screen.getByRole('status')).toHaveTextContent('last successful update');
  });
});

describe('live-region semantics', () => {
  const role = (banner: ReturnType<typeof selectBanner>) => {
    if (!banner) throw new Error('expected a banner');
    const { unmount } = render(<SessionBannerView banner={banner} onAction={() => {}} />);
    const element = document.querySelector('[data-banner]')!;
    const result = {
      role: element.getAttribute('role'),
      ariaLive: element.getAttribute('aria-live'),
    };
    unmount();
    return result;
  };
  const stale = activeStatus({
    realtime: { vehiclePositions: feed({ stale: true }), tripUpdates: null },
  });
  const failed = activeStatus({
    schedule: { state: 'failed', loadedAt: null, error: null },
  });
  const loading = activeStatus({ schedule: { state: 'loading', loadedAt: null, error: null } });

  it('errors are assertive alerts', () => {
    const down = new ApiError('network', 'x');
    expect(role(selectBanner({ phase: 'engaged', status: failed, error: null }, NOW))).toEqual({
      role: 'alert',
      ariaLive: null,
    });
    expect(
      role(selectBanner({ phase: 'engaged', status: activeStatus(), error: down }, NOW)),
    ).toEqual({
      role: 'alert',
      ariaLive: null,
    });
    expect(
      role(
        selectBanner({ phase: 'ended', status: dormantStatus('max-duration'), error: null }, NOW),
      ),
    ).toEqual({ role: 'alert', ariaLive: null });
  });

  it('paused, loading and stale notices are polite status regions, not alerts', () => {
    for (const banner of [
      selectBanner({ phase: 'paused-idle', status: activeStatus(), error: null }, NOW),
      selectBanner({ phase: 'paused-hidden', status: activeStatus(), error: null }, NOW),
      selectBanner({ phase: 'engaged', status: loading, error: null }, NOW),
      selectBanner({ phase: 'engaged', status: stale, error: null }, NOW),
    ]) {
      expect(role(banner)).toEqual({ role: 'status', ariaLive: null });
    }
  });
});

describe('failed Restart feedback', () => {
  it('shows the note inside the ended banner and clears it on the next attempt', async () => {
    const clock = new FakeClock();
    const pending: { resolve: (s: SessionStatus) => void; reject: (e: unknown) => void }[] = [];
    const next = () =>
      new Promise<SessionStatus>((resolve, reject) => pending.push({ resolve, reject }));
    const controller = new ActivityController({ clock, api: { start: next, ping: next } });

    render(
      <SessionProvider controller={controller}>
        <SessionBanner />
      </SessionProvider>,
    );
    pending[0]!.resolve(dormantStatus('max-duration'));
    await screen.findByRole('alert');
    expect(screen.queryByText(/Restart failed/)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    pending[1]!.reject(new ApiError('network', 'down'));
    expect(
      await screen.findByText("Restart failed — can't reach the server. Try again."),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Session ended');

    await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(screen.queryByText(/Restart failed/)).toBeNull();
    pending[2]!.resolve(activeStatus());
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
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
