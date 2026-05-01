export default function HeroMotif({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="640"
      height="640"
      viewBox="0 0 640 640"
      fill="none"
      aria-hidden="true"
      role="presentation"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="motif-fade" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0B1220" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#0B1220" stopOpacity="0.0" />
        </linearGradient>
      </defs>

      {/* outer reseller field — soft */}
      <rect
        x="60"
        y="60"
        width="520"
        height="520"
        stroke="#0B1220"
        strokeOpacity="0.15"
        strokeWidth="1"
        fill="url(#motif-fade)"
      />

      {/* nested rectangles representing the channel narrowing */}
      <rect
        x="120"
        y="120"
        width="400"
        height="400"
        stroke="#0B1220"
        strokeOpacity="0.22"
        strokeWidth="1"
        fill="none"
      />
      <rect
        x="180"
        y="180"
        width="280"
        height="280"
        stroke="#0B1220"
        strokeOpacity="0.32"
        strokeWidth="1"
        fill="none"
      />

      {/* core — owned channel — accent stroke */}
      <rect
        x="240"
        y="240"
        width="160"
        height="160"
        stroke="#D4B36A"
        strokeWidth="1.5"
        fill="#D4B36A"
        fillOpacity="0.06"
      />

      {/* directional rule — flow into the channel */}
      <path
        d="M 60 320 L 240 320"
        stroke="#0B1220"
        strokeOpacity="0.45"
        strokeWidth="1"
      />
      <path
        d="M 230 314 L 240 320 L 230 326"
        stroke="#0B1220"
        strokeOpacity="0.6"
        strokeWidth="1"
        fill="none"
      />

      {/* tiny accent dot — origin point */}
      <circle cx="60" cy="320" r="3" fill="#D4B36A" />
    </svg>
  );
}
