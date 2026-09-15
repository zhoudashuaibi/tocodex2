import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBalance, formatRelativeTime } from '@/lib/utils';
import { cn } from '@/lib/utils';

export function BalanceTag({
  value,
  checkedAt,
  error,
}: {
  value: number | null | undefined;
  checkedAt?: string | null;
  error?: string | null;
}) {
  const has = value !== null && value !== undefined;
  const content = (
    <span className={cn('font-mono text-sm', has ? (Number(value) > 0 ? 'text-[var(--success)]' : 'text-muted-foreground') : 'text-muted-foreground')}>
      {has ? formatBalance(value) : '未查询'}
    </span>
  );
  if (!checkedAt && !error) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-4">{content}</span>
      </TooltipTrigger>
      <TooltipContent>
        {checkedAt && <div>查询时间：{formatRelativeTime(checkedAt)}</div>}
        {error && <div className="text-destructive">错误：{error}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
