/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Type-check via tsc; skip ESLint strict rules at build time
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "m.media-amazon.com" },
      { protocol: "https", hostname: "images-na.ssl-images-amazon.com" },
      { protocol: "https", hostname: "*.amazon.com" },
    ],
  },
};

export default nextConfig;
