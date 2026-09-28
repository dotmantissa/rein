export default function ReinLogo({ className = "", size = 32 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Stylized horse head with rein line */}
      <path
        d="M16 52V32C16 22 22 14 32 12C38 10 42 12 46 16C50 20 50 26 48 30L44 36C42 38 40 38 38 36L36 32"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Rein line */}
      <path
        d="M32 28L24 40L16 52"
        stroke="#eb1700"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Eye */}
      <circle cx="40" cy="20" r="2" fill="currentColor" />
      {/* Ear */}
      <path
        d="M44 12L48 6L46 14"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
