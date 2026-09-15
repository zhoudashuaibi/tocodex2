import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

/**
 * 可排序表头：点击循环 升序 → 降序 → 恢复默认。
 * firstDir 控制首次点击的方向（时间/余额列传 'desc' 更符合直觉）。
 */
export function SortableHead({
  label,
  sortKey,
  sort,
  onSort,
  firstDir = 'asc',
  className,
}: {
  label: ReactNode;
  sortKey: string;
  sort: SortState | null;
  onSort: (sort: SortState | null) => void;
  firstDir?: 'asc' | 'desc';
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const toggle = (): SortState | null => {
    if (!active || !sort) return { key: sortKey, dir: firstDir };
    if (sort.dir === firstDir) return { key: sortKey, dir: firstDir === 'asc' ? 'desc' : 'asc' };
    return null;
  };

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(toggle())}
        className={cn(
          'inline-flex items-center gap-1 whitespace-nowrap font-medium tracking-[0.04em] transition-colors hover:text-foreground',
          active && 'text-foreground',
        )}
      >
        {label}
        {active ? (
          sort.dir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}
