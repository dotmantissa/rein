'use client';

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { api } from '@/lib/api';
import Link from 'next/link';
import { Shield, Activity, AlertTriangle, Ban, FileText, Scale } from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';

export default function Dashboard() {
  const { getAccessToken, user } = usePrivy();
  const [stats, setStats] = useState<{
    mandates: Record<string, number>;
    verdicts: Record<string, number>;
    total_revocations: number;
    appeals: Record<string, number>;
  } | null>(null);
  const [recentVerdicts, setRecentVerdicts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const token = await getAccessToken();
        if (!token) return;

        // Register user on first load
        if (user?.email?.address) {
          await api.registerUser(token, { email: user.email.address }).catch(() => {});
        }

        const [statsData, verdictsData] = await Promise.all([
          api.getStats(token).catch(() => null),
          api.getVerdicts(token).catch(() => ({ verdicts: [] })),
        ]);
        if (statsData) setStats(statsData);
        setRecentVerdicts(verdictsData.verdicts?.slice(0, 8) || []);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [getAccessToken, user]);

  const activeMandates = stats?.mandates?.ACTIVE || 0;
  const totalVerdicts = Object.values(stats?.verdicts || {}).reduce((a, b) => a + b, 0);
  const breaches = stats?.verdicts?.breach || 0;
  const breachRate = totalVerdicts > 0 ? Math.round((breaches / totalVerdicts) * 100) : 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Stats row with asymmetric sizing */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-5 rounded-sm">
          <div className="flex items-center gap-2 text-neutral-500 text-xs font-mono uppercase tracking-wider mb-3">
            <Shield size={14} />
            <span>active mandates</span>
          </div>
          <div className="text-4xl font-mono font-bold tabular-nums">{activeMandates}</div>
        </div>

        <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-5 rounded-sm">
          <div className="flex items-center gap-2 text-neutral-500 text-xs font-mono uppercase tracking-wider mb-3">
            <Activity size={14} />
            <span>verdicts issued</span>
          </div>
          <div className="text-4xl font-mono font-bold tabular-nums">{totalVerdicts}</div>
        </div>

        <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-5 rounded-sm">
          <div className="flex items-center gap-2 text-neutral-500 text-xs font-mono uppercase tracking-wider mb-3">
            <AlertTriangle size={14} className="text-amber-500" />
            <span>breach rate</span>
          </div>
          <div className="text-4xl font-mono font-bold tabular-nums">
            {breachRate}<span className="text-lg text-neutral-500">%</span>
          </div>
        </div>

        <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-5 rounded-sm">
          <div className="flex items-center gap-2 text-neutral-500 text-xs font-mono uppercase tracking-wider mb-3">
            <Ban size={14} className="text-[#eb1700]" />
            <span>revocations</span>
          </div>
          <div className="text-4xl font-mono font-bold tabular-nums text-[#eb1700]">
            {stats?.total_revocations || 0}
          </div>
        </div>
      </div>

      {/* Two column layout: activity + actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
          <h2 className="font-mono text-sm text-neutral-400 mb-4">recent verdicts</h2>
          {recentVerdicts.length > 0 ? (
            <div className="space-y-1">
              {recentVerdicts.map((v: any, i: number) => (
                <div
                  key={v.verdict_id || i}
                  className="flex items-center gap-4 px-4 py-3 bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm group"
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    v.verdict === 'breach' ? 'bg-[#eb1700]' :
                    v.verdict === 'ambiguous' ? 'bg-amber-500' :
                    'bg-green-500'
                  }`} />
                  <span className="font-mono text-xs text-neutral-500 w-24 flex-shrink-0">
                    {v.tx_hash ? `${v.tx_hash.slice(0, 6)}...${v.tx_hash.slice(-4)}` : 'pending'}
                  </span>
                  <StatusBadge status={v.verdict || 'ambiguous'} />
                  <span className="text-sm text-neutral-400 truncate flex-1">
                    {v.reasoning?.slice(0, 80) || 'Waiting for reasoning...'}
                  </span>
                  <span className="text-xs text-neutral-600 font-mono flex-shrink-0">
                    {v.created_at ? new Date(v.created_at).toLocaleDateString() : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-8 rounded-sm text-center">
              <p className="text-neutral-500 text-sm">
                No verdicts yet. Your agents are running unsupervised out there.
              </p>
              <p className="text-neutral-600 text-xs mt-1">
                Write a mandate and review some actions to get started.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <h2 className="font-mono text-sm text-neutral-400 mb-4">quick actions</h2>
          <Link
            href="/mandates/new"
            className="flex items-center gap-3 w-full bg-[#eb1700] text-white py-3 px-4 rounded-sm transition-colors duration-150 hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eb1700] focus-visible:ring-offset-2 focus-visible:ring-offset-[#191919]"
          >
            <FileText size={18} />
            <span className="font-medium text-sm">Write a new mandate</span>
          </Link>
          <Link
            href="/review"
            className="flex items-center gap-3 w-full bg-[#1f1f1f] border border-[#2a2a2a] text-white/70 py-3 px-4 rounded-sm transition-colors duration-150 hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-2 focus-visible:ring-offset-[#191919]"
          >
            <Scale size={18} />
            <span className="font-medium text-sm">Review an action</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
