'use client';

import { motion } from 'framer-motion';

interface ReinLineProps {
  height: number;
}

export function ReinLine({ height }: ReinLineProps) {
  return (
    <div className="absolute left-6 top-0 bottom-0 w-[2px] z-0">
      <motion.div
        initial={{ height: 0 }}
        animate={{ height: '100%' }}
        transition={{ duration: 1, ease: 'easeOut' }}
        className="w-full bg-[#eb1700] origin-top"
        style={{ minHeight: height }}
      />
    </div>
  );
}
