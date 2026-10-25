import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Placeholder: the content arrives with the trip-detail-screen plan. */
export function TripDetailPage() {
  // The router has already percent-decoded the segment.
  const { tripId } = useParams<{ tripId: string }>();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/">
            <ArrowLeft aria-hidden />
            Dashboard
          </Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="break-all">Trip {tripId}</CardTitle>
          <CardDescription>
            Schedule rows, the latest trip update, the map and vehicle positions will appear here.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-48" />
        </CardContent>
      </Card>
    </div>
  );
}
