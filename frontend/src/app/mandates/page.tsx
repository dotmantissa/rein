'use client';

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { api } from '@/lib/api';
import { MandateCard } from '@/components/mandate/MandateCard';
import Link from 'next/link';
import { Plus } from 'lucide-react';

const FILTERS = ['All', 'ACTIVE', 'FLAGGED', 'REVOKED', 'RESTORED'] as const;

export default function MandatesPage() {
  const { getAccessToken } = usePrivy();
  const [mandates, setMandates] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('All');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const token = await getAccessToken();
        if (token) {
          const data = await api.getMandates(token);
          setMandates(data.mandates || []);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getAccessToken]);

  const filtered = mandates.filter(m => filter === 'All' ? true : m.status === filter);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filter tabs with left red underline for active */}
      <div className="flex gap-1 border-b border-[#2a2a2a]">
        {FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2.5 text-sm font-mono transition-colors duration-150 border-b-2 ${
              filter === f
                ? 'border-[#eb1700] text-white'
                : 'border-transparent text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {f.toLowerCase()}
          </button>
        ))}
      </div>

      {filtered.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {filtered.map(m => (
            <MandateCard
              key={m.delegation_id}
              delegationId={m.delegation_id}
              agentAddress={m.agent_address}
              status={m.status}
              mandateText={m.mandate_text}
              spendCeilingWei={m.spend_ceiling_wei}
              chainId={m.chain_id}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-16 bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm">
          <p className="text-neutral-400 mb-1">
            {filter === 'All'
              ? 'No mandates yet. Your agents are running unsupervised.'
              : `Nothing with status "${filter.toLowerCase()}" right now.`}
          </p>
          <p className="text-neutral-600 text-xs mb-6">
            {filter === 'All' && 'Time to write one and put them on a leash.'}
          </p>
          {filter === 'All' && (
            <Link
              href="/mandates/new"
              className="inline-flex items-center gap-2 bg-[#eb1700] text-white px-5 py-2 rounded-sm text-sm hover:bg-red-700 transition-colors"
            >
              <Plus size={16} />
              Write your first mandate
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
