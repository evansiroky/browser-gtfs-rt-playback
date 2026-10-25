import { LoaderCircle, OctagonX, Pause, TriangleAlert, WifiOff } from 'lucide-react';
import type { ComponentType } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useNowSeconds } from '@/lib/use-now';
import { selectBanner, type BannerModel } from '@/session/banner';
import { useSession } from '@/session/use-session';

const ICONS: Record<BannerModel['id'], ComponentType> = {
  ended: OctagonX,
  'paused-idle': Pause,
  'paused-hidden': Pause,
  unreachable: WifiOff,
  'schedule-failed': TriangleAlert,
  'schedule-loading': LoaderCircle,
  'stale-feed': TriangleAlert,
};

/** Presentational: renders one banner model. */
export function SessionBannerView({
  banner,
  onAction,
}: {
  banner: BannerModel;
  onAction: () => void;
}) {
  const Icon = ICONS[banner.id];
  return (
    <Alert
      // Errors interrupt (assertive role="alert"); paused, loading and stale notices are polite.
      role={banner.tone === 'error' ? 'alert' : 'status'}
      variant={banner.tone === 'error' ? 'destructive' : 'default'}
      data-banner={banner.id}
    >
      <Icon />
      <AlertTitle className="line-clamp-none">{banner.title}</AlertTitle>
      {(banner.description || banner.note) && (
        <AlertDescription>
          {banner.description}
          {banner.note && <span className="font-medium">{banner.note}</span>}
        </AlertDescription>
      )}
      {banner.action && (
        <div className="col-start-2 mt-2">
          <Button
            size="sm"
            variant={banner.tone === 'error' ? 'destructive' : 'default'}
            onClick={onAction}
          >
            {banner.action.label}
          </Button>
        </div>
      )}
    </Alert>
  );
}

/** The session banner for the current page, or nothing. */
export function SessionBanner() {
  const { phase, status, error, restartFailed, restart } = useSession();
  const now = useNowSeconds();
  const banner = selectBanner({ phase, status, error, restartFailed }, now);
  return banner ? <SessionBannerView banner={banner} onAction={restart} /> : null;
}
