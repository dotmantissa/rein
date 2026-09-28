'use client';

import { useEffect, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { api } from '@/lib/api';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Ban, ExternalLink, ShieldAlert, ArrowUpRight } from 'lucide-react';
import { SeverityBadge } from '@/components/ui/SeverityBadge';

export default function RevocationsPage() {
  const { getAccessToken } = usePrivy();
  const [revocations, setRevocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const token = await getAccessToken();
        if (token) {
          const data = await api.getRevocations(token);
          setRevocations(data.revocations || []);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getAccessToken]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-6 h-6 border-2 border-[#eb1700] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div>
        <h2 className="font-mono text-sm text-neutral-300">enforced revocations</h2>
        <p className="text-xs text-neutral-500">
          When an agent commits an irreconcilable breach, authority is revoked on GenLayer and disabled on the host chain.
        </p>
      </div>

      {revocations.length > 0 ? (
        <div className="grid gap-4">
          {revocations.map(r => (
            <motion.div
              key={r.revocation_id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
              className="relative overflow-hidden border border-[#eb1700]/40 rounded-sm p-6 bg-[#1f1f1f]"
            >
              <div className="flex flex-col md:flex-row justify-between gap-6 relative z-10">
                <div className="space-y-4 flex-1">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 text-[#eb1700] font-mono text-xs font-semibold">
                      <Ban size={16} />
                      REVOKED
                    </div>
                    {r.severity && <SeverityBadge severity={r.severity} />}
                    <span className="text-xs font-mono text-neutral-500">
                      ID: {r.revocation_id}
                    </span>
                  </div>

                  {r.reason && (
                    <div className="space-y-1">
                      <span className="text-xs font-mono text-neutral-500">court breach determination</span>
                      <p className="text-sm text-neutral-200 leading-relaxed font-mono bg-black/30 p-3 rounded-sm border-l-2 border-[#eb1700]">
                        {r.reason}
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
                    <div className="space-y-1">
                      <span className="text-neutral-500">GenLayer verdict tx</span>
                      <div className="bg-black/30 px-3 py-1.5 rounded-sm flex items-center justify-between text-neutral-300">
                        <span className="truncate">{r.genlayer_tx_hash ? `${r.genlayer_tx_hash.slice(0, 10)}...${r.genlayer_tx_hash.slice(-8)}` : 'confirmed'}</span>
                        <ExternalLink size={12} className="text-neutral-500 shrink-0 ml-2" />
                      </div>
                    </div>

                    {r.evm_tx_hash ? (
                      <div className="space-y-1">
                        <span className="text-neutral-500">EVM host chain revocation tx</span>
                        <div className="bg-black/30 px-3 py-1.5 rounded-sm flex items-center justify-between text-neutral-300">
                          <span className="truncate">{`${r.evm_tx_hash.slice(0, 10)}...${r.evm_tx_hash.slice(-8)}`}</span>
                          <ExternalLink size={12} className="text-neutral-500 shrink-0 ml-2" />
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <span className="text-neutral-500">EVM host chain state</span>
                        <div className="bg-black/30 px-3 py-1.5 rounded-sm text-amber-400">
                          Relayer execution recorded
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="text-xs text-neutral-500 font-mono flex items-center gap-2">
                    <span>Mandate:</span>
                    <Link
                      href={`/mandates/${r.delegation_id}`}
                      className="text-white hover:text-[#eb1700] transition-colors underline underline-offset-2"
                    >
                      {r.delegation_id}
                    </Link>
                  </div>
                </div>

                <div className="flex md:flex-col items-end justify-between gap-3 shrink-0">
                  <span className="text-xs font-mono text-neutral-500">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString() : ''}
                  </span>
                  <Link
                    href={`/appeals?revocationId=${r.revocation_id}`}
                    className="inline-flex items-center gap-1.5 bg-white text-[#191919] hover:bg-neutral-200 font-mono text-xs px-3.5 py-2 rounded-sm transition-colors"
                  >
                    Post bond and appeal
                    <ArrowUpRight size={12} />
                  </Link>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="text-center py-16 bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm">
          <ShieldAlert size={36} className="mx-auto text-neutral-600 mb-3" />
          <p className="text-neutral-400 text-sm">No revocations on record.</p>
          <p className="text-neutral-600 text-xs mt-1">Your agents are operating within their permitted boundaries.</p>
        </div>
      )}
    </div>
  );
}
