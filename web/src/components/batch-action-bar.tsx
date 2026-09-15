import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 表格选中后底部浮出的批量操作条 */
export function BatchActionBar({
  count,
  extra,
  children,
  onClear,
}: {
  count: number;
  extra?: React.ReactNode;
  children: React.ReactNode;
  onClear: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div
      className={cn(
        'app-surface fixed bottom-6 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-max -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border bg-card px-4 py-3 shadow-xl',
      )}
    >
      <span className="text-sm font-medium">已选 {count} 项</span>
      {extra && <span className="text-sm text-muted-foreground">{extra}</span>}
      <div className="mx-1 h-5 w-px bg-border" />
      {children}
      <Button variant="ghost" size="icon" onClick={onClear} title="清空选择">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function SpinnerButton({ children, busy, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      {...props}
      disabled={props.disabled || busy}
      className={cn('inline-flex items-center gap-1.5', props.className)}
    >
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}
