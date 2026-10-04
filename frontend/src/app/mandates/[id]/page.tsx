'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import { api } from '@/lib/api';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ReinLine } from '@/components/timeline/ReinLine';
import { TimelineEntry } from '@/components/timeline/TimelineEntry';
import Link from 'next/link';
import { Cpu, ShieldAlert, ArrowUpRight, Scale, Link2, Lock, Unlock } from 'lucide-react';

const CHAIN_NAMES: Record<string, string> = {
  '1': 'Ethereum',
  '8453': 'Base',
  '11155111': 'Sepolia',
  '137': 'Polygon',
  '42161': 'Arbitrum',
  '10': 'Optimism',
};

function formatWei(wei: string): string {
  try {
    const n = BigInt(wei || '0');
    if (n >= BigInt('1000000000000000000')) {
      return `${(Number(n) / 1e18).toFixed(4)} ETH`;
    }
    if (n >= BigInt('1000000000')) {
      return `${(Number(n) / 1e9).toFixed(2)} Gwei`;
    }
    return `${wei} Wei`;
  } catch {
    return wei || '0 Wei';
  }
}

export default function MandateDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { getAccessToken } = usePrivy();
  const [mandate, setMandate] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // Read straight from ReinSessionKeyRegistry on the host chain. This is the
  // only statement on this page that is not a database row: if `active` is
  // false, the agent's session key cannot spend, whatever anything else says.
  const [host, setHost] = useState<any>(null);

  useEffect(() => {
    async function load() {
      try {
        const token = await getAccessToken();
        if (token && id) {
          const [mandateRes, verdictsRes] = await Promise.all([
            api.getMandate(token, id).catch(() => null),
            api.getVerdictsByDelegation(token, id).catch(() => ({ verdicts: [] })),
          ]);

          if (mandateRes?.mandate) {
            setMandate(mandateRes.mandate);
          }
          if (verdictsRes?.verdicts) {
            setTimeline(verdictsRes.verdicts);
          }
          api
            .getHostStatus(token, id)
            .then(setHost)
            .catch(() => setHost(null));
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id, getAccessToken]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!mandate) {
    return (
      <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-8 rounded-sm text-center">
        <p className="text-neutral-400 text-sm mb-4">Mandate not found or unavailable.</p>
        <Link href="/mandates" className="text-sm font-mono text-[#eb1700] hover:underline">
          Return to mandates
        </Link>
      </div>
    );
  }

  const isRevoked = mandate.status === 'REVOKED';

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Mandate Hero Card */}
      <div className="bg-[#1f1f1f] border border-[#2a2a2a] p-6 rounded-sm relative overflow-hidden">
        {isRevoked && (
          <div className="absolute inset-0 bg-[#eb1700]/5 pointer-events-none" />
        )}

        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Cpu size={16} className="text-neutral-500" />
              <h2 className="font-mono text-sm text-neutral-300">
                Agent <span className="text-white font-semibold">{mandate.agent_address}</span>
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-black/30 border border-[#2a2a2a] px-2 py-0.5 rounded-sm text-xs font-mono text-neutral-400">
                {CHAIN_NAMES[mandate.chain_id] || `Chain ${mandate.chain_id}`}
              </span>
              <span className="bg-black/30 border border-[#2a2a2a] px-2 py-0.5 rounded-sm text-xs font-mono text-neutral-400">
                Ceiling: {formatWei(mandate.spend_ceiling_wei)}
              </span>
              {mandate.session_key_id && (
                <span className="bg-black/30 border border-[#2a2a2a] px-2 py-0.5 rounded-sm text-xs font-mono text-neutral-400">
                  Key: {mandate.session_key_id.slice(0, 10)}...
                </span>
              )}
              {host && (
                <span
                  className={`inline-flex items-center gap-1 border px-2 py-0.5 rounded-sm text-xs font-mono ${
                    host.active
                      ? 'border-green-500/30 bg-green-500/10 text-green-300'
                      : 'border-[#eb1700]/40 bg-[#eb1700]/10 text-[#eb1700]'
                  }`}
                  title="Read live from the host-chain session key registry"
                >
                  {host.active ? <Unlock size={11} /> : <Lock size={11} />}
                  {host.active ? 'key can spend' : 'key revoked on chain'}
                </span>
              )}
            </div>
          </div>

          <StatusBadge status={(mandate.status || 'ACTIVE') as any} className="self-start" />
        </div>

        {/* Mandate Natural Language Text */}
        <div className="space-y-2">
          <span className="text-xs font-mono text-neutral-500">delegated authority mandate</span>
          <div className="p-4 bg-black/30 rounded-sm text-neutral-200 font-mono text-sm border-l-2 border-[#eb1700] leading-relaxed">
            {mandate.mandate_text}
          </div>
        </div>

        {mandate.genlayer_tx_hash && (
          <div className="mt-4 pt-4 border-t border-[#2a2a2a] flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 font-mono">
            <span>Delegation ID: {mandate.delegation_id}</span>
            <span className="text-neutral-400">
              GenLayer tx: {mandate.genlayer_tx_hash.slice(0, 10)}...{mandate.genlayer_tx_hash.slice(-8)}
            </span>
          </div>
        )}

        {mandate.mandate_hash && (
          <p className="mt-2 text-[11px] font-mono text-neutral-600 break-all">
            Committed mandate hash: {mandate.mandate_hash}
          </p>
        )}

        {host && (
          <div className="mt-4 p-4 border border-[#2a2a2a] bg-black/20 rounded-sm space-y-2">
            <div className="flex items-center gap-2 text-xs font-mono text-neutral-400">
              <Link2 size={13} />
              host chain authority
            </div>
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              The delegation this mandate governs lives on chain {host.chainId}.
              Everything else on this page is a record of a decision; this is the
              authority itself, read live from the registry.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-[11px] font-mono">
              <div className="flex justify-between gap-2">
                <span className="text-neutral-600">session key registry</span>
                <span className="text-neutral-300 truncate">
                  {host.sessionKeyRegistry
                    ? `${host.sessionKeyRegistry.slice(0, 10)}...${host.sessionKeyRegistry.slice(-6)}`
                    : 'not configured'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-neutral-600">can the key spend</span>
                <span className={host.active ? 'text-green-300' : 'text-[#eb1700]'}>
                  {host.active ? 'yes' : 'no'}
                </span>
              </div>
              {host.delegation && (
                <>
                  <div className="flex justify-between gap-2">
                    <span className="text-neutral-600">spent of ceiling</span>
                    <span className="text-neutral-300">
                      {formatWei(host.delegation.spentWei)} / {formatWei(host.delegation.ceilingWei)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-neutral-600">registry state</span>
                    <span className="text-neutral-300">{host.delegation.state}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {isRevoked && (
          <div className="mt-6 p-4 border border-[#eb1700]/30 bg-[#eb1700]/10 rounded-sm">
            <div className="flex items-center gap-2 text-[#eb1700] font-medium text-sm mb-1">
              <ShieldAlert size={16} />
              Revocation Enforced
            </div>
            <p className="text-xs text-neutral-300 leading-relaxed">
              A breach verdict was reached on GenLayer and the revocation was
              submitted to the host chain. The Enforcer read that transaction
              back before recording this status, so the agent&rsquo;s session key
              no longer spends.
              {host && host.active
                ? ' The host chain currently reports the key as live, which means a restoration has landed since.'
                : ''}
            </p>
            <div className="mt-3">
              <Link
                href="/appeals"
                className="inline-flex items-center gap-1 text-xs font-mono text-[#eb1700] hover:text-white transition-colors"
              >
                File an appeal with the validator panel
                <ArrowUpRight size={12} />
              </Link>
            </div>
          </div>
        )}
      </div>

      {/* Activity Timeline Header & Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="font-mono text-sm text-neutral-300">supervised activity</h3>
          <p className="text-xs text-neutral-500">Every agent transaction checked against the registered mandate.</p>
        </div>
        {!isRevoked && (
          <Link
            href={`/review?mandateId=${id}`}
            className="inline-flex items-center gap-2 bg-[#eb1700] text-white px-4 py-2 rounded-sm text-xs font-mono hover:bg-red-700 transition-colors"
          >
            <Scale size={14} />
            Review an action
          </Link>
        )}
      </div>

      {/* The Rein Line Structural Device */}
      <div className="relative">
        <ReinLine height={Math.max(timeline.length * 120, 120)} />
        {timeline.length > 0 ? (
          <div className="space-y-0 relative z-10">
            {timeline.map((entry, i) => (
              <TimelineEntry
                key={entry.verdict_id || i}
                txHash={entry.tx_hash || '0x...'}
                description={entry.action_description || 'Supervised transaction executed by agent'}
                verdict={(entry.verdict || 'compliant') as any}
                severity={entry.severity}
                reasoning={entry.reasoning || 'No reasoning available.'}
                timestamp={entry.created_at || new Date().toISOString()}
                isLast={i === timeline.length - 1}
              />
            ))}
          </div>
        ) : (
          <div className="pl-16 py-8 text-neutral-500 text-sm font-mono relative z-10">
            This agent has been behaving. No breaches flagged so far.
          </div>
        )}
      </div>
    </div>
  );
}
