// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AppRoutes } from '@/app';
import { ActivityController } from '@/session/activity-controller';
import { SessionProvider } from '@/session/session-provider';
import { FakeClock } from '@/test/fake-clock';
import { activeStatus, dormantStatus } from '@/test/fixtures';

function renderAt(path: string, status = activeStatus()) {
  const controller = new ActivityController({
    clock: new FakeClock(),
    api: {
      start: () => Promise.resolve(status),
      ping: () => Promise.resolve(status),
    },
  });
  return render(
    <SessionProvider controller={controller}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SessionProvider>,
  );
}

describe('app shell routes', () => {
  it('renders the dashboard placeholder at /', async () => {
    renderAt('/');
    expect(screen.getByRole('link', { name: /GTFS-RT Debugger/ })).toHaveAttribute('href', '/');
    expect(
      screen.getByText('Dashboard', { selector: '[data-slot=card-title]' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });

  it('renders the trip placeholder with the decoded trip ID and a way back', () => {
    renderAt('/trips/route%2F12%20A');
    expect(screen.getByText('Trip route/12 A')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dashboard/ })).toHaveAttribute('href', '/');
  });

  it('shows the session banner above the page', async () => {
    renderAt('/', dormantStatus('max-duration'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Session ended');
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
  });

  it('renders not-found for unknown paths', () => {
    renderAt('/nope');
    expect(screen.getByText('Page not found')).toBeInTheDocument();
  });
});
