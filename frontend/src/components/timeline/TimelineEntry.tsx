'use client';

import { useState } from 'react';
import { StatusBadge, type Status } from '@/components/ui/StatusBadge';
import { SeverityBadge, type Severity } from '@/components/ui/SeverityBadge';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/cn';

interface TimelineEntryProps {
  txHash: string;
  description: string;
  verdict: Status;
  severity?: Severity;
  reasoning: string;
  timestamp: string;
  isLast?: boolean;
}

export function TimelineEntry({
  txHash,
  description,
  verdict,
  severity,
  reasoning,
  timestamp,

}: TimelineEntryProps) {
  const [expanded, setExpanded] = useState(false);
  const isBreach = verdict === 'breach' || verdict === 'REVOKED';
  const isFlagged = verdict === 'ambiguous' || verdict === 'FLAGGED';
  const isCompliant = verdict === 'compliant' || verdict === 'ACTIVE';

  return (
    <div className="relative pl-16 py-4">
      <div
        className={cn(
          'absolute left-[21px] top-8 w-3 h-3 rounded-full border-2 border-[#191919] z-10',
          {
            'bg-green-500': isCompliant,
            'bg-amber-500': isFlagged,
            'bg-[#eb1700]': isBreach,
          }
        )}
      />

      <div className="bg-[#1f1f1f] border border-[#2a2a2a] rounded-lg p-4 transition-colors hover:border-neutral-600">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2">
          <div className="flex items-center gap-3">
            <StatusBadge status={verdict} />
            {severity && <SeverityBadge severity={severity} />}
          </div>
          <div className="text-xs text-neutral-500 font-mono flex items-center gap-2">
            <span>{new Date(timestamp).toLocaleString()}</span>
            <span className="bg-black/20 px-2 py-1 rounded">{txHash.slice(0, 10)}...</span>
          </div>
        </div>

        <p className="text-white text-sm mt-2">{description}</p>

        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-3 flex items-center gap-1 text-xs text-neutral-400 hover:text-white transition-colors focus:outline-none focus:ring-2 focus:ring-[#eb1700] rounded"
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? 'Hide reasoning' : 'Show reasoning'}
        </button>

        {expanded && (
          <div className="mt-3 p-3 bg-black/20 rounded-md text-sm text-neutral-300 font-mono leading-relaxed border-l-2 border-[#eb1700]/50">
            {reasoning}
          </div>
        )}
      </div>
    </div>
  );
}
