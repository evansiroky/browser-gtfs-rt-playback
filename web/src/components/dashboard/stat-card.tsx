import { Skeleton } from '@/components/ui/skeleton';

/**
 * One statistic: the last known number, or a placeholder while there is none. `whenMissing`
 * says why a null value is missing: the feed is not configured, or its first snapshot (or the
 * schedule) has not arrived yet.
 */
export function StatCard({
  id,
  label,
  value,
  whenMissing = 'loading',
}: {
  id: string;
  label: string;
  value: number | null;
  whenMissing?: 'loading' | 'not-configured';
}) {
  return (
    <div data-stat={id} className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">
        {value !== null ? (
          value
        ) : whenMissing === 'not-configured' ? (
          <span className="text-base font-normal text-muted-foreground">Not configured</span>
        ) : (
          <Skeleton role="status" aria-label="Loading" className="mt-1 h-7 w-16" />
        )}
      </dd>
    </div>
  );
}
