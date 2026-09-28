'use client';

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { SeverityBadge } from '@/components/ui/SeverityBadge';
import { ChevronDown, ChevronUp } from 'lucide-react';

const FILTERS = ['all', 'compliant', 'breach', 'ambiguous'] as const;

export default function VerdictsPage() {
  const { getAccessToken } = usePrivy();
  const [verdicts, setVerdicts] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const token = await getAccessToken();
        if (token) {
          const data = await api.getVerdicts(token);
          setVerdicts(data.verdicts || []);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getAccessToken]);

  const filtered = verdicts.filter(v => filter === 'all' ? true : v.verdict === filter);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-[#2a2a2a]">
        {FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2.5 text-sm font-mono transition-colors duration-150 border-b-2 ${
              filter === f ? 'border-[#eb1700] text-white' : 'border-transparent text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {filtered.length > 0 ? (
        <div className="space-y-1">
          {filtered.map((v: any) => {
            const isExpanded = expanded === v.verdict_id;
            return (
              <div key={v.verdict_id || v.id} className="bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm overflow-hidden">
                <button
                  onClick={() => setExpanded(isExpanded ? null : v.verdict_id)}
                  className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-[#2a2a2a]/30 transition-colors"
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    v.verdict === 'breach' ? 'bg-[#eb1700]' :
                    v.verdict === 'ambiguous' ? 'bg-amber-500' :
                    'bg-green-500'
                  }`} />
                  <span className="font-mono text-xs text-neutral-500 w-28 flex-shrink-0">
                    {v.tx_hash ? `${v.tx_hash.slice(0, 6)}...${v.tx_hash.slice(-4)}` : 'n/a'}
                  </span>
                  <StatusBadge status={v.verdict} />
                  <SeverityBadge severity={v.severity} />
                  <span className="text-xs text-neutral-500 font-mono flex-shrink-0">
                    {v.confidence ? `${(v.confidence * 100).toFixed(0)}%` : ''}
                  </span>
                  <span className="flex-1" />
                  <span className="text-xs text-neutral-600 font-mono">
                    {v.created_at ? new Date(v.created_at).toLocaleDateString() : ''}
                  </span>
                  {isExpanded ? <ChevronUp size={14} className="text-neutral-500" /> : <ChevronDown size={14} className="text-neutral-500" />}
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 pt-1 border-t border-[#2a2a2a]">
                    <div className="space-y-3">
                      {v.reasoning && (
                        <div>
                          <span className="text-xs font-mono text-neutral-500">reasoning</span>
                          <p className="text-sm text-neutral-300 mt-1">{v.reasoning}</p>
                        </div>
                      )}
                      {v.breached_clause && (
                        <div>
                          <span className="text-xs font-mono text-[#eb1700]">breached clause</span>
                          <p className="text-sm font-mono border-l-2 border-[#eb1700] pl-3 mt-1">{v.breached_clause}</p>
                        </div>
                      )}
                      {v.mandate_text && (
                        <div>
                          <span className="text-xs font-mono text-neutral-500">mandate</span>
                          <p className="text-sm text-neutral-400 mt-1 line-clamp-3">{v.mandate_text}</p>
                        </div>
                      )}
                      {v.genlayer_tx_hash && (
                        <p className="text-xs font-mono text-neutral-600">
                          GenLayer tx: {v.genlayer_tx_hash}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-16 bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm">
          <p className="text-neutral-500 text-sm">
            {filter === 'all' ? 'No verdicts yet. Submit an action for review to see the court in action.' : `No ${filter} verdicts found.`}
          </p>
        </div>
      )}
    </div>
  );
}
