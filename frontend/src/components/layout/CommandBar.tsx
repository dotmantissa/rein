'use client';

import { usePathname } from 'next/navigation';
import { usePrivy } from '@privy-io/react-auth';
import Link from 'next/link';

export function CommandBar() {
  const pathname = usePathname();
  const { user } = usePrivy();

  const getTitle = () => {
    if (pathname === '/') return 'Dashboard';
    if (pathname.startsWith('/mandates/new')) return 'New Mandate';
    if (pathname.startsWith('/mandates')) return 'Mandates';
    if (pathname.startsWith('/review')) return 'Review';
    if (pathname.startsWith('/verdicts')) return 'Verdicts';
    if (pathname.startsWith('/revocations')) return 'Revocations';
    if (pathname.startsWith('/appeals')) return 'Appeals';
    return 'REIN';
  };

  const getAction = () => {
    if (pathname === '/mandates' || pathname === '/') {
      return (
        <Link href="/mandates/new" className="bg-[#eb1700] hover:bg-[#eb1700]/90 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors">
          New Mandate
        </Link>
      );
    }
    return null;
  };

  return (
    <header className="h-14 border-b border-[#2a2a2a] bg-[#1f1f1f] flex items-center justify-between px-6 sticky top-0 z-40">
      <h1 className="font-mono text-lg font-medium text-white">{getTitle()}</h1>
      <div className="flex items-center gap-6">
        {getAction()}
        {user?.email && (
          <span className="text-sm text-neutral-400 font-mono hidden sm:inline-block">
            {user.email.address}
          </span>
        )}
      </div>
    </header>
  );
}
