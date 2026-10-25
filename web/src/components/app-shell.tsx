import { Bus } from 'lucide-react';
import { Link, Outlet } from 'react-router';
import { SessionBanner } from '@/components/session-banner';
import { SessionStatusBadge } from '@/components/session-status-badge';
import { Separator } from '@/components/ui/separator';

/** Header, the session banner above everything else, then the routed page. */
export function AppShell() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <Bus aria-hidden className="size-5" />
            <span>GTFS-RT Debugger</span>
          </Link>
          <Separator orientation="vertical" className="data-[orientation=vertical]:h-5" />
          <div className="ml-auto">
            <SessionStatusBadge />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 py-4">
        <SessionBanner />
        <Outlet />
      </main>
    </div>
  );
}
