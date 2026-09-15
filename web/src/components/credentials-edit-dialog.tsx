import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { ReserveAccount } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface FieldDef {
  key: string;
  label: string;
  masked?: string | null;
  clearable: boolean;
  mono?: boolean;
}

/** 编辑备用池账号绑定的凭据：留空 = 不改；填新值 = 覆盖；点 ✕ = 清空（仅限可清空项） */
export function CredentialsEditDialog({
  account,
  open,
  onOpenChange,
}: {
  account: ReserveAccount | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['accounts', account?.id, 'credentials'],
    queryFn: () => accountsApi.credentials(account!.id),
    enabled: open && !!account,
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [clears, setClears] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) {
      setValues({});
      setClears({});
    }
  }, [open]);

  const current = data?.credentials;
  const fields: FieldDef[] = [
    { key: 'password', label: 'ChatGPT 登录密码', masked: current?.password, clearable: true },
    { key: 'totp_pickup_code', label: '2FA 取件码（在线取码）', masked: current?.totp_pickup_code, clearable: true, mono: true },
    { key: 'totp_secret', label: '2FA 密钥（Base32，本地算码）', masked: current?.totp_secret, clearable: true, mono: true },
    { key: 'outlook_password', label: '邮箱密码（收件用）', masked: current?.outlook?.password, clearable: false },
    { key: 'outlook_client_id', label: 'clientId', masked: current?.outlook?.client_id, clearable: false, mono: true },
    { key: 'outlook_refresh_token', label: 'refresh_token（收件用）', masked: current?.outlook?.refresh_token, clearable: false, mono: true },
  ];

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = {};
      for (const field of fields) {
        if (field.clearable && clears[field.key]) body[field.key] = '';
        else if (values[field.key]?.trim()) body[field.key] = values[field.key].trim();
      }
      return accountsApi.updateCredentials(account!.id, body);
    },
    onSuccess: (result) => {
      toast.success(
        `已更新 ${result.account.email} 的凭据` +
          (result.account.has_2fa ? '（2FA ✓' : '（2FA ✗') +
          (result.account.has_password ? '｜密码 ✓）' : '｜密码 ✗）'),
      );
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ['accounts', 'reserve'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑账号凭据</DialogTitle>
          <DialogDescription>
            {account?.email}（邮箱不可改）；留空保持不变，填写新值覆盖
          </DialogDescription>
        </DialogHeader>
        {isLoading || !current ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载凭据…
          </div>
        ) : (
          <div className="grid gap-3">
            {fields.map((field) => (
              <div key={field.key} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">
                    {field.label}
                    {field.masked ? (
                      <span className={`ml-2 ${field.mono ? 'font-mono' : ''} text-muted-foreground`}>当前：{field.masked}</span>
                    ) : (
                      <span className="ml-2 text-muted-foreground">（未设置）</span>
                    )}
                  </Label>
                  {field.clearable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={`h-6 px-2 text-xs ${clears[field.key] ? 'text-destructive' : 'text-muted-foreground'}`}
                      onClick={() => setClears((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                    >
                      <X className="h-3 w-3" />
                      {clears[field.key] ? '取消清空' : '清空'}
                    </Button>
                  )}
                </div>
                <Input
                  value={clears[field.key] ? '' : values[field.key] ?? ''}
                  onChange={(e) => {
                    setValues((prev) => ({ ...prev, [field.key]: e.target.value }));
                    setClears((prev) => ({ ...prev, [field.key]: false }));
                  }}
                  disabled={clears[field.key]}
                  placeholder={clears[field.key] ? '将清空该项' : '留空保持不变'}
                  className={field.mono ? 'font-mono text-xs' : undefined}
                  spellCheck={false}
                />
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            取消
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || isLoading || !current || !Object.keys(values).some((k) => values[k]?.trim()) && !Object.values(clears).some(Boolean)}
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            <Save className="h-4 w-4" />
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
