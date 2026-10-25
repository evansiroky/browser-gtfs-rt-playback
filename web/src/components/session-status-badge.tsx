import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ActivityPhase } from '@/session/activity-controller';
import { useSession } from '@/session/use-session';

const LABELS: Record<ActivityPhase, { label: string; hint: string; className: string }> = {
  starting: {
    label: 'Connecting',
    hint: 'Starting the session on the server.',
    className: 'bg-amber-500',
  },
  engaged: {
    label: 'Live',
    hint: 'Updating every 10 seconds while you use this page.',
    className: 'bg-emerald-500',
  },
  'paused-hidden': {
    label: 'Paused',
    hint: 'Updates stop while the tab is hidden.',
    className: 'bg-muted-foreground',
  },
  'paused-idle': {
    label: 'Paused',
    hint: 'Updates stop after a minute without activity; any interaction resumes them.',
    className: 'bg-muted-foreground',
  },
  ended: {
    label: 'Ended',
    hint: 'The session reached its maximum running time.',
    className: 'bg-destructive',
  },
};

/** Compact session state for the header. */
export function SessionStatusBadge() {
  const { phase } = useSession();
  const { label, hint, className } = LABELS[phase];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="cursor-default gap-1.5" data-phase={phase}>
          <span aria-hidden className={`size-2 rounded-full ${className}`} />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
