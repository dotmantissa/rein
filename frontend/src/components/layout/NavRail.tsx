'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, FileText, Scale, Shield, Ban, MessageSquare, Sun, Moon, LogOut } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/cn';
import { usePrivy } from '@privy-io/react-auth';

const NAV_ITEMS = [
  { href: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/mandates', icon: FileText, label: 'Mandates' },
  { href: '/review', icon: Scale, label: 'Review Actions' },
  { href: '/verdicts', icon: Shield, label: 'Verdicts' },
  { href: '/revocations', icon: Ban, label: 'Revocations' },
  { href: '/appeals', icon: MessageSquare, label: 'Appeals' },
];

export function NavRail() {
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();
  const { logout } = usePrivy();

  return (
    <nav className="fixed md:left-0 md:top-0 md:h-screen w-full md:w-[56px] bottom-0 md:bottom-auto bg-[#191919] border-t md:border-t-0 md:border-r border-[#2a2a2a] z-50 flex md:flex-col items-center justify-between py-2 md:py-4 px-4 md:px-0">
      <div className="hidden md:flex items-center justify-center w-full mb-8">
        <Image src="/logo.jpg" alt="REIN" width={32} height={32} className="rounded-sm" />
      </div>

      <div className="flex md:flex-col items-center gap-2 md:gap-4 flex-1 md:flex-none justify-around md:justify-start w-full">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          const Icon = item.icon;
          
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={cn(
                'relative flex items-center justify-center w-10 h-10 rounded-md transition-all duration-200',
                isActive ? 'text-white' : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
              )}
            >
              {isActive && (
                <div className="hidden md:block absolute left-[-16px] top-0 bottom-0 w-[2px] bg-[#eb1700]" />
              )}
              <Icon size={20} />
            </Link>
          );
        })}
      </div>

      <div className="hidden md:flex flex-col items-center gap-4 mt-auto">
        <button
          onClick={toggleTheme}
          className="text-neutral-500 hover:text-white transition-colors"
          title="Toggle Theme"
        >
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        <button
          onClick={logout}
          className="text-neutral-500 hover:text-white transition-colors"
          title="Logout"
        >
          <LogOut size={20} />
        </button>
      </div>
    </nav>
  );
}
