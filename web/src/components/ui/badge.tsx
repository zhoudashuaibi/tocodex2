import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-[var(--success)]/20 bg-[var(--success)]/10 text-[var(--success)]',
        warning: 'border-[var(--warning)]/20 bg-[var(--warning)]/10 text-[var(--warning)]',
        danger: 'border-destructive/20 bg-destructive/10 text-destructive',
        muted: 'border-transparent bg-muted text-muted-foreground',
        info: 'border-[var(--info)]/20 bg-[var(--info)]/10 text-[var(--info)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
