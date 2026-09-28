'use client';

import Link from 'next/link';
import { StatusBadge, type Status } from '@/components/ui/StatusBadge';
import { Cpu, Wallet } from 'lucide-react';

interface MandateCardProps {
  delegationId: string;
  agentAddress: string;
  status: string;
  mandateText: string;
  spendCeilingWei: string;
  chainId: string;
}

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
    const n = BigInt(wei);
    if (n >= BigInt('1000000000000000000')) {
      return `${(Number(n) / 1e18).toFixed(4)} ETH`;
    }
    if (n >= BigInt('1000000000')) {
      return `${(Number(n) / 1e9).toFixed(2)} Gwei`;
    }
    return `${wei} Wei`;
  } catch {
    return wei || '0';
  }
}

export function MandateCard({ delegationId, agentAddress, status, mandateText, spendCeilingWei, chainId }: MandateCardProps) {
  const safeStatus = (status || 'ACTIVE') as Status;

  return (
    <Link
      href={`/mandates/${delegationId}`}
      className="block bg-[#1f1f1f] border border-[#2a2a2a] rounded-sm p-4 transition-colors duration-150 hover:border-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#eb1700] focus-visible:ring-offset-2 focus-visible:ring-offset-[#191919]"
    >
      {/* Top: agent address + status */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-neutral-500" />
          <span className="font-mono text-xs text-neutral-400">
            {agentAddress ? `${agentAddress.slice(0, 6)}...${agentAddress.slice(-4)}` : 'unknown'}
          </span>
        </div>
        <StatusBadge status={safeStatus} />
      </div>

      {/* Mandate text preview */}
      <p className="text-sm text-neutral-300 line-clamp-2 mb-3 leading-relaxed">
        {mandateText || 'No mandate text'}
      </p>

      {/* Bottom: chain + ceiling */}
      <div className="flex items-center justify-between text-xs text-neutral-500">
        <span className="font-mono">
          {CHAIN_NAMES[chainId] || `chain ${chainId}`}
        </span>
        <div className="flex items-center gap-1">
          <Wallet size={12} />
          <span className="font-mono">{formatWei(spendCeilingWei)}</span>
        </div>
      </div>
    </Link>
  );
}
