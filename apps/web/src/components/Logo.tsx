// The Pulse mark: one heartbeat on a tangerine tile. Used in the sidebar, auth pages and landing page.
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="4" fill="var(--accent)" />
      <path
        d="M3 17h7l2.5-7 4 14 3-10 1.8 3H29"
        fill="none"
        stroke="var(--accent-text)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
