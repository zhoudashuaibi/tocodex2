import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface StatusDef {
  label: string;
  variant: 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'secondary';
}

const JOB_STATUS: Record<string, StatusDef> = {
  queued: { label: '排队', variant: 'muted' },
  running: { label: '进行中', variant: 'info' },
  awaiting_input: { label: '待输入', variant: 'warning' },
  completed: { label: '已完成', variant: 'success' },
  failed: { label: '失败', variant: 'danger' },
  canceled: { label: '已取消', variant: 'muted' },
};

const MAIN_STATUS: Record<string, StatusDef> = {
  active: { label: '可用', variant: 'success' },
  authorizing: { label: '授权中', variant: 'info' },
  needs_reauth: { label: '待重新授权', variant: 'warning' },
};

const RESERVE_STATUS: Record<string, StatusDef> = {
  mail_pending: { label: '待初始化', variant: 'muted' },
  mail_failed: { label: '初始化失败', variant: 'danger' },
  joining: { label: '加入中', variant: 'info' },
  mail_ok: { label: '就绪', variant: 'success' },
};

const DISCARD_REASON: Record<string, StatusDef> = {
  banned_401: { label: '封禁(401)', variant: 'danger' },
  rate_limited_429: { label: '限流(429)', variant: 'warning' },
  repair_failed: { label: '修复失败', variant: 'warning' },
  login_failed: { label: '登录封禁', variant: 'danger' },
  manual: { label: '手动废弃', variant: 'muted' },
};

const PROXY_STATUS: Record<string, StatusDef> = {
  alive: { label: '可用', variant: 'success' },
  dead: { label: '失效', variant: 'danger' },
  cf_challenge: { label: '被CF拦截', variant: 'warning' },
  unknown: { label: '未测', variant: 'muted' },
  testing: { label: '测试中', variant: 'info' },
};

export function StatusBadge({ domain, value, tooltip }: { domain: 'job' | 'main' | 'reserve' | 'discard' | 'proxy'; value: string | null | undefined; tooltip?: string | null }) {
  const map = { job: JOB_STATUS, main: MAIN_STATUS, reserve: RESERVE_STATUS, discard: DISCARD_REASON, proxy: PROXY_STATUS }[domain];
  const def = (value && map[value]) || { label: value ?? '—', variant: 'muted' as const };
  const badge = <Badge variant={def.variant}>{def.label}</Badge>;
  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{badge}</span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }
  return badge;
}
