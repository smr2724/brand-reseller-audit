/**
 * Inline SVG chart comparing reseller vs direct channel profit.
 * Built mobile-first; reflows naturally as the SVG scales.
 */
export default function ProfitMathChart({ className }: { className?: string }) {
  // domain max set just above the larger value for breathing room
  const max = 2.6; // $M
  const reseller = 1.15;
  const direct = 2.4;

  const W = 720;
  const H = 220;
  const padL = 0;
  const padR = 16;
  const barH = 56;
  const trackW = W - padL - padR;

  const resellerW = (reseller / max) * trackW;
  const directW = (direct / max) * trackW;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="Annual profit per channel: through resellers approximately $1.15 million; direct on Amazon approximately $2.4 million."
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* reseller bar */}
      <g>
        <text
          x="0"
          y="14"
          fill="#A8B0BF"
          fontSize="11"
          letterSpacing="0.18em"
          fontFamily="var(--font-inter), Inter, system-ui, sans-serif"
          fontWeight="600"
        >
          THROUGH RESELLERS
        </text>
        <rect
          x={padL}
          y="28"
          width={trackW}
          height={barH}
          fill="rgba(255,255,255,0.04)"
          stroke="rgba(255,255,255,0.12)"
        />
        <rect x={padL} y="28" width={resellerW} height={barH} fill="rgba(255,255,255,0.18)" />
        <text
          x={padL + 18}
          y="60"
          fill="#fff"
          fontSize="22"
          fontFamily="var(--font-fraunces), Georgia, serif"
          fontWeight="400"
          fontStyle="italic"
          style={{ fontVariantNumeric: "tabular-nums lining-nums" }}
        >
          ~$1.15M
        </text>
        <text
          x={padL + 18}
          y="78"
          fill="#A8B0BF"
          fontSize="11"
          letterSpacing="0.08em"
          fontFamily="var(--font-inter), Inter, system-ui, sans-serif"
        >
          $11.48 / unit · 100k units
        </text>
      </g>

      {/* direct bar */}
      <g transform="translate(0, 110)">
        <text
          x="0"
          y="14"
          fill="#D4B36A"
          fontSize="11"
          letterSpacing="0.18em"
          fontFamily="var(--font-inter), Inter, system-ui, sans-serif"
          fontWeight="600"
        >
          DIRECT ON AMAZON
        </text>
        <rect
          x={padL}
          y="28"
          width={trackW}
          height={barH}
          fill="rgba(212,179,106,0.06)"
          stroke="rgba(212,179,106,0.5)"
        />
        <rect x={padL} y="28" width={directW} height={barH} fill="rgba(212,179,106,0.85)" />
        <text
          x={padL + 18}
          y="60"
          fill="#0B1220"
          fontSize="22"
          fontFamily="var(--font-fraunces), Georgia, serif"
          fontWeight="500"
          fontStyle="italic"
          style={{ fontVariantNumeric: "tabular-nums lining-nums" }}
        >
          ~$2.4M
        </text>
        <text
          x={padL + 18}
          y="78"
          fill="#0B1220"
          fontSize="11"
          letterSpacing="0.08em"
          fontFamily="var(--font-inter), Inter, system-ui, sans-serif"
        >
          $24 / unit · 100k units
        </text>
      </g>
    </svg>
  );
}
