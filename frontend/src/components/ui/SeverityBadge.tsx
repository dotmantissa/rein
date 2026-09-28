import { cn } from '@/lib/cn';

export type Severity = 'LOW' | 'MED' | 'HIGH' | 'CRITICAL';

interface SeverityBadgeProps {
  severity: Severity;
  className?: string;
}

export function SeverityBadge({ severity, className }: SeverityBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-1 text-xs font-medium uppercase font-mono tracking-wider',
        {
          'bg-gray-500/10 text-gray-400 border border-gray-500/20': severity === 'LOW',
          'bg-amber-500/10 text-amber-500 border border-amber-500/20': severity === 'MED',
          'bg-orange-500/10 text-orange-500 border border-orange-500/20': severity === 'HIGH',
          'bg-[#eb1700]/10 text-[#eb1700] border border-[#eb1700]/20': severity === 'CRITICAL',
        },
        className
      )}
    >
      {severity}
    </span>
  );
}
