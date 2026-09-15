import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  tone = 'default',
}: {
  title: string;
  value: string | number;
  sub?: string;
  icon?: LucideIcon;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
}) {
  return (
    <Card className="relative overflow-hidden border-border/90">
      <CardHeader className="flex-row items-center justify-between gap-3 px-5 pt-5 pb-0">
        <CardTitle className="text-xs font-medium text-muted-foreground">{title}</CardTitle>
        {Icon && (
          <div
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md border',
              tone === 'success' && 'border-[var(--success)]/20 bg-[var(--success)]/10 text-[var(--success)]',
              tone === 'warning' && 'border-[var(--warning)]/20 bg-[var(--warning)]/10 text-[var(--warning)]',
              tone === 'danger' && 'border-destructive/20 bg-destructive/10 text-destructive',
              tone === 'info' && 'border-[var(--info)]/20 bg-[var(--info)]/10 text-[var(--info)]',
              tone === 'default' && 'bg-muted text-muted-foreground',
            )}
          >
            <Icon className="size-4" />
          </div>
        )}
      </CardHeader>
      <CardContent className="px-5 pt-3 pb-5">
        <div className="text-2xl font-semibold leading-none">{value}</div>
        {sub && <div className="mt-2 truncate text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}
