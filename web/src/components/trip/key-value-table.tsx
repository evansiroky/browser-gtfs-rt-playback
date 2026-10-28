import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface KeyValueRow {
  key: string;
  value: ReactNode;
}

export interface KeyValueSection {
  /** A label row above the rows, for the values computed from the feed rather than read from it. */
  heading?: string;
  /** The names are the feed's own column names, set in monospace. Default true. */
  columns?: boolean;
  rows: KeyValueRow[];
}

/** A column that is present in the feed but empty says so, rather than showing a blank cell. */
function Value({ value }: { value: ReactNode }) {
  return value === '' ? <span className="text-muted-foreground italic">(empty)</span> : value;
}

/** Name and value, one row each; the names are the feed's own column names. */
export function KeyValueTable({ label, sections }: { label: string; sections: KeyValueSection[] }) {
  return (
    <table aria-label={label} className="w-full text-left text-sm">
      {sections.map((section, index) => (
        <tbody key={index} className={index > 0 ? 'border-t' : undefined}>
          {section.heading && (
            <tr>
              <th colSpan={2} scope="colgroup" className="pt-3 pb-1 text-xs font-medium">
                {section.heading}
              </th>
            </tr>
          )}
          {section.rows.map((row) => (
            <tr key={row.key} data-key={row.key} className="align-top">
              <th
                scope="row"
                className={cn(
                  'w-2/5 py-1 pr-3 text-xs font-normal break-words text-muted-foreground',
                  section.columns !== false && 'font-mono break-all',
                )}
              >
                {row.key}
              </th>
              <td className="py-1 break-words" data-slot="value">
                <Value value={row.value} />
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}
