import { REASON_TEXT } from '@/lib/trip-format';
import type { TripReason } from '@gtfs-rt-debugger/shared';

/** Why a trip is in the "not scheduled this minute" list, in plain words. */
export function ReasonLabel({ reason }: { reason: TripReason | null }) {
  if (reason === null) return <span className="text-muted-foreground">—</span>;
  return <span data-reason={reason}>{REASON_TEXT[reason] ?? reason}</span>;
}
