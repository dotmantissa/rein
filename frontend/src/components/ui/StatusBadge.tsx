import { cn } from '@/lib/cn';

export type Status = 'ACTIVE' | 'FLAGGED' | 'REVOKED' | 'RESTORED' | 'compliant' | 'breach' | 'ambiguous';

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const isGreen = status === 'ACTIVE' || status === 'compliant';
  const isAmber = status === 'FLAGGED' || status === 'ambiguous';
  const isRed = status === 'REVOKED' || status === 'breach';
  const isBlue = status === 'RESTORED';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium uppercase font-mono tracking-wider',
        {
          'bg-green-500/10 text-green-500 border border-green-500/20': isGreen,
          'bg-amber-500/10 text-amber-500 border border-amber-500/20': isAmber,
          'bg-[#eb1700]/10 text-[#eb1700] border border-[#eb1700]/20': isRed,
          'bg-blue-500/10 text-blue-500 border border-blue-500/20': isBlue,
        },
        className
      )}
    >
      {status}
    </span>
  );
}
