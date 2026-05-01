import Image from "next/image";

export default function Logo({ size = 36 }: { size?: number }) {
  return (
    <span className="m-logo" aria-label="Rolle Management Group home">
      <Image
        src="/rmg-logo.png"
        alt=""
        width={size}
        height={size}
        priority
        style={{ width: size, height: size, display: "block", objectFit: "contain" }}
      />
      <span>Rolle Management Group</span>
    </span>
  );
}
