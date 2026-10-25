import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Button asChild variant="outline" size="sm">
        <Link to="/">Back to the dashboard</Link>
      </Button>
    </div>
  );
}
